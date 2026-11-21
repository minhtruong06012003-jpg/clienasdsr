import { joinPublicPath, type ContentTypeView } from '@cmsnt/shared';
import { HAS_WEB_URL, WEB_URL } from '@/lib/site';

/** URL công khai của một bài thuộc loại nội dung: /{slug loại}/{slug bài} (có tiền tố ngôn ngữ) */
export function entryUrl(type: Pick<ContentTypeView, 'slugs' | 'isPublic'> | null | undefined, slug: string | null | undefined, locale: string, defaultLocale: string): string {
  // chưa cấu hình WEB_URL -> không có URL công khai (ẩn link xem trên web)
  if (!HAS_WEB_URL || !type || !type.isPublic || !slug) return '';
  const base = type.slugs?.[locale] ?? type.slugs?.[defaultLocale];
  if (!base) return '';
  return `${WEB_URL}${joinPublicPath(locale, defaultLocale, base, slug)}`;
}

/** Tiền tố hiển thị trước ô slug: /en/projects/ */
export function entrySlugPrefix(type: Pick<ContentTypeView, 'slugs'> | null | undefined, locale: string, defaultLocale: string): string {
  const base = type?.slugs?.[locale] ?? type?.slugs?.[defaultLocale] ?? '';
  return `${locale !== defaultLocale ? `/${locale}` : ''}/${base ? `${base}/` : ''}`;
}

/** URL công khai trang lưu trữ một term: /{slug taxonomy}/{slug term} */
export function termUrl(taxSlugs: Record<string, string> | null | undefined, isPublic: boolean | undefined, slug: string | null | undefined, locale: string, defaultLocale: string): string {
  if (!HAS_WEB_URL || !isPublic || !slug) return '';
  const base = taxSlugs?.[locale] ?? taxSlugs?.[defaultLocale];
  return base ? `${WEB_URL}${joinPublicPath(locale, defaultLocale, base, slug)}` : '';
}

/** Hiển thị giá trị trường tuỳ chỉnh trong ô bảng (chuỗi ngắn) */
export function formatFieldValue(v: unknown, locale: string): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? '✓' : '—';
  if (typeof v === 'number') return v.toLocaleString('vi-VN');
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (Array.isArray(v)) return v.length ? `${v.length} mục` : '—';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // giá trị đa ngôn ngữ { vi, en } / liên kết { label, url }
    if (typeof o[locale] === 'string') return formatFieldValue(o[locale], locale);
    if ('url' in o) return formatFieldValue(o.label && typeof o.label !== 'object' ? o.label : o.url, locale);
    const first = Object.values(o).find((x) => typeof x === 'string');
    return first ? formatFieldValue(first, locale) : '…';
  }
  return String(v);
}
