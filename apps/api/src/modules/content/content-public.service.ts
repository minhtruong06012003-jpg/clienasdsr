import { Injectable, NotFoundException } from '@nestjs/common';
import { joinPublicPath, type EntryCard, type EntryDetail, type MediaRef, type PublicContentType, type PublicResolveResult } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { BlockResolverService } from '../blocks/block-resolver.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ContentMetaService, type TaxonomyMeta, type TypeMeta } from './content-meta.service.js';
import { ENTRY_CARD_INCLUDE, entryOrderBy, entryPath, isTitleOrder, presentEntryCard, publishedEntryWhere, titleOrderedEntryIds, type EntryCardRow, type PresentEnv } from './content.presenter.js';
import { buildAlternates, labelFor, resolvePublicPath, slugFor } from './content.util.js';
import type { PublicEntryQueryDto } from './content.dto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quan hệ cần nạp cho trang chi tiết */
const ENTRY_DETAIL_INCLUDE = {
  ...ENTRY_CARD_INCLUDE,
  translations: true,
  author: { select: { id: true, name: true, avatar: true } },
} satisfies Prisma.EntryInclude;
type EntryDetailRow = Prisma.EntryGetPayload<{ include: typeof ENTRY_DETAIL_INCLUDE }>;

/** Tham số truy vấn danh sách dùng chung (API công khai, block, theme) */
export interface EntryQueryParams {
  type?: string;
  /** "<taxKey>:<slug>[,<taxKey>:<slug>]" */
  term?: string;
  termIds?: string[];
  featured?: boolean;
  search?: string;
  sort?: string;
  parent?: string;
  ids?: string[];
  exclude?: string[];
  cf?: Record<string, string>;
  page?: number;
  limit?: number;
}

/**
 * Dữ liệu công khai của loại nội dung tuỳ biến cho storefront: bootstrap, danh sách, chi tiết,
 * phân giải đường dẫn, sitemap, xem trước bản nháp.
 */
@Injectable()
export class ContentPublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly customFields: CustomFieldsService,
    private readonly meta: ContentMetaService,
    private readonly blocks: BlockResolverService,
  ) {}

  private async env(localeInput?: string): Promise<PresentEnv & { locales: string[] }> {
    const [locale, defaultLocale, locales] = await Promise.all([this.languages.resolve(localeInput), this.languages.defaultLocale(), this.languages.codes()]);
    return { locale, defaultLocale, locales };
  }

  /** Loại nội dung rút gọn theo locale */
  presentType(t: TypeMeta, taxonomies: TaxonomyMeta[], env: PresentEnv): PublicContentType {
    const label = labelFor(t.labels, env.locale, env.defaultLocale, t.key);
    return {
      key: t.key,
      label: label.plural,
      singularLabel: label.singular,
      archivePath: t.isPublic && t.hasArchive ? joinPublicPath(env.locale, env.defaultLocale, slugFor(t.slugs, env.locale, env.defaultLocale, t.key)) : null,
      slugs: t.slugs,
      supports: t.supports,
      hasArchive: t.hasArchive,
      perPage: t.perPage,
      taxonomies: taxonomies.filter((x) => x.contentTypes.includes(t.key)).map((x) => x.key),
      filters: taxonomies
        .filter((x) => x.contentTypes.includes(t.key) && x.showInFilter)
        .map((x) => ({ key: x.key, label: labelFor(x.labels, env.locale, env.defaultLocale, x.key).singular })),
    };
  }

  /** Danh sách loại nội dung public cho bootstrap storefront (isActive && isPublic) */
  async bootstrapTypes(locale: string): Promise<PublicContentType[]> {
    const env = await this.env(locale);
    const [types, taxes] = await Promise.all([this.meta.types(), this.meta.taxonomies()]);
    return types.filter((t) => t.isActive && t.isPublic).map((t) => this.presentType(t, taxes, env));
  }

  /** GET /public/content-types — giống bootstrap */
  publicTypes(locale?: string) {
    return this.bootstrapTypes(locale ?? '');
  }

  // ======================= Thẻ bài =======================

  /** Dựng thẻ cho nhiều dòng (gắn ảnh + trường tuỳ chỉnh public) */
  async cards(rows: EntryCardRow[], env: PresentEnv): Promise<EntryCard[]> {
    const media = await this.media.findMany(rows.map((r) => r.featuredImageId));
    return Promise.all(
      rows.map(async (r) => {
        const cf = await this.customFields.present('entry', r.customFields, env.locale, env.defaultLocale, { contentType: r.type.key });
        return presentEntryCard(r, env, media as Map<string, unknown>, cf.customFields);
      }),
    );
  }

  /** Điều kiện lọc danh sách công khai */
  private async buildWhere(p: EntryQueryParams, env: PresentEnv): Promise<Prisma.EntryWhereInput | null> {
    const and: Prisma.EntryWhereInput[] = [publishedEntryWhere(), { translations: { some: { locale: env.locale } } }];
    if (p.type) {
      const types = p.type.split(',').map((s) => s.trim()).filter(Boolean);
      and.push({ type: { key: { in: types } } });
    }
    if (p.term) {
      // nhóm theo taxonomy: cùng taxonomy = một trong, khác taxonomy = đồng thời
      const byTax = new Map<string, string[]>();
      for (const part of p.term.split(',')) {
        const [tax, slug] = part.split(':').map((s) => s?.trim());
        if (tax && slug) byTax.set(tax, [...(byTax.get(tax) ?? []), slug]);
      }
      for (const [tax, slugs] of byTax) and.push({ terms: { some: { term: { taxonomy: { key: tax }, translations: { some: { locale: env.locale, slug: { in: slugs } } } } } } });
    }
    if (p.termIds?.length) and.push({ terms: { some: { termId: { in: p.termIds } } } });
    if (p.featured) and.push({ isFeatured: true });
    if (p.parent) and.push({ parentId: p.parent === 'root' ? null : UUID_RE.test(p.parent) ? p.parent : undefined });
    if (p.ids?.length) and.push({ id: { in: p.ids } });
    if (p.exclude?.length) and.push({ id: { notIn: p.exclude } });
    if (p.search?.trim()) {
      const s = p.search.trim();
      // tìm không dấu ("nha" khớp "Nhà") khi DB có unaccent; không có thì ILIKE như cũ
      const ids = await this.unaccentMatches(s, env.locale);
      if (ids) and.push({ id: { in: ids } });
      else and.push({ translations: { some: { locale: env.locale, OR: [{ title: { contains: s, mode: 'insensitive' } }, { excerpt: { contains: s, mode: 'insensitive' } }, { content: { contains: s, mode: 'insensitive' } }] } } });
    }
    // lọc theo trường tuỳ chỉnh ?cf[key]=value
    const cfWhere = await this.customFields.publicWhere<Prisma.EntryWhereInput>('entry', p.cf);
    and.push(...cfWhere);
    return { AND: and };
  }

  /** cache kiểm tra extension unaccent (10 phút) */
  private unaccentCheck: { ok: boolean; at: number } | null = null;

  /**
   * Id entry có bản dịch (locale) chứa MỌI từ khoá, so khớp không dấu.
   * Trả null khi DB không có extension unaccent (người gọi lùi về ILIKE).
   */
  private async unaccentMatches(search: string, locale: string): Promise<string[] | null> {
    if (!this.unaccentCheck || Date.now() - this.unaccentCheck.at > 600_000) {
      const rows = await this.prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM pg_extension WHERE extname = 'unaccent'`.catch(() => []);
      this.unaccentCheck = { ok: rows.length > 0, at: Date.now() };
    }
    if (!this.unaccentCheck.ok) return null;
    const terms = search.split(/\s+/).filter(Boolean).slice(0, 8);
    let ids = null as Set<string> | null;
    for (const t of terms) {
      // escape ký tự đại diện của LIKE trong từ khoá người dùng nhập
      const pattern = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await this.prisma.$queryRaw<{ entryId: string }[]>`
        SELECT DISTINCT "entryId" FROM entry_translations
        WHERE locale = ${locale}
          AND (unaccent(lower(title)) LIKE unaccent(lower(${pattern}))
            OR unaccent(lower(coalesce(excerpt, ''))) LIKE unaccent(lower(${pattern}))
            OR unaccent(lower(content)) LIKE unaccent(lower(${pattern})))`;
      const found: Set<string> = new Set(rows.map((r) => r.entryId));
      const prev: Set<string> | null = ids;
      ids = prev ? new Set([...prev].filter((id: string) => found.has(id))) : found;
      if (!ids.size) break;
    }
    return [...(ids ?? [])];
  }

  /**
   * Truy vấn danh sách thẻ bài (dùng cho API công khai; block / theme có thể gọi trực tiếp).
   * Thứ tự: `sort` (newest|oldest|title|order|featured|updated) hoặc orderBy mặc định của loại.
   */
  async query(p: EntryQueryParams, localeInput?: string) {
    const env = await this.env(localeInput);
    const { skip, take, page, limit } = pageArgs({ page: p.page, limit: Math.min(p.limit ?? 12, 100) });
    const firstType = p.type ? await this.meta.type(p.type.split(',')[0].trim()) : undefined;
    if (p.type && !p.type.includes(',') && (!firstType || !firstType.isActive)) throw new NotFoundException('Không tìm thấy loại nội dung');
    const where = (await this.buildWhere(p, env))!;
    const order = p.sort || firstType?.orderBy || 'publishedAt_desc';
    let rows: EntryCardRow[];
    const total = await this.prisma.entry.count({ where });
    if (p.ids?.length && !p.sort) {
      // chọn tay: giữ đúng thứ tự id truyền vào
      const found = await this.prisma.entry.findMany({ where, include: ENTRY_CARD_INCLUDE });
      rows = p.ids.map((id) => found.find((r) => r.id === id)).filter((r): r is EntryCardRow => !!r).slice(skip, skip + take);
    } else if (isTitleOrder(order)) {
      // sắp theo tiêu đề của bản dịch locale hiện tại
      // sắp theo tiêu đề bản dịch hiện tại, thiếu thì tiêu đề ngôn ngữ mặc định (khớp total)
      const ids = await titleOrderedEntryIds(this.prisma, where, env.locale, env.defaultLocale, skip, take);
      const found = await this.prisma.entry.findMany({ where: { id: { in: ids } }, include: ENTRY_CARD_INCLUDE });
      rows = ids.map((id) => found.find((r) => r.id === id)).filter((r): r is EntryCardRow => !!r);
    } else {
      rows = await this.prisma.entry.findMany({ where, skip, take, orderBy: entryOrderBy(order, env.locale), include: ENTRY_CARD_INCLUDE });
    }
    return paginate(await this.cards(rows, env), total, page, limit);
  }

  /** GET /public/entries */
  list(q: PublicEntryQueryDto & { cf?: Record<string, string> }) {
    const split = (s?: string) => s?.split(',').map((x) => x.trim()).filter((x) => UUID_RE.test(x));
    return this.query(
      {
        type: q.type,
        term: q.term,
        featured: q.featured === '1' || q.featured === 'true',
        search: q.search,
        sort: q.sort,
        parent: q.parent,
        ids: split(q.ids),
        exclude: split(q.exclude),
        cf: q.cf,
        page: q.page,
        limit: q.limit,
      },
      q.locale,
    );
  }

  /** Thẻ của các bài theo id (đã xuất bản), giữ thứ tự — cho trường tuỳ chỉnh / block chọn tay */
  async cardsByIds(ids: string[], localeInput?: string): Promise<EntryCard[]> {
    if (!ids.length) return [];
    const env = await this.env(localeInput);
    const rows = await this.prisma.entry.findMany({ where: { id: { in: ids }, ...publishedEntryWhere() }, include: ENTRY_CARD_INCLUDE });
    const cards = await this.cards(rows, env);
    return ids.map((id) => cards.find((c) => c.id === id)).filter((c): c is EntryCard => !!c);
  }

  // ======================= Chi tiết =======================

  /** GET /public/entries/:type/:slug — 404 nếu không có / chưa xuất bản / loại không public */
  async detail(typeKey: string, slug: string, localeInput?: string): Promise<EntryDetail> {
    const env = await this.env(localeInput);
    const type = await this.meta.type(typeKey);
    if (!type || !type.isActive || !type.isPublic) throw new NotFoundException('Không tìm thấy loại nội dung');
    const row = await this.prisma.entry.findFirst({ where: { ...publishedEntryWhere(), typeId: type.id, translations: { some: { locale: env.locale, slug } } }, include: ENTRY_DETAIL_INCLUDE });
    if (!row) throw new NotFoundException('Không tìm thấy nội dung');
    return this.presentDetail(row, type, env, false);
  }

  /** Xem trước theo id (kể cả bản nháp / hẹn giờ) — dùng cho module preview */
  async publicById(id: string, localeInput?: string, preview = false): Promise<EntryDetail> {
    const env = await this.env(localeInput);
    const row = await this.prisma.entry.findFirst({ where: { id, ...(preview ? { deletedAt: null } : publishedEntryWhere()) }, include: ENTRY_DETAIL_INCLUDE });
    if (!row) throw new NotFoundException('Không tìm thấy nội dung');
    const type = await this.meta.typeById(row.typeId);
    if (!type) throw new NotFoundException('Không tìm thấy loại nội dung');
    return this.presentDetail(row, type, env, preview);
  }

  private async presentDetail(row: EntryDetailRow, type: TypeMeta, env: PresentEnv & { locales: string[] }, preview: boolean): Promise<EntryDetail> {
    const tr = row.translations.find((t) => t.locale === env.locale) ?? row.translations.find((t) => t.locale === env.defaultLocale) ?? row.translations[0];
    const taxes = await this.meta.taxonomies();
    const [media, cf] = await Promise.all([
      this.media.findMany([row.featuredImageId, tr?.ogImageId]),
      this.customFields.present('entry', row.customFields, env.locale, env.defaultLocale, { contentType: type.key }),
    ]);
    const card = presentEntryCard(row, env, media as Map<string, unknown>, cf.customFields);
    const termIds = row.terms.map((t) => t.termId);

    // bài liên quan: cùng loại, chung term (không có term -> mới nhất)
    const relatedRows = await this.prisma.entry.findMany({
      where: { ...publishedEntryWhere(), typeId: type.id, id: { not: row.id }, translations: { some: { locale: env.locale } }, ...(termIds.length ? { terms: { some: { termId: { in: termIds } } } } : {}) },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 4,
      include: ENTRY_CARD_INCLUDE,
    });

    // bài trước / sau theo thứ tự mặc định của loại
    const bySort = type.orderBy === 'sortOrder_asc';
    const pivot = bySort ? { sortOrder: row.sortOrder } : { publishedAt: row.publishedAt ?? row.createdAt };
    const neighbourWhere = { ...publishedEntryWhere(), typeId: type.id, id: { not: row.id }, translations: { some: { locale: env.locale } } };
    const neighbourSelect = { type: { select: { key: true, slugs: true, isPublic: true } }, translations: { where: { locale: env.locale }, select: { title: true, slug: true } } };
    const [prevRow, nextRow] = await Promise.all([
      this.prisma.entry.findFirst({
        where: { ...neighbourWhere, ...(bySort ? { sortOrder: { lt: pivot.sortOrder } } : { publishedAt: { lt: pivot.publishedAt } }) },
        orderBy: bySort ? { sortOrder: 'desc' } : { publishedAt: 'desc' },
        select: neighbourSelect,
      }),
      this.prisma.entry.findFirst({
        where: { ...neighbourWhere, ...(bySort ? { sortOrder: { gt: pivot.sortOrder } } : { publishedAt: { gt: pivot.publishedAt } }) },
        orderBy: bySort ? { sortOrder: 'asc' } : { publishedAt: 'asc' },
        select: neighbourSelect,
      }),
    ]);
    const neighbour = (n: typeof prevRow) => (n && n.translations[0] ? { title: n.translations[0].title, path: entryPath(n.type, n.translations[0].slug, env) } : null);

    const supportsBlocks = type.supports.includes('blocks');
    const rawBlocks = Array.isArray(tr?.blocks) ? (tr!.blocks as unknown[]) : [];
    const blocks = supportsBlocks && rawBlocks.length ? await this.blocks.resolve(rawBlocks, env.locale, 0, 'view', { entity: 'entry', customFields: cf.customFields, customFieldGroups: cf.customFieldGroups }) : [];

    const detail: EntryDetail = {
      ...card,
      content: tr?.content ?? '',
      blocks: blocks as unknown as EntryDetail['blocks'],
      parentId: row.parentId,
      author: row.author && type.supports.includes('author') ? { id: row.author.id, name: row.author.name, avatar: this.media.present(row.author.avatar)?.url ?? null } : null,
      updatedAt: row.updatedAt.toISOString(),
      seoTitle: tr?.seoTitle ?? null,
      seoDescription: tr?.seoDescription ?? null,
      seoKeywords: tr?.seoKeywords ?? null,
      canonicalUrl: tr?.canonicalUrl ?? null,
      ogImage: (media.get(tr?.ogImageId ?? '') as MediaRef | undefined) ?? null,
      noindex: preview ? true : (tr?.noindex ?? false),
      nofollow: tr?.nofollow ?? false,
      schemaJson: tr?.schemaJson ?? null,
      customFieldGroups: cf.customFieldGroups,
      alternates: buildAlternates(row.translations, type.isPublic ? type.slugs : null, env.locales, env.defaultLocale, type.key),
      related: await this.cards(relatedRows, env),
      prev: neighbour(prevRow),
      next: neighbour(nextRow),
      contentType: this.presentType(type, taxes, env),
    };
    return this.hooks.applyFilters('entry.public', detail, { locale: env.locale, preview });
  }

  // ======================= Phân giải đường dẫn =======================

  /** GET /public/resolve?path=a/b — storefront dùng cho route catch-all */
  async resolve(path: string, localeInput?: string): Promise<PublicResolveResult> {
    const env = await this.env(localeInput);
    const [types, taxes] = await Promise.all([this.meta.types(), this.meta.taxonomies()]);
    const active = types.filter((t) => t.isActive);
    const r = resolvePublicPath(path ?? '', env.locale, env.defaultLocale, active, taxes);
    switch (r.kind) {
      case 'archive':
      case 'entry': {
        const t = active.find((x) => x.key === r.typeKey)!;
        const contentType = this.presentType(t, taxes, env);
        return r.kind === 'archive' ? { kind: 'archive', contentType } : { kind: 'entry', contentType, slug: r.slug };
      }
      case 'term': {
        const tax = taxes.find((x) => x.key === r.taxonomyKey)!;
        return { kind: 'term', taxonomy: { key: tax.key, label: labelFor(tax.labels, env.locale, env.defaultLocale, tax.key).plural, slugs: tax.slugs }, slug: r.slug };
      }
      default:
        return r;
    }
  }

  // ======================= Sitemap =======================

  /** Bài public (loại public + đang bật) cho sitemap */
  async sitemapEntries() {
    const types = (await this.meta.types()).filter((t) => t.isActive && t.isPublic);
    if (!types.length) return [];
    const rows = await this.prisma.entry.findMany({
      where: { ...publishedEntryWhere(), typeId: { in: types.map((t) => t.id) } },
      select: { id: true, typeId: true, updatedAt: true, featuredImageId: true, translations: { select: { locale: true, slug: true, noindex: true, title: true } } },
      orderBy: { publishedAt: 'desc' },
    });
    return rows.map((r) => ({ ...r, type: types.find((t) => t.id === r.typeId)! }));
  }

  /** Loại public có trang lưu trữ (cho sitemap) */
  async sitemapArchives() {
    return (await this.meta.types()).filter((t) => t.isActive && t.isPublic && t.hasArchive);
  }
}

