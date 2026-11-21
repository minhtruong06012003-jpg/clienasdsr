import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { LanguagesService } from '../languages/languages.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MediaService } from '../media/media.service.js';
import { MenusModule, MenusService } from '../menus/menus.module.js';
import { HooksService } from '../hooks/hooks.service.js';
import { PostsModule } from '../posts/posts.module.js';
import { PostsService } from '../posts/posts.service.js';
import { ProductsModule } from '../products/products.module.js';
import { ProductsService } from '../products/products.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { CaptchaService } from '../security/captcha.service.js';
import { ContentModule } from '../content/content.module.js';
import { ContentPublicService } from '../content/content-public.service.js';
import { ThemeTemplatesModule } from '../theme-templates/theme-templates.module.js';
import { ThemeTemplatesService } from '../theme-templates/theme-templates.service.js';
import { Throttle } from '@nestjs/throttler';
import { readFeatures } from '@cmsnt/shared';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { SearchModule } from '../search/search.module.js';
import { SearchService } from '../search/search.service.js';
import { PRODUCT_CARD_INCLUDE, presentProductCard } from '../products/products.presenter.js';
import { POST_CARD_INCLUDE, presentPostCard } from '../posts/posts.presenter.js';

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly menus: MenusService,
    private readonly hooks: HooksService,
    private readonly posts: PostsService,
    private readonly products: ProductsService,
    private readonly payments: PaymentsService,
    private readonly captcha: CaptchaService,
    private readonly content: ContentPublicService,
    private readonly templates: ThemeTemplatesService,
    private readonly siteSearch: SearchService,
  ) {}

  /** Mọi thứ storefront cần cho layout: cài đặt (gồm mã theo dõi, nút liên hệ), ngôn ngữ, menu, phương thức thanh toán */
  async bootstrap(localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    const [settings, languages, defaultLocale, menus, paymentMethods, captcha, contentTypes, themeTemplates] = await Promise.all([
      this.settings.publicSettings(),
      this.languages.list(true),
      this.languages.defaultLocale(),
      this.menus.publicMenus(locale),
      this.payments.methods(locale),
      // captcha: chỉ provider + site key + form đang bật (không có secret)
      this.captcha.publicConfig(),
      // loại nội dung tuỳ biến public (menu, link lưu trữ) + chỉ mục mẫu Theme Builder đang bật
      this.content.bootstrapTypes(locale),
      this.templates.index(),
    ]);
    // thay id media bằng object có url
    const g = settings.general as Record<string, unknown>;
    const seo = settings.seo as Record<string, unknown>;
    const mediaMap = await this.media.findMany([g.logo, g.logoDark, g.favicon, seo.defaultOgImage, seo.organizationLogo] as string[]);
    for (const k of ['logo', 'logoDark', 'favicon']) g[k] = mediaMap.get(g[k] as string) ?? null;
    for (const k of ['defaultOgImage', 'organizationLogo']) seo[k] = mediaMap.get(seo[k] as string) ?? null;
    // đăng nhập bằng Google: chỉ báo bật khi đã có Client ID (frontend dùng clientId để hiện nút Google)
    const acc = (settings.account ?? {}) as { googleLoginEnabled?: boolean; googleClientId?: string };
    const googleClientId = String(acc.googleClientId ?? '').trim();
    const auth = { google: { enabled: acc.googleLoginEnabled === true && !!googleClientId, clientId: googleClientId } };
    return this.hooks.applyFilters('public.bootstrap', { locale, defaultLocale, languages, settings, menus, paymentMethods, captcha, contentTypes, themeTemplates, auth }, { locale });
  }

  /**
   * Tìm nhanh cho ô tìm kiếm của frontend riêng — GIỮ shape { products, posts } (thẻ như publicList).
   * Xếp hạng + không dấu nhờ SearchService (unaccent), rồi trình bày bằng presenter sẵn có theo đúng thứ tự.
   */
  async search(q: string, localeInput?: string) {
    const term = q?.trim().slice(0, 200);
    if (!term) return { products: [], posts: [] };
    const locale = await this.languages.resolve(localeInput);
    const fallback = await this.languages.defaultLocale();
    const features = readFeatures(await this.settings.get('features'));
    const [productIds, postIds] = await Promise.all([
      features.shop ? this.siteSearch.rankedIds('product', term, locale, 8) : Promise.resolve([] as string[]),
      features.blog ? this.siteSearch.rankedIds('post', term, locale, 6) : Promise.resolve([] as string[]),
    ]);
    const [productRows, postRows] = await Promise.all([
      productIds.length ? this.prisma.product.findMany({ where: { id: { in: productIds } }, include: PRODUCT_CARD_INCLUDE }) : [],
      postIds.length ? this.prisma.post.findMany({ where: { id: { in: postIds } }, include: POST_CARD_INCLUDE }) : [],
    ]);
    const media = await this.media.findMany([...productRows.flatMap((r) => [r.featuredImageId, r.galleryIds[0]]), ...postRows.map((r) => r.featuredImageId)]);
    const byOrder = <T extends { id: string }>(ids: string[], rows: T[]) => ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is T => !!r);
    return {
      products: byOrder(productIds, productRows).map((r) => presentProductCard(r, locale, fallback, media)),
      posts: byOrder(postIds, postRows).map((r) => presentPostCard(r, locale, fallback, media)),
    };
  }
}

@Controller('public')
export class PublicController {
  constructor(private readonly pub: PublicService) {}

  @Public()
  @Get('bootstrap')
  bootstrap(@Query('locale') locale?: string) {
    return this.pub.bootstrap(locale);
  }

  @Public()
  @RequireFeature('search')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get('search')
  search(@Query('q') q: string, @Query('locale') locale?: string) {
    return this.pub.search(q, locale);
  }
}

@Module({ imports: [MenusModule, PostsModule, ProductsModule, ContentModule, ThemeTemplatesModule, SearchModule], controllers: [PublicController], providers: [PublicService] })
export class PublicModule {}
