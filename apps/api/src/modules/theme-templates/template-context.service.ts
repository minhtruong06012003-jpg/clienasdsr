import { Injectable } from '@nestjs/common';
import { buildPath, joinPublicPath, type EntryCard, type MediaRef, type PublicFieldGroup, type PublicTerm, type TemplateListing, type TemplateRecord } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService, type MediaDto } from '../media/media.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { publishedCondition } from '../../common/utils/publish.util.js';
import { titleOrderedEntryIds } from '../content/content.presenter.js';
import { excerptFrom } from '../../common/utils/html.util.js';
import { POST_CARD_INCLUDE, presentPostCard, publishedPostWhere } from '../posts/posts.presenter.js';
import { PRODUCT_CARD_INCLUDE, effectivePrice, presentProductCard, publishedProductWhere } from '../products/products.presenter.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Bản ghi đầy đủ dùng nội bộ khi resolve block: TemplateRecord + dữ liệu phụ không gửi ra ngoài
 * (blocks của entry/trang cho dynamic-content, nhóm trường cho dynamic-field, id term cho điều kiện mẫu).
 */
export type FullTemplateRecord = TemplateRecord & {
  blocks?: unknown[];
  customFieldGroups?: PublicFieldGroup[];
  termIds?: string[];
};

/** Kiểu trang đang dựng ngữ cảnh: chi tiết (single), lưu trữ (archive), tìm kiếm, header/footer... */
export type ContextKind = 'single' | 'archive' | 'search' | 'header' | 'footer' | 'not_found' | string;

export interface BuildContextInput {
  kind?: ContextKind | null;
  target: string;
  id?: string | null;
  slug?: string | null;
  locale?: string | null;
  page?: number | null;
  /** lọc trang lưu trữ theo term: "<taxonomy>:<slug>" hoặc chỉ "<slug>" */
  termSlug?: string | null;
  q?: string | null;
  /** admin (builder): cho phép bản nháp, không id → bản mới nhất */
  admin?: boolean;
}

export interface BuiltContext {
  locale: string;
  fallback: string;
  record: FullTemplateRecord | null;
  listing: TemplateListing | null;
  page: number;
}

type TypeRow = Prisma.ContentTypeGetPayload<object>;
type TaxRow = Prisma.TaxonomyGetPayload<object>;
type Crumb = { label: string; path: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORE_TARGETS = ['page', 'post', 'product', 'post_category', 'post_tag', 'product_category'];
/** Target có trang lưu trữ (danh sách) */
const ARCHIVE_ONLY = ['post_category', 'post_tag', 'product_category'];

/** Nhãn nhỏ theo ngôn ngữ cho breadcrumb / tiêu đề lưu trữ */
const LABELS: Record<string, { home: string; blog: string; shop: string; search: string }> = {
  vi: { home: 'Trang chủ', blog: 'Blog', shop: 'Sản phẩm', search: 'Kết quả tìm kiếm' },
  en: { home: 'Home', blog: 'Blog', shop: 'Products', search: 'Search results' },
};
const labels = (locale: string) => LABELS[locale] ?? LABELS.en;

const pickTr = <T extends { locale: string }>(list: T[], locale: string, fallback: string): T | undefined =>
  list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0];

const asRef = (m: MediaDto | null | undefined): MediaRef | null => (m ?? null) as unknown as MediaRef | null;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const ENTRY_CARD_INCLUDE = {
  type: true,
  translations: { select: { locale: true, title: true, slug: true, excerpt: true, content: true } },
  terms: { include: { term: { include: { translations: { select: { locale: true, name: true, slug: true } }, taxonomy: true } } } },
} satisfies Prisma.EntryInclude;
type EntryCardRow = Prisma.EntryGetPayload<{ include: typeof ENTRY_CARD_INCLUDE }>;

export interface EntryQuery {
  /** key loại nội dung; rỗng = mọi loại đang bật */
  types?: string[];
  termIds?: string[];
  featuredOnly?: boolean;
  search?: string | null;
  orderBy?: string | null;
  page?: number;
  limit?: number;
  excludeIds?: string[];
  /** chỉ loại có searchable = true (trang tìm kiếm) */
  searchableOnly?: boolean;
}

/**
 * Dựng ngữ cảnh cho Theme Builder: bản ghi đang xem (TemplateRecord) và danh sách lưu trữ (TemplateListing),
 * cùng các truy vấn dùng chung cho block động (thẻ entry, term công khai, đường dẫn loại nội dung).
 * Truy vấn prisma trực tiếp để không phụ thuộc module nội dung khác.
 */
@Injectable()
export class TemplateContextService {
  /** cache ngắn danh sách loại nội dung / taxonomy (một request render gọi nhiều lần) */
  private typeCache: { at: number; types: TypeRow[]; taxes: TaxRow[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly customFields: CustomFieldsService,
    private readonly settings: SettingsService,
  ) {}

  async locales(input?: string | null) {
    return { locale: await this.languages.resolve(input), fallback: await this.languages.defaultLocale() };
  }

  // ------------------------------------------------------------------ loại nội dung / taxonomy

  private async meta() {
    if (this.typeCache && Date.now() - this.typeCache.at < 3000) return this.typeCache;
    const [types, taxes] = await Promise.all([
      this.prisma.contentType.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.taxonomy.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    ]);
    this.typeCache = { at: Date.now(), types, taxes };
    return this.typeCache;
  }

  async contentTypes(activeOnly = true) {
    const { types } = await this.meta();
    return activeOnly ? types.filter((t) => t.isActive) : types;
  }

  async taxonomies() {
    return (await this.meta()).taxes;
  }

  async contentType(key: string) {
    return (await this.contentTypes()).find((t) => t.key === key) ?? null;
  }

  async taxonomy(key: string) {
    return (await this.taxonomies()).find((t) => t.key === key) ?? null;
  }

  /** Nhãn số nhiều / số ít của loại nội dung hoặc taxonomy theo locale */
  label(row: { key: string; labels: unknown }, locale: string, fallback: string, form: 'plural' | 'singular' = 'plural'): string {
    const l = (row.labels ?? {}) as Record<string, { singular?: string; plural?: string }>;
    return l[locale]?.[form] || l[fallback]?.[form] || l[locale]?.singular || l[fallback]?.singular || row.key;
  }

  /** Slug gốc theo locale (lùi về ngôn ngữ mặc định rồi key) */
  baseSlug(row: { key: string; slugs: unknown }, locale: string, fallback: string): string {
    const s = (row.slugs ?? {}) as Record<string, string>;
    return s[locale] || s[fallback] || row.key.replace(/_/g, '-');
  }

  entryPath(type: TypeRow, slug: string, locale: string, fallback: string): string | null {
    return type.isPublic && slug ? joinPublicPath(locale, fallback, this.baseSlug(type, locale, fallback), slug) : null;
  }

  archivePath(type: TypeRow, locale: string, fallback: string): string | null {
    return type.isPublic && type.hasArchive ? joinPublicPath(locale, fallback, this.baseSlug(type, locale, fallback)) : null;
  }

  termPath(tax: TaxRow, slug: string, locale: string, fallback: string): string | null {
    return tax.isPublic && slug ? joinPublicPath(locale, fallback, this.baseSlug(tax, locale, fallback), slug) : null;
  }

  private homeCrumb(locale: string, fallback: string): Crumb {
    return { label: labels(locale).home, path: buildPath('home', null, locale, fallback) };
  }

  // ------------------------------------------------------------------ thẻ entry

  private entryWhere(q: EntryQuery, locale: string, fallback: string): Prisma.EntryWhereInput {
    const and: Prisma.EntryWhereInput[] = [publishedCondition()];
    if (q.search?.trim()) {
      and.push({ translations: { some: { locale: { in: [locale, fallback] }, OR: [{ title: { contains: q.search.trim(), mode: 'insensitive' } }, { excerpt: { contains: q.search.trim(), mode: 'insensitive' } }] } } });
    }
    return {
      deletedAt: null,
      AND: and,
      type: { isActive: true, ...(q.types?.length ? { key: { in: q.types } } : {}), ...(q.searchableOnly ? { searchable: true, isPublic: true } : {}) },
      translations: { some: { locale: { in: [locale, fallback] } } },
      ...(q.termIds?.length ? { terms: { some: { termId: { in: q.termIds } } } } : {}),
      ...(q.featuredOnly ? { isFeatured: true } : {}),
      ...(q.excludeIds?.length ? { id: { notIn: q.excludeIds } } : {}),
    };
  }

  /** Thứ tự sắp xếp: nhận cả giá trị của ContentType.orderBy lẫn giá trị block (newest/oldest/title/order) */
  private entryOrder(o: string | null | undefined): Prisma.EntryOrderByWithRelationInput[] | 'title' {
    switch (o) {
      case 'publishedAt_asc':
      case 'oldest':
      case 'date_asc':
        return [{ publishedAt: 'asc' }, { createdAt: 'asc' }];
      case 'title_asc':
      case 'title':
        return 'title';
      case 'sortOrder_asc':
      case 'order':
      case 'menu_order':
        return [{ sortOrder: 'asc' }, { publishedAt: 'desc' }];
      case 'featured':
        return [{ isFeatured: 'desc' }, { publishedAt: 'desc' }];
      case 'updated':
        return [{ updatedAt: 'desc' }];
      default:
        return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
    }
  }

  /** Truy vấn entry đã xuất bản → thẻ EntryCard + phân trang */
  async queryEntries(q: EntryQuery, locale: string, fallback: string): Promise<{ items: EntryCard[]; total: number; page: number; totalPages: number; limit: number }> {
    const limit = Math.min(Math.max(Number(q.limit) || 12, 1), 100);
    const page = Math.max(Number(q.page) || 1, 1);
    const where = this.entryWhere(q, locale, fallback);
    // không chỉ định thứ tự → theo cài đặt của loại nội dung (khi chỉ có 1 loại)
    let orderKey = q.orderBy;
    if ((!orderKey || orderKey === 'default') && q.types?.length === 1) orderKey = (await this.contentType(q.types[0]))?.orderBy;
    const order = this.entryOrder(orderKey);
    const total = await this.prisma.entry.count({ where });
    let rows: EntryCardRow[];
    if (order === 'title') {
      // sắp theo tiêu đề bản dịch hiện tại, thiếu thì tiêu đề ngôn ngữ mặc định (khớp total)
      const ids = await titleOrderedEntryIds(this.prisma, where, locale, fallback, (page - 1) * limit, limit);
      const found = await this.prisma.entry.findMany({ where: { id: { in: ids } }, include: ENTRY_CARD_INCLUDE });
      rows = ids.map((id) => found.find((r) => r.id === id)).filter((r): r is EntryCardRow => !!r);
    } else {
      rows = await this.prisma.entry.findMany({ where, orderBy: order, skip: (page - 1) * limit, take: limit, include: ENTRY_CARD_INCLUDE });
    }
    return { items: await this.entryCards(rows, locale, fallback), total, page, totalPages: Math.max(1, Math.ceil(total / limit)), limit };
  }

  /** Entry theo danh sách id (giữ thứ tự id) */
  async entriesByIds(ids: string[], locale: string, fallback: string): Promise<EntryCard[]> {
    const valid = ids.filter((id) => UUID_RE.test(id));
    if (!valid.length) return [];
    const rows = await this.prisma.entry.findMany({ where: { id: { in: valid }, ...this.entryWhere({}, locale, fallback) }, include: ENTRY_CARD_INCLUDE });
    rows.sort((a, b) => valid.indexOf(a.id) - valid.indexOf(b.id));
    return this.entryCards(rows, locale, fallback);
  }

  async entryCards(rows: EntryCardRow[], locale: string, fallback: string): Promise<EntryCard[]> {
    const mediaMap = await this.media.findMany(rows.map((r) => r.featuredImageId));
    return Promise.all(
      rows.map(async (r) => {
        const tr = pickTr(r.translations, locale, fallback);
        const terms: EntryCard['terms'] = {};
        for (const et of r.terms) {
          const tt = pickTr(et.term.translations, locale, fallback);
          if (!tt) continue;
          (terms[et.term.taxonomy.key] ??= []).push({ id: et.termId, name: tt.name, slug: tt.slug, path: this.termPath(et.term.taxonomy, tt.slug, locale, fallback) });
        }
        const cf = await this.customFields.present('entry', r.customFields, locale, fallback, { contentType: r.type.key });
        return {
          id: r.id,
          type: r.type.key,
          title: tr?.title ?? '',
          slug: tr?.slug ?? '',
          excerpt: tr?.excerpt || excerptFrom(tr?.content, 180) || null,
          featuredImage: asRef(mediaMap.get(r.featuredImageId ?? '')),
          publishedAt: iso(r.publishedAt ?? r.createdAt),
          isFeatured: r.isFeatured,
          path: tr ? this.entryPath(r.type, tr.slug, locale, fallback) : null,
          terms,
          customFields: cf.customFields,
        };
      }),
    );
  }

  // ------------------------------------------------------------------ term công khai

  /** Term của một taxonomy (dạng PublicTerm, kèm số bài đã xuất bản) */
  async publicTerms(taxKey: string, opts: { locale: string; fallback: string; parentOnly?: boolean; ids?: string[]; limit?: number; hideEmpty?: boolean }): Promise<PublicTerm[]> {
    const tax = await this.taxonomy(taxKey);
    if (!tax) return [];
    const { locale, fallback } = opts;
    const ids = (opts.ids ?? []).filter((x) => UUID_RE.test(x));
    const rows = await this.prisma.term.findMany({
      where: { taxonomyId: tax.id, ...(opts.parentOnly ? { parentId: null } : {}), ...(ids.length ? { id: { in: ids } } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: opts.limit ? Math.min(opts.limit, 200) : undefined,
      include: { translations: true, _count: { select: { entries: { where: { entry: { deletedAt: null, ...publishedCondition(), type: { isActive: true } } } } } } },
    });
    const mediaMap = await this.media.findMany(rows.map((r) => r.imageId));
    const out = rows
      .map((r): PublicTerm | null => {
        const tr = pickTr(r.translations, locale, fallback);
        if (!tr) return null;
        return {
          id: r.id,
          taxonomy: tax.key,
          parentId: r.parentId,
          name: tr.name,
          slug: tr.slug,
          description: tr.description,
          image: asRef(mediaMap.get(r.imageId ?? '')),
          path: this.termPath(tax, tr.slug, locale, fallback),
          count: r._count.entries,
        };
      })
      .filter((x): x is PublicTerm => !!x && (!opts.hideEmpty || !!x.count));
    if (ids.length) out.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return out;
  }

  // ------------------------------------------------------------------ bài viết / sản phẩm

  private postPath = (slug: string, locale: string, fallback: string) => buildPath('post', slug, locale, fallback);
  private productPath = (slug: string, locale: string, fallback: string) => buildPath('product', slug, locale, fallback);

  async queryPosts(q: { categoryIds?: string[]; tagIds?: string[]; featuredOnly?: boolean; search?: string | null; page?: number; limit?: number; excludeIds?: string[]; orderBy?: string | null }, locale: string, fallback: string) {
    const limit = Math.min(Math.max(Number(q.limit) || 12, 1), 100);
    const page = Math.max(Number(q.page) || 1, 1);
    const where: Prisma.PostWhereInput = { ...publishedPostWhere(), translations: { some: { locale: { in: [locale, fallback] } } } };
    const and: Prisma.PostWhereInput[] = [];
    if (q.categoryIds?.length) and.push({ categories: { some: { categoryId: { in: q.categoryIds } } } });
    if (q.tagIds?.length) and.push({ tags: { some: { tagId: { in: q.tagIds } } } });
    if (q.featuredOnly) where.isFeatured = true;
    if (q.excludeIds?.length) where.id = { notIn: q.excludeIds };
    if (q.search?.trim()) and.push({ translations: { some: { locale: { in: [locale, fallback] }, title: { contains: q.search.trim(), mode: 'insensitive' } } } });
    if (and.length) where.AND = and;
    const orderBy: Prisma.PostOrderByWithRelationInput[] =
      q.orderBy === 'oldest' || q.orderBy === 'publishedAt_asc' ? [{ publishedAt: 'asc' }] : q.orderBy === 'popular' ? [{ viewCount: 'desc' }] : [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, include: POST_CARD_INCLUDE }),
      this.prisma.post.count({ where }),
    ]);
    const mediaMap = await this.media.findMany(rows.map((r) => r.featuredImageId));
    const items = rows.map((r) => {
      const card = presentPostCard(r, locale, fallback, mediaMap);
      return { ...card, path: this.postPath(card.slug, locale, fallback) };
    });
    return { items, total, page, totalPages: Math.max(1, Math.ceil(total / limit)), limit };
  }

  async queryProducts(q: { categoryIds?: string[]; featuredOnly?: boolean; search?: string | null; page?: number; limit?: number; excludeIds?: string[]; orderBy?: string | null }, locale: string, fallback: string) {
    const limit = Math.min(Math.max(Number(q.limit) || 12, 1), 100);
    const page = Math.max(Number(q.page) || 1, 1);
    const where: Prisma.ProductWhereInput = publishedProductWhere();
    const and: Prisma.ProductWhereInput[] = [];
    if (q.categoryIds?.length) and.push({ categories: { some: { categoryId: { in: q.categoryIds } } } });
    if (q.featuredOnly) where.isFeatured = true;
    if (q.excludeIds?.length) where.id = { notIn: q.excludeIds };
    if (q.search?.trim()) and.push({ translations: { some: { locale: { in: [locale, fallback] }, name: { contains: q.search.trim(), mode: 'insensitive' } } } });
    if (and.length) where.AND = and;
    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      q.orderBy === 'price_asc' ? [{ price: 'asc' }] : q.orderBy === 'price_desc' ? [{ price: 'desc' }] : q.orderBy === 'best_selling' ? [{ soldCount: 'desc' }] : q.orderBy === 'order' ? [{ sortOrder: 'asc' }] : [{ createdAt: 'desc' }];
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, include: PRODUCT_CARD_INCLUDE }),
      this.prisma.product.count({ where }),
    ]);
    const mediaMap = await this.media.findMany(rows.flatMap((r) => [r.featuredImageId, r.galleryIds[0]]));
    const items = rows.map((r) => {
      const card = presentProductCard(r, locale, fallback, mediaMap);
      return { ...card, path: this.productPath(card.slug, locale, fallback) };
    });
    return { items, total, page, totalPages: Math.max(1, Math.ceil(total / limit)), limit };
  }

  // ------------------------------------------------------------------ bản ghi (TemplateRecord)

  /** Điều kiện tìm bản ghi: theo id, theo slug hoặc (không có cả hai) bản mới nhất */
  private lookup(id: string | null | undefined, slug: string | null | undefined, locale: string, fallback: string): { ok: boolean; where: Record<string, unknown> } {
    if (id) return UUID_RE.test(id) ? { ok: true, where: { id } } : { ok: false, where: {} };
    if (slug) return { ok: true, where: { translations: { some: { slug, locale: { in: [locale, fallback] } } } } };
    return { ok: true, where: {} };
  }

  private async author(a: { name: string; avatar: Parameters<MediaService['present']>[0] } | null | undefined) {
    return a ? { name: a.name, avatar: this.media.present(a.avatar)?.url ?? null } : null;
  }

  /** Dựng TemplateRecord cho một target (page | post | product | entry:<k> | post_category | post_tag | product_category | term:<k>) */
  async record(target: string, opts: { id?: string | null; slug?: string | null; locale: string; fallback: string; admin?: boolean }): Promise<FullTemplateRecord | null> {
    const { locale, fallback, admin } = opts;
    const lk = this.lookup(opts.id, opts.slug, locale, fallback);
    if (!lk.ok) return null;
    const home = this.homeCrumb(locale, fallback);
    // public: chỉ nội dung đang hiển thị; admin (builder): mọi trạng thái trừ thùng rác
    const live = admin ? { deletedAt: null } : { deletedAt: null, ...publishedCondition() };
    const authorSel = { select: { name: true, avatar: true } } as const;

    if (target === 'page') {
      const p = await this.prisma.page.findFirst({ where: { ...live, ...lk.where }, orderBy: { updatedAt: 'desc' }, include: { translations: true, author: authorSel } });
      const tr = p && pickTr(p.translations, locale, fallback);
      if (!p || !tr) return null;
      const [cf, mediaMap] = await Promise.all([this.customFields.present('page', p.customFields, locale, fallback, { template: p.template }), this.media.findMany([p.featuredImageId])]);
      const path = buildPath('page', tr.slug, locale, fallback);
      return {
        entity: 'page', target, id: p.id, title: tr.title, slug: tr.slug, path, excerpt: tr.excerpt ?? null, content: null,
        featuredImage: asRef(mediaMap.get(p.featuredImageId ?? '')), publishedAt: iso(p.publishedAt), updatedAt: iso(p.updatedAt),
        author: await this.author(p.author), terms: {}, customFields: cf.customFields, customFieldGroups: cf.customFieldGroups,
        breadcrumbs: [home, { label: tr.title, path }], blocks: Array.isArray(tr.blocks) ? (tr.blocks as unknown[]) : [], termIds: [],
      };
    }

    if (target === 'post') {
      const p = await this.prisma.post.findFirst({
        where: { ...live, ...lk.where },
        orderBy: admin ? { updatedAt: 'desc' } : { publishedAt: 'desc' },
        include: { translations: true, author: authorSel, categories: { include: { category: { include: { translations: true } } } }, tags: { include: { tag: { include: { translations: true } } } } },
      });
      const tr = p && pickTr(p.translations, locale, fallback);
      if (!p || !tr) return null;
      const categoryIds = p.categories.map((c) => c.categoryId);
      const [cf, mediaMap] = await Promise.all([this.customFields.present('post', p.customFields, locale, fallback, { categoryIds }), this.media.findMany([p.featuredImageId])]);
      const term = (type: 'post_category' | 'post_tag', trs: { locale: string; name: string; slug: string }[]) => {
        const t = pickTr(trs, locale, fallback);
        return t ? { name: t.name, slug: t.slug, path: buildPath(type, t.slug, locale, fallback) } : null;
      };
      const path = this.postPath(tr.slug, locale, fallback);
      return {
        entity: 'post', target, id: p.id, title: tr.title, slug: tr.slug, path, excerpt: tr.excerpt || excerptFrom(tr.content, 180) || null, content: tr.content,
        featuredImage: asRef(mediaMap.get(p.featuredImageId ?? '')), publishedAt: iso(p.publishedAt ?? p.createdAt), updatedAt: iso(p.updatedAt),
        author: await this.author(p.author),
        terms: {
          category: p.categories.map((c) => term('post_category', c.category.translations)).filter((x) => !!x),
          tag: p.tags.map((t) => term('post_tag', t.tag.translations)).filter((x) => !!x),
        },
        customFields: cf.customFields, customFieldGroups: cf.customFieldGroups,
        breadcrumbs: [home, { label: labels(locale).blog, path: joinPublicPath(locale, fallback, 'blog') }, { label: tr.title, path }],
        termIds: [...categoryIds, ...p.tags.map((t) => t.tagId)],
      };
    }

    if (target === 'product') {
      const p = await this.prisma.product.findFirst({
        where: { ...live, ...lk.where },
        orderBy: { updatedAt: 'desc' },
        include: { translations: true, categories: { include: { category: { include: { translations: true } } } } },
      });
      const tr = p && pickTr(p.translations, locale, fallback);
      if (!p || !tr) return null;
      const categoryIds = p.categories.map((c) => c.categoryId);
      const [cf, mediaMap] = await Promise.all([
        this.customFields.present('product', p.customFields, locale, fallback, { productType: p.type, categoryIds }),
        this.media.findMany([p.featuredImageId, ...p.galleryIds]),
      ]);
      const { price, salePrice } = effectivePrice(p);
      const path = this.productPath(tr.slug, locale, fallback);
      return {
        entity: 'product', target, id: p.id, title: tr.name, slug: tr.slug, path, excerpt: tr.shortDescription ?? null, content: tr.description,
        featuredImage: asRef(mediaMap.get(p.featuredImageId ?? '')), gallery: p.galleryIds.map((id) => asRef(mediaMap.get(id))).filter((x): x is MediaRef => !!x),
        publishedAt: iso(p.publishedAt ?? p.createdAt), updatedAt: iso(p.updatedAt), author: null,
        terms: {
          product_category: p.categories
            .map((c) => {
              const t = pickTr(c.category.translations, locale, fallback);
              return t ? { name: t.name, slug: t.slug, path: buildPath('product_category', t.slug, locale, fallback) } : null;
            })
            .filter((x) => !!x),
        },
        customFields: cf.customFields, customFieldGroups: cf.customFieldGroups, price, salePrice,
        breadcrumbs: [home, { label: labels(locale).shop, path: joinPublicPath(locale, fallback, 'products') }, { label: tr.name, path }],
        termIds: categoryIds,
      };
    }

    if (target.startsWith('entry:')) {
      const type = await this.contentType(target.slice(6));
      if (!type) return null;
      const e = await this.prisma.entry.findFirst({
        where: { ...live, typeId: type.id, ...lk.where },
        orderBy: admin ? { updatedAt: 'desc' } : { publishedAt: 'desc' },
        include: { translations: true, author: authorSel, terms: { include: { term: { include: { translations: true, taxonomy: true } } } } },
      });
      const tr = e && pickTr(e.translations, locale, fallback);
      if (!e || !tr) return null;
      const [cf, mediaMap] = await Promise.all([this.customFields.present('entry', e.customFields, locale, fallback, { contentType: type.key }), this.media.findMany([e.featuredImageId])]);
      const terms: TemplateRecord['terms'] = {};
      for (const et of e.terms) {
        const t = pickTr(et.term.translations, locale, fallback);
        if (t) (terms[et.term.taxonomy.key] ??= []).push({ name: t.name, slug: t.slug, path: this.termPath(et.term.taxonomy, t.slug, locale, fallback) });
      }
      const path = this.entryPath(type, tr.slug, locale, fallback);
      const crumbs: Crumb[] = [home];
      const archive = this.archivePath(type, locale, fallback);
      if (archive) crumbs.push({ label: this.label(type, locale, fallback), path: archive });
      crumbs.push({ label: tr.title, path });
      return {
        entity: 'entry', target, id: e.id, title: tr.title, slug: tr.slug, path, excerpt: tr.excerpt || excerptFrom(tr.content, 180) || null, content: tr.content,
        featuredImage: asRef(mediaMap.get(e.featuredImageId ?? '')), publishedAt: iso(e.publishedAt ?? e.createdAt), updatedAt: iso(e.updatedAt),
        author: await this.author(e.author), terms, customFields: cf.customFields, customFieldGroups: cf.customFieldGroups,
        breadcrumbs: crumbs, blocks: Array.isArray(tr.blocks) ? (tr.blocks as unknown[]) : [], termIds: e.terms.map((t) => t.termId),
      };
    }

    if (target === 'post_category' || target === 'product_category' || target === 'post_tag') {
      const row =
        target === 'post_category'
          ? await this.prisma.postCategory.findFirst({ where: lk.where, orderBy: { updatedAt: 'desc' }, include: { translations: true } })
          : target === 'product_category'
            ? await this.prisma.productCategory.findFirst({ where: { ...(admin ? {} : { isActive: true }), ...lk.where }, orderBy: { updatedAt: 'desc' }, include: { translations: true } })
            : await this.prisma.postTag.findFirst({ where: lk.where, orderBy: { createdAt: 'desc' }, include: { translations: true } });
      if (!row) return null;
      const tr = pickTr(row.translations as { locale: string; name: string; slug: string; description?: string | null }[], locale, fallback);
      if (!tr) return null;
      const r = row as { id: string; imageId?: string | null; customFields?: unknown; updatedAt?: Date; createdAt: Date };
      const cf =
        target === 'post_tag'
          ? { customFields: {}, customFieldGroups: [] as PublicFieldGroup[] }
          : await this.customFields.present(target, r.customFields, locale, fallback);
      const mediaMap = await this.media.findMany([r.imageId]);
      const path = buildPath(target, tr.slug, locale, fallback);
      const parent = target === 'product_category' ? { label: labels(locale).shop, path: joinPublicPath(locale, fallback, 'products') } : { label: labels(locale).blog, path: joinPublicPath(locale, fallback, 'blog') };
      return {
        entity: target, target, id: r.id, title: tr.name, slug: tr.slug, path, excerpt: tr.description ?? null, content: tr.description ?? null,
        featuredImage: asRef(mediaMap.get(r.imageId ?? '')), publishedAt: null, updatedAt: iso(r.updatedAt ?? r.createdAt), author: null, terms: {},
        customFields: cf.customFields, customFieldGroups: cf.customFieldGroups, breadcrumbs: [home, parent, { label: tr.name, path }], termIds: [r.id],
      };
    }

    if (target.startsWith('term:')) {
      const tax = await this.taxonomy(target.slice(5));
      if (!tax) return null;
      // slug của term chỉ duy nhất trong taxonomy → lookup theo slug phải lọc taxonomyId
      const t = await this.prisma.term.findFirst({ where: { taxonomyId: tax.id, ...lk.where }, orderBy: { updatedAt: 'desc' }, include: { translations: true } });
      const tr = t && pickTr(t.translations, locale, fallback);
      if (!t || !tr) return null;
      const [cf, mediaMap] = await Promise.all([this.customFields.present('term', t.customFields, locale, fallback, { taxonomy: tax.key }), this.media.findMany([t.imageId])]);
      const path = this.termPath(tax, tr.slug, locale, fallback);
      return {
        entity: 'term', target, id: t.id, title: tr.name, slug: tr.slug, path, excerpt: tr.description ?? null, content: tr.description ?? null,
        featuredImage: asRef(mediaMap.get(t.imageId ?? '')), publishedAt: null, updatedAt: iso(t.updatedAt), author: null, terms: {},
        customFields: cf.customFields, customFieldGroups: cf.customFieldGroups, breadcrumbs: [home, { label: tr.name, path }], termIds: [t.id],
      };
    }
    return null;
  }

  // ------------------------------------------------------------------ danh sách lưu trữ (TemplateListing)

  /** Tìm term theo "<taxonomy>:<slug>" hoặc "<slug>" trong các taxonomy cho trước */
  private async termIdsBySlug(termSlug: string, taxKeys: string[], locale: string, fallback: string): Promise<string[]> {
    const [a, b] = termSlug.includes(':') ? termSlug.split(':', 2) : [null, termSlug];
    const keys = a ? [a] : taxKeys;
    const taxIds = (await this.taxonomies()).filter((t) => keys.includes(t.key)).map((t) => t.id);
    if (!taxIds.length || !b) return [];
    const rows = await this.prisma.termTranslation.findMany({ where: { taxonomyId: { in: taxIds }, slug: b, locale: { in: [locale, fallback] } }, select: { termId: true } });
    return [...new Set(rows.map((r) => r.termId))];
  }

  /**
   * Danh sách cho trang lưu trữ / tìm kiếm của target.
   * record: bản ghi term/chuyên mục/danh mục (cho lưu trữ theo phân loại).
   */
  async listing(target: string, opts: { record?: FullTemplateRecord | null; page?: number | null; termSlug?: string | null; q?: string | null; locale: string; fallback: string; search?: boolean }): Promise<TemplateListing | null> {
    const { locale, fallback } = opts;
    const page = Math.max(Number(opts.page) || 1, 1);
    const general = await this.settings.get<{ postsPerPage?: number; productsPerPage?: number }>('general');
    const search = opts.q?.trim() || null;
    const L = labels(locale);
    const searchTitle = (t: string) => (opts.search && search ? `${L.search}: ${search}` : t);

    if (target === 'post' || target === 'post_category' || target === 'post_tag') {
      if (target !== 'post' && !opts.record) return null;
      const r = await this.queryPosts(
        { page, limit: general.postsPerPage || 12, search, categoryIds: target === 'post_category' ? [opts.record!.id] : undefined, tagIds: target === 'post_tag' ? [opts.record!.id] : undefined },
        locale,
        fallback,
      );
      return { target, title: searchTitle(opts.record?.title ?? L.blog), description: opts.record?.excerpt ?? null, items: r.items, itemKind: 'post', page: r.page, totalPages: r.totalPages, total: r.total, basePath: opts.record?.path ?? joinPublicPath(locale, fallback, 'blog') };
    }

    if (target === 'product' || target === 'product_category') {
      if (target !== 'product' && !opts.record) return null;
      const r = await this.queryProducts({ page, limit: general.productsPerPage || 12, search, categoryIds: target === 'product_category' ? [opts.record!.id] : undefined }, locale, fallback);
      return { target, title: searchTitle(opts.record?.title ?? L.shop), description: opts.record?.excerpt ?? null, items: r.items, itemKind: 'product', page: r.page, totalPages: r.totalPages, total: r.total, basePath: opts.record?.path ?? joinPublicPath(locale, fallback, 'products') };
    }

    if (target.startsWith('entry:')) {
      const type = await this.contentType(target.slice(6));
      if (!type) return null;
      const termIds = opts.termSlug ? await this.termIdsBySlug(opts.termSlug, (await this.taxonomies()).filter((t) => t.contentTypes.includes(type.key)).map((t) => t.key), locale, fallback) : undefined;
      if (opts.termSlug && !termIds?.length) return { target, title: this.label(type, locale, fallback), description: type.description, items: [], itemKind: 'entry', page, totalPages: 1, total: 0, basePath: this.archivePath(type, locale, fallback) };
      const r = await this.queryEntries({ types: [type.key], termIds, page, limit: type.perPage || 12, search, orderBy: type.orderBy }, locale, fallback);
      return { target, title: searchTitle(this.label(type, locale, fallback)), description: type.description, items: r.items, itemKind: 'entry', page: r.page, totalPages: r.totalPages, total: r.total, basePath: this.archivePath(type, locale, fallback) };
    }

    if (target.startsWith('term:')) {
      const tax = await this.taxonomy(target.slice(5));
      if (!tax || !opts.record) return null;
      const types = (await this.contentTypes()).filter((t) => tax.contentTypes.includes(t.key));
      const perPage = types.length === 1 ? types[0].perPage : 12;
      const r = await this.queryEntries({ types: types.map((t) => t.key), termIds: [opts.record.id], page, limit: perPage || 12, search, orderBy: types.length === 1 ? types[0].orderBy : null }, locale, fallback);
      return { target, title: opts.record.title, description: opts.record.excerpt, items: r.items, itemKind: 'entry', page: r.page, totalPages: r.totalPages, total: r.total, basePath: opts.record.path };
    }

    // "*" ở trang tìm kiếm: entry của mọi loại cho phép tìm kiếm
    if (target === '*' && opts.search) {
      const r = await this.queryEntries({ page, limit: 12, search, searchableOnly: true }, locale, fallback);
      return { target, title: searchTitle(L.search), description: null, items: r.items, itemKind: 'entry', page: r.page, totalPages: r.totalPages, total: r.total, basePath: joinPublicPath(locale, fallback, 'search') };
    }
    return null;
  }

  /** Bản ghi "ảo" đại diện cho trang lưu trữ (để dynamic-title / breadcrumbs dùng được ở mẫu archive) */
  private archiveRecord(listing: TemplateListing, locale: string, fallback: string): FullTemplateRecord {
    const home = this.homeCrumb(locale, fallback);
    return {
      entity: 'archive', target: listing.target, id: '', title: listing.title, slug: '', path: listing.basePath, excerpt: listing.description, content: listing.description,
      featuredImage: null, publishedAt: null, updatedAt: null, author: null, terms: {}, customFields: {}, customFieldGroups: [],
      breadcrumbs: [home, { label: listing.title, path: listing.basePath }], termIds: [],
    };
  }

  /**
   * Dựng ngữ cảnh đầy đủ cho một lần render mẫu / xem trước trong builder.
   * - single (hoặc header/footer có id/slug): record = bản ghi
   * - archive: record = term/chuyên mục (lưu trữ theo phân loại) hoặc bản ghi ảo của trang lưu trữ; listing = danh sách
   * - search: listing theo q
   * - không rõ kind (builder không gửi): record + listing nếu target có cả hai
   */
  async build(input: BuildContextInput): Promise<BuiltContext> {
    const { locale, fallback } = await this.locales(input.locale);
    const page = Math.max(Number(input.page) || 1, 1);
    const target = input.target || '*';
    const kind = input.kind ?? null;
    const out: BuiltContext = { locale, fallback, record: null, listing: null, page };
    const isTaxArchive = ARCHIVE_ONLY.includes(target) || target.startsWith('term:');
    const valid = target === '*' || CORE_TARGETS.includes(target) || target.startsWith('entry:') || target.startsWith('term:');
    if (!valid) return out;

    if (kind === 'search') {
      out.listing = await this.listing(target, { page, q: input.q, locale, fallback, search: true });
      if (out.listing) out.record = this.archiveRecord(out.listing, locale, fallback);
      return out;
    }
    if (kind === 'not_found') return out;

    const hasRef = !!input.id || !!input.slug;
    const wantRecord =
      target !== '*' &&
      (kind === 'archive' ? isTaxArchive : kind === 'header' || kind === 'footer' ? hasRef : true); // single / không rõ kind → luôn dựng record
    if (wantRecord) out.record = await this.record(target, { id: input.id, slug: input.slug, locale, fallback, admin: input.admin });

    const wantListing = kind === 'archive' || (!kind && target !== 'page' && target !== '*');
    if (wantListing) {
      out.listing = await this.listing(target, { record: isTaxArchive ? out.record : null, page, termSlug: input.termSlug, q: input.q, locale, fallback });
      if (kind === 'archive' && !isTaxArchive && out.listing) out.record = this.archiveRecord(out.listing, locale, fallback);
    }
    return out;
  }
}
