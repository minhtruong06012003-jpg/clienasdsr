import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service.js';
import type { Prisma, ShippingLocation } from '../../../generated/prisma/client.js';
import { VN_PROVINCES } from '../regions.js';
import type { CarrierAddress, CarrierConfig, CarrierLocation, ShippingCarrier } from './carrier.interface.js';

/** Bỏ dấu, viết thường, bỏ tiền tố hành chính để so khớp tên giữa các hãng ("Quận 1" ~ "Q.1" ~ "1") */
export function normalizeLocationName(name: string): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/^(tinh|thanh pho|tp\.?|t\.p\.?|quan|q\.?|huyen|h\.?|thi xa|tx\.?|phuong|p\.?|xa|x\.?|thi tran|tt\.?)\s+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Trả về mã tỉnh ISO "VN-HN" khớp tên hãng trả về (vd "Hà Nội", "Thành phố Hồ Chí Minh", "TP. Hồ Chí Minh") */
export function matchProvinceCode(name: string): string | null {
  const n = normalizeLocationName(name).replace(/\s+/g, '');
  const alias: Record<string, string> = { hcm: 'VN-SG', hochiminh: 'VN-SG', tphcm: 'VN-SG', saigon: 'VN-SG', hanoi: 'VN-HN', bariavungtau: 'VN-BV', thuathienhue: 'VN-TH', hue: 'VN-TH' };
  if (alias[n]) return alias[n];
  for (const p of VN_PROVINCES) {
    const pv = normalizeLocationName(p.name.vi).replace(/\s+/g, '');
    if (pv === n || pv.replace(/^(thanhpho|tinh)/, '') === n.replace(/^(thanhpho|tinh)/, '')) return p.code;
  }
  return null;
}

export interface LocationNode {
  code: string;
  name: string;
  level: number;
  parentCode: string | null;
  /** cấp dưới có dữ liệu không (để storefront biết hiện select tiếp) */
  hasChildren?: boolean;
}

/**
 * Danh mục địa chỉ hành chính (bảng shipping_locations) đồng bộ từ API hãng (GHN / Viettel Post / GoShip...).
 * Mỗi dòng giữ mã của từng hãng (carrierCodes) để tạo vận đơn với đúng mã của hãng đó.
 */
@Injectable()
export class ShippingLocationsService {
  private readonly logger = new Logger('ShippingLocations');

  constructor(private readonly prisma: PrismaService) {}

  /** Cấp con của một mã (bỏ trống = danh sách tỉnh đã có dữ liệu quận/phường) */
  async children(parentCode?: string | null): Promise<LocationNode[]> {
    const rows = await this.prisma.shippingLocation.findMany({ where: { parentCode: parentCode || null, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { code: true, name: true, level: true, parentCode: true } });
    if (!rows.length) return [];
    const codes = rows.map((r) => r.code);
    const withKids = await this.prisma.shippingLocation.groupBy({ by: ['parentCode'], where: { parentCode: { in: codes }, isActive: true }, _count: { _all: true } });
    const set = new Set(withKids.map((w) => w.parentCode));
    return rows.map((r) => ({ ...r, hasChildren: set.has(r.code) }));
  }

  /** Số lượng theo cấp (để admin biết đã đồng bộ chưa) */
  async stats() {
    const rows = await this.prisma.shippingLocation.groupBy({ by: ['level'], _count: { _all: true } });
    const latest = await this.prisma.shippingLocation.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, carrierCodes: true } });
    const carriers = new Set<string>();
    const all = await this.prisma.shippingLocation.findMany({ where: { level: 1 }, select: { carrierCodes: true } });
    for (const r of all) for (const k of Object.keys((r.carrierCodes as object) ?? {})) carriers.add(k);
    return { provinces: rows.find((r) => r.level === 1)?._count._all ?? 0, districts: rows.find((r) => r.level === 2)?._count._all ?? 0, wards: rows.find((r) => r.level === 3)?._count._all ?? 0, updatedAt: latest?.updatedAt ?? null, carriers: [...carriers] };
  }

  /** Lấy một dòng theo mã nội bộ */
  byCode(code: string) {
    return this.prisma.shippingLocation.findUnique({ where: { code } });
  }

  /**
   * Đồng bộ danh mục từ một hãng: tỉnh -> quận -> phường. Tỉnh ánh xạ về mã ISO "VN-xx" bằng tên;
   * quận/phường tạo mã nội bộ từ mã hãng đầu tiên đồng bộ, hãng sau khớp theo tên (normalized) trong cùng cấp cha.
   * Trả về số dòng đã ghi. Chạy lâu (GHN ~ 11.000 phường) nên gọi từ job nền.
   */
  async syncFromCarrier(carrierKey: string, carrier: ShippingCarrier, cfg: CarrierConfig, onProgress?: (msg: string) => void): Promise<{ provinces: number; districts: number; wards: number }> {
    if (!carrier.listLocations) throw new BadRequestException(`${carrier.meta.name} không cung cấp danh mục địa chỉ`);
    const counts = { provinces: 0, districts: 0, wards: 0 };
    const provinces = await carrier.listLocations(cfg, 1);
    const threeLevels = (carrier.meta.addressLevels ?? 3) === 3;
    for (const [pi, p] of provinces.entries()) {
      const provinceCode = matchProvinceCode(p.name);
      if (!provinceCode) {
        this.logger.warn(`Không khớp tỉnh "${p.name}" của ${carrierKey}`);
        continue;
      }
      await this.upsert({ level: 1, code: provinceCode, name: VN_PROVINCES.find((x) => x.code === provinceCode)?.name.vi ?? p.name, parentCode: null, sortOrder: pi }, carrierKey, p.code);
      counts.provinces++;
      onProgress?.(`${carrierKey}: ${p.name}`);
      if (threeLevels) {
        const districts = await carrier.listLocations(cfg, 2, p.code);
        for (const [di, d] of districts.entries()) {
          const districtCode = await this.upsertChild({ level: 2, parentCode: provinceCode, name: d.name, sortOrder: di }, carrierKey, d.code);
          counts.districts++;
          const wards = await carrier.listLocations(cfg, 3, d.code);
          for (const [wi, w] of wards.entries()) {
            await this.upsertChild({ level: 3, parentCode: districtCode, name: w.name, sortOrder: wi }, carrierKey, w.code);
            counts.wards++;
          }
        }
      } else {
        // hãng dùng 2 cấp (tỉnh -> phường): phường gắn trực tiếp vào tỉnh (level 3, parent = tỉnh)
        const wards = await carrier.listLocations(cfg, 3, p.code);
        for (const [wi, w] of wards.entries()) {
          await this.upsertChild({ level: 3, parentCode: provinceCode, name: w.name, sortOrder: wi }, carrierKey, w.code);
          counts.wards++;
        }
      }
    }
    return counts;
  }

  /** Upsert theo mã nội bộ cố định (tỉnh) */
  private async upsert(data: { level: number; code: string; name: string; parentCode: string | null; sortOrder: number }, carrierKey: string, carrierCode: string) {
    const existing = await this.prisma.shippingLocation.findUnique({ where: { code: data.code } });
    const carrierCodes = { ...((existing?.carrierCodes as Record<string, string>) ?? {}), [carrierKey]: carrierCode } as Prisma.InputJsonValue;
    if (existing) return this.prisma.shippingLocation.update({ where: { code: data.code }, data: { carrierCodes, sortOrder: existing.sortOrder || data.sortOrder } });
    return this.prisma.shippingLocation.create({ data: { ...data, normalized: normalizeLocationName(data.name), carrierCodes } });
  }

  /** Upsert quận/phường: khớp theo tên đã chuẩn hoá trong cùng cấp cha; chưa có thì tạo mã mới từ mã hãng */
  private async upsertChild(data: { level: number; parentCode: string; name: string; sortOrder: number }, carrierKey: string, carrierCode: string): Promise<string> {
    const normalized = normalizeLocationName(data.name);
    const siblings = await this.prisma.shippingLocation.findMany({ where: { parentCode: data.parentCode, level: data.level }, select: { id: true, code: true, normalized: true, carrierCodes: true } });
    let match = siblings.find((s) => (s.carrierCodes as Record<string, string>)?.[carrierKey] === carrierCode) ?? siblings.find((s) => s.normalized === normalized);
    // khớp lỏng: "1" ~ "quan 1", "binh thanh" ~ "q binh thanh"
    if (!match) match = siblings.find((s) => s.normalized.replace(/\s+/g, '') === normalized.replace(/\s+/g, ''));
    if (match) {
      const carrierCodes = { ...((match.carrierCodes as Record<string, string>) ?? {}), [carrierKey]: carrierCode } as Prisma.InputJsonValue;
      await this.prisma.shippingLocation.update({ where: { id: match.id }, data: { carrierCodes } });
      return match.code;
    }
    const prefix = data.level === 2 ? 'D' : 'W';
    const code = `${data.parentCode}-${prefix}${String(carrierCode).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
    const dup = await this.prisma.shippingLocation.findUnique({ where: { code }, select: { id: true } });
    const finalCode = dup ? `${code}-${Math.random().toString(36).slice(2, 6)}` : code;
    await this.prisma.shippingLocation.create({ data: { level: data.level, code: finalCode, name: data.name, normalized, parentCode: data.parentCode, sortOrder: data.sortOrder, carrierCodes: { [carrierKey]: carrierCode } as Prisma.InputJsonValue } });
    return finalCode;
  }

  /**
   * Điền mã của các hãng cho một địa chỉ: theo mã nội bộ (districtCode/wardCode) nếu có, không thì khớp theo tên.
   * Trả về bản sao địa chỉ có `carrierCodes` + tên đã chuẩn (để hãng dùng tên cũng được).
   */
  async enrich(addr: CarrierAddress): Promise<CarrierAddress> {
    const out: CarrierAddress = { ...addr, carrierCodes: { ...(addr.carrierCodes ?? {}) } };
    const put = (row: ShippingLocation | null | undefined, field: 'province' | 'district' | 'ward') => {
      if (!row) return;
      for (const [carrier, code] of Object.entries((row.carrierCodes as Record<string, string>) ?? {})) {
        out.carrierCodes![carrier] = { ...(out.carrierCodes![carrier] ?? {}), [field]: code };
      }
      if (field === 'province') {
        out.provinceCode = row.code;
        out.provinceName ||= row.name;
      } else if (field === 'district') {
        out.districtCode = row.code;
        out.districtName ||= row.name;
      } else {
        out.wardCode = row.code;
        out.wardName ||= row.name;
      }
    };
    // tỉnh
    let province: ShippingLocation | null = null;
    if (addr.provinceCode) province = await this.byCode(addr.provinceCode);
    if (!province && addr.provinceName) {
      const code = matchProvinceCode(addr.provinceName);
      if (code) province = await this.byCode(code);
    }
    put(province, 'province');
    // quận
    let district: ShippingLocation | null = null;
    if (addr.districtCode) district = await this.byCode(addr.districtCode);
    if (!district && province && addr.districtName) district = await this.findByName(province.code, 2, addr.districtName);
    put(district, 'district');
    // phường (cha là quận, hoặc tỉnh khi hãng 2 cấp)
    let ward: ShippingLocation | null = null;
    if (addr.wardCode) ward = await this.byCode(addr.wardCode);
    if (!ward && addr.wardName) {
      if (district) ward = await this.findByName(district.code, 3, addr.wardName);
      if (!ward && province) ward = await this.findByName(province.code, 3, addr.wardName);
    }
    put(ward, 'ward');
    return out;
  }

  private async findByName(parentCode: string, level: number, name: string) {
    const normalized = normalizeLocationName(name);
    if (!normalized) return null;
    const rows = await this.prisma.shippingLocation.findMany({ where: { parentCode, level, isActive: true } });
    return rows.find((r) => r.normalized === normalized) ?? rows.find((r) => r.normalized.replace(/\s+/g, '') === normalized.replace(/\s+/g, '')) ?? rows.find((r) => normalized.includes(r.normalized) || r.normalized.includes(normalized)) ?? null;
  }

  /** Tìm nhanh theo tên (gợi ý ở admin) */
  async search(q: string, level?: number, parentCode?: string) {
    const normalized = normalizeLocationName(q);
    return this.prisma.shippingLocation.findMany({ where: { ...(level ? { level } : {}), ...(parentCode ? { parentCode } : {}), normalized: { contains: normalized } }, take: 20, orderBy: [{ level: 'asc' }, { name: 'asc' }], select: { code: true, name: true, level: true, parentCode: true } });
  }
}
