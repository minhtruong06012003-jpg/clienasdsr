import { RESERVED_SLUGS, joinPublicPath, slugify, type TypeLabels } from '@cmsnt/shared';

/**
 * Hàm thuần (không đụng DB) cho loại nội dung tuỳ biến: chuẩn hoá slug gốc, kiểm trùng,
 * phân giải đường dẫn công khai và dựng alternates. Tách riêng để viết test đơn vị.
 */

/** Một "chủ sở hữu" slug gốc đã có trong hệ thống (loại nội dung / taxonomy / trang) */
export interface SlugOwner {
  kind: 'content_type' | 'taxonomy' | 'page';
  /** key loại nội dung / taxonomy, hoặc id trang */
  id: string;
  /** slug theo locale */
  slugs: Record<string, string>;
}

/**
 * Slug 2 chữ cái (vd en, fr) — không dùng làm slug gốc vì có thể trùng tiền tố ngôn ngữ (kể cả ngôn ngữ bật sau).
 * Mã dạng "zh-cn" chỉ chặn khi ngôn ngữ đang bật (tránh chặn nhầm slug hợp lệ như "du-an").
 */
const LOCALE_LIKE_RE = /^[a-z]{2}$/;

/**
 * Chuẩn hoá slug theo locale: slugify, bỏ locale không bật, thiếu locale thì lấy slug ngôn ngữ mặc định
 * (hoặc từ `fallbackSource`, vd key / nhãn). Trả về đủ mọi locale đang bật.
 */
export function normalizeSlugs(input: Record<string, unknown> | null | undefined, locales: string[], defaultLocale: string, fallbackSource: string): Record<string, string> {
  const raw = input && typeof input === 'object' ? input : {};
  const out: Record<string, string> = {};
  for (const l of locales) {
    const v = raw[l];
    const s = typeof v === 'string' ? slugify(v, 60) : '';
    if (s) out[l] = s;
  }
  const base = out[defaultLocale] || Object.values(out)[0] || slugify(fallbackSource.replace(/_/g, '-'), 60) || 'noi-dung';
  for (const l of locales) if (!out[l]) out[l] = base;
  return out;
}

/**
 * Kiểm một bộ slug gốc mới có hợp lệ không. Trả về danh sách lỗi (rỗng = hợp lệ).
 * - không thuộc RESERVED_SLUGS, không giống mã ngôn ngữ
 * - không trùng slug của loại nội dung / taxonomy / trang KHÁC trong CÙNG locale
 */
export function slugConflicts(slugs: Record<string, string>, self: { kind: SlugOwner['kind']; id?: string }, owners: SlugOwner[], locales: string[]): string[] {
  const errors: string[] = [];
  const reserved = new Set<string>(RESERVED_SLUGS);
  const kindLabel: Record<SlugOwner['kind'], string> = { content_type: 'loại nội dung', taxonomy: 'phân loại', page: 'trang' };
  for (const [locale, slug] of Object.entries(slugs)) {
    if (!slug) continue;
    if (reserved.has(slug)) {
      errors.push(`Đường dẫn "${slug}" (${locale}) trùng đường dẫn hệ thống`);
      continue;
    }
    if (LOCALE_LIKE_RE.test(slug) || locales.includes(slug)) {
      errors.push(`Đường dẫn "${slug}" (${locale}) trùng dạng mã ngôn ngữ`);
      continue;
    }
    for (const o of owners) {
      if (o.kind === self.kind && o.id === self.id) continue;
      if (o.slugs[locale] === slug) {
        errors.push(`Đường dẫn "${slug}" (${locale}) đã được ${kindLabel[o.kind]} "${o.id}" sử dụng`);
        break;
      }
    }
  }
  return errors;
}

/** Slug gốc của một loại/taxonomy theo locale (thiếu thì dùng ngôn ngữ mặc định, rồi key) */
export function slugFor(slugs: unknown, locale: string, defaultLocale: string, key: string): string {
  const s = (slugs && typeof slugs === 'object' ? slugs : {}) as Record<string, string>;
  return s[locale] || s[defaultLocale] || Object.values(s).find(Boolean) || key.replace(/_/g, '-');
}

/** Nhãn số nhiều / số ít theo locale */
export function labelFor(labels: unknown, locale: string, defaultLocale: string, key: string): { singular: string; plural: string } {
  const l = (labels && typeof labels === 'object' ? labels : {}) as TypeLabels;
  const v = l[locale] ?? l[defaultLocale] ?? Object.values(l)[0];
  return { singular: v?.singular || v?.plural || key, plural: v?.plural || v?.singular || key };
}

/** Kết quả phân giải đường dẫn (dạng thô, service gắn PublicContentType) */
export type RawResolve =
  | { kind: 'archive'; typeKey: string }
  | { kind: 'entry'; typeKey: string; slug: string }
  | { kind: 'term'; taxonomyKey: string; slug: string }
  | { kind: 'page'; slug: string }
  | { kind: 'none' };

export interface ResolveTypeInfo {
  key: string;
  slugs: Record<string, string>;
  isPublic: boolean;
  hasArchive: boolean;
}
export interface ResolveTaxonomyInfo {
  key: string;
  slugs: Record<string, string>;
  isPublic: boolean;
}

/**
 * Phân giải đường dẫn công khai (đã bỏ tiền tố ngôn ngữ) cho route catch-all của storefront.
 *  - 1 đoạn: slug loại nội dung có lưu trữ -> archive; còn lại -> page
 *  - 2 đoạn: slug loại public -> entry; slug taxonomy public -> term
 *  - khác -> none
 */
export function resolvePublicPath(path: string, locale: string, defaultLocale: string, types: ResolveTypeInfo[], taxonomies: ResolveTaxonomyInfo[]): RawResolve {
  const segs = path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s).toLowerCase();
      } catch {
        return s.toLowerCase();
      }
    });
  if (!segs.length || segs.length > 2) return { kind: 'none' };
  const typeBySlug = (slug: string) => types.find((t) => t.isPublic && slugFor(t.slugs, locale, defaultLocale, t.key) === slug);
  if (segs.length === 1) {
    const type = typeBySlug(segs[0]);
    if (type && type.hasArchive) return { kind: 'archive', typeKey: type.key };
    return { kind: 'page', slug: segs[0] };
  }
  const [first, second] = segs;
  const type = typeBySlug(first);
  if (type) return { kind: 'entry', typeKey: type.key, slug: second };
  const tax = taxonomies.find((t) => t.isPublic && slugFor(t.slugs, locale, defaultLocale, t.key) === first);
  if (tax) return { kind: 'term', taxonomyKey: tax.key, slug: second };
  return { kind: 'none' };
}

/**
 * Dựng alternates {locale: path} cho một bản ghi có bản dịch: chỉ locale đang bật và có slug;
 * `baseSlugs` = slug gốc (loại / taxonomy) theo locale; null = không có URL công khai.
 */
export function buildAlternates(translations: { locale: string; slug: string }[], baseSlugs: Record<string, string> | null, locales: string[], defaultLocale: string, key: string): Record<string, string> {
  if (!baseSlugs) return {};
  const out: Record<string, string> = {};
  for (const t of translations) {
    if (!locales.includes(t.locale) || !t.slug) continue;
    out[t.locale] = joinPublicPath(t.locale, defaultLocale, slugFor(baseSlugs, t.locale, defaultLocale, key), t.slug);
  }
  return out;
}
