import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { IgnoreAuthHeader, Public } from '../../common/decorators/public.decorator.js';
import { MediaService } from '../media/media.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { isChildSite } from '../../common/utils/tenant.js';
import { DEVELOPER_ROLE, hasPermission } from '@cmsnt/shared';
import { logWriter } from '../logs/log-writer.js';
import * as argon2 from 'argon2';
import { AiOverviewService } from './ai-overview.service.js';
import { ProfitService } from './profit.service.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { TicketsService } from '../tickets/tickets.service.js';

export interface SetupStep {
  key: string;
  title: string;
  description: string;
  href: string;
  done: boolean;
  optional?: boolean;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly settings: SettingsService,
    private readonly tickets: TicketsService,
  ) {}

  async stats(days: number, user: AuthUser) {
    const canOrders = hasPermission(user.permissions, 'orders.read');
    const canReviews = hasPermission(user.permissions, 'reviews.manage');
    const canComments = hasPermission(user.permissions, 'comments.manage');
    const { lowStockThreshold = 5 } = await this.settings.get<{ lowStockThreshold?: number }>('commerce');
    const threshold = Number(lowStockThreshold) || 5;
    const since = new Date(Date.now() - days * 86400_000);
    const prevSince = new Date(Date.now() - 2 * days * 86400_000);
    const paidStatuses = { notIn: ['CANCELLED', 'REFUNDED'] as ('CANCELLED' | 'REFUNDED')[] };
    const [
      pages,
      posts,
      products,
      customers,
      ordersPeriod,
      ordersPrev,
      revenue,
      revenuePrev,
      pendingOrders,
      lowStock,
      recentOrders,
      topProducts,
      mediaStats,
      pendingReviews,
      pendingComments,
    ] = await Promise.all([
      this.prisma.page.count({ where: { deletedAt: null } }),
      this.prisma.post.count({ where: { deletedAt: null } }),
      this.prisma.product.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, role: { slug: 'customer' } } }),
      canOrders ? this.prisma.order.count({ where: { createdAt: { gte: since } } }) : 0,
      canOrders ? this.prisma.order.count({ where: { createdAt: { gte: prevSince, lt: since } } }) : 0,
      canOrders ? this.prisma.order.aggregate({ where: { createdAt: { gte: since }, status: paidStatuses }, _sum: { total: true } }) : { _sum: { total: 0 } },
      canOrders ? this.prisma.order.aggregate({ where: { createdAt: { gte: prevSince, lt: since }, status: paidStatuses }, _sum: { total: true } }) : { _sum: { total: 0 } },
      canOrders ? this.prisma.order.count({ where: { status: 'PENDING' } }) : 0,
      // sắp hết hàng: theo ngưỡng riêng của sản phẩm, nếu không có thì theo cài đặt bán hàng
      this.prisma.$queryRaw<{ id: string; sku: string | null; stockQuantity: number; name: string | null; total: bigint }[]>`
        SELECT p.id, p.sku, p."stockQuantity",
          (SELECT t.name FROM product_translations t WHERE t."productId" = p.id ORDER BY t.locale LIMIT 1) AS name,
          COUNT(*) OVER() AS total
        FROM products p
        WHERE p."deletedAt" IS NULL AND p."manageStock" = true AND p."stockQuantity" <= COALESCE(p."lowStockThreshold", ${threshold})
        ORDER BY p."stockQuantity" ASC LIMIT 8`,
      canOrders ? this.prisma.order.findMany({ take: 8, orderBy: { createdAt: 'desc' }, select: { id: true, code: true, customerName: true, total: true, status: true, paymentStatus: true, createdAt: true } }) : [],
      this.prisma.product.findMany({
        where: { deletedAt: null },
        take: 5,
        orderBy: { soldCount: 'desc' },
        select: { id: true, soldCount: true, featuredImageId: true, translations: { select: { name: true }, take: 1 } },
      }),
      this.media.stats(),
      canReviews ? this.prisma.productReview.count({ where: { status: 'PENDING' } }) : 0,
      canComments ? this.prisma.comment.count({ where: { status: 'PENDING' } }) : 0,
    ]);

    // doanh thu theo ngày
    const rows = !canOrders ? [] : await this.prisma.$queryRaw<{ day: Date; total: number; count: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COALESCE(SUM(total), 0)::float AS total, COUNT(*) AS count
      FROM orders
      WHERE "createdAt" >= ${since} AND status NOT IN ('CANCELLED', 'REFUNDED')
      GROUP BY 1 ORDER BY 1`;
    const chart: { date: string; revenue: number; orders: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      const row = rows.find((r) => new Date(r.day).toISOString().slice(0, 10) === key);
      chart.push({ date: key, revenue: row ? Number(row.total) : 0, orders: row ? Number(row.count) : 0 });
    }

    const rev = Number(revenue._sum.total ?? 0);
    const revPrev = Number(revenuePrev._sum.total ?? 0);
    const pct = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100));
    return {
      counts: { pages, posts, products, customers, media: mediaStats.count, mediaSize: mediaStats.totalSize },
      period: { days, orders: ordersPeriod, ordersChange: pct(ordersPeriod, ordersPrev), revenue: rev, revenueChange: pct(rev, revPrev) },
      alerts: { pendingOrders, pendingReviews, pendingComments, lowStock: Number(lowStock[0]?.total ?? 0) },
      chart,
      lowStock: lowStock.map((p) => ({ id: p.id, sku: p.sku, stockQuantity: Number(p.stockQuantity), name: p.name ?? '' })),
      recentOrders,
      topProducts: await this.media.attach(
        topProducts.map((p) => ({ id: p.id, soldCount: p.soldCount, featuredImageId: p.featuredImageId, name: p.translations[0]?.name ?? '' })),
        ['featuredImageId'],
      ),
    };
  }

  /** Số việc cần xử lý, hiện cạnh menu (sidebar gọi định kỳ) — chỉ đếm phần người dùng có quyền xem */
  async badges(user: AuthUser) {
    const can = (p: string) => hasPermission(user.permissions, p);
    const [pendingOrders, pendingReviews, pendingComments, einvoiceNeedsAction, digitalCodesAttention] = await Promise.all([
      can('orders.read') ? this.prisma.order.count({ where: { status: 'PENDING' } }) : 0,
      can('reviews.manage') ? this.prisma.productReview.count({ where: { status: 'PENDING' } }) : 0,
      can('comments.manage') ? this.prisma.comment.count({ where: { status: 'PENDING' } }) : 0,
      // hoá đơn điện tử phát hành lỗi cần xử lý
      can('einvoice.read') ? this.prisma.eInvoice.count({ where: { status: 'FAILED' } }) : 0,
      // kho mã số: đơn đã thanh toán còn thiếu mã + mã khách báo lỗi chưa xử lý
      can('digital_codes.read')
        ? Promise.all([
            this.prisma.order.count({ where: { codeStatus: { in: ['pending', 'partial'] }, paymentStatus: 'PAID', status: { notIn: ['CANCELLED', 'REFUNDED'] } } }),
            this.prisma.digitalCode.count({ where: { reportStatus: 'OPEN' } }),
          ]).then(([a, b]) => a + b)
        : 0,
    ]);
    // số lỗi error/fatal mới trong nhật ký lỗi kể từ lần xem gần nhất (chỉ hiện cho vai trò Nhà phát triển khớp với tab Lỗi devOnly)
    const newErrors = user.roleSlug === DEVELOPER_ROLE && can('logs.read') ? logWriter.unseenCount() : 0;
    // số ticket hỗ trợ khách đang chờ Admin phản hồi trên cả Web chính + toàn bộ Web con (T-215 & T-430)
    const openTickets =
      can('ai.tasks') || can('users.read')
        ? await this.tickets.adminOpenTicketsCount(user).catch(() => 0)
        : 0;
    return { pendingOrders, pendingReviews, pendingComments, einvoiceNeedsAction, newErrors, digitalCodesAttention, openTickets };
  }

  /** Danh sách việc cần làm khi bàn giao website mới cho khách */
  async setup(user: AuthUser): Promise<{ steps: SetupStep[]; done: number; total: number }> {
    type I18n = Record<string, string> | string | null | undefined;
    const [general, contact, mail, aiProviders, paidPlans, gateways, me] = await Promise.all([
      this.settings.get<{ siteName?: I18n; logo?: unknown; siteUrl?: string; homepageId?: string | null }>('general'),
      this.settings.get<{ phone?: string; hotline?: string; email?: string }>('contact'),
      this.settings.get<{ host?: string }>('mail'),
      // nhà cung cấp AI đã bật và có khoá API (AI Studio › Công cụ AI › tab Khoá API)
      Promise.all(['ai_tmc', 'ai_kapend', 'ai_aideepcut', 'ai_ahiep', 'ai_imgstudio', 'ai_tavtavvideo', 'ai_runup'].map((k) => this.settings.get<{ enabled?: boolean; apiKey?: string }>(k))),
      // gói cước có phí đang bán trên bảng giá
      this.prisma.creditPlan.count({ where: { active: true, price: { gt: 0 } } }),
      // cổng thanh toán online đang bật (Cài đặt › Cổng thanh toán)
      Promise.all(['web2m', 'usdt'].map((g) => this.settings.get<{ enabled?: boolean }>(g))),
      this.prisma.user.findUnique({ where: { id: user.id }, select: { email: true, passwordHash: true } }),
    ]);
    const siteName = typeof general.siteName === 'string' ? general.siteName : Object.values(general.siteName ?? {}).find(Boolean) ?? '';
    const siteUrl = general.siteUrl ?? '';
    // còn dùng mật khẩu seed mặc định -> nhắc đổi (chỉ kiểm tra với tài khoản seed)
    const seedEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@cmsnt.co').toLowerCase();
    const defaultPassword =
      !!me && me.email.toLowerCase() === seedEmail && (await argon2.verify(me.passwordHash, process.env.SEED_ADMIN_PASSWORD ?? '123456').catch(() => false));

    const allSteps: SetupStep[] = [
      { key: 'password', title: 'Đổi mật khẩu mặc định', description: 'Tài khoản quản trị vẫn dùng mật khẩu khởi tạo — đổi ngay để bảo mật.', href: '/profile', done: !defaultPassword },
      { key: 'brand', title: 'Tên & logo website', description: 'Hiển thị trên header, tab trình duyệt, email và kết quả tìm kiếm.', href: '/settings?tab=general', done: !!general.logo && !!siteName && siteName !== 'CMSNT Shop' },
      { key: 'domain', title: 'Khai báo tên miền', description: 'Địa chỉ website thật, dùng cho SEO, sitemap và link trong email.', href: '/settings?tab=general', done: /^https:\/\//.test(siteUrl) && !/localhost|127\.0\.0\.1|\.ddev\.site/.test(siteUrl) },
      { key: 'contact', title: 'Thông tin liên hệ', description: 'Số điện thoại, email để khách liên hệ khi cần hỗ trợ.', href: '/settings?tab=contact', done: !!(contact.phone || contact.hotline) && !!contact.email },
      // website AI credits: thay các bước của web bán hàng (trang chủ CMS, menu, sản phẩm) bằng bước AI Studio
      { key: 'ai', title: 'Kết nối nhà cung cấp AI', description: 'Nhập khoá API TMC, Kapend, AI DeepCut hoặc AHiep để khách tạo được video, ảnh, giọng nói.', href: '/ai/tools?tab=keys', done: aiProviders.some((p) => p.enabled === true && !!p.apiKey) },
      { key: 'plans', title: 'Gói cước credits', description: 'Đặt giá, số credits và giá năm cho các gói trên bảng giá.', href: '/ai/plans', done: paidPlans > 0 },
      { key: 'payment', title: 'Kết nối thanh toán online', description: 'Web2M (ngân hàng tự động) để khách thanh toán gói cước, gói tự kích hoạt khi nhận tiền.', href: '/settings?tab=payments', done: gateways.some((g) => g.enabled === true) },
      { key: 'mail', title: 'Cấu hình email gửi đi (SMTP)', description: 'Để gửi email xác thực tài khoản, đặt lại mật khẩu.', href: '/settings?tab=mail', done: !!mail.host },
    ];
    const steps = isChildSite() ? allSteps.filter((s) => !['ai', 'plans', 'payment'].includes(s.key)) : allSteps;
    const required = steps.filter((s) => !s.optional);
    return { steps, done: required.filter((s) => s.done).length, total: required.length };
  }
}

@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly aiOverview: AiOverviewService,
    private readonly profit: ProfitService,
  ) {}

  @RequirePermissions('dashboard.view')
  @Get()
  stats(@Query('days') days: string | undefined, @CurrentUser() user: AuthUser) {
    return this.dashboard.stats(Math.min(Math.max(Number(days) || 30, 7), 365), user);
  }

  /** Tổng quan kinh doanh AI Studio: tiền nạp, bán gói, tác vụ AI, credits, khách hàng, affiliate */
  @RequirePermissions('dashboard.view')
  @Get('ai')
  ai(@Query('days') days: string | undefined, @CurrentUser() user: AuthUser) {
    return this.aiOverview.overview(Math.min(Math.max(Number(days) || 30, 1), 365), user);
  }

  /** Thống kê doanh thu, chi phí nguồn, lợi nhuận & tổng đơn hàng theo các website nguồn (có lọc ngày) */
  @RequirePermissions('dashboard.view')
  @Get('source-stats')
  sourceStats(
    @Query('preset') preset: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('scope') scope: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.aiOverview.sourceStats({ preset, from, to, scope }, user);
  }

  @RequirePermissions('admin.access')
  @Get('badges')
  badges(@CurrentUser() user: AuthUser) {
    return this.dashboard.badges(user);
  }

  /** Thống kê Lợi nhuận CTV / Web con: tổng tiền khách nạp, số tiền nhận được (10% gốc + % tăng giá) & cột cắt giao thoa khi đổi % giữa tháng */
  @RequirePermissions('admin.access')
  @Get('profit')
  profitStats(
    @Query('preset') preset: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('month') month: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.getStats({ preset, from, to, month }, user);
  }

  /** Chủ hệ thống (`*`) thêm mốc điều chỉnh % lợi nhuận (tạo cột cắt giao thoa mới) */
  @RequirePermissions('admin.access')
  @Post('profit/milestones')
  addProfitMilestone(
    @Body() body: { basePercent?: number; markupExtra?: number; effectiveAt?: string; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.addMilestone(body, user);
  }

  /** Chủ hệ thống (`*`) cập nhật thẳng mức % hiện tại (không tách thêm cột cắt) */
  @RequirePermissions('admin.access')
  @Put('profit/rate')
  updateProfitRate(
    @Body() body: { basePercent?: number; markupExtra?: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.updateCurrentRate(body, user);
  }

  /** Chủ hệ thống (`*`) xoá mốc điều chỉnh % nhập nhầm */
  @RequirePermissions('admin.access')
  @Delete('profit/milestones/:id')
  removeProfitMilestone(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.profit.removeMilestone(id, user);
  }

  // ---- T-477 & T-478: Quản lý & thống kê tập trung Lợi nhuận toàn bộ Web con trên nov.ai.vn ----

  @RequirePermissions('admin.access')
  @Get('child-profits')
  allChildProfits(
    @Query('preset') preset: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('month') month: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.getAllChildProfits({ preset, from, to, month }, user);
  }

  @RequirePermissions('admin.access')
  @Post('child-profits/bulk-rate')
  bulkUpdateChildRates(
    @Body()
    body: {
      siteCodes?: string[];
      mode?: 'update' | 'milestone';
      basePercent?: number;
      markupExtra?: number;
      effectiveAt?: string;
      note?: string;
    },
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.bulkUpdateChildSitesRate(body, user);
  }

  @RequirePermissions('admin.access')
  @Put('child-profits/:siteCode/rate')
  updateChildSiteRate(
    @Param('siteCode') siteCode: string,
    @Body() body: { basePercent?: number; markupExtra?: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.updateChildSiteRate(siteCode, body, user);
  }

  @RequirePermissions('admin.access')
  @Post('child-profits/:siteCode/milestones')
  addChildSiteMilestone(
    @Param('siteCode') siteCode: string,
    @Body() body: { basePercent?: number; markupExtra?: number; effectiveAt?: string; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.addChildSiteMilestone(siteCode, body, user);
  }

  @RequirePermissions('admin.access')
  @Delete('child-profits/:siteCode/milestones/:id')
  removeChildSiteMilestone(
    @Param('siteCode') siteCode: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.profit.removeChildSiteMilestone(siteCode, id, user);
  }

  @RequirePermissions('settings.manage')
  @Get('setup')
  setup(@CurrentUser() user: AuthUser) {
    return this.dashboard.setup(user);
  }
}

/** Cổng nội bộ loopback `127.0.0.1` + `x-server-secret` để Web mẹ `nov.ai.vn` đọc & cập nhật cấu hình Lợi nhuận trên từng Web con (T-477) */
@Public()
@IgnoreAuthHeader()
@Controller('internal/hub-profit')
export class InternalHubProfitController {
  constructor(
    private readonly profit: ProfitService,
    private readonly prisma: PrismaService,
  ) {}

  private assertLoopbackSecret(req: Request) {
    const remote = String(req.socket?.remoteAddress || req.ip || '');
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) throw new ForbiddenException('Chỉ cho phép kết nối nội bộ');
    const expected = (process.env.SERVER_API_SECRET ?? '').trim();
    const provided = String(req.headers['x-server-secret'] ?? '').trim();
    if (!expected || !provided || expected.length !== provided.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
      throw new ForbiddenException('Xác thực nội bộ không hợp lệ');
    }
  }

  private get systemActor(): AuthUser {
    return {
      id: '',
      name: 'Quản trị tổng',
      email: 'hub@nov.ai.vn',
      roleId: 'system',
      roleSlug: 'admin',
      permissions: ['*'],
    };
  }

  @Get('stats')
  stats(
    @Req() req: Request,
    @Query('preset') preset?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('month') month?: string,
  ) {
    this.assertLoopbackSecret(req);
    return this.profit.getStats({ preset, from, to, month }, this.systemActor);
  }

  @Put('rate')
  updateRate(@Req() req: Request, @Body() body: { basePercent?: number; markupExtra?: number; note?: string }) {
    this.assertLoopbackSecret(req);
    return this.profit.updateCurrentRate(body, this.systemActor);
  }

  @Post('milestones')
  @HttpCode(200)
  addMilestone(
    @Req() req: Request,
    @Body() body: { basePercent?: number; markupExtra?: number; effectiveAt?: string; note?: string },
  ) {
    this.assertLoopbackSecret(req);
    return this.profit.addMilestone(body, this.systemActor);
  }

  @Delete('milestones/:id')
  removeMilestone(@Req() req: Request, @Param('id') id: string) {
    this.assertLoopbackSecret(req);
    return this.profit.removeMilestone(id, this.systemActor);
  }

  /** T-487 & T-507: Nhận danh sách tool bảo trì tự động & cấu hình tham số đã tự sửa lỗi (`healedFields`) từ Web mẹ nov.ai.vn để đồng bộ tức thì sang Web con */
  @Post('sync-maint')
  @HttpCode(200)
  async syncAutoMaintenance(
    @Req() req: Request,
    @Body() body: { maintKeys?: string[]; healedFields?: Record<string, Record<string, string[]>> },
  ) {
    this.assertLoopbackSecret(req);
    const maintSet = new Set(Array.isArray(body?.maintKeys) ? body.maintKeys.map(String) : []);
    const healedMap = body?.healedFields && typeof body.healedFields === 'object' ? body.healedFields : null;
    const rows = await this.prisma.aiTool.findMany({ select: { key: true, options: true } });
    let updated = 0;
    const now = Date.now();
    for (const r of rows) {
      const opts = r.options && typeof r.options === 'object' ? (r.options as Record<string, unknown>) : {};
      if (opts.deleted === true) continue;
      const shouldMaint = maintSet.has(r.key);
      let nextOpts: Record<string, unknown> | null = null;
      if (shouldMaint && opts.autoMaintenance !== true) {
        nextOpts = { ...(nextOpts ?? opts), autoMaintenance: true, autoMaintainedAt: now };
      } else if (!shouldMaint && opts.autoMaintenance === true) {
        nextOpts = { ...(nextOpts ?? opts) };
        delete nextOpts.autoMaintenance;
        delete nextOpts.autoMaintainedAt;
      }
      if (healedMap && Object.prototype.hasOwnProperty.call(healedMap, r.key)) {
        const incoming = healedMap[r.key];
        if (JSON.stringify(opts.healedFieldOptions ?? null) !== JSON.stringify(incoming ?? null)) {
          nextOpts = { ...(nextOpts ?? opts), healedFieldOptions: incoming };
        }
      }
      if (nextOpts) {
        await this.prisma.aiTool.update({
          where: { key: r.key },
          data: { options: nextOpts as object },
        });
        updated++;
      }
    }
    return { ok: true, updated };
  }
}

@Module({
  imports: [TicketsModule],
  controllers: [DashboardController, InternalHubProfitController],
  providers: [DashboardService, AiOverviewService, ProfitService],
})
export class DashboardModule {}
