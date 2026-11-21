import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { Prisma, type ShippingMethod } from '../../generated/prisma/client.js';
import { COUNTRIES, COUNTRY_MAP, PROVINCE_MAP, REGION_GROUPS, VN_PROVINCES } from './regions.js';
import type { ReorderIdsDto, SaveMethodDto, SaveZoneDto, UpdateZoneDto } from './shipping.dto.js';
import { ShippingCarriersService, type CarrierQuoteInput, type OrderAddress } from './carriers/carriers.service.js';

export interface ShippingRule {
  upTo: number | null;
  cost: number;
}

/** Phương thức vận chuyển đã tính phí, trả về cho storefront */
export interface ShippingOption {
  /** id ShippingMethod, 'default' (phí đồng giá cũ), hoặc "<methodId>|<carrier>|<service>" với phí lấy từ hãng */
  id: string;
  type: ShippingMethod['type'];
  name: string;
  description: string | null;
  cost: number;
  /** id ShippingMethod gốc (CARRIER) */
  methodId?: string;
  /** Hãng & dịch vụ khi phí lấy từ API hãng */
  carrier?: string;
  carrierName?: string;
  service?: string;
  serviceName?: string;
  estimatedDays?: number | null;
  expectedDeliveryAt?: string | null;
}

export interface ResolveInput {
  /** mã tỉnh/thành "VN-HN" */
  province?: string | null;
  /** mã quốc gia, mặc định VN */
  country?: string | null;
  /** tạm tính (sau khi loại dòng không hợp lệ) */
  subtotal: number;
  /** tổng cân nặng (gram) */
  weight: number;
  locale?: string;
  /** địa chỉ đầy đủ (quận/phường) + dòng hàng + thanh toán — cần cho phương thức CARRIER lấy phí từ hãng */
  address?: OrderAddress | null;
  items?: CarrierQuoteInput['items'];
  paymentMethod?: string | null;
}

export const DEFAULT_SHIPPING_ID = 'default';

type I18nJson = Record<string, string> | null | undefined;

const pick = (v: I18nJson, locale: string, fallback: string) => {
  if (!v || typeof v !== 'object') return '';
  return v[locale] || v[fallback] || Object.values(v).find(Boolean) || '';
};

/** Tra bảng quy tắc [{ upTo, cost }] theo giá trị (gram hoặc tiền); upTo null = còn lại. Không khớp → null */
export function matchRule(rules: unknown, value: number): number | null {
  if (!Array.isArray(rules) || !rules.length) return null;
  const list = (rules as ShippingRule[])
    .filter((r) => r && typeof r === 'object' && Number.isFinite(Number(r.cost)))
    .map((r) => ({ upTo: r.upTo == null || r.upTo === ('' as unknown) ? null : Number(r.upTo), cost: Number(r.cost) }))
    .sort((a, b) => (a.upTo == null ? 1 : b.upTo == null ? -1 : a.upTo - b.upTo));
  const hit = list.find((r) => r.upTo == null || value <= r.upTo);
  return hit ? hit.cost : null;
}

/**
 * Tính phí một method. Trả null nếu method không áp dụng (vd FREE chưa đạt ngưỡng).
 * Tách thành hàm thuần để test.
 */
export function computeMethodCost(m: Pick<ShippingMethod, 'type' | 'cost' | 'minOrderTotal' | 'rules'>, input: { subtotal: number; weight: number }): number | null {
  if (m.type === 'CARRIER') return null; // phí hãng tính ở resolveMethods
  const base = Number(m.cost) || 0;
  switch (m.type) {
    case 'FLAT':
      return base;
    case 'PICKUP':
      return 0;
    case 'FREE': {
      const min = m.minOrderTotal == null ? 0 : Number(m.minOrderTotal);
      return input.subtotal >= min ? 0 : null;
    }
    case 'WEIGHT':
      return matchRule(m.rules, input.weight) ?? base;
    case 'PRICE':
      return matchRule(m.rules, input.subtotal) ?? base;
    default:
      return base;
  }
}

/**
 * Chọn vùng phù hợp nhất: ưu tiên vùng khớp mã tỉnh → khớp quốc gia → "*" (mọi nơi);
 * cùng mức ưu tiên thì lấy vùng đứng trước (sortOrder).
 */
export function pickZone<Z extends { regions: string[] }>(zones: Z[], province?: string | null, country?: string | null): Z | null {
  const c = (country || 'VN').toUpperCase();
  const p = province ? province.toUpperCase() : null;
  if (p) {
    const z = zones.find((z) => z.regions.includes(p));
    if (z) return z;
  }
  return zones.find((z) => z.regions.includes(c)) ?? zones.find((z) => z.regions.includes('*')) ?? null;
}

@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly languages: LanguagesService,
    private readonly carriers: ShippingCarriersService,
  ) {}

  // ---------------- danh mục vùng ----------------

  /** Dữ liệu tỉnh/thành + quốc gia cho Select ở checkout. Quốc gia chỉ liệt kê những nước có vùng vận chuyển (chưa có vùng → chỉ VN). */
  async regions() {
    const zones = await this.prisma.shippingZone.findMany({ where: { isActive: true }, select: { regions: true } });
    let countries = COUNTRIES;
    if (zones.length) {
      const codes = new Set<string>(['VN']);
      let all = false;
      for (const z of zones) {
        for (const r of z.regions) {
          if (r === '*') all = true;
          else codes.add(r.split('-')[0].toUpperCase());
        }
      }
      if (!all) countries = COUNTRIES.filter((c) => codes.has(c.code));
    } else {
      countries = COUNTRIES.filter((c) => c.code === 'VN');
    }
    return { countries, provinces: VN_PROVINCES, groups: REGION_GROUPS };
  }

  /** Danh mục đầy đủ cho admin chọn vùng */
  allRegions() {
    return { countries: COUNTRIES, provinces: VN_PROVINCES, groups: REGION_GROUPS };
  }

  // ---------------- tính phí ----------------

  /**
   * Trả các phương thức vận chuyển khả dụng (đã tính phí) cho địa chỉ/giỏ hàng.
   * Chưa cấu hình vùng nào → dùng phí đồng giá + ngưỡng miễn phí trong Cài đặt > Bán hàng.
   */
  async resolveMethods(input: ResolveInput): Promise<ShippingOption[]> {
    const locale = await this.languages.resolve(input.locale);
    const fallback = await this.languages.defaultLocale();
    const zones = await this.prisma.shippingZone.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { methods: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!zones.length) {
      // chưa cấu hình vùng: phí đồng giá cũ + báo giá từ các hãng đã bật (không cần tạo vùng/phương thức)
      const legacy = await this.legacyMethods(input.subtotal, locale);
      return [...legacy, ...(await this.carrierOptions(input, null))];
    }

    const zone = pickZone(zones, input.province, input.country);
    if (!zone) return [];
    const out: ShippingOption[] = [];
    // báo giá hãng chỉ gọi 1 lần cho mọi phương thức CARRIER của vùng
    let carrierQuotes: Awaited<ReturnType<ShippingCarriersService['quote']>> | null = null;
    for (const m of zone.methods) {
      if (m.type === 'CARRIER') {
        carrierQuotes ??= await this.carrierQuotes(input, m);
        out.push(...this.optionsFromQuotes(carrierQuotes, m, locale, fallback));
        continue;
      }
      const cost = computeMethodCost(m, input);
      if (cost == null) continue;
      out.push({
        id: m.id,
        type: m.type,
        name: pick(m.name as I18nJson, locale, fallback) || m.type,
        description: pick(m.description as I18nJson, locale, fallback) || null,
        cost: Math.round(cost),
      });
    }
    return out;
  }

  // ---------------- phí từ hãng vận chuyển ----------------

  private carrierName(key: string) {
    return this.carriers['registry'].get(key)?.meta.name ?? key;
  }

  /** Gọi báo giá hãng cho input checkout; lỗi -> rỗng (phương thức dùng phí dự phòng nếu có) */
  private async carrierQuotes(input: ResolveInput, m: Pick<ShippingMethod, 'carrier' | 'carrierService'> | null) {
    try {
      return await this.carriers.quote({
        to: input.address ?? { province: input.province, country: input.country },
        subtotal: input.subtotal,
        weight: input.weight,
        items: input.items ?? [],
        paymentMethod: input.paymentMethod ?? null,
        carrier: m?.carrier ?? null,
        service: m?.carrier ? (m.carrierService ?? null) : null,
      });
    } catch {
      return { quotes: [], errors: {} };
    }
  }

  /** Chuyển quote hãng thành ShippingOption theo cấu hình phương thức (lọc hãng/dịch vụ, điều chỉnh phí, phí dự phòng) */
  private optionsFromQuotes(res: Awaited<ReturnType<ShippingCarriersService['quote']>>, m: Pick<ShippingMethod, 'id' | 'type' | 'name' | 'description' | 'carrier' | 'carrierService' | 'feeAdjust' | 'fallbackCost'> | null, locale: string, fallback: string): ShippingOption[] {
    const name = m ? pick(m.name as I18nJson, locale, fallback) : '';
    const description = m ? pick(m.description as I18nJson, locale, fallback) || null : null;
    const quotes = res.quotes.filter((q) => (!m?.carrier || q.carrier === m.carrier) && (!m?.carrierService || q.serviceCode === m.carrierService));
    if (!quotes.length) {
      if (m && m.fallbackCost != null) {
        // API hãng lỗi / chưa đủ địa chỉ -> phí dự phòng, vẫn nhớ hãng để tạo vận đơn sau
        return [{ id: m.id, methodId: m.id, type: m.type, name: name || this.carrierName(m.carrier ?? ''), description, cost: Math.round(Number(m.fallbackCost)), carrier: m.carrier ?? undefined, service: m.carrierService ?? undefined }];
      }
      return [];
    }
    return quotes.map((q) => ({
      id: m ? `${m.id}|${q.carrier}|${q.serviceCode}` : `carrier|${q.carrier}|${q.serviceCode}`,
      methodId: m?.id,
      type: 'CARRIER' as const,
      name: name ? (m?.carrier && m.carrierService ? name : `${name} · ${q.serviceName}`) : `${q.carrierName ?? this.carrierName(q.carrier)} · ${q.serviceName}`,
      description: description ?? (q.estimatedDays ? (locale === 'en' ? `Est. ${q.estimatedDays} day(s)` : `Dự kiến ${q.estimatedDays} ngày`) : null),
      cost: m ? this.carriers.applyFeeAdjust(q.fee, m) : q.fee,
      carrier: q.carrier,
      carrierName: q.carrierName ?? this.carrierName(q.carrier),
      service: q.serviceCode,
      serviceName: q.serviceName,
      estimatedDays: q.estimatedDays ?? null,
      expectedDeliveryAt: q.expectedDeliveryAt ? new Date(q.expectedDeliveryAt).toISOString() : null,
    }));
  }

  /** Mọi dịch vụ của các hãng đã bật (khi chưa cấu hình vùng) */
  private async carrierOptions(input: ResolveInput, m: null): Promise<ShippingOption[]> {
    const locale = await this.languages.resolve(input.locale);
    const fallback = await this.languages.defaultLocale();
    const res = await this.carrierQuotes(input, m);
    return this.optionsFromQuotes(res, m, locale, fallback);
  }

  /** Phí đồng giá cũ (Cài đặt > Bán hàng) khi chưa có vùng vận chuyển */
  private async legacyMethods(subtotal: number, locale: string): Promise<ShippingOption[]> {
    const commerce = await this.settings.get<{ shippingFlatRate?: number; freeShippingThreshold?: number }>('commerce');
    let cost = Number(commerce.shippingFlatRate) || 0;
    const threshold = Number(commerce.freeShippingThreshold) || 0;
    if (threshold > 0 && subtotal >= threshold) cost = 0;
    return [{ id: DEFAULT_SHIPPING_ID, type: 'FLAT', name: locale === 'vi' ? 'Giao hàng tiêu chuẩn' : 'Standard shipping', description: null, cost }];
  }

  /** Đã cấu hình vùng vận chuyển chưa (để storefront biết khi nào phải chọn tỉnh/thành) */
  async hasZones() {
    return (await this.prisma.shippingZone.count({ where: { isActive: true } })) > 0;
  }

  // ---------------- admin: vùng ----------------

  zones() {
    return this.prisma.shippingZone.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { methods: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
  }

  private normalizeRegions(regions: string[]) {
    const out = new Set<string>();
    for (const raw of regions) {
      const r = raw.trim().toUpperCase();
      if (!r) continue;
      if (r === '*' || COUNTRY_MAP.has(r) || PROVINCE_MAP.has(r)) out.add(r);
      else throw new BadRequestException(`Mã vùng không hợp lệ: ${raw}`);
    }
    if (!out.size) throw new BadRequestException('Vui lòng chọn ít nhất một vùng');
    return [...out];
  }

  async createZone(dto: SaveZoneDto) {
    const last = await this.prisma.shippingZone.aggregate({ _max: { sortOrder: true } });
    return this.prisma.shippingZone.create({
      data: { name: dto.name.trim(), regions: this.normalizeRegions(dto.regions), isActive: dto.isActive ?? true, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      include: { methods: true },
    });
  }

  async updateZone(id: string, dto: UpdateZoneDto) {
    const data: Prisma.ShippingZoneUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.regions !== undefined) data.regions = this.normalizeRegions(dto.regions);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    try {
      return await this.prisma.shippingZone.update({ where: { id }, data, include: { methods: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } });
    } catch {
      throw new NotFoundException('Không tìm thấy vùng vận chuyển');
    }
  }

  async removeZone(id: string) {
    await this.prisma.shippingZone.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Không tìm thấy vùng vận chuyển');
    });
    return { success: true };
  }

  async reorderZones(dto: ReorderIdsDto) {
    await this.prisma.$transaction(dto.ids.map((id, i) => this.prisma.shippingZone.update({ where: { id }, data: { sortOrder: i } })));
    return { success: true };
  }

  /** Tạo nhanh vùng "Toàn quốc" từ phí đồng giá cũ (chỉ khi chưa có vùng nào) */
  async quickSetup() {
    if (await this.prisma.shippingZone.count()) throw new BadRequestException('Đã có vùng vận chuyển, không cần thiết lập nhanh');
    const commerce = await this.settings.get<{ shippingFlatRate?: number; freeShippingThreshold?: number }>('commerce');
    const flat = Number(commerce.shippingFlatRate) || 0;
    const threshold = Number(commerce.freeShippingThreshold) || 0;
    const methods: Prisma.ShippingMethodCreateWithoutZoneInput[] = [
      { type: 'FLAT', name: { vi: 'Giao hàng tiêu chuẩn', en: 'Standard shipping' }, cost: flat, sortOrder: 0 },
    ];
    if (threshold > 0) {
      methods.push({ type: 'FREE', name: { vi: 'Miễn phí vận chuyển', en: 'Free shipping' }, description: { vi: `Đơn từ ${threshold.toLocaleString('vi-VN')}đ`, en: `Orders from ${threshold.toLocaleString('en-US')}` }, cost: 0, minOrderTotal: threshold, sortOrder: 1 });
    }
    return this.prisma.shippingZone.create({ data: { name: 'Toàn quốc', regions: ['VN'], sortOrder: 0, methods: { create: methods } }, include: { methods: true } });
  }

  // ---------------- admin: phương thức ----------------

  private methodData(dto: SaveMethodDto) {
    const name = Object.fromEntries(Object.entries(dto.name ?? {}).map(([k, v]) => [k, String(v ?? '').trim()]));
    if (!Object.values(name).some(Boolean)) throw new BadRequestException('Vui lòng nhập tên phương thức');
    const rules = (dto.rules ?? []).map((r) => ({ upTo: r.upTo == null ? null : Number(r.upTo), cost: Number(r.cost) || 0 }));
    if ((dto.type === 'WEIGHT' || dto.type === 'PRICE') && !rules.length && !dto.cost) throw new BadRequestException('Vui lòng thêm ít nhất một quy tắc phí hoặc phí mặc định');
    return {
      type: dto.type,
      name,
      description: dto.description ? Object.fromEntries(Object.entries(dto.description).map(([k, v]) => [k, String(v ?? '').trim()])) : undefined,
      cost: dto.cost ?? 0,
      minOrderTotal: dto.type === 'FREE' ? (dto.minOrderTotal ?? null) : null,
      rules: dto.type === 'WEIGHT' || dto.type === 'PRICE' ? rules : [],
      isActive: dto.isActive ?? true,
      // phương thức lấy phí từ hãng
      carrier: dto.type === 'CARRIER' ? dto.carrier?.trim() || null : null,
      carrierService: dto.type === 'CARRIER' ? dto.carrierService?.trim() || null : null,
      feeAdjust: dto.type === 'CARRIER' && dto.feeAdjust && Number(dto.feeAdjust.value) ? { type: dto.feeAdjust.type === 'percent' ? 'percent' : 'fixed', value: Number(dto.feeAdjust.value) } : Prisma.JsonNull,
      fallbackCost: dto.type === 'CARRIER' ? (dto.fallbackCost ?? null) : null,
    };
  }

  async createMethod(zoneId: string, dto: SaveMethodDto) {
    const zone = await this.prisma.shippingZone.findUnique({ where: { id: zoneId }, select: { id: true } });
    if (!zone) throw new NotFoundException('Không tìm thấy vùng vận chuyển');
    const last = await this.prisma.shippingMethod.aggregate({ where: { zoneId }, _max: { sortOrder: true } });
    return this.prisma.shippingMethod.create({ data: { ...this.methodData(dto), zoneId, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
  }

  async updateMethod(id: string, dto: SaveMethodDto) {
    try {
      return await this.prisma.shippingMethod.update({ where: { id }, data: this.methodData(dto) });
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new NotFoundException('Không tìm thấy phương thức vận chuyển');
    }
  }

  async toggleMethod(id: string, isActive: boolean) {
    return this.prisma.shippingMethod.update({ where: { id }, data: { isActive } });
  }

  async removeMethod(id: string) {
    await this.prisma.shippingMethod.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Không tìm thấy phương thức vận chuyển');
    });
    return { success: true };
  }

  async reorderMethods(dto: ReorderIdsDto) {
    await this.prisma.$transaction(dto.ids.map((id, i) => this.prisma.shippingMethod.update({ where: { id }, data: { sortOrder: i } })));
    return { success: true };
  }
}
