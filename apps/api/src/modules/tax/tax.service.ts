import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { TaxComputation } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { computeTax, resolveTaxMode, type TaxAddress, type TaxRateRow, type TaxSettings, type TaxTotalsInput } from './tax.calc.js';
import type { PreviewTaxDto, SaveTaxRateDto } from './tax.dto.js';

/** Dòng hàng đưa vào tính thuế: có taxClass thì dùng luôn, không thì tra theo productId */
export interface TaxItem {
  productId?: string | null;
  taxClass?: string | null;
  total: number;
}

/** Thời gian giữ cache bảng thuế suất trong bộ nhớ (vẫn xoá ngay khi admin sửa) */
const CACHE_MS = 60_000;

@Injectable()
export class TaxService {
  private cache: { at: number; rows: TaxRateRow[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------- tính thuế ----------------

  /** Bảng thuế suất đang bật (cache 60 giây) */
  private async activeRates(): Promise<TaxRateRow[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    const rows = await this.prisma.taxRate.findMany({ where: { isActive: true }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
    const mapped = rows.map((r) => ({ id: r.id, name: r.name, taxClass: r.taxClass, country: r.country, province: r.province, rate: Number(r.rate), shipping: r.shipping, priority: r.priority, isActive: r.isActive }));
    this.cache = { at: Date.now(), rows: mapped };
    return mapped;
  }

  /**
   * Tính thuế cho báo giá / đơn mới.
   * `commerce` truyền vào nếu nơi gọi đã đọc cài đặt (tránh đọc lại). Chế độ `flat` (mặc định) = công thức cũ.
   * Số trả về CHƯA làm tròn.
   */
  async compute(items: TaxItem[], address: TaxAddress | null | undefined, totals: TaxTotalsInput, commerce?: TaxSettings): Promise<TaxComputation> {
    const s = commerce ?? (await this.settings.get<TaxSettings>('commerce'));
    const mode = resolveTaxMode(s.taxMode);
    if (mode !== 'rates') return computeTax(items, address ?? {}, totals, s);
    // thiếu taxClass -> tra theo sản phẩm
    const need = [...new Set(items.filter((i) => i.taxClass === undefined && i.productId).map((i) => i.productId!))];
    const classes = new Map<string, string | null>();
    if (need.length) {
      const rows = await this.prisma.product.findMany({ where: { id: { in: need } }, select: { id: true, taxClass: true } });
      for (const r of rows) classes.set(r.id, r.taxClass);
    }
    const lines = items.map((i) => ({ total: i.total, taxClass: i.taxClass !== undefined ? i.taxClass : i.productId ? (classes.get(i.productId) ?? null) : null }));
    return computeTax(lines, address ?? {}, totals, s, await this.activeRates());
  }

  /** Thử tính (trang Cài đặt › Thuế) theo cài đặt đang lưu */
  async preview(dto: PreviewTaxDto) {
    return this.compute([{ taxClass: dto.taxClass || null, total: dto.amount }], { country: dto.country, province: dto.province }, { shippingTotal: dto.shipping ?? 0 });
  }

  // ---------------- CRUD bảng thuế suất ----------------

  private present<T extends { rate: unknown }>(r: T) {
    return { ...r, rate: Number(r.rate) };
  }

  async list() {
    const rows = await this.prisma.taxRate.findMany({ orderBy: [{ taxClass: 'asc' }, { country: 'asc' }, { province: 'asc' }, { priority: 'desc' }] });
    return rows.map((r) => this.present(r));
  }

  /** Các lớp thuế đang dùng (bảng thuế + sản phẩm) để admin chọn */
  async classes() {
    const [a, b] = await Promise.all([
      this.prisma.taxRate.findMany({ distinct: ['taxClass'], select: { taxClass: true } }),
      this.prisma.product.findMany({ where: { taxClass: { not: null } }, distinct: ['taxClass'], select: { taxClass: true } }),
    ]);
    return [...new Set(['standard', 'reduced', 'zero', ...a.map((x) => x.taxClass), ...b.map((x) => x.taxClass!).filter(Boolean)])];
  }

  private changed(action: string, id: string, actorId?: string | null) {
    this.cache = null;
    this.events.emit('activity', { userId: actorId ?? null, action: `tax-rate.${action}`, entityType: 'tax_rate', entityId: id, meta: {} });
  }

  private data(dto: SaveTaxRateDto) {
    return {
      name: dto.name.trim(),
      taxClass: dto.taxClass || 'standard',
      country: dto.country || '*',
      // tỉnh chỉ có nghĩa khi đã chọn quốc gia
      province: dto.country && dto.country !== '*' ? dto.province || '*' : '*',
      rate: dto.rate,
      shipping: dto.shipping ?? false,
      priority: dto.priority ?? 0,
      isActive: dto.isActive ?? true,
    };
  }

  async create(dto: SaveTaxRateDto, actorId?: string | null) {
    const row = await this.prisma.taxRate.create({ data: this.data(dto) });
    this.changed('create', row.id, actorId);
    return this.present(row);
  }

  async update(id: string, dto: SaveTaxRateDto, actorId?: string | null) {
    if (!(await this.prisma.taxRate.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Không tìm thấy thuế suất');
    const row = await this.prisma.taxRate.update({ where: { id }, data: this.data(dto) });
    this.changed('update', id, actorId);
    return this.present(row);
  }

  async remove(id: string, actorId?: string | null) {
    if (!(await this.prisma.taxRate.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Không tìm thấy thuế suất');
    await this.prisma.taxRate.delete({ where: { id } });
    this.changed('delete', id, actorId);
    return { ok: true };
  }
}
