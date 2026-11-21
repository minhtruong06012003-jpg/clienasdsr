import { BadRequestException } from '@nestjs/common';
import { slugify } from '@cmsnt/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';

type TranslationDelegate =
  | 'pageTranslation'
  | 'postTranslation'
  | 'postCategoryTranslation'
  | 'postTagTranslation'
  | 'productTranslation'
  | 'productCategoryTranslation';

interface SlugItem {
  locale: string;
  slug?: string | null;
  title?: string;
  name?: string;
}

/**
 * Chuẩn hoá danh sách bản dịch: kiểm tra locale hợp lệ, không trùng locale,
 * tự sinh slug từ title/name và đảm bảo slug duy nhất trong cùng locale.
 */
const RESERVED_PAGE_SLUGS = new Set(['api', 'admin', 'blog', 'products', 'product-category', 'search', 'cart', 'checkout', 'account', 'order-success', 'order-tracking', 'reset-password', 'verify-email', 'sitemap', 'robots', 'rss', 'uploads', 'static']);

export async function prepareTranslations<T extends SlugItem>(
  prisma: PrismaService,
  delegate: TranslationDelegate,
  ownerKey: string,
  ownerId: string | undefined,
  items: T[],
  validLocales: string[],
): Promise<(T & { slug: string })[]> {
  const seen = new Set<string>();
  const out: (T & { slug: string })[] = [];
  for (const item of items) {
    if (!validLocales.includes(item.locale)) throw new BadRequestException(`Ngôn ngữ "${item.locale}" chưa được bật`);
    if (seen.has(item.locale)) throw new BadRequestException(`Trùng bản dịch ngôn ngữ "${item.locale}"`);
    seen.add(item.locale);
    const source = item.slug?.trim() || item.title || item.name || '';
    let base = slugify(source) || 'item';
    // slug trang nằm ngay sau "/" nên không được trùng route hệ thống hoặc mã ngôn ngữ (vd /en, /blog)
    // Chỉ coi slug 2 chữ cái (vd "fr") là mã ngôn ngữ: dạng "xx-yy" trùng slug tiếng Việt thường gặp ("du-an", "ve-chung-toi")
    if (delegate === 'pageTranslation' && (RESERVED_PAGE_SLUGS.has(base) || validLocales.includes(base) || /^[a-z]{2}$/.test(base) || (await usedByContentRoute(prisma, item.locale, base)))) base = `${base}-page`;
    let slug = base;
    let i = 2;
    const model = (prisma as unknown as Record<string, { findFirst(args: unknown): Promise<unknown> }>)[delegate];
    while (
      await model.findFirst({
        where: { locale: item.locale, slug, ...(ownerId ? { NOT: { [ownerKey]: ownerId } } : {}) },
        select: { id: true },
      })
    ) {
      slug = `${base}-${i++}`;
    }
    out.push({ ...item, slug });
  }
  return out;
}

/** Chọn bản dịch theo locale, fallback ngôn ngữ mặc định rồi bản đầu tiên. */
export function pickTranslation<T extends { locale: string }>(translations: T[] | undefined, locale: string, fallback?: string): T | undefined {
  if (!translations?.length) return undefined;
  return translations.find((t) => t.locale === locale) ?? (fallback ? translations.find((t) => t.locale === fallback) : undefined) ?? translations[0];
}

/** Gộp bản dịch vào object gốc để trả về cho storefront. */
export function flatten<T extends { translations?: { locale: string }[] }>(entity: T, locale: string, fallback?: string) {
  const { translations, ...rest } = entity;
  const tr = pickTranslation(translations, locale, fallback);
  const alternates = Object.fromEntries((translations ?? []).map((t) => [t.locale, (t as { slug?: string }).slug ?? '']));
  return { ...rest, ...(tr ?? {}), id: (entity as unknown as { id: string }).id, locale: tr?.locale ?? locale, alternates };
}

/**
 * Slug 1 cấp đã được loại nội dung tuỳ biến / taxonomy dùng làm đường dẫn gốc ở locale này
 * (vd /du-an là trang lưu trữ "Dự án") — trang không được lấy trùng, nếu không sẽ bị che mất.
 */
async function usedByContentRoute(prisma: PrismaService, locale: string, slug: string): Promise<boolean> {
  const [types, taxonomies] = await Promise.all([prisma.contentType.findMany({ select: { slugs: true } }), prisma.taxonomy.findMany({ select: { slugs: true } })]);
  return [...types, ...taxonomies].some((r) => (r.slugs as Record<string, string> | null)?.[locale] === slug);
}
