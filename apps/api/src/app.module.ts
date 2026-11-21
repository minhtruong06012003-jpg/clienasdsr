import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SchedulerModule } from './modules/scheduler/scheduler.module.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { DemoModeGuard } from './common/guards/demo-mode.guard.js';
import { SerializeInterceptor } from './common/interceptors/serialize.interceptor.js';
import { PublicCacheInterceptor } from './common/interceptors/public-cache.interceptor.js';
import { ContactMaskInterceptor } from './common/interceptors/contact-mask.interceptor.js';
import { AppThrottlerGuard, throttleOptionsFromEnv } from './common/guards/app-throttler.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { LanguagesModule } from './modules/languages/languages.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { MailModule } from './modules/mail/mail.module.js';
import { ActivityModule } from './modules/activity/activity.service.js';
import { EventsModule } from './modules/events/revalidate.listener.js';
import { MediaModule } from './modules/media/media.module.js';
import { HooksModule } from './modules/hooks/hooks.module.js';
import { BlocksModule } from './modules/blocks/blocks.module.js';
import { PagesModule } from './modules/pages/pages.module.js';
import { PostsModule } from './modules/posts/posts.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { MenusModule } from './modules/menus/menus.module.js';
import { SeoModule } from './modules/seo/seo.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { AccountModule } from './modules/account/account.module.js';
import { PublicModule } from './modules/public/public.module.js';
import { ToolsModule } from './modules/tools/tools.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { CommentsModule } from './modules/comments/comments.module.js';
import { PreviewModule } from './modules/preview/preview.module.js';
import { ShippingModule } from './modules/shipping/shipping.module.js';
import { DownloadsModule } from './modules/downloads/downloads.module.js';
import { DigitalCodesModule } from './modules/digital-codes/digital-codes.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { SecurityModule } from './modules/security/security.module.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { SystemLogsModule } from './modules/system-logs/system-logs.module.js';
import { TaxModule } from './modules/tax/tax.module.js';
import { EInvoiceModule } from './modules/einvoice/einvoice.module.js';
import { LogsModule } from './modules/logs/logs.module.js';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { ThemeTemplatesModule } from './modules/theme-templates/theme-templates.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { ApiKeysModule } from './modules/api-keys/api-keys.module.js';
import { EditLocksModule } from './modules/edit-locks/edit-locks.module.js';
import { WishlistModule } from './modules/wishlist/wishlist.module.js';
import { CartsModule } from './modules/carts/carts.module.js';
import { PaymentGatewaysModule } from './modules/payment-gateways/payment-gateways.module.js';
import { CardTopupModule } from './modules/card-topup/card-topup.module.js';
import { EmailNotificationsModule } from './modules/email-notifications/email-notifications.module.js';
import { CreditsModule } from './modules/credits/credits.module.js';
import { AffiliateModule } from './modules/affiliate/affiliate.module.js';
import { AnnouncementsModule } from './modules/announcements/announcements.module.js';
import { TicketsModule } from './modules/tickets/tickets.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { ChildPanelsModule } from './modules/child-panels/child-panels.module.js';
import { TelegramModule } from './modules/telegram/telegram.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 50 }),
    // giới hạn request toàn cục: THROTTLE_LIMIT / THROTTLE_TTL (mặc định 300 request / 60 giây mỗi IP)
    ThrottlerModule.forRoot(throttleOptionsFromEnv()),
    PrismaModule,
    SchedulerModule,
    MailModule,
    SettingsModule,
    LanguagesModule,
    AuthModule,
    ApiKeysModule,
    EditLocksModule,
    PaymentsModule,
    HooksModule,
    MediaModule,
    CustomFieldsModule,
    ContentModule,
    ThemeTemplatesModule,
    SearchModule,
    BlocksModule,
    UsersModule,
    RolesModule,
    ActivityModule,
    EventsModule,
    PagesModule,
    PostsModule,
    ProductsModule,
    OrdersModule,
    MenusModule,
    SeoModule,
    DashboardModule,
    AccountModule,
    PublicModule,
    ToolsModule,
    ReviewsModule,
    CommentsModule,
    PreviewModule,
    ShippingModule,
    DownloadsModule,
    DigitalCodesModule,
    ReportsModule,
    AnalyticsModule,
    SecurityModule,
    WalletModule,
    SystemLogsModule,
    TaxModule,
    EInvoiceModule,
    LogsModule,
    WishlistModule,
    CartsModule,
    // module tích hợp sẵn (trước đây là plugin): cổng thanh toán, email thông báo, webhook
    PaymentGatewaysModule,
    // Nạp thẻ cào vào ví (Card24h, TheSieuRe... chuẩn chargingws/v2)
    CardTopupModule,
    EmailNotificationsModule,
    // AI Studio: credits & gói cước, tiếp thị liên kết, công cụ AI
    CreditsModule,
    AffiliateModule,
    AnnouncementsModule,
    TicketsModule,
    AiModule,
    ChildPanelsModule,
    // Bot Telegram báo khách + báo quản trị (cảnh báo nguồn API hết tiền)
    TelegramModule,
  ],
  controllers: [HealthController],
  providers: [
    // miễn giới hạn toàn cục cho API key hợp lệ / x-server-secret (frontend SSR), giữ @Throttle riêng của từng route
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // chế độ demo: chặn mọi thao tác thêm/sửa/xoá (trừ vai trò Nhà phát triển) — đặt sau JwtAuthGuard để có req.user
    { provide: APP_GUARD, useClass: DemoModeGuard },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
    // Cache-Control cho GET /api/public/* (CDN cache được dữ liệu công khai; endpoint cá nhân hoá -> no-store)
    { provide: APP_INTERCEPTOR, useClass: PublicCacheInterceptor },
    // web con: che email / SĐT khách với tài khoản cộng tác viên (chỉ xem)
    { provide: APP_INTERCEPTOR, useClass: ContactMaskInterceptor },
    // bắt mọi exception: trả response chuẩn + ghi nhật ký lỗi (lỗi Prisma đổi mã qua PrismaExceptionFilter)
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
