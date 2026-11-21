import { publishedCondition } from '../../common/utils/publish.util.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { MediaDto } from '../media/media.service.js';
import { excerptFrom } from '../../common/utils/html.util.js';

export const publishedPostWhere = (): Prisma.PostWhereInput => ({
  deletedAt: null,
  ...publishedCondition(),
});

export const POST_CARD_INCLUDE = {
  translations: { select: { locale: true, title: true, slug: true, excerpt: true, content: true, readingTime: true } },
  author: { select: { id: true, name: true } },
  categories: { include: { category: { include: { translations: { select: { locale: true, name: true, slug: true } } } } } },
} satisfies Prisma.PostInclude;

type PostCardRow = Prisma.PostGetPayload<{ include: typeof POST_CARD_INCLUDE }>;

const pick = <T extends { locale: string }>(list: T[], locale: string, fallback: string) =>
  list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0];

export function presentPostCard(p: PostCardRow, locale: string, fallback: string, media: Map<string, MediaDto>) {
  const tr = pick(p.translations, locale, fallback);
  return {
    id: p.id,
    title: tr?.title ?? '',
    slug: tr?.slug ?? '',
    excerpt: tr?.excerpt || excerptFrom(tr?.content, 180),
    readingTime: tr?.readingTime ?? 1,
    publishedAt: p.publishedAt ?? p.createdAt,
    isFeatured: p.isFeatured,
    author: p.author,
    featuredImage: media.get(p.featuredImageId ?? '') ?? null,
    categories: p.categories.map((c) => {
      const ct = pick(c.category.translations, locale, fallback);
      return { id: c.categoryId, name: ct?.name ?? '', slug: ct?.slug ?? '' };
    }),
  };
}
