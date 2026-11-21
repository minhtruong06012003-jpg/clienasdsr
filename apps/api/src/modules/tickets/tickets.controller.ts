import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { IgnoreAuthHeader, Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { TicketsService } from './tickets.service.js';
import { AdminSiteUserUpdateDto, AdminSiteUserWalletDto, CascadeRefundDto, CreateTicketDto, ReplyTicketDto, TicketQueryDto, UpdateTicketStatusDto } from './tickets.dto.js';

@Controller('account/tickets')
export class AccountTicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: TicketQueryDto) {
    return this.tickets.myList(user.id, q);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.tickets.myUnreadCount(user.id);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.myDetail(user.id, id);
  }

  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.tickets.create(user, dto);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/reply')
  @HttpCode(200)
  reply(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyTicketDto) {
    return this.tickets.customerReply(user, id, dto);
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.customerClose(user.id, id);
  }
}

@Controller('admin/tickets')
export class AdminTicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @RequirePermissions('ai.tasks', 'users.read')
  @Get()
  list(@Query() q: TicketQueryDto, @CurrentUser() user: AuthUser) {
    return this.tickets.adminList(q, user);
  }

  /** Xem thông tin độc lập, ví, lịch sử giao dịch & đơn AI của khách ngay từ Ticket (cả Web mẹ & Web con — T-430, T-435) */
  @RequirePermissions('users.read')
  @Get('site-users/:siteCode/:userId')
  inspectSiteUser(
    @Param('siteCode') siteCode: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tickets.adminInspectSiteUser(siteCode, userId, actor);
  }

  /** Sửa thành viên (tên, SĐT, khoá/mở khoá, giảm giá riêng, mật khẩu, đăng xuất thiết bị) đúng trên DB độc lập của site đó (T-430, T-435) */
  @RequirePermissions('users.write')
  @Put('site-users/:siteCode/:userId')
  updateSiteUser(
    @Param('siteCode') siteCode: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminSiteUserUpdateDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tickets.adminUpdateSiteUser(siteCode, userId, dto, actor);
  }

  /** Cộng / Trừ tiền ví thành viên đúng trên DB độc lập của site đó (bắt buộc khoá idempotencyKey chống lặp 100% — T-430, T-435, T-436) */
  @RequirePermissions('users.wallet')
  @Post('site-users/:siteCode/:userId/wallet')
  @HttpCode(200)
  adjustSiteUserWallet(
    @Param('siteCode') siteCode: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminSiteUserWalletDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tickets.adminAdjustSiteUserWallet(siteCode, userId, dto, actor);
  }

  /** Hoàn tiền 1 chạm đơn AI của thành viên ngay trong hộp Sửa thành viên (T-430, T-434) */
  @RequirePermissions('ai.tasks.manage')
  @Post('site-users/:siteCode/tasks/:taskId/cancel')
  @HttpCode(200)
  cancelSiteTask(
    @Param('siteCode') siteCode: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tickets.adminCancelSiteTask(siteCode, taskId, actor);
  }

  @RequirePermissions('ai.tasks', 'users.read')
  @Get(':id')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.adminDetail(id, user);
  }

  @RequirePermissions('ai.tasks', 'users.read')
  @Post(':id/reply')
  @HttpCode(200)
  reply(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: ReplyTicketDto) {
    return this.tickets.adminReply(actor, id, dto);
  }

  @RequirePermissions('ai.tasks', 'users.read')
  @Put(':id/status')
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTicketStatusDto, @CurrentUser() actor: AuthUser) {
    return this.tickets.adminSetStatus(id, dto.status, actor);
  }

  /** Hoàn tiền tác vụ AI đính kèm trên cả Ticket web chính lẫn Ticket web con ngay từ 1 màn hình (T-409 & T-430) */
  @RequirePermissions('ai.tasks.manage')
  @Post(':id/refund-task/:taskId')
  @HttpCode(200)
  refundLinkedTask(@Param('id') id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @CurrentUser() actor: AuthUser) {
    return this.tickets.adminRefundLinkedTask(id, taskId, actor);
  }
}

/**
 * Cổng nội bộ chỉ cho phép loopback `127.0.0.1` kèm `X-Server-Secret` để Web chính (`nov.ai.vn`)
 * gom và hỗ trợ trực tiếp toàn bộ Ticket từ mọi Website con trên 1 bảng duy nhất (T-430).
 */
@Public()
@IgnoreAuthHeader()
@Controller('internal/hub-tickets')
export class InternalHubTicketsController {
  constructor(private readonly tickets: TicketsService) {}

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

  @Get('all')
  all(@Req() req: Request) {
    this.assertLoopbackSecret(req);
    return this.tickets.internalExportTickets();
  }

  @Get('open-count')
  openCount(@Req() req: Request) {
    this.assertLoopbackSecret(req);
    return this.tickets.internalOpenCount();
  }

  @Get('users/:userId')
  inspectUser(@Req() req: Request, @Param('userId', ParseUUIDPipe) userId: string) {
    this.assertLoopbackSecret(req);
    return this.tickets.localInspectUser(userId);
  }

  @Put('users/:userId')
  updateUser(@Req() req: Request, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: AdminSiteUserUpdateDto) {
    this.assertLoopbackSecret(req);
    return this.tickets.localUpdateUser(userId, dto);
  }

  @Post('users/:userId/wallet')
  @HttpCode(200)
  adjustUserWallet(@Req() req: Request, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: AdminSiteUserWalletDto) {
    this.assertLoopbackSecret(req);
    return this.tickets.localAdjustUserWallet(userId, dto);
  }

  @Get('tasks-search')
  searchTasks(@Req() req: Request, @Query('q') q?: string, @Query('status') status?: string) {
    this.assertLoopbackSecret(req);
    return this.tickets.internalSearchTasks(q, status);
  }

  @Get('tasks/:taskId')
  getTask(@Req() req: Request, @Param('taskId', ParseUUIDPipe) taskId: string) {
    this.assertLoopbackSecret(req);
    return this.tickets.internalGetTask(taskId);
  }

  @Post('tasks/cascade-refund')
  @HttpCode(200)
  cascadeRefund(@Req() req: Request, @Body() dto: CascadeRefundDto) {
    this.assertLoopbackSecret(req);
    return this.tickets.internalCascadeRefund(dto);
  }

  @Get(':id')
  detail(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    this.assertLoopbackSecret(req);
    return this.tickets.localAdminDetail(id);
  }

  @Post(':id/reply')
  @HttpCode(200)
  reply(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReplyTicketDto & { authorName?: string }) {
    this.assertLoopbackSecret(req);
    return this.tickets.localAdminReplyByName(body.authorName || 'Đội ngũ Hỗ trợ', id, body);
  }

  @Put(':id/status')
  setStatus(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketStatusDto) {
    this.assertLoopbackSecret(req);
    return this.tickets.localAdminSetStatus(id, dto.status);
  }

  @Post('tasks/:taskId/cancel')
  @HttpCode(200)
  cancelTask(@Req() req: Request, @Param('taskId', ParseUUIDPipe) taskId: string) {
    this.assertLoopbackSecret(req);
    return this.tickets.internalCancelTask(taskId);
  }

  @Post('notify-parent')
  @HttpCode(200)
  async notifyParent(@Req() req: Request, @Body() body: { childSecret?: string; domain?: string; html?: string }) {
    const remote = String(req.socket?.remoteAddress || req.ip || '');
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) throw new ForbiddenException('Chỉ cho phép kết nối nội bộ');
    return this.tickets.receiveChildTelegramAlert(body.childSecret ?? '', body.domain ?? '', body.html ?? '');
  }
}
