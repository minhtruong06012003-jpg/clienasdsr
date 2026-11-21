import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { PRODUCT_CARD_INCLUDE, presentProductCard, publishedProductWhere } from '../products/products.presenter.js';
import { POST_CARD_INCLUDE, presentPostCard, publishedPostWhere } from '../posts/posts.presenter.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TemplateListing } from '@cmsnt/shared';
import { TemplateContextService, type FullTemplateRecord } from '../theme-templates/template-context.service.js';

export interface BlockNode {
  id: string;
  type: string;
  data?: Record<string, any>;
  settings?: Record<string, unknown>;
  resolved?: Record<string, unknown>;
}

/**
 * Ngữ cảnh bản ghi chứa block:
 * - trang thường: entity + customFields để block "Trường tuỳ chỉnh" đọc giá trị của chính trang
 * - mẫu Theme Builder: record (bản ghi đang xem) / listing (danh sách lưu trữ) cho block động
 */
export interface ResolveContext {
  entity?: string;
  customFields?: Record<string, unknown>;
  customFieldGroups?: { key: string; name: string; fields: { key: string; label: string; type: string }[] }[];
  /** bản ghi đang hiển thị (mẫu single / lưu trữ theo phân loại) */
  record?: FullTemplateRecord | null;
  /** danh sách đang hiển thị (mẫu archive / search) */
  listing?: TemplateListing | null;
  /** trang hiện tại (phân trang query-loop nguồn "query") */
  page?: number;
}

/** Block động của Theme Builder chỉ cần record */
const RECORD_BLOCKS = ['dynamic-title', 'dynamic-meta', 'storefront-slot'];

/**
 * Gắn dữ liệu động cho block trước khi render (sản phẩm, bài viết, form, global block...).
 * Dùng cho cả storefront (public) và canvas của page builder trong admin.
 */
@Injectable()
export class BlockResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly templateData: TemplateContextService,
  ) {}

  async resolve(blocks: unknown, localeInput?: string, depth = 0, mode: 'view' | 'edit' = 'view', ctx: ResolveContext = {}): Promise<BlockNode[]> {
    if (!Array.isArray(blocks) || depth > 4) return [];
    const locale = await this.languages.resolve(localeInput);
    const fallback = await this.languages.defaultLocale();
    const out: BlockNode[] = [];
    for (const raw of blocks as BlockNode[]) {
      if (!raw || typeof raw !== 'object' || !raw.type) continue;
      const block: BlockNode = { ...raw, data: { ...(raw.data ?? {}) } };
      try {
        block.resolved = await this.resolveOne(block, locale, fallback, depth, mode, ctx);
      } catch {
        block.resolved = {};
      }
      // block lồng nhau (columns / tabs...)
      if (Array.isArray(block.data!.columns)) {
        block.data!.columns = await Promise.all(
          block.data!.columns.map(async (c: { blocks?: unknown }) => ({ ...c, blocks: await this.resolve(c?.blocks ?? [], locale, depth + 1, mode, ctx) })),
        );
      }
      out.push(await this.hooks.applyFilters('block.resolve', block, { locale, ctx }));
    }
    return out;
  }

  private async resolveOne(block: BlockNode, locale: string, fallback: string, depth: number, mode: 'view' | 'edit', ctx: ResolveContext): Promise<Record<string, unknown> | undefined> {
    const d = block.data ?? {};
    switch (block.type) {
      case 'product-grid':
      case 'product-carousel':
        return { products: await this.products(d, locale, fallback) };
      case 'post-list':
        return { posts: await this.posts(d, locale, fallback) };
      case 'category-grid':
        return { categories: await this.categories(d, locale, fallback) };
      case 'global-block': {
        if (!d.blockKey) return {};
        const gb = await this.prisma.globalBlock.findFirst({ where: { key: d.blockKey, isActive: true }, include: { translations: true } });
        const tr = gb?.translations.find((t) => t.locale === locale) ?? gb?.translations.find((t) => t.locale === fallback);
        return { blocks: await this.resolve(tr?.blocks ?? [], locale, depth + 1, mode, ctx) };
      }
      case 'custom-fields': {
        // Giá trị trường tuỳ chỉnh của chính trang đang render: chọn nhóm (groupKey) hoặc toàn bộ; bỏ trường trống
        const groups = (ctx.customFieldGroups ?? []).filter((g) => !d.groupKey || g.key === d.groupKey);
        const values = ctx.customFields ?? {};
        const items = groups.flatMap((g) => g.fields.map((f) => ({ group: g.key, key: f.key, label: f.label, type: f.type, value: values[f.key] ?? null }))).filter((i) => i.value !== null && i.value !== '' && !(Array.isArray(i.value) && !i.value.length));
        return { items, groups: groups.map((g) => ({ key: g.key, name: g.name })), inEditor: mode === 'edit' && !ctx.customFieldGroups };
      }
      default:
        return this.resolveDynamic(block, d, locale, fallback, depth, mode, ctx);
    }
  }

  // ------------------------------------------------------------------ block động (Theme Builder)

  /** Record gửi ra ngoài: bỏ dữ liệu nội bộ (blocks thô, nhóm trường, id term) */
  private publicRecord(r: FullTemplateRecord | null | undefined) {
    if (!r) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { blocks, customFieldGroups, termIds, ...rest } = r;
    return rest;
  }

  private async resolveDynamic(block: BlockNode, d: Record<string, any>, locale: string, fallback: string, depth: number, mode: 'view' | 'edit', ctx: ResolveContext): Promise<Record<string, unknown> | undefined> {
    const record = this.publicRecord(ctx.record);
    const inEditor = mode === 'edit' && !ctx.record && !ctx.listing;
    if (RECORD_BLOCKS.includes(block.type)) return { record, ...(inEditor ? { inEditor } : {}) };
    switch (block.type) {
      case 'dynamic-content': {
        // entry / trang dựng bằng Page Builder → resolve đệ quy blocks của nó (record không gửi lại blocks thô;
        // bên trong bỏ blocks của record để dynamic-content lồng nhau không lặp lại chính nó)
        const raw = ctx.record?.blocks;
        const blocks = Array.isArray(raw) && raw.length ? await this.resolve(raw, locale, depth + 1, mode, { ...ctx, record: ctx.record ? { ...ctx.record, blocks: [] } : null, customFields: ctx.record?.customFields, customFieldGroups: ctx.record?.customFieldGroups }) : undefined;
        return { record, ...(blocks ? { blocks } : {}), ...(inEditor ? { inEditor } : {}) };
      }
      case 'dynamic-image': {
        let image: unknown = null;
        if (d.source === 'field' && d.fieldKey) image = await this.mediaValue(ctx.record?.customFields?.[d.fieldKey]);
        else image = ctx.record?.featuredImage ?? null;
        return { record, image, ...(inEditor ? { inEditor } : {}) };
      }
      case 'dynamic-field': {
        const key = String(d.fieldKey ?? '');
        const def = ctx.record?.customFieldGroups?.flatMap((g) => g.fields).find((f) => f.key === key) ?? null;
        let value: unknown = null;
        if (key && ctx.record) {
          if (key in (ctx.record.customFields ?? {})) value = ctx.record.customFields[key];
          // trường lõi của record (title, excerpt, price, publishedAt...) — trừ dữ liệu nội bộ
          else if (!['blocks', 'customFieldGroups', 'termIds'].includes(key) && key in ctx.record) value = (ctx.record as unknown as Record<string, unknown>)[key];
        }
        return { record, value: value ?? null, field: def ? { key: def.key, label: def.label, type: def.type } : null, ...(inEditor ? { inEditor } : {}) };
      }
      case 'breadcrumbs': {
        const items = ctx.record?.breadcrumbs ?? (ctx.listing ? [{ label: ctx.listing.title, path: ctx.listing.basePath }] : []);
        return { items, ...(inEditor ? { inEditor } : {}) };
      }
      case 'query-loop':
        return this.queryLoop(d, locale, fallback, ctx);
      case 'term-list': {
        if (!d.taxonomy) return { terms: [] };
        const terms = await this.templateData.publicTerms(String(d.taxonomy), { locale, fallback, parentOnly: !!d.parentOnly, ids: Array.isArray(d.termIds) ? d.termIds : undefined, limit: Number(d.limit) || undefined, hideEmpty: !!d.hideEmpty });
        return { terms };
      }
      case 'entry-list': {
        if (!d.contentType) return { items: [] };
        const ids: string[] = Array.isArray(d.entryIds) ? d.entryIds : [];
        if (d.source === 'manual' && ids.length) return { items: await this.templateData.entriesByIds(ids, locale, fallback) };
        const r = await this.templateData.queryEntries(
          { types: [String(d.contentType)], termIds: Array.isArray(d.termIds) ? d.termIds : undefined, featuredOnly: !!d.featuredOnly, orderBy: d.orderBy, limit: Math.min(Number(d.limit) || 6, 48), excludeIds: ctx.record?.entity === 'entry' ? [ctx.record.id] : undefined },
          locale,
          fallback,
        );
        return { items: r.items };
      }
      default:
        return undefined;
    }
  }

  /** Giá trị trường ảnh: đã là MediaRef (present của custom fields) hoặc id media */
  private async mediaValue(v: unknown): Promise<unknown> {
    if (!v) return null;
    if (Array.isArray(v)) return this.mediaValue(v[0]);
    if (typeof v === 'object' && 'url' in (v as object)) return v;
    if (typeof v === 'string') return (await this.media.findMany([v])).get(v) ?? null;
    return null;
  }

  /**
   * Vòng lặp truy vấn: nguồn "current" dùng listing của trang lưu trữ đang xem;
   * nguồn "query" (hoặc không có listing) tự truy vấn entry / post / product theo data.
   */
  private async queryLoop(d: Record<string, any>, locale: string, fallback: string, ctx: ResolveContext) {
    if ((d.source ?? 'current') === 'current' && ctx.listing) {
      const l = ctx.listing;
      return { items: l.items, itemKind: l.itemKind, page: l.page, totalPages: l.totalPages, total: l.total, basePath: l.basePath };
    }
    const contentType = String(d.contentType || (ctx.record?.entity === 'entry' ? ctx.record.target.slice(6) : '') || 'post');
    const limit = Math.min(Number(d.limit) || 6, 48);
    const page = d.pagination ? Math.max(ctx.page ?? 1, 1) : 1;
    const termIds: string[] | undefined = Array.isArray(d.termIds) && d.termIds.length ? d.termIds : undefined;
    // không lặp lại chính bản ghi đang xem (vd "bài liên quan")
    const excludeIds = ctx.record?.id ? [ctx.record.id] : undefined;
    const common = { limit, page, featuredOnly: !!d.featuredOnly, orderBy: d.orderBy, excludeIds };
    if (contentType === 'post') {
      const r = await this.templateData.queryPosts({ ...common, categoryIds: termIds }, locale, fallback);
      return { items: r.items, itemKind: 'post', page: r.page, totalPages: r.totalPages, total: r.total, basePath: null };
    }
    if (contentType === 'product') {
      const r = await this.templateData.queryProducts({ ...common, categoryIds: termIds }, locale, fallback);
      return { items: r.items, itemKind: 'product', page: r.page, totalPages: r.totalPages, total: r.total, basePath: null };
    }
    const r = await this.templateData.queryEntries({ ...common, types: [contentType], termIds }, locale, fallback);
    return { items: r.items, itemKind: 'entry', page: r.page, totalPages: r.totalPages, total: r.total, basePath: null };
  }

  private async products(d: Record<string, any>, locale: string, fallback: string) {
    const limit = Math.min(Number(d.limit) || 8, 48);
    const where: Prisma.ProductWhereInput = publishedProductWhere();
    let orderBy: Prisma.ProductOrderByWithRelationInput = { createdAt: 'desc' };
    switch (d.source) {
      case 'featured':
        where.isFeatured = true;
        break;
      case 'best_selling':
        orderBy = { soldCount: 'desc' };
        break;
      case 'on_sale':
        where.salePrice = { not: null };
        break;
      case 'category':
        if (d.categoryId) where.categories = { some: { categoryId: d.categoryId } };
        break;
      case 'manual':
        if (Array.isArray(d.productIds) && d.productIds.length) where.id = { in: d.productIds };
        else return [];
        break;
    }
    const rows = await this.prisma.product.findMany({ where, orderBy, take: limit, include: PRODUCT_CARD_INCLUDE });
    if (d.source === 'manual') rows.sort((a, b) => d.productIds.indexOf(a.id) - d.productIds.indexOf(b.id));
    const mediaMap = await this.media.findMany(rows.flatMap((r) => [r.featuredImageId, r.galleryIds[0]]));
    return rows.map((r) => presentProductCard(r, locale, fallback, mediaMap));
  }

  private async posts(d: Record<string, any>, locale: string, fallback: string) {
    const limit = Math.min(Number(d.limit) || 6, 30);
    const where: Prisma.PostWhereInput = { ...publishedPostWhere(), translations: { some: { locale } } };
    if (d.source === 'featured') where.isFeatured = true;
    if (d.source === 'category' && d.categoryId) where.categories = { some: { categoryId: d.categoryId } };
    const rows = await this.prisma.post.findMany({ where, orderBy: { publishedAt: 'desc' }, take: limit, include: POST_CARD_INCLUDE });
    const mediaMap = await this.media.findMany(rows.map((r) => r.featuredImageId));
    return rows.map((r) => presentPostCard(r, locale, fallback, mediaMap));
  }

  private async categories(d: Record<string, any>, locale: string, fallback: string) {
    const ids: string[] = Array.isArray(d.categoryIds) ? d.categoryIds : [];
    const rows = await this.prisma.productCategory.findMany({
      where: { isActive: true, ...(ids.length ? { id: { in: ids } } : { parentId: null }) },
      orderBy: { sortOrder: 'asc' },
      take: Math.min(Number(d.limit) || 8, 24),
      include: { translations: true, _count: { select: { products: true } } },
    });
    const mediaMap = await this.media.findMany(rows.map((r) => r.imageId));
    return rows.map((r) => {
      const tr = r.translations.find((t) => t.locale === locale) ?? r.translations.find((t) => t.locale === fallback);
      return { id: r.id, name: tr?.name ?? '', slug: tr?.slug ?? '', description: tr?.description, image: mediaMap.get(r.imageId ?? '') ?? null, productCount: r._count.products };
    });
  }
}
