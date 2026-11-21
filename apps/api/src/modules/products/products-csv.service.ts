import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hasPermission, slugify } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { SafeFetchError, safeFetch } from '../../common/utils/safe-fetch.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ProductsService } from './products.service.js';
import { ProductCategoriesService } from './product-categories.service.js';
import type { ProductDownloadDto, ProductQueryDto, SaveProductDto, VariantDto } from './products.dto.js';

// ============================================================
// CSV: parse / stringify (RFC 4180, tự nhận dấu phân cách , ; tab, bỏ BOM)
// ============================================================

export function detectDelimiter(headerLine: string) {
  const counts = [',', ';', '\t'].map((d) => ({ d, n: headerLine.split(d).length }));
  return counts.sort((a, b) => b.n - a.n)[0].d;
}

export function parseCsv(input: string, delimiter?: string): string[][] {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  text = text.replace(/\r\n?/g, '\n');
  const sep = delimiter ?? detectDelimiter(text.split('\n', 1)[0] ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // bỏ dòng trống hoàn toàn
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Chống CSV injection: ô bắt đầu bằng = + - @ hoặc ký tự điều khiển sẽ được thêm dấu ' phía trước */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  let s = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]) {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ============================================================
// Cột
// ============================================================

/** Cột xuất (thứ tự cố định). Dòng biến thể: type = VARIANT, có parentId/parentSku/variantOptions */
export const CSV_COLUMNS = [
  'id',
  'type',
  'status',
  'sku',
  'barcode',
  'name',
  'slug',
  'shortDescription',
  'description',
  'price',
  'salePrice',
  'saleStart',
  'saleEnd',
  'costPrice',
  'manageStock',
  'stockQuantity',
  'stockStatus',
  'lowStockThreshold',
  'weight',
  'length',
  'width',
  'height',
  'brand',
  'categories',
  'featuredImage',
  'gallery',
  'isFeatured',
  'sortOrder',
  'publishedAt',
  'seoTitle',
  'seoDescription',
  'options',
  'downloads',
  // sản phẩm ảo / kho mã (nhập được cả tên is_virtual, code_delivery, code_warranty_days)
  'isVirtual',
  'codeDelivery',
  'codeWarrantyDays',
  'parentId',
  'parentSku',
  'variantOptions',
] as const;

type Col = (typeof CSV_COLUMNS)[number];

const norm = (h: string) => h.toLowerCase().replace(/[\s_\-()?.:]/g, '');

/** Tên cột đã chuẩn hoá -> cột nội bộ (gồm cả tên cột WooCommerce) */
const HEADER_MAP: Record<string, string> = Object.fromEntries([
  ...CSV_COLUMNS.map((c) => [norm(c), c]),
  // WooCommerce
  ['published', 'published'],
  ['isfeatured', 'isFeatured'],
  ['datesalepricestarts', 'saleStart'],
  ['datesalepriceends', 'saleEnd'],
  ['instock', 'inStock'],
  ['stock', 'stockQuantity'],
  ['lowstockamount', 'lowStockThreshold'],
  ['backordersallowed', 'backorders'],
  ['weightkg', 'weight'],
  ['lengthcm', 'length'],
  ['widthcm', 'width'],
  ['heightcm', 'height'],
  ['regularprice', 'price'],
  ['images', 'images'],
  ['parent', 'parent'],
  ['position', 'sortOrder'],
  ['brands', 'brand'],
  ['gtinupceanorisbn', 'barcode'],
  ['downloadable', 'downloadable'],
  // Woo "Virtual?" -> sản phẩm ảo
  ['virtual', 'isVirtual'],
  ['downloadlimit', 'downloadLimit'],
  ['downloadexpirydays', 'expiryDays'],
  ['metatitle', 'seoTitle'],
  ['metadescription', 'seoDescription'],
  // tên tiếng Việt thường gặp
  ['tên', 'name'],
  ['tênsảnphẩm', 'name'],
  ['giá', 'price'],
  ['giábán', 'price'],
  ['giákhuyếnmãi', 'salePrice'],
  ['mãsku', 'sku'],
  ['danhmục', 'categories'],
  ['thươnghiệu', 'brand'],
  ['tồnkho', 'stockQuantity'],
  ['môtả', 'description'],
  ['môtảngắn', 'shortDescription'],
  ['trạngthái', 'status'],
  ['ảnh', 'featuredImage'],
  ['ảnhđạidiện', 'featuredImage'],
]);

interface RawRow {
  line: number;
  v: Record<string, string>;
  /** Woo: Attribute N name / value(s) */
  attrs: { name: string; value: string }[];
  /** Woo: Download N name / URL */
  dls: { name: string; url: string }[];
}

interface ParsedVariant {
  line: number;
  id?: string;
  sku: string | null;
  optionValues: Record<string, string>;
  price: number | null;
  salePrice: number | null;
  stockQuantity: number | null;
  stockStatus?: VariantDto['stockStatus'];
  image: string | null;
  weight: number | null;
  isActive: boolean;
}

interface ParsedProduct {
  line: number;
  id?: string;
  /** id gốc trong file (kể cả id số của WooCommerce) để dòng biến thể tham chiếu cha */
  rawId?: string;
  type: 'SIMPLE' | 'VARIABLE' | 'DIGITAL';
  status?: SaveProductDto['status'];
  sku: string | null;
  barcode: string | null;
  name: string;
  slug: string | null;
  shortDescription?: string | null;
  description?: string;
  price: number | null;
  salePrice: number | null;
  saleStart: string | null;
  saleEnd: string | null;
  costPrice: number | null;
  manageStock?: boolean;
  stockQuantity: number | null;
  stockStatus?: SaveProductDto['stockStatus'];
  lowStockThreshold: number | null;
  weight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  brand: string | null;
  categories: string[];
  featuredImage: string | null;
  gallery: string[];
  isFeatured?: boolean;
  sortOrder: number | null;
  publishedAt: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  options: unknown[] | null;
  /** undefined = cột không có trong file -> giữ nguyên khi cập nhật */
  isVirtual?: boolean;
  codeDelivery?: boolean;
  codeWarrantyDays?: number | null;
  /** [{ name, url|mediaId }] */
  downloads: { name: string; src: string; limit: number | null; days: number | null }[] | null;
  variants: ParsedVariant[];
}

export interface ImportOptions {
  mode: 'upsert' | 'insert';
  locale?: string;
  dryRun: boolean;
  createCategories: boolean;
  downloadImages: boolean;
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
  warnings: { row: number; message: string }[];
  /** số ô bị bỏ qua vì không nhận ra tên cột */
  unknownColumns: string[];
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

const bool = (v: string | undefined): boolean | undefined => {
  if (v == null || v.trim() === '') return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'có', 'co', 'x', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'không', 'khong', 'off', '-1'].includes(s)) return false;
  return undefined;
};

/** Số: bỏ khoảng trắng, ký hiệu tiền; dấu phẩy coi là phân cách hàng nghìn */
const num = (v: string | undefined): number | null => {
  if (v == null) return null;
  const s = v.replace(/[\s₫đ$€]/gi, '').replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`"${v}" không phải số`);
  return n;
};

const int = (v: string | undefined): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};

const dateIso = (v: string | undefined): string | null => {
  if (!v || !v.trim()) return null;
  const d = new Date(v.trim());
  if (Number.isNaN(d.getTime())) throw new Error(`"${v}" không phải ngày hợp lệ`);
  return d.toISOString();
};

const splitList = (v: string | undefined, seps = /[|,]/) => (v ?? '').split(seps).map((s) => s.trim()).filter(Boolean);

const isUuid = (s: string | undefined | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

@Injectable()
export class ProductsCsvService {
  private readonly logger = new Logger('ProductsCsv');

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly categories: ProductCategoriesService,
    private readonly media: MediaService,
    private readonly languages: LanguagesService,
    private readonly config: ConfigService,
  ) {}

  // ============================================================
  // Xuất
  // ============================================================

  async export(q: ProductQueryDto) {
    const locale = await this.languages.resolve(q.locale);
    const fallback = await this.languages.defaultLocale();
    const where: Prisma.ProductWhereInput = { deletedAt: null };
    if (q.status) where.status = q.status as Prisma.ProductWhereInput['status'];
    if (q.type) where.type = q.type as Prisma.ProductWhereInput['type'];
    if (q.stockStatus) where.stockStatus = q.stockStatus as Prisma.ProductWhereInput['stockStatus'];
    if (q.brandId) where.brandId = q.brandId;
    if (q.categoryId) where.categories = { some: { categoryId: q.categoryId } };
    if (q.ids) where.id = { in: q.ids.split(',').filter(isUuid) };
    if (q.search) where.OR = [{ sku: { contains: q.search, mode: 'insensitive' } }, { translations: { some: { name: { contains: q.search, mode: 'insensitive' } } } }];
    const rows = await this.prisma.product.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        translations: true,
        brand: { select: { name: true } },
        categories: { include: { category: { include: { translations: { select: { locale: true, slug: true } } } } } },
        variants: { orderBy: { sortOrder: 'asc' } },
        downloads: { orderBy: { sortOrder: 'asc' } },
      },
    });
    const media = await this.media.findMany(rows.flatMap((p) => [p.featuredImageId, ...p.galleryIds, ...p.variants.map((v) => v.imageId), ...p.downloads.map((d) => d.mediaId)]));
    const url = (id: string | null | undefined) => (id ? (media.get(id)?.url ?? '') : '');
    const n = (v: unknown) => (v == null ? '' : Number(v));
    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const pickSlug = (list: { locale: string; slug: string }[]) => (list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0])?.slug ?? '';

    const out: unknown[][] = [[...CSV_COLUMNS]];
    for (const p of rows) {
      const tr = p.translations.find((t) => t.locale === locale) ?? p.translations.find((t) => t.locale === fallback) ?? p.translations[0];
      const options = Array.isArray(p.options) ? (p.options as { key: string; name?: Record<string, string>; values?: { value: string; label?: Record<string, string> }[] }[]) : [];
      const rec: Record<Col, unknown> = {
        id: p.id,
        type: p.type,
        status: p.status,
        sku: p.sku ?? '',
        barcode: p.barcode ?? '',
        name: tr?.name ?? '',
        slug: tr?.slug ?? '',
        shortDescription: tr?.shortDescription ?? '',
        description: tr?.description ?? '',
        price: n(p.price),
        salePrice: n(p.salePrice),
        saleStart: iso(p.saleStart),
        saleEnd: iso(p.saleEnd),
        costPrice: n(p.costPrice),
        manageStock: p.manageStock ? 1 : 0,
        stockQuantity: p.stockQuantity,
        stockStatus: p.stockStatus,
        lowStockThreshold: p.lowStockThreshold ?? '',
        weight: n(p.weight),
        length: n(p.length),
        width: n(p.width),
        height: n(p.height),
        brand: p.brand?.name ?? '',
        categories: p.categories.map((c) => pickSlug(c.category.translations)).filter(Boolean).join('|'),
        featuredImage: url(p.featuredImageId),
        gallery: p.galleryIds.map(url).filter(Boolean).join('|'),
        isFeatured: p.isFeatured ? 1 : 0,
        sortOrder: p.sortOrder,
        publishedAt: iso(p.publishedAt),
        seoTitle: tr?.seoTitle ?? '',
        seoDescription: tr?.seoDescription ?? '',
        options: options.length ? JSON.stringify(options) : '',
        downloads: p.type === 'DIGITAL' ? p.downloads.map((d) => [d.name, d.mediaId ? url(d.mediaId) : (d.url ?? ''), d.downloadLimit ?? '', d.expiryDays ?? ''].join('|')).join(';') : '',
        isVirtual: p.isVirtual ? 1 : 0,
        codeDelivery: p.codeDelivery ? 1 : 0,
        codeWarrantyDays: p.codeWarrantyDays ?? '',
        parentId: '',
        parentSku: '',
        variantOptions: '',
      };
      out.push(CSV_COLUMNS.map((c) => rec[c]));
      if (p.type !== 'VARIABLE') continue;
      for (const v of p.variants) {
        const ov = (v.optionValues ?? {}) as Record<string, string>;
        const label = options
          .filter((o) => ov[o.key] != null)
          .map((o) => o.values?.find((x) => x.value === ov[o.key])?.label?.[locale] ?? ov[o.key])
          .join(' / ');
        const vr: Record<Col, unknown> = {
          ...Object.fromEntries(CSV_COLUMNS.map((c) => [c, ''])),
          id: v.id,
          type: 'VARIANT',
          sku: v.sku ?? '',
          name: label ? `${tr?.name ?? ''} - ${label}` : (tr?.name ?? ''),
          price: n(v.price),
          salePrice: n(v.salePrice),
          stockQuantity: v.stockQuantity,
          stockStatus: v.stockStatus,
          weight: n(v.weight),
          featuredImage: url(v.imageId),
          isFeatured: v.isActive ? 1 : 0,
          sortOrder: v.sortOrder,
          parentId: p.id,
          parentSku: p.sku ?? '',
          variantOptions: Object.entries(ov)
            .map(([k, val]) => `${k}=${val}`)
            .join(';'),
        } as Record<Col, unknown>;
        out.push(CSV_COLUMNS.map((c) => vr[c]));
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `products-${locale}-${stamp}.csv`, content: toCsv(out) };
  }

  /** File mẫu: 1 sản phẩm thường, 1 sản phẩm biến thể (cha + 2 con), 1 sản phẩm số */
  async template() {
    const locale = await this.languages.defaultLocale();
    const blank = () => Object.fromEntries(CSV_COLUMNS.map((c) => [c, ''])) as Record<Col, unknown>;
    const rows: Record<Col, unknown>[] = [
      { ...blank(), type: 'SIMPLE', status: 'DRAFT', sku: 'AO-THUN-01', name: 'Áo thun cotton', slug: 'ao-thun-cotton', shortDescription: 'Mô tả ngắn', description: '<p>Mô tả chi tiết (HTML)</p>', price: 199000, salePrice: 149000, manageStock: 1, stockQuantity: 50, stockStatus: 'IN_STOCK', weight: 0.25, brand: 'Thương hiệu A', categories: 'ao-thun|thoi-trang-nam', featuredImage: 'https://example.com/ao-thun.jpg', gallery: 'https://example.com/ao-thun-2.jpg|https://example.com/ao-thun-3.jpg', isFeatured: 0, sortOrder: 0 },
      { ...blank(), type: 'VARIABLE', status: 'DRAFT', sku: 'GIAY-01', name: 'Giày thể thao', slug: 'giay-the-thao', price: 500000, manageStock: 1, stockStatus: 'IN_STOCK', categories: 'giay', options: JSON.stringify([{ key: 'size', name: { [locale]: 'Size' }, values: [{ value: '40', label: { [locale]: '40' } }, { value: '41', label: { [locale]: '41' } }] }]) },
      { ...blank(), type: 'VARIANT', sku: 'GIAY-01-40', price: 500000, stockQuantity: 10, parentSku: 'GIAY-01', variantOptions: 'size=40', isFeatured: 1 },
      { ...blank(), type: 'VARIANT', sku: 'GIAY-01-41', price: 520000, stockQuantity: 5, parentSku: 'GIAY-01', variantOptions: 'size=41', isFeatured: 1 },
      // sản phẩm bán theo kho mã: tồn kho tự tính theo số mã nhập ở "Kho mã số" (stockQuantity bị bỏ qua)
      { ...blank(), type: 'SIMPLE', status: 'DRAFT', sku: 'NETFLIX-1T', name: 'Tài khoản Netflix 1 tháng', slug: 'tai-khoan-netflix-1-thang', price: 79000, manageStock: 1, stockStatus: 'IN_STOCK', isVirtual: 1, codeDelivery: 1, codeWarrantyDays: 30 },
      { ...blank(), type: 'DIGITAL', status: 'DRAFT', sku: 'EBOOK-01', name: 'Ebook hướng dẫn', slug: 'ebook-huong-dan', price: 99000, stockStatus: 'IN_STOCK', downloads: 'Ebook PDF|https://example.com/ebook.pdf|3|30' },
    ];
    return { filename: 'products-template.csv', content: toCsv([[...CSV_COLUMNS], ...rows.map((r) => CSV_COLUMNS.map((c) => r[c]))]) };
  }

  // ============================================================
  // Nhập
  // ============================================================

  async import(buffer: Buffer, opts: ImportOptions, user: AuthUser): Promise<ImportReport> {
    const locale = await this.languages.resolve(opts.locale);
    const text = buffer.toString('utf8');
    const table = parseCsv(text);
    if (table.length < 2) throw new BadRequestException('File CSV trống hoặc thiếu dòng tiêu đề');
    if (table.length - 1 > MAX_ROWS) throw new BadRequestException(`Tối đa ${MAX_ROWS} dòng mỗi lần nhập`);
    const report: ImportReport = { dryRun: opts.dryRun, total: 0, created: 0, updated: 0, skipped: 0, errors: [], warnings: [], unknownColumns: [] };

    // ---- ánh xạ cột ----
    const header = table[0].map((h) => h.trim());
    const colKeys: (string | null)[] = [];
    const attrCols: Record<number, { name?: number; value?: number }> = {};
    const dlCols: Record<number, { name?: number; url?: number }> = {};
    header.forEach((h, i) => {
      const key = norm(h);
      let m = /^attribute(\d+)(name|values?)$/.exec(key);
      if (m) {
        (attrCols[Number(m[1])] ??= {})[m[2] === 'name' ? 'name' : 'value'] = i;
        colKeys.push(null);
        return;
      }
      m = /^download(\d+)(name|url)$/.exec(key);
      if (m) {
        (dlCols[Number(m[1])] ??= {})[m[2] as 'name' | 'url'] = i;
        colKeys.push(null);
        return;
      }
      const mapped = HEADER_MAP[key] ?? null;
      if (!mapped && h) report.unknownColumns.push(h);
      colKeys.push(mapped);
    });
    if (!colKeys.includes('name') && !colKeys.includes('id') && !colKeys.includes('sku')) throw new BadRequestException('Không tìm thấy cột name / id / sku trong file');

    const raws: RawRow[] = table.slice(1).map((cells, idx) => {
      const v: Record<string, string> = {};
      colKeys.forEach((k, i) => {
        if (k && cells[i] != null && cells[i] !== '') v[k] = cells[i];
      });
      const attrs = Object.values(attrCols)
        .map((c) => ({ name: c.name != null ? (cells[c.name] ?? '').trim() : '', value: c.value != null ? (cells[c.value] ?? '').trim() : '' }))
        .filter((a) => a.name);
      const dls = Object.values(dlCols)
        .map((c) => ({ name: c.name != null ? (cells[c.name] ?? '').trim() : '', url: c.url != null ? (cells[c.url] ?? '').trim() : '' }))
        .filter((d) => d.url);
      return { line: idx + 2, v, attrs, dls };
    });

    // ---- gom dòng cha / biến thể ----
    const products: ParsedProduct[] = [];
    const byId = new Map<string, ParsedProduct>();
    const bySku = new Map<string, ParsedProduct>();
    let last: ParsedProduct | null = null;
    for (const r of raws) {
      try {
        if (this.isVariantRow(r)) {
          const parentRef = r.v.parentId ?? r.v.parentSku ?? r.v.parent ?? '';
          const ref = parentRef.replace(/^id:/i, '').trim();
          const parent = (ref && (byId.get(ref) ?? bySku.get(ref))) || (!ref ? last : null);
          if (!parent) throw new Error(`Không tìm thấy sản phẩm cha "${parentRef}" ở các dòng phía trên`);
          parent.variants.push(this.parseVariant(r, parent));
          continue;
        }
        const p = this.parseProduct(r, locale);
        products.push(p);
        if (p.rawId) byId.set(p.rawId, p);
        if (p.sku) bySku.set(p.sku, p);
        last = p;
      } catch (err) {
        report.errors.push({ row: r.line, message: (err as Error).message });
      }
    }
    report.total = products.length;

    // ---- kiểm tra trùng trong file ----
    const seenSku = new Map<string, number>();
    for (const p of products) {
      if (p.sku) {
        if (seenSku.has(p.sku)) report.errors.push({ row: p.line, message: `SKU "${p.sku}" trùng với dòng ${seenSku.get(p.sku)}` });
        else seenSku.set(p.sku, p.line);
      }
      for (const v of p.variants) {
        if (!v.sku) continue;
        if (seenSku.has(v.sku)) report.errors.push({ row: v.line, message: `SKU "${v.sku}" trùng với dòng ${seenSku.get(v.sku)}` });
        else seenSku.set(v.sku, v.line);
      }
    }
    const badRows = new Set(report.errors.map((e) => e.row));

    // ---- cache tra cứu ----
    const canPublish = hasPermission(user.permissions, 'products.publish');
    const imageCache = new Map<string, string | null>();
    const brandCache = new Map<string, string | null>();
    const catCache = new Map<string, string | null>();

    for (const p of products) {
      if (badRows.has(p.line) || p.variants.some((v) => badRows.has(v.line))) {
        report.skipped++;
        continue;
      }
      try {
        const existing = await this.findExisting(p, locale);
        if (existing && opts.mode === 'insert') {
          report.skipped++;
          report.warnings.push({ row: p.line, message: `Đã tồn tại (${existing.sku ?? existing.id}) — bỏ qua vì chế độ "chỉ thêm mới"` });
          continue;
        }
        if (p.status === 'PUBLISHED' && !canPublish) throw new Error('Cần quyền xuất bản để đặt trạng thái PUBLISHED');
        if (!existing && !p.name) throw new Error('Thiếu tên sản phẩm');
        if (!existing && p.price == null && p.type !== 'VARIABLE') throw new Error('Thiếu giá bán');
        if (p.salePrice != null && p.price != null && p.salePrice >= p.price) throw new Error('Giá khuyến mãi phải nhỏ hơn giá gốc');
        // SKU thuộc sản phẩm khác
        if (p.sku) {
          const other = await this.prisma.product.findUnique({ where: { sku: p.sku }, select: { id: true } });
          if (other && other.id !== existing?.id) throw new Error(`SKU "${p.sku}" đã thuộc sản phẩm khác`);
          const otherVar = await this.prisma.productVariant.findUnique({ where: { sku: p.sku }, select: { productId: true } });
          if (otherVar && otherVar.productId !== existing?.id) throw new Error(`SKU "${p.sku}" đã dùng cho một biến thể khác`);
        }

        const dto: SaveProductDto = {
          type: p.type,
          status: p.status,
          sku: p.sku,
          barcode: p.barcode,
          price: p.price ?? (existing ? undefined : 0),
          salePrice: p.salePrice,
          saleStart: p.saleStart,
          saleEnd: p.saleEnd,
          costPrice: p.costPrice,
          manageStock: p.manageStock,
          stockQuantity: p.stockQuantity ?? undefined,
          stockStatus: p.stockStatus,
          lowStockThreshold: p.lowStockThreshold,
          weight: p.weight,
          length: p.length,
          width: p.width,
          height: p.height,
          isFeatured: p.isFeatured,
          sortOrder: p.sortOrder ?? undefined,
          publishedAt: p.publishedAt,
          isVirtual: p.isVirtual,
          codeDelivery: p.codeDelivery,
          codeWarrantyDays: p.codeWarrantyDays,
          translations: [],
        };
        // undefined -> giữ nguyên khi cập nhật (Prisma bỏ qua undefined); tạo mới -> mặc định
        for (const k of Object.keys(dto) as (keyof SaveProductDto)[]) if (dto[k] === null && !existing) delete dto[k];

        // bản dịch: cập nhật mà không có slug -> giữ slug cũ (tránh prepareTranslations sinh lại từ tên)
        const oldTr = existing?.translations.find((t) => t.locale === locale);
        if (p.name || !oldTr) {
          dto.translations = [
            {
              locale,
              name: p.name || oldTr?.name || '',
              slug: p.slug ?? oldTr?.slug ?? undefined,
              ...(p.shortDescription !== undefined ? { shortDescription: p.shortDescription } : {}),
              ...(p.description !== undefined ? { description: p.description } : {}),
              ...(p.seoTitle !== undefined ? { seoTitle: p.seoTitle } : {}),
              ...(p.seoDescription !== undefined ? { seoDescription: p.seoDescription } : {}),
            },
          ];
        } else {
          dto.translations = [{ locale, name: oldTr.name, slug: p.slug ?? oldTr.slug, ...(p.shortDescription !== undefined ? { shortDescription: p.shortDescription } : {}), ...(p.description !== undefined ? { description: p.description } : {}), ...(p.seoTitle !== undefined ? { seoTitle: p.seoTitle } : {}), ...(p.seoDescription !== undefined ? { seoDescription: p.seoDescription } : {}) }];
        }

        // thương hiệu / danh mục
        if (p.brand !== null) dto.brandId = p.brand ? await this.resolveBrand(p.brand, opts, brandCache) : null;
        if (p.categories.length) {
          const ids: string[] = [];
          for (const c of p.categories) {
            const id = await this.resolveCategory(c, locale, opts, catCache);
            if (id) ids.push(id);
            else report.warnings.push({ row: p.line, message: `Không tìm thấy danh mục "${c}"${opts.createCategories ? '' : ' (bật "tạo danh mục" để tự tạo)'}` });
          }
          dto.categoryIds = ids;
        }

        // ảnh
        if (p.featuredImage !== null) {
          const id = p.featuredImage ? await this.resolveImage(p.featuredImage, opts, user, imageCache) : null;
          if (p.featuredImage && !id) report.warnings.push({ row: p.line, message: `Không lấy được ảnh "${p.featuredImage}"${opts.downloadImages ? '' : ' (URL ngoài — bật "tải ảnh về")'}` });
          else dto.featuredImageId = id;
        }
        if (p.gallery.length) {
          const ids: string[] = [];
          for (const g of p.gallery) {
            const id = await this.resolveImage(g, opts, user, imageCache);
            if (id) ids.push(id);
            else report.warnings.push({ row: p.line, message: `Không lấy được ảnh "${g}"` });
          }
          dto.galleryIds = ids;
        }

        // biến thể + thuộc tính
        if (p.type === 'VARIABLE' && p.variants.length) {
          const existingVariants = existing ? await this.prisma.productVariant.findMany({ where: { productId: existing.id } }) : [];
          dto.variants = [];
          for (const v of p.variants) {
            if (v.price == null && p.price == null) throw new Error(`Dòng ${v.line}: biến thể thiếu giá`);
            if (v.sku) {
              const other = await this.prisma.productVariant.findUnique({ where: { sku: v.sku }, select: { productId: true } });
              if (other && other.productId !== existing?.id) throw new Error(`Dòng ${v.line}: SKU "${v.sku}" đã thuộc sản phẩm khác`);
              const otherP = await this.prisma.product.findUnique({ where: { sku: v.sku }, select: { id: true } });
              if (otherP && otherP.id !== existing?.id) throw new Error(`Dòng ${v.line}: SKU "${v.sku}" đã là SKU của một sản phẩm`);
            }
            const match =
              (v.id && existingVariants.find((e) => e.id === v.id)) ||
              (v.sku && existingVariants.find((e) => e.sku === v.sku)) ||
              existingVariants.find((e) => this.sameCombo(e.optionValues as Record<string, string>, v.optionValues));
            const imageId = v.image ? await this.resolveImage(v.image, opts, user, imageCache) : v.image === '' ? null : undefined;
            dto.variants.push({
              id: match?.id,
              sku: v.sku,
              optionValues: v.optionValues,
              price: v.price ?? p.price ?? 0,
              salePrice: v.salePrice,
              stockQuantity: v.stockQuantity ?? match?.stockQuantity ?? 0,
              stockStatus: v.stockStatus,
              imageId: imageId === undefined ? match?.imageId : imageId,
              weight: v.weight,
              isActive: v.isActive,
            });
          }
          dto.options = p.options ?? this.deriveOptions(p.variants, (existing?.options as unknown[] | null) ?? null, locale);
        } else if (p.options) dto.options = p.options;

        // file tải về (sản phẩm số)
        if (p.type === 'DIGITAL' && p.downloads) {
          const list: ProductDownloadDto[] = [];
          for (const d of p.downloads) {
            const mediaId = /^https?:\/\//i.test(d.src) && !this.isLocalUrl(d.src) ? null : await this.resolveMediaAny(d.src);
            if (!mediaId && !/^https?:\/\//i.test(d.src)) {
              report.warnings.push({ row: p.line, message: `Không tìm thấy file "${d.src}" trong thư viện` });
              continue;
            }
            list.push({ name: d.name, mediaId, url: mediaId ? null : d.src, downloadLimit: d.limit, expiryDays: d.days });
          }
          dto.downloads = list;
        }

        if (!opts.dryRun) await this.products.save(existing?.id, dto, user);
        if (existing) report.updated++;
        else report.created++;
      } catch (err) {
        const msg = err instanceof ForbiddenException || err instanceof BadRequestException ? (err.getResponse() as { message?: string | string[] }).message : (err as Error).message;
        report.errors.push({ row: p.line, message: Array.isArray(msg) ? msg.join(', ') : String(msg ?? err) });
        report.skipped++;
      }
    }
    if (!opts.dryRun) this.logger.log(`Nhập CSV bởi ${user.email}: tạo ${report.created}, cập nhật ${report.updated}, bỏ qua ${report.skipped}, lỗi ${report.errors.length}`);
    return report;
  }

  // ---------------- parse từng dòng ----------------

  private isVariantRow(r: RawRow) {
    const t = (r.v.type ?? '').toLowerCase();
    if (/variant|variation/.test(t)) return true;
    return !t && !!(r.v.parentId || r.v.parentSku || r.v.parent);
  }

  private parseType(r: RawRow): ParsedProduct['type'] | undefined {
    const t = (r.v.type ?? '').trim().toUpperCase();
    if (!t) return bool(r.v.downloadable) ? 'DIGITAL' : undefined;
    if (['SIMPLE', 'VARIABLE', 'DIGITAL'].includes(t)) return t as ParsedProduct['type'];
    if (t.includes('VARIABLE')) return 'VARIABLE';
    if (t.includes('DOWNLOADABLE') || bool(r.v.downloadable)) return 'DIGITAL';
    if (t.includes('SIMPLE') || t.includes('VIRTUAL')) return 'SIMPLE';
    throw new Error(`Loại sản phẩm "${r.v.type}" không hợp lệ (SIMPLE / VARIABLE / DIGITAL)`);
  }

  private parseStatus(r: RawRow): SaveProductDto['status'] | undefined {
    const s = (r.v.status ?? '').trim().toUpperCase();
    if (s) {
      if (['DRAFT', 'PUBLISHED', 'SCHEDULED', 'ARCHIVED'].includes(s)) return s as SaveProductDto['status'];
      if (s === 'PUBLISH' || s === '1') return 'PUBLISHED';
      if (s === 'PRIVATE' || s === 'PENDING' || s === '0' || s === '-1') return 'DRAFT';
      throw new Error(`Trạng thái "${r.v.status}" không hợp lệ (DRAFT / PUBLISHED / ARCHIVED)`);
    }
    const pub = r.v.published;
    if (pub != null) return pub.trim() === '1' ? 'PUBLISHED' : 'DRAFT';
    return undefined;
  }

  private parseStockStatus(v: string | undefined, inStock?: string, backorders?: string): SaveProductDto['stockStatus'] | undefined {
    const s = (v ?? '').trim().toUpperCase().replace(/\s+/g, '_');
    if (s) {
      if (['IN_STOCK', 'OUT_OF_STOCK', 'BACKORDER'].includes(s)) return s as SaveProductDto['stockStatus'];
      if (s === 'INSTOCK' || s === 'CÒN_HÀNG') return 'IN_STOCK';
      if (s === 'OUTOFSTOCK' || s === 'HẾT_HÀNG') return 'OUT_OF_STOCK';
      if (s === 'ONBACKORDER') return 'BACKORDER';
      throw new Error(`Trạng thái kho "${v}" không hợp lệ`);
    }
    if (bool(backorders) === true || (backorders ?? '').toLowerCase() === 'notify') return 'BACKORDER';
    const b = bool(inStock);
    return b === undefined ? undefined : b ? 'IN_STOCK' : 'OUT_OF_STOCK';
  }

  private parseProduct(r: RawRow, locale: string): ParsedProduct {
    const v = r.v;
    const type = this.parseType(r) ?? (r.attrs.length ? 'VARIABLE' : 'SIMPLE');
    const id = v.id?.trim();
    if (id && !isUuid(id) && !/^\d+$/.test(id)) throw new Error(`id "${id}" không hợp lệ`);
    // ảnh: cột riêng hoặc Woo "Images" (ảnh đầu = đại diện)
    let featuredImage: string | null = v.featuredImage != null ? v.featuredImage.trim() : null;
    let gallery = splitList(v.gallery, /\|/);
    if (featuredImage === null && v.images) {
      const imgs = splitList(v.images, /[|,]/);
      featuredImage = imgs[0] ?? '';
      gallery = imgs.slice(1);
    }
    const stockQuantity = int(v.stockQuantity);
    let manageStock = bool(v.manageStock);
    if (manageStock === undefined && v.stockQuantity != null && v.manageStock === undefined && v.inStock != null) manageStock = stockQuantity != null;

    let options: unknown[] | null = null;
    if (v.options?.trim()) {
      try {
        const parsed = JSON.parse(v.options);
        if (!Array.isArray(parsed)) throw new Error();
        options = parsed;
      } catch {
        throw new Error('Cột options phải là JSON mảng thuộc tính');
      }
    } else if (r.attrs.length && type === 'VARIABLE') {
      // Woo: Attribute N name + value(s) "Đỏ, Xanh"
      options = r.attrs.map((a) => ({
        key: slugify(a.name).replace(/-/g, '_') || 'attr',
        name: { [locale]: a.name },
        values: splitList(a.value, /[|,]/).map((val) => ({ value: slugify(val) || val, label: { [locale]: val } })),
      }));
    }

    let downloads: ParsedProduct['downloads'] = null;
    if (v.downloads != null) {
      downloads = splitList(v.downloads, /;/).map((item) => {
        const [name, src, limit, days] = item.split('|').map((s) => s.trim());
        if (!src) throw new Error(`File tải về "${item}" thiếu URL (định dạng: tên|url|giới hạn|số ngày)`);
        return { name: name || src.split('/').pop() || 'File', src, limit: int(limit), days: int(days) };
      });
    } else if (r.dls.length) {
      downloads = r.dls.map((d) => ({ name: d.name || d.url.split('/').pop() || 'File', src: d.url, limit: int(v.downloadLimit), days: int(v.expiryDays) }));
    }

    return {
      line: r.line,
      id: isUuid(id) ? id : undefined,
      rawId: id || undefined,
      type,
      status: this.parseStatus(r),
      sku: v.sku != null ? v.sku.trim() || null : null,
      barcode: v.barcode != null ? v.barcode.trim() || null : null,
      name: (v.name ?? '').trim(),
      slug: v.slug != null ? v.slug.trim() || null : null,
      shortDescription: v.shortDescription != null ? v.shortDescription : undefined,
      description: v.description != null ? v.description : undefined,
      price: num(v.price),
      salePrice: num(v.salePrice),
      saleStart: dateIso(v.saleStart),
      saleEnd: dateIso(v.saleEnd),
      costPrice: num(v.costPrice),
      manageStock,
      stockQuantity,
      stockStatus: this.parseStockStatus(v.stockStatus, v.inStock, v.backorders),
      lowStockThreshold: int(v.lowStockThreshold),
      weight: num(v.weight),
      length: num(v.length),
      width: num(v.width),
      height: num(v.height),
      brand: v.brand != null ? v.brand.trim() : null,
      categories: splitList(v.categories, /[|,]/),
      featuredImage,
      gallery,
      isFeatured: bool(v.isFeatured),
      sortOrder: int(v.sortOrder),
      publishedAt: dateIso(v.publishedAt),
      seoTitle: v.seoTitle,
      seoDescription: v.seoDescription,
      options,
      isVirtual: bool(v.isVirtual),
      codeDelivery: bool(v.codeDelivery),
      // cột có nhưng để trống = bỏ bảo hành (null); không có cột = giữ nguyên
      codeWarrantyDays: v.codeWarrantyDays != null ? int(v.codeWarrantyDays) : undefined,
      downloads,
      variants: [],
    };
  }

  private parseVariant(r: RawRow, parent: ParsedProduct): ParsedVariant {
    const v = r.v;
    const optionValues: Record<string, string> = {};
    for (const pair of splitList(v.variantOptions, /;/)) {
      const [k, ...rest] = pair.split('=');
      if (k && rest.length) optionValues[k.trim()] = rest.join('=').trim();
    }
    // Woo: Attribute N name/value trên dòng biến thể = 1 giá trị
    for (const a of r.attrs) if (a.value) optionValues[slugify(a.name).replace(/-/g, '_') || 'attr'] = slugify(a.value) || a.value;
    if (!Object.keys(optionValues).length) throw new Error('Biến thể thiếu variantOptions (vd: color=red;size=M)');
    const id = v.id?.trim();
    const active = bool(v.isFeatured);
    const published = v.published != null ? v.published.trim() === '1' : undefined;
    const image = v.featuredImage != null ? v.featuredImage.trim() : v.images != null ? (splitList(v.images, /[|,]/)[0] ?? '') : null;
    void parent;
    return {
      line: r.line,
      id: isUuid(id) ? id : undefined,
      sku: v.sku != null ? v.sku.trim() || null : null,
      optionValues,
      price: num(v.price),
      salePrice: num(v.salePrice),
      stockQuantity: int(v.stockQuantity),
      stockStatus: this.parseStockStatus(v.stockStatus, v.inStock, v.backorders),
      image,
      weight: num(v.weight),
      isActive: active ?? published ?? true,
    };
  }

  private sameCombo(a: Record<string, string>, b: Record<string, string>) {
    const ka = Object.keys(a ?? {});
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
  }

  /** Không có cột options -> suy ra thuộc tính từ các biến thể (gộp với options cũ nếu có) */
  private deriveOptions(variants: ParsedVariant[], existing: unknown[] | null, locale: string) {
    type Opt = { key: string; name: Record<string, string>; values: { value: string; label: Record<string, string> }[] };
    const opts: Opt[] = Array.isArray(existing) ? (existing as Opt[]).map((o) => ({ ...o, values: [...(o.values ?? [])] })) : [];
    for (const v of variants) {
      for (const [k, val] of Object.entries(v.optionValues)) {
        let o = opts.find((x) => x.key === k);
        if (!o) {
          o = { key: k, name: { [locale]: k }, values: [] };
          opts.push(o);
        }
        if (!o.values.some((x) => x.value === val)) o.values.push({ value: val, label: { [locale]: val } });
      }
    }
    return opts;
  }

  // ---------------- tra cứu ----------------

  private async findExisting(p: ParsedProduct, locale: string) {
    const include = { translations: { select: { locale: true, name: true, slug: true } } } as const;
    if (p.id) {
      const byId = await this.prisma.product.findUnique({ where: { id: p.id }, include });
      if (byId) return byId;
    }
    if (p.sku) {
      const bySku = await this.prisma.product.findUnique({ where: { sku: p.sku }, include });
      if (bySku) return bySku;
    }
    if (p.slug) {
      const tr = await this.prisma.productTranslation.findFirst({ where: { slug: p.slug, locale }, select: { productId: true } });
      if (tr) return this.prisma.product.findUnique({ where: { id: tr.productId }, include });
    }
    return null;
  }

  private async resolveBrand(name: string, opts: ImportOptions, cache: Map<string, string | null>) {
    const key = name.toLowerCase();
    if (cache.has(key)) return cache.get(key)!;
    const found = await this.prisma.brand.findFirst({ where: { OR: [{ name: { equals: name, mode: 'insensitive' } }, { slug: slugify(name) }] }, select: { id: true } });
    let id = found?.id ?? null;
    if (!id && opts.createCategories && !opts.dryRun) {
      const b = await this.products.saveBrand(undefined, { name, slug: slugify(name) });
      id = b.id;
    }
    if (!id && opts.createCategories && opts.dryRun) id = 'dry-run';
    cache.set(key, id);
    return id;
  }

  /** Danh mục theo slug hoặc tên (mọi ngôn ngữ); Woo "Cha > Con" -> tạo theo cây khi cho phép */
  private async resolveCategory(token: string, locale: string, opts: ImportOptions, cache: Map<string, string | null>): Promise<string | null> {
    const chain = token
      .split('>')
      .map((s) => s.trim())
      .filter(Boolean);
    let parentId: string | null = null;
    let id: string | null = null;
    for (const part of chain) {
      const key: string = `${parentId ?? ''}>${part.toLowerCase()}`;
      if (cache.has(key)) {
        id = cache.get(key)!;
      } else if (parentId === 'dry-run') {
        id = 'dry-run';
      } else {
        const where: Prisma.ProductCategoryWhereInput = {
          translations: { some: { OR: [{ slug: part }, { slug: slugify(part) }, { name: { equals: part, mode: 'insensitive' } }] } },
          ...(chain.length > 1 ? { parentId } : {}),
        };
        const found = await this.prisma.productCategory.findFirst({ where, select: { id: true } });
        id = found?.id ?? null;
        if (!id && opts.createCategories) {
          if (opts.dryRun) id = 'dry-run';
          else {
            const cat = await this.categories.save(undefined, { parentId, translations: [{ locale, name: part, slug: slugify(part) }] });
            id = cat.id;
          }
        }
        cache.set(key, id);
      }
      if (!id) return null;
      parentId = id;
    }
    return id;
  }

  private isLocalUrl(url: string) {
    const base = this.config.get<string>('apiPublicUrl') ?? '';
    return (base && url.startsWith(`${base}/uploads/`)) || /\/uploads\/\d{4}\/\d{2}\//.test(url);
  }

  /** Media theo id / đường dẫn trong /uploads (kể cả URL biến thể -thumb/-medium) */
  private async resolveMediaAny(ref: string): Promise<string | null> {
    if (isUuid(ref)) return (await this.prisma.media.findUnique({ where: { id: ref }, select: { id: true } }))?.id ?? null;
    const m = /\/uploads\/(.+?)(?:[?#].*)?$/.exec(ref);
    if (!m) return null;
    const path = decodeURIComponent(m[1]);
    const exact = await this.prisma.media.findFirst({ where: { path }, select: { id: true } });
    if (exact) return exact.id;
    // URL biến thể: 2026/10/abc-thumb.webp -> tìm file gốc 2026/10/abc.*
    const stripped = path.replace(/-(thumb|medium|large|webp)\.[a-z0-9]+$/i, '');
    if (stripped === path) return null;
    return (await this.prisma.media.findFirst({ where: { path: { startsWith: `${stripped}.` } }, select: { id: true } }))?.id ?? null;
  }

  private async resolveImage(ref: string, opts: ImportOptions, user: AuthUser, cache: Map<string, string | null>): Promise<string | null> {
    if (cache.has(ref)) return cache.get(ref)!;
    let id = await this.resolveMediaAny(ref);
    if (!id && /^https?:\/\//i.test(ref) && !this.isLocalUrl(ref) && opts.downloadImages) {
      id = opts.dryRun ? 'dry-run' : await this.downloadImage(ref, user).catch((err) => {
        this.logger.warn(`Không tải được ảnh ${ref}: ${(err as Error).message}`);
        return null;
      });
    }
    cache.set(ref, id);
    return id;
  }

  /**
   * Tải ảnh ngoài về thư viện media (tối đa 5MB, chỉ nhận image/*).
   * Dùng safeFetch: chặn URL trỏ vào IP nội bộ / metadata cloud (SSRF), kiểm lại từng bước redirect.
   */
  private async downloadImage(url: string, user: AuthUser): Promise<string | null> {
    const res = await safeFetch(url, { timeoutMs: 20_000, maxBytes: MAX_IMAGE_BYTES, maxRedirects: 3, headers: { accept: 'image/*' } }).catch((err: unknown) => {
      // đổi thông báo quá dung lượng về câu quen thuộc của màn nhập CSV
      if (err instanceof SafeFetchError && err.code === 'TOO_LARGE') throw new Error('ảnh lớn hơn 5MB');
      throw err;
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mimetype = res.mime;
    if (!mimetype.startsWith('image/')) throw new Error(`không phải ảnh (${mimetype || 'không rõ kiểu'})`);
    const buffer = res.body;
    const originalname = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image') || 'image';
    const file = { buffer, mimetype, originalname: Buffer.from(originalname, 'utf8').toString('latin1'), size: buffer.length, fieldname: 'file', encoding: '7bit' } as Express.Multer.File;
    const media = await this.media.upload(file, { uploaderId: user.id });
    return media.id;
  }
}
