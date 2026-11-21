import { Body, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { PagesService } from '../pages/pages.service.js';
import { PostsService } from '../posts/posts.service.js';
import { PostTermsService } from '../posts/terms.service.js';
import { ProductsService } from '../products/products.service.js';
import { ProductCategoriesService } from '../products/product-categories.service.js';
import { PagesModule } from '../pages/pages.module.js';
import { PostsModule } from '../posts/posts.module.js';
import { ProductsModule } from '../products/products.module.js';
import { ContentModule } from '../content/content.module.js';
import { ContentPublicService } from '../content/content-public.service.js';
import { ContentTermsService } from '../content/content-terms.service.js';
import { slugFor } from '../content/content.util.js';
import { joinPublicPath } from '@cmsnt/shared';

class RedirectDto {
  @IsString() fromPath: string;
  @IsString() toPath: string;
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([301, 302, 307, 308, 410]) statusCode?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Chia trang sitemap: không truyền gì = trả toàn bộ như cũ; `limit` tối đa 50.000 URL/trang (giới hạn của chuẩn sitemap) */
class SitemapQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50_000) limit?: number;
}

/** Giữ kết quả sitemap trong bộ nhớ 5 phút (xoá ngay khi có sự kiện content.changed) */
const SITEMAP_CACHE_MS = 5 * 60_000;
/** Số mục mỗi trang khi chỉ truyền `page` */
const SITEMAP_DEFAULT_LIMIT = 5000;

const normalizePath = (p: string) => {
  let path = p.trim();
  try {
    if (/^https?:\/\//.test(path)) path = new URL(path).pathname;
  } catch {
    /* giữ nguyên */
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
};

type SitemapData = Awaited<ReturnType<SeoService['buildSitemap']>>;

@Injectable()
export class SeoService {
  /** cache sitemap trong tiến trình (mỗi instance giữ riêng, hết hạn sau SITEMAP_CACHE_MS) */
  private sitemapCache: { at: number; data: SitemapData } | null = null;
  /** lượt dựng sitemap đang chạy — nhiều request cùng lúc dùng chung */
  private sitemapLoading: Promise<SitemapData> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly pages: PagesService,
    private readonly posts: PostsService,
    private readonly terms: PostTermsService,
    private readonly products: ProductsService,
    private readonly productCategories: ProductCategoriesService,
    private readonly events: EventEmitter2,
    private readonly content: ContentPublicService,
    private readonly contentTerms: ContentTermsService,
  ) {}

  async redirects(q: PaginationQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where = q.search ? { OR: [{ fromPath: { contains: q.search } }, { toPath: { contains: q.search } }] } : {};
    const [data, total] = await Promise.all([this.prisma.redirect.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }), this.prisma.redirect.count({ where })]);
    return paginate(data, total, page, limit);
  }

  async saveRedirect(id: string | undefined, dto: RedirectDto) {
    const data = { ...dto, fromPath: normalizePath(dto.fromPath), toPath: /^https?:\/\//.test(dto.toPath) ? dto.toPath.trim() : normalizePath(dto.toPath) };
    const r = id ? await this.prisma.redirect.update({ where: { id }, data }) : await this.prisma.redirect.create({ data });
    this.events.emit('content.changed', { type: 'redirect', tags: ['redirects'] });
    return r;
  }

  async removeRedirect(id: string) {
    await this.prisma.redirect.delete({ where: { id } });
    this.events.emit('content.changed', { type: 'redirect', tags: ['redirects'] });
    return { success: true };
  }

  publicRedirects() {
    return this.prisma.redirect.findMany({ where: { isActive: true }, select: { fromPath: true, toPath: true, statusCode: true } });
  }

  async hit(fromPath: string) {
    await this.prisma.redirect.updateMany({ where: { fromPath: normalizePath(fromPath) }, data: { hits: { increment: 1 } } });
    return { success: true };
  }

  /** Nội dung đổi (bài, sản phẩm, trang, ngôn ngữ...) -> bỏ cache sitemap để lần gọi sau dựng lại */
  @OnEvent('content.changed')
  onContentChanged() {
    this.sitemapCache = null;
    this.sitemapLoading = null;
  }

  /**
   * Dữ liệu thô cho sitemap.xml (frontend riêng tự dựng URL + hreflang), có cache 5 phút.
   * - Không truyền page/limit: trả toàn bộ `{ languages, defaultLocale, entries }` (giữ nguyên response cũ).
   * - Có page/limit: trả một trang `entries` kèm `meta { page, limit, total, totalPages }` — frontend dựng
   *   sitemap index (sitemap-1.xml, sitemap-2.xml...) cho site lớn.
   */
  async sitemap(q: { page?: number; limit?: number } = {}) {
    const data = await this.cachedSitemap();
    if (q.page === undefined && q.limit === undefined) return data;
    const limit = q.limit ?? SITEMAP_DEFAULT_LIMIT;
    const page = q.page ?? 1;
    const total = data.entries.length;
    return {
      languages: data.languages,
      defaultLocale: data.defaultLocale,
      entries: data.entries.slice((page - 1) * limit, page * limit),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  private async cachedSitemap(): Promise<SitemapData> {
    if (this.sitemapCache && Date.now() - this.sitemapCache.at < SITEMAP_CACHE_MS) return this.sitemapCache.data;
    if (this.sitemapLoading) return this.sitemapLoading;
    const loading = this.buildSitemap();
    this.sitemapLoading = loading;
    try {
      const data = await loading;
      // nội dung đổi trong lúc đang dựng (onContentChanged đã chạy) thì không lưu bản có thể đã cũ
      if (this.sitemapLoading === loading) this.sitemapCache = { at: Date.now(), data };
      return data;
    } finally {
      if (this.sitemapLoading === loading) this.sitemapLoading = null;
    }
  }

  /** Dựng toàn bộ dữ liệu sitemap từ DB (không cache) */
  private async buildSitemap() {
    const [languages, defaultLocale, pages, posts, postCategories, products, productCategories, contentEntries, contentTerms, contentArchives] = await Promise.all([
      this.languages.codes(),
      this.languages.defaultLocale(),
      this.pages.sitemapEntries(),
      this.posts.sitemapEntries(),
      this.terms.sitemapCategories(),
      this.products.sitemapEntries(),
      this.productCategories.sitemapEntries(),
      this.content.sitemapEntries(),
      this.contentTerms.sitemapEntries(),
      this.content.sitemapArchives(),
    ]);
    const images = await this.media.findMany([...posts.map((p) => p.featuredImageId), ...products.map((p) => p.featuredImageId), ...contentEntries.map((e) => e.featuredImageId)]);
    const img = (id: string | null) => images.get(id ?? '')?.url ?? null;
    return {
      languages,
      defaultLocale,
      entries: [
        ...pages.map((p) => ({ type: p.isHomepage ? 'home' : 'page', updatedAt: p.updatedAt, translations: p.translations.filter((t) => !t.noindex), image: null })),
        ...posts.map((p) => ({ type: 'post', updatedAt: p.updatedAt, translations: p.translations.filter((t) => !t.noindex), image: img(p.featuredImageId) })),
        ...postCategories.map((c) => ({ type: 'post_category', updatedAt: c.updatedAt, translations: c.translations, image: null })),
        ...products.map((p) => ({ type: 'product', updatedAt: p.updatedAt, translations: p.translations.filter((t) => !t.noindex), image: img(p.featuredImageId) })),
        ...productCategories.map((c) => ({ type: 'product_category', updatedAt: c.updatedAt, translations: c.translations, image: null })),
        // Loại nội dung tuỳ biến: `path` (đã có tiền tố ngôn ngữ) tính sẵn vì đường dẫn gồm slug loại / taxonomy theo locale.
        // `contentType` / `taxonomy` để frontend bỏ URL khi loại bị tắt.
        ...contentArchives.map((t) => ({
          type: 'content_type',
          contentType: t.key,
          updatedAt: null,
          translations: languages.map((l) => ({ locale: l, slug: slugFor(t.slugs, l, defaultLocale, t.key), path: joinPublicPath(l, defaultLocale, slugFor(t.slugs, l, defaultLocale, t.key)) })),
          image: null,
        })),
        ...contentEntries.map((e) => ({
          type: 'entry',
          contentType: e.type.key,
          updatedAt: e.updatedAt,
          translations: e.translations
            .filter((t) => !t.noindex && languages.includes(t.locale))
            .map((t) => ({ locale: t.locale, slug: t.slug, path: joinPublicPath(t.locale, defaultLocale, slugFor(e.type.slugs, t.locale, defaultLocale, e.type.key), t.slug) })),
          image: img(e.featuredImageId),
        })),
        ...contentTerms.map((t) => ({
          type: 'term',
          taxonomy: t.taxonomy.key,
          updatedAt: t.updatedAt,
          translations: t.translations
            .filter((tr) => languages.includes(tr.locale))
            .map((tr) => ({ locale: tr.locale, slug: tr.slug, path: joinPublicPath(tr.locale, defaultLocale, slugFor(t.taxonomy.slugs, tr.locale, defaultLocale, t.taxonomy.key), tr.slug) })),
          image: null,
        })),
      ].filter((e) => e.translations.length),
    };
  }

  /** Kiểm tra nhanh tình trạng SEO toàn site */
  async audit() {
    const [pagesNoDesc, postsNoDesc, productsNoDesc, productsNoImage, postsNoImage, mediaNoAlt] = await Promise.all([
      this.prisma.pageTranslation.count({ where: { OR: [{ seoDescription: null }, { seoDescription: '' }], page: { deletedAt: null, status: 'PUBLISHED' } } }),
      this.prisma.postTranslation.count({ where: { OR: [{ seoDescription: null }, { seoDescription: '' }], post: { deletedAt: null, status: 'PUBLISHED' } } }),
      this.prisma.productTranslation.count({ where: { OR: [{ seoDescription: null }, { seoDescription: '' }], product: { deletedAt: null, status: 'PUBLISHED' } } }),
      this.prisma.product.count({ where: { deletedAt: null, status: 'PUBLISHED', featuredImageId: null } }),
      this.prisma.post.count({ where: { deletedAt: null, status: 'PUBLISHED', featuredImageId: null } }),
      this.prisma.media.count({ where: { mimeType: { startsWith: 'image/' }, alt: { equals: {} } } }),
    ]);
    return { pagesNoDesc, postsNoDesc, productsNoDesc, productsNoImage, postsNoImage, mediaNoAlt };
  }
}

@Controller()
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  @RequirePermissions('seo.manage')
  @Get('admin/seo/redirects')
  redirects(@Query() q: PaginationQueryDto) {
    return this.seo.redirects(q);
  }

  @RequirePermissions('seo.manage')
  @Post('admin/seo/redirects')
  create(@Body() dto: RedirectDto) {
    return this.seo.saveRedirect(undefined, dto);
  }

  @RequirePermissions('seo.manage')
  @Patch('admin/seo/redirects/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RedirectDto) {
    return this.seo.saveRedirect(id, dto);
  }

  @RequirePermissions('seo.manage')
  @Delete('admin/seo/redirects/:id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.seo.removeRedirect(id);
  }

  @RequirePermissions('seo.manage')
  @Get('admin/seo/audit')
  audit() {
    return this.seo.audit();
  }

  @Public()
  @Get('public/redirects')
  publicRedirects() {
    return this.seo.publicRedirects();
  }

  @Public()
  @Post('public/redirects/hit')
  hit(@Body('path') path: string) {
    return this.seo.hit(path ?? '');
  }

  /** Sitemap: dựng nặng (quét mọi nội dung) nên giới hạn riêng chặt hơn mức toàn cục: 30 request / phút / IP */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('public/sitemap')
  sitemap(@Query() q: SitemapQueryDto) {
    return this.seo.sitemap(q);
  }
}

@Module({ imports: [PagesModule, PostsModule, ProductsModule, ContentModule], controllers: [SeoController], providers: [SeoService] })
export class SeoModule {}
