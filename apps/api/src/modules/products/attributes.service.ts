import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ATTRIBUTE_KEY_RE, slugify, type ProductAttributeValue } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MediaService } from '../media/media.service.js';
import type { ProductAttribute as AttributeRow } from '../../generated/prisma/client.js';
import type { SaveAttributeDto } from './attributes.dto.js';

/** Chuẩn hoá mã thuộc tính: "Màu sắc" -> "mau_sac" */
export const attributeKey = (s: string) => slugify(s).replace(/-/g, '_').slice(0, 50);

/** Chuẩn hoá danh sách giá trị: giữ nguyên mã đã nhập (khớp optionValues cũ, phân biệt hoa thường), mã rỗng sinh từ nhãn; bỏ trùng; nhãn rỗng lấy mã */
export function normalizeAttributeValues(values: SaveAttributeDto['values'] = []): ProductAttributeValue[] {
  const seen = new Set<string>();
  const out: ProductAttributeValue[] = [];
  for (const v of values) {
    const firstLabel = Object.values(v.label ?? {}).find((x) => typeof x === 'string' && x.trim()) ?? '';
    const value = (v.value ?? '').trim().slice(0, 100) || slugify(firstLabel);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = Object.fromEntries(Object.entries(v.label ?? {}).filter(([, x]) => typeof x === 'string').map(([k, x]) => [k, x.trim()]));
    out.push({ value, label: Object.keys(label).length ? label : { vi: value }, color: v.color || null, imageId: v.imageId || null });
  }
  return out;
}

/** Thuộc tính sản phẩm dùng chung (màu, size...) — chọn trong variants editor, swatch + bộ lọc ở storefront */
@Injectable()
export class ProductAttributesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly events: EventEmitter2,
  ) {}

  /** Gắn URL ảnh cho giá trị kiểu image */
  private async present(rows: AttributeRow[]) {
    const ids = rows.flatMap((r) => ((r.values as unknown as ProductAttributeValue[]) ?? []).map((v) => v.imageId));
    const media = await this.media.findMany(ids);
    return rows.map((r) => ({
      ...r,
      values: ((r.values as unknown as ProductAttributeValue[]) ?? []).map((v) => {
        const m = v.imageId ? media.get(v.imageId) : undefined;
        return { ...v, image: m ? { url: m.url, thumb: m.urls?.thumb ?? m.url } : null };
      }),
    }));
  }

  async list() {
    return this.present(await this.prisma.productAttribute.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }));
  }

  /** Storefront: tất cả (hoặc chỉ thuộc tính dùng làm bộ lọc) */
  async publicList(filterable?: boolean) {
    const rows = await this.prisma.productAttribute.findMany({ where: filterable ? { filterable: true } : {}, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return (await this.present(rows)).map(({ createdAt: _c, updatedAt: _u, ...r }) => r);
  }

  async get(id: string) {
    const row = await this.prisma.productAttribute.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy thuộc tính');
    return (await this.present([row]))[0];
  }

  private changed(action: string, id: string, actorId?: string | null) {
    // storefront: trang danh sách (bộ lọc) + trang sản phẩm (swatch)
    this.events.emit('content.changed', { type: 'product', tags: ['products', 'product-attributes'] });
    this.events.emit('activity', { userId: actorId ?? null, action: `product-attribute.${action}`, entityType: 'product_attribute', entityId: id, meta: {} });
  }

  private data(dto: SaveAttributeDto) {
    const name = Object.fromEntries(Object.entries(dto.name ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.trim()]));
    const firstName = Object.values(name).find(Boolean) ?? '';
    const key = attributeKey(dto.key || firstName);
    if (!ATTRIBUTE_KEY_RE.test(key)) throw new BadRequestException('Mã thuộc tính không hợp lệ (a-z, 0-9, _)');
    if (!firstName) throw new BadRequestException('Vui lòng nhập tên thuộc tính');
    return {
      key,
      name,
      type: dto.type ?? 'select',
      values: normalizeAttributeValues(dto.values) as object[],
      filterable: dto.filterable ?? true,
      sortOrder: dto.sortOrder ?? 0,
    };
  }

  private async ensureUniqueKey(key: string, exceptId?: string) {
    const dup = await this.prisma.productAttribute.findUnique({ where: { key }, select: { id: true } });
    if (dup && dup.id !== exceptId) throw new ConflictException(`Mã thuộc tính "${key}" đã tồn tại`);
  }

  async create(dto: SaveAttributeDto, actorId?: string | null) {
    const data = this.data(dto);
    await this.ensureUniqueKey(data.key);
    const row = await this.prisma.productAttribute.create({ data });
    this.changed('create', row.id, actorId);
    return this.get(row.id);
  }

  async update(id: string, dto: SaveAttributeDto, actorId?: string | null) {
    if (!(await this.prisma.productAttribute.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Không tìm thấy thuộc tính');
    const data = this.data(dto);
    await this.ensureUniqueKey(data.key, id);
    await this.prisma.productAttribute.update({ where: { id }, data });
    this.changed('update', id, actorId);
    return this.get(id);
  }

  /** Xoá định nghĩa thuộc tính; sản phẩm đang dùng mã này vẫn giữ options/biến thể (chỉ mất swatch + bộ lọc) */
  async remove(id: string, actorId?: string | null) {
    if (!(await this.prisma.productAttribute.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Không tìm thấy thuộc tính');
    await this.prisma.productAttribute.delete({ where: { id } });
    this.changed('delete', id, actorId);
    return { ok: true };
  }

  /** Thứ tự hiển thị */
  async reorder(ids: string[]) {
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.productAttribute.update({ where: { id }, data: { sortOrder: i } })));
    this.events.emit('content.changed', { type: 'product', tags: ['products', 'product-attributes'] });
    return { ok: true };
  }

  /** Số sản phẩm đang dùng mỗi mã thuộc tính (có biến thể chứa key) — hiển thị ở trang quản lý */
  async usage(): Promise<Record<string, number>> {
    const rows = await this.prisma.$queryRaw<{ key: string; count: bigint }[]>`
      SELECT k.key AS key, COUNT(DISTINCT v."productId") AS count
      FROM product_variants v, LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(v."optionValues") = 'object' THEN v."optionValues" ELSE '{}'::jsonb END) AS k(key)
      GROUP BY k.key`;
    return Object.fromEntries(rows.map((r) => [r.key, Number(r.count)]));
  }
}
