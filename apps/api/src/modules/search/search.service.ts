import { Injectable, Logger } from '@nestjs/common';
import { joinPublicPath, readFeatures, type MediaRef } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { LanguagesService } from '../languages/languages.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MediaService } from '../media/media.service.js';
import { excerptFrom } from '../../common/utils/html.util.js';
import { PRODUCT_CARD_INCLUDE, presentProductCard } from '../products/products.presenter.js';

/** Loại kết quả tìm kiếm */
export type SearchHitType = 'page' | 'post' | 'product' | 'entry';

/** Một kết quả tìm kiếm toàn website (GET /public/site-search) */
export interface SearchHit {
  type: SearchHitType;
  /** key loại nội dung (chỉ có với entry) */
  contentType?: string;
  id: string;
  title: string;
  excerpt: string | null;
  path: string;
  image: MediaRef | null;
  price?: number | null;
  salePrice?: number | null;
}

export interface SearchGroup {
  /** page | post | product | entry:<key> */
  type: string;
  label: string;
  count: number;
}

export interface SiteSearchQuery {
  q?: string;
  /** all | page | post | product | entry:<key> */
  type?: string;
  page?: number;
  limit?: number;
  locale?: string;
}

/** Dòng thô trả về từ truy vấn xếp hạng */
interface RankRow {
  type: SearchHitType;
  ctype: string | null;
  id: string;
  score: number;
}

/** Nhãn nhóm kết quả theo locale (thiếu locale -> tiếng Việt) */
const GROUP_LABELS: Record<'page' | 'post' | 'product', Record<string, string>> = {
  page: { vi: 'Trang', en: 'Pages' },
  post: { vi: 'Bài viết', en: 'Posts' },
  product: { vi: 'Sản phẩm', en: 'Products' },
};

/** Giới hạn để truy vấn không quá nặng */
const MAX_TERMS = 8;
const MAX_TERM_LEN = 100;
/** Kiểm lại extension unaccent sau mỗi khoảng này (admin có thể cài thêm khi đang chạy) */
const UNACCENT_RECHECK_MS = 10 * 60_000;

/** Thoát ký tự đặc biệt của LIKE (\ % _) — ký tự thoát mặc định của PostgreSQL là "\" */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Tách từ khoá theo khoảng trắng (bỏ trùng, giới hạn số từ / độ dài) */
export function splitTerms(q: string | undefined | null): string[] {
  const words = (q ?? '').trim().split(/\s+/).filter(Boolean).map((w) => w.slice(0, MAX_TERM_LEN));
  return [...new Set(words.map((w) => w.toLowerCase()))].slice(0, MAX_TERMS);
}

/**
 * Tìm kiếm toàn website (trang, bài viết, sản phẩm, nội dung tuỳ biến) bằng SQL thô có tham số.
 * - Không dấu nhờ extension `unaccent` (nếu DB có); không có thì lùi về ILIKE (vẫn không phân biệt hoa thường).
 * - Mỗi từ khoá phải xuất hiện ở tiêu đề / mô tả / nội dung (AND giữa các từ).
 * - Xếp hạng: khớp tiêu đề > mô tả > nội dung; khớp nguyên cụm trong tiêu đề được cộng thêm điểm.
 * - Chỉ lấy nội dung đang hiển thị công khai (đã xuất bản, tới giờ, chưa xoá, không noindex).
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger('Search');
  /** cache kết quả kiểm tra extension unaccent */
  private unaccent: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
  ) {}

  /** DB có extension unaccent không (cache UNACCENT_RECHECK_MS) */
  async hasUnaccent(): Promise<boolean> {
    if (this.unaccent && Date.now() - this.unaccent.at < UNACCENT_RECHECK_MS) return this.unaccent.ok;
    let ok = false;
    try {
      const rows = await this.prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok FROM pg_extension WHERE extname = 'unaccent'`;
      ok = rows.length > 0;
    } catch (err) {
      this.logger.warn(`Không kiểm tra được extension unaccent: ${(err as Error).message}`);
    }
    if (!ok && this.unaccent?.ok !== false) this.logger.warn('PostgreSQL chưa có extension "unaccent" — tìm kiếm không dấu lùi về ILIKE');
    this.unaccent = { ok, at: Date.now() };
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Dựng SQL
  // ---------------------------------------------------------------------------

  /** Điều kiện "cột chứa từ khoá" (không dấu nếu có unaccent) */
  private like(col: string, term: string, unaccent: boolean): Prisma.Sql {
    const pattern = `%${escapeLike(term)}%`;
    const c = Prisma.raw(`coalesce(${col}, '')`);
    return unaccent ? Prisma.sql`unaccent(lower(${c})) LIKE unaccent(lower(${pattern}))` : Prisma.sql`${c} ILIKE ${pattern}`;
  }

  private any(cols: string[], term: string, unaccent: boolean): Prisma.Sql {
    return Prisma.sql`(${Prisma.join(cols.map((c) => this.like(c, term, unaccent)), ' OR ')})`;
  }

  /**
   * Một nhánh của UNION: mỗi từ phải khớp ở ít nhất một cột; điểm = tổng điểm từng từ
   * (tiêu đề 100, mô tả 10, nội dung 1) + 1000 nếu tiêu đề chứa nguyên cụm từ khoá.
   */
  private branch(o: { type: SearchHitType; ctype: string; id: string; pub: string; from: string; where: string; title: string; excerpt: string[]; content: string[] }, terms: string[], phrase: string, unaccent: boolean, locale: string): Prisma.Sql {
    const conds = terms.map((t) => this.any([o.title, ...o.excerpt, ...o.content], t, unaccent));
    const score = terms.map(
      (t) => Prisma.sql`(CASE WHEN ${this.like(o.title, t, unaccent)} THEN 100 WHEN ${o.excerpt.length ? this.any(o.excerpt, t, unaccent) : Prisma.sql`false`} THEN 10 ELSE 1 END)`,
    );
    const bonus = terms.length > 1 ? Prisma.sql` + (CASE WHEN ${this.like(o.title, phrase, unaccent)} THEN 1000 ELSE 0 END)` : Prisma.empty;
    return Prisma.sql`SELECT ${o.type}::text AS type, ${Prisma.raw(o.ctype)} AS ctype, ${Prisma.raw(o.id)} AS id, (${Prisma.join(score, ' + ')})${bonus} AS score, ${Prisma.raw(o.pub)} AS pub
      FROM ${Prisma.raw(o.from)}
      WHERE t.locale = ${locale} AND ${Prisma.raw(o.where)} AND ${Prisma.join(conds, ' AND ')}`;
  }

  /** Điều kiện "đang hiển thị công khai" giống publishedCondition() của Prisma */
  private static published(alias: string) {
    return `${alias}."deletedAt" IS NULL AND ((${alias}.status = 'PUBLISHED' AND (${alias}."publishedAt" IS NULL OR ${alias}."publishedAt" <= now())) OR (${alias}.status = 'SCHEDULED' AND ${alias}."publishedAt" <= now()))`;
  }

  /** CTE "hits" gồm các nguồn được phép */
  private hitsSql(sources: SearchHitType[], terms: string[], phrase: string, unaccent: boolean, locale: string): Prisma.Sql {
    const parts: Prisma.Sql[] = [];
    const P = SearchService.published;
    if (sources.includes('page'))
      parts.push(
        this.branch(
          { type: 'page', ctype: 'NULL::text', id: 'p.id', pub: 'p."publishedAt"', from: 'page_translations t JOIN pages p ON p.id = t."pageId"', where: `${P('p')} AND t.noindex = false`, title: 't.title', excerpt: ['t.excerpt', 't."seoDescription"'], content: ['t.blocks::text'] },
          terms, phrase, unaccent, locale,
        ),
      );
    if (sources.includes('post'))
      parts.push(
        this.branch(
          { type: 'post', ctype: 'NULL::text', id: 'p.id', pub: 'p."publishedAt"', from: 'post_translations t JOIN posts p ON p.id = t."postId"', where: `${P('p')} AND t.noindex = false`, title: 't.title', excerpt: ['t.excerpt'], content: ['t.content'] },
          terms, phrase, unaccent, locale,
        ),
      );
    if (sources.includes('product'))
      parts.push(
        this.branch(
          { type: 'product', ctype: 'NULL::text', id: 'p.id', pub: 'p."publishedAt"', from: 'product_translations t JOIN products p ON p.id = t."productId"', where: `${P('p')} AND t.noindex = false`, title: 't.name', excerpt: ['t."shortDescription"', 'p.sku'], content: ['t.description'] },
          terms, phrase, unaccent, locale,
        ),
      );
    if (sources.includes('entry'))
      parts.push(
        this.branch(
          {
            type: 'entry', ctype: 'ct.key', id: 'e.id', pub: 'e."publishedAt"',
            from: 'entry_translations t JOIN entries e ON e.id = t."entryId" JOIN content_types ct ON ct.id = e."typeId"',
            where: `${P('e')} AND t.noindex = false AND ct."isActive" = true AND ct."isPublic" = true AND ct.searchable = true`,
            title: 't.title', excerpt: ['t.excerpt'], content: ['t.content', 't.blocks::text'],
          },
          terms, phrase, unaccent, locale,
        ),
      );
    return Prisma.sql`WITH hits AS (${Prisma.join(parts, ' UNION ALL ')})`;
  }

  /** Nguồn được bật theo công tắc tính năng (tắt bán hàng -> không tìm sản phẩm...) */
  private async enabledSources(): Promise<SearchHitType[]> {
    const f = readFeatures(await this.settings.get('features'));
    return (['page', 'post', 'product', 'entry'] as SearchHitType[]).filter((s) => (s === 'post' ? f.blog : s === 'product' ? f.shop : true));
  }

  /** Lọc theo ?type= : all | page | post | product | entry | entry:<key> */
  private static typeFilter(type: string | undefined): Prisma.Sql {
    if (!type || type === 'all') return Prisma.empty;
    if (type.startsWith('entry:')) return Prisma.sql`WHERE type = 'entry' AND ctype = ${type.slice(6)}`;
    return Prisma.sql`WHERE type = ${type}`;
  }

  /**
   * Id đã xếp hạng của một loại (dùng cho GET /public/search cũ: lấy id rồi trình bày bằng presenter sẵn có).
   */
  async rankedIds(type: 'post' | 'product' | 'page', q: string, locale: string, limit: number): Promise<string[]> {
    const terms = splitTerms(q);
    if (!terms.length) return [];
    const unaccent = await this.hasUnaccent();
    const rows = await this.prisma.$queryRaw<RankRow[]>`${this.hitsSql([type], terms, terms.join(' '), unaccent, locale)}
      SELECT id::text AS id FROM hits ORDER BY score DESC, pub DESC NULLS LAST, id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /** GET /public/site-search */
  async search(query: SiteSearchQuery) {
    const locale = await this.languages.resolve(query.locale);
    const fallback = await this.languages.defaultLocale();
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(50, Math.max(1, Math.floor(Number(query.limit) || 10)));
    const terms = splitTerms(query.q);
    const empty = { data: [] as SearchHit[], meta: { page, limit, total: 0, totalPages: 1 }, groups: [] as SearchGroup[] };
    if (!terms.length) return empty;

    const sources = await this.enabledSources();
    const type = query.type && query.type !== 'all' ? query.type : 'all';
    // loại bị tắt (vd tìm product khi đã tắt bán hàng) -> rỗng
    const baseType = type.startsWith('entry:') ? 'entry' : type;
    if (type !== 'all' && !sources.includes(baseType as SearchHitType)) return empty;

    const unaccent = await this.hasUnaccent();
    const hits = this.hitsSql(sources, terms, terms.join(' '), unaccent, locale);
    const [groupRows, rows] = await Promise.all([
      this.prisma.$queryRaw<{ type: SearchHitType; ctype: string | null; count: number }[]>`${hits}
        SELECT type, ctype, count(*)::int AS count FROM hits GROUP BY type, ctype`,
      this.prisma.$queryRaw<RankRow[]>`${hits}
        SELECT type, ctype, id::text AS id, score FROM hits ${SearchService.typeFilter(type)}
        ORDER BY score DESC, pub DESC NULLS LAST, id LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    ]);

    const groups = await this.groupLabels(groupRows, locale, fallback);
    // nhóm entry luôn mang type "entry:<loại>" -> type=entry (mọi loại tuỳ biến) phải cộng tất cả các nhóm đó
    const total =
      type === 'all'
        ? groups.reduce((s, g) => s + g.count, 0)
        : type === 'entry'
          ? groups.filter((g) => g.type.startsWith('entry:')).reduce((s, g) => s + g.count, 0)
          : (groups.find((g) => g.type === type)?.count ?? 0);
    const data = await this.hydrate(rows, locale, fallback);
    return { data, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, groups };
  }

  /** Nhãn nhóm: trang / bài viết / sản phẩm / tên loại nội dung theo locale */
  private async groupLabels(rows: { type: SearchHitType; ctype: string | null; count: number }[], locale: string, fallback: string): Promise<SearchGroup[]> {
    const keys = rows.filter((r) => r.type === 'entry' && r.ctype).map((r) => r.ctype!);
    const types = keys.length ? await this.prisma.contentType.findMany({ where: { key: { in: keys } }, select: { key: true, labels: true, sortOrder: true } }) : [];
    const order = ['page', 'post', 'product'];
    return rows
      .map((r) => {
        if (r.type !== 'entry') return { type: r.type, label: GROUP_LABELS[r.type][locale] ?? GROUP_LABELS[r.type].vi, count: r.count, sort: order.indexOf(r.type) };
        const ct = types.find((t) => t.key === r.ctype);
        const labels = (ct?.labels ?? {}) as Record<string, { plural?: string; singular?: string }>;
        const label = labels[locale]?.plural || labels[fallback]?.plural || Object.values(labels)[0]?.plural || r.ctype || 'entry';
        return { type: `entry:${r.ctype}`, label, count: r.count, sort: 10 + (ct?.sortOrder ?? 0) };
      })
      .sort((a, b) => a.sort - b.sort)
      .map(({ sort: _s, ...g }) => g);
  }

  /** Lấy tiêu đề, mô tả, ảnh, đường dẫn cho các id đã xếp hạng (giữ thứ tự) */
  private async hydrate(rows: RankRow[], locale: string, fallback: string): Promise<SearchHit[]> {
    const ids = (t: SearchHitType) => rows.filter((r) => r.type === t).map((r) => r.id);
    const pick = <T extends { locale: string }>(list: T[]) => list.find((x) => x.locale === locale) ?? list.find((x) => x.locale === fallback) ?? list[0];
    const path = (...seg: (string | null | undefined)[]) => joinPublicPath(locale, fallback, ...seg);
    const out = new Map<string, SearchHit>();

    const [pages, posts, products, entries, general] = await Promise.all([
      ids('page').length ? this.prisma.page.findMany({ where: { id: { in: ids('page') } }, select: { id: true, featuredImageId: true, translations: { select: { locale: true, title: true, slug: true, excerpt: true, seoDescription: true } } } }) : [],
      ids('post').length ? this.prisma.post.findMany({ where: { id: { in: ids('post') } }, select: { id: true, featuredImageId: true, translations: { select: { locale: true, title: true, slug: true, excerpt: true, content: true } } } }) : [],
      ids('product').length ? this.prisma.product.findMany({ where: { id: { in: ids('product') } }, include: PRODUCT_CARD_INCLUDE }) : [],
      ids('entry').length
        ? this.prisma.entry.findMany({ where: { id: { in: ids('entry') } }, select: { id: true, featuredImageId: true, type: { select: { key: true, slugs: true } }, translations: { select: { locale: true, title: true, slug: true, excerpt: true, content: true } } } })
        : [],
      this.settings.get<{ homepageId?: string }>('general'),
    ]);
    const media = await this.media.findMany([...pages, ...posts, ...entries].map((r) => r.featuredImageId).concat(products.flatMap((p) => [p.featuredImageId, p.galleryIds[0]])));
    const img = (id: string | null | undefined): MediaRef | null => {
      const m = id ? media.get(id) : undefined;
      return m ? { id: m.id, url: m.url, alt: ((m.alt ?? {}) as Record<string, string>)[locale] ?? '', width: m.width ?? undefined, height: m.height ?? undefined } : null;
    };

    for (const p of pages) {
      const tr = pick(p.translations);
      if (!tr) continue;
      out.set(`page:${p.id}`, { type: 'page', id: p.id, title: tr.title, excerpt: tr.excerpt || tr.seoDescription || null, path: p.id === general.homepageId ? path() : path(tr.slug), image: img(p.featuredImageId) });
    }
    for (const p of posts) {
      const tr = pick(p.translations);
      if (!tr) continue;
      out.set(`post:${p.id}`, { type: 'post', id: p.id, title: tr.title, excerpt: tr.excerpt || excerptFrom(tr.content, 180) || null, path: path('blog', tr.slug), image: img(p.featuredImageId) });
    }
    for (const p of products) {
      const card = presentProductCard(p, locale, fallback, media);
      out.set(`product:${p.id}`, { type: 'product', id: p.id, title: card.name, excerpt: card.shortDescription ? excerptFrom(card.shortDescription, 180) : null, path: path('products', card.slug), image: img(p.featuredImageId ?? p.galleryIds[0]), price: card.price, salePrice: card.salePrice });
    }
    for (const e of entries) {
      const tr = pick(e.translations);
      if (!tr) continue;
      const slugs = (e.type.slugs ?? {}) as Record<string, string>;
      const typeSlug = slugs[locale] || slugs[fallback] || e.type.key;
      out.set(`entry:${e.id}`, { type: 'entry', contentType: e.type.key, id: e.id, title: tr.title, excerpt: tr.excerpt || excerptFrom(tr.content, 180) || null, path: path(typeSlug, tr.slug), image: img(e.featuredImageId) });
    }
    return rows.map((r) => out.get(`${r.type}:${r.id}`)).filter((x): x is SearchHit => !!x);
  }
}
