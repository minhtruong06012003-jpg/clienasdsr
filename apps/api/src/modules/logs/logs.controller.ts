import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { isChildSite } from '../../common/utils/tenant.js';
import { LogsService } from './logs.service.js';
import { ClientErrorDto, LogEntriesQuery } from './logs.dto.js';

const canReadRawLogs = (user?: AuthUser) => !isChildSite() && !!user?.permissions?.includes('*');

/** Trang quản trị › Nhật ký lỗi: xem / tải / xoá file log (chỉ Siêu quản trị trên Web chính, không mở cho CTV / Web con) */
@Controller('admin/logs')
@RequirePermissions('logs.read')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  @Get('files')
  files(@CurrentUser() user: AuthUser) {
    if (!canReadRawLogs(user)) return [];
    return this.logs.files();
  }

  @Get('entries')
  entries(@Query() q: LogEntriesQuery, @CurrentUser() user: AuthUser) {
    if (!canReadRawLogs(user)) return { data: [], total: 0, page: 1, limit: Number(q.limit) || 50 };
    return this.logs.entries(q);
  }

  @Get('files/:name/download')
  download(@Param('name') name: string, @Res() res: Response, @CurrentUser() user: AuthUser) {
    if (!canReadRawLogs(user)) throw new ForbiddenException('Không có quyền tải nhật ký máy chủ');
    const path = this.logs.assertName(name);
    res.download(path, name, (err) => {
      if (err && !res.headersSent) res.status(404).json({ statusCode: 404, message: 'Không tìm thấy file log' });
    });
  }

  @Delete('files/:name')
  @RequirePermissions('logs.manage')
  remove(@Param('name') name: string) {
    return this.logs.remove(name);
  }

  @Delete('files')
  @RequirePermissions('logs.manage')
  clear() {
    return this.logs.clear();
  }

  /** Đánh dấu đã xem -> badge số lỗi mới trên menu về 0 */
  @Post('seen')
  @HttpCode(200)
  seen() {
    return this.logs.markSeen();
  }
}

/** Trang quản trị gửi lỗi JavaScript của chính nó (cần đăng nhập + quyền truy cập admin) */
@Controller('admin/client-errors')
@RequirePermissions('admin.access')
export class AdminClientErrorsController {
  constructor(private readonly logs: LogsService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(204)
  report(@Body() dto: ClientErrorDto, @Req() req: Request, @CurrentUser() user: AuthUser) {
    this.logs.captureClient(dto, 'admin-client', { ip: req.ip, userAgent: req.get('user-agent'), userId: user?.id, userEmail: user?.email });
  }
}

/**
 * Storefront gửi lỗi: trình duyệt (web-client) hoặc máy chủ Next.js (web-server — xác thực
 * bằng header x-log-secret = REVALIDATE_SECRET, không có/sai thì coi như lỗi trình duyệt).
 */
@Controller('public/client-errors')
export class PublicClientErrorsController {
  constructor(private readonly logs: LogsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(204)
  report(@Body() dto: ClientErrorDto, @Req() req: Request) {
    const fromServer = isServerSecret(req.get('x-log-secret'));
    this.logs.captureClient(dto, fromServer ? 'web-server' : 'web-client', { ip: fromServer ? undefined : req.ip, userAgent: req.get('user-agent') });
  }
}

function isServerSecret(given: string | undefined) {
  const secret = process.env.REVALIDATE_SECRET ?? '';
  if (!given || secret.length < 8) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
