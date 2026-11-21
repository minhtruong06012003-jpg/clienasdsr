import { joinPublicPath, type EntryCard, type MediaRef } from '@cmsnt/shared';
import { publishedCondition } from '../../common/utils/publish.util.js';
import { excerptFrom } from '../../common/utils/html.util.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { slugFor } from './content.util.js';

/**
 * Trình bày bài của loại nội dung tuỳ biến cho API công khai (thẻ EntryCard).
 * Hàm thuần — dùng chung cho ContentPublicService và CustomFieldsService (trường kiểu "entries").
 */

/** Điều kiện bài đang hiển thị công khai (kể cả hẹn giờ đã tới giờ) và loại nội dung đang bật */
export const publishedEntryWhere = (): Prisma.EntryWhereInput => ({
  deletedAt: null,
  type: { isActive: true },
  ...publishedCondition(),
});

/** Quan hệ cần nạp để dựng thẻ */
export const ENTRY_CARD_INCLUDE = {
  type: { select: { key: true, slugs: true, isPublic: true } },
  translations: { select: { locale: true, title: true, slug: true, excerpt: true, content: true } },
  terms: {
    include: {
      term: {
        select: {
          id: true,
          sortOrder: true,
          translations: { select: { locale: true, name: true, slug: true } },
          taxonomy: { select: { key: true, slugs: true, isPublic: true } },
        },
      },
    },
  },
} satisfies Prisma.EntryInclude;

export type EntryCardRow = Prisma.EntryGetPayload<{ include: typeof ENTRY_CARD_INCLUDE }>;

const pick = <T extends { locale: string }>(list: T[], locale: string, fallback: string) => list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0];

/** Ngữ cảnh trình bày: locale hiện tại + mặc định */
export interface PresentEnv {
  locale: string;
  defaultLocale: string;
}

/** Đường dẫn công khai của một bài; null nếu loại không public */
export function entryPath(type: { key: string; slugs: unknown; isPublic: boolean }, slug: string, env: PresentEnv): string | null {
  if (!type.isPublic || !slug) return null;
  return joinPublicPath(env.locale, env.defaultLocale, slugFor(type.slugs, env.locale, env.defaultLocale, type.key), slug);
}

/** Đường dẫn công khai của một term; null nếu taxonomy không public */
export function termPath(tax: { key: string; slugs: unknown; isPublic: boolean }, slug: string, env: PresentEnv): string | null {
  if (!tax.isPublic || !slug) return null;
  return joinPublicPath(env.locale, env.defaultLocale, slugFor(tax.slugs, env.locale, env.defaultLocale, tax.key), slug);
}

/** Gom term của bài theo taxonomy key */
export function groupEntryTerms(row: Pick<EntryCardRow, 'terms'>, env: PresentEnv): EntryCard['terms'] {
  const out: EntryCard['terms'] = {};
  const sorted = [...row.terms].sort((a, b) => a.term.sortOrder - b.term.sortOrder);
  for (const { term } of sorted) {
    const tr = pick(term.translations, env.locale, env.defaultLocale);
    if (!tr) continue;
    (out[term.taxonomy.key] ??= []).push({ id: term.id, name: tr.name, slug: tr.slug, path: termPath(term.taxonomy, tr.slug, env) });
  }
  return out;
}

/** Thẻ bài (EntryCard). `customFields` đã trình bày sẵn (service gọi CustomFieldsService.present). */
export function presentEntryCard(row: EntryCardRow, env: PresentEnv, media: Map<string, unknown>, customFields: Record<string, unknown> = {}): EntryCard {
  const tr = pick(row.translations, env.locale, env.defaultLocale);
  const slug = tr?.slug ?? '';
  return {
    id: row.id,
    type: row.type.key,
    title: tr?.title ?? '',
    slug,
    excerpt: tr?.excerpt || excerptFrom(tr?.content, 180) || null,
    featuredImage: (media.get(row.featuredImageId ?? '') as MediaRef | undefined) ?? null,
    publishedAt: (row.publishedAt ?? row.createdAt)?.toISOString() ?? null,
    isFeatured: row.isFeatured,
    path: entryPath(row.type, slug, env),
    terms: groupEntryTerms(row, env),
    customFields,
  };
}

/** Thứ tự sắp xếp theo cấu hình loại nội dung (orderBy) hoặc tham số sort công khai */
export function entryOrderBy(order: string | null | undefined, locale: string): Prisma.EntryOrderByWithRelationInput[] {
  switch (order) {
    case 'publishedAt_asc':
    case 'oldest':
      return [{ publishedAt: 'asc' }, { createdAt: 'asc' }];
    case 'sortOrder_asc':
    case 'order':
      return [{ sortOrder: 'asc' }, { publishedAt: 'desc' }];
    case 'title_asc':
    case 'title':
      // Prisma không sắp xếp theo quan hệ 1-n -> service tự sắp theo tiêu đề sau khi lấy (xem sortByTitle)
      return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
    case 'updated':
      return [{ updatedAt: 'desc' }];
    case 'featured':
      return [{ isFeatured: 'desc' }, { publishedAt: 'desc' }];
    default:
      void locale;
      return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
  }
}

/** Order theo tiêu đề không làm được bằng Prisma -> cần lấy toàn bộ id rồi sắp (dùng khi loại có ít bài) */
export const isTitleOrder = (order: string | null | undefined) => order === 'title_asc' || order === 'title';

/**
 * Id entry (theo `where`) sắp theo tiêu đề của bản dịch `locale`, thiếu bản dịch đó thì lấy tiêu đề ngôn ngữ mặc định —
 * khớp cách thẻ hiển thị (cũng rơi về ngôn ngữ mặc định). Trước đây chỉ lấy bản dịch `locale` nên bài chỉ có bản
 * tiếng Việt biến mất khỏi trang /en dù vẫn được đếm vào total.
 * Sắp trong bộ nhớ (chỉ đọc id + tiêu đề) — đủ nhanh cho vài nghìn bài mỗi loại.
 */
export async function titleOrderedEntryIds(
  prisma: { entry: { findMany(args: unknown): Promise<unknown[]> } },
  where: Prisma.EntryWhereInput,
  locale: string,
  fallback: string,
  skip: number,
  take: number,
): Promise<string[]> {
  const rows = (await prisma.entry.findMany({
    where,
    select: { id: true, translations: { where: { locale: { in: [locale, fallback] } }, select: { locale: true, title: true } } },
  })) as { id: string; translations: { locale: string; title: string }[] }[];
  const titled = rows.map((r) => ({
    id: r.id,
    title: (r.translations.find((t) => t.locale === locale) ?? r.translations.find((t) => t.locale === fallback))?.title ?? '',
  }));
  titled.sort((a, b) => a.title.localeCompare(b.title, locale, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  return titled.slice(skip, skip + take).map((r) => r.id);
}
