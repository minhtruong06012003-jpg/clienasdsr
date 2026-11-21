import { All, Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { hasPermission } from '@cmsnt/shared';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { IgnoreAuthHeader, Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { CardTopupService } from './card-topup.service.js';
import { AdminCardTopupQuery, ApproveCardDto, CardTopupQuery, RejectCardDto, SubmitCardDto } from './card-topup.dto.js';

/** Storefront: cấu hình form nạp thẻ + callback từ nhà cung cấp */
@Controller()
export class PublicCardTopupController {
  constructor(private readonly cards: CardTopupService) {}

  /** Nhà mạng, mệnh giá, chiết khấu, lưu ý — để website khách dựng form nạp thẻ */
  @Public()
  @RequireFeature('wallet')
  @Get('public/card-topup/config')
  config() {
    return this.cards.publicConfig();
  }

  /**
   * Nhà cung cấp đổi thẻ gọi về (GET hoặc POST). Xác thực bằng chữ ký callback_sign.
   * Giới hạn 120 request/phút/IP (bằng webhook cổng thanh toán): đủ cho callback thật, hạn chế kẻ lạ spam ghi nhật ký.
   */
  @Public()
  @IgnoreAuthHeader()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @All('card-topup/callback/:provider')
  async callback(@Param('provider') provider: string, @Req() req: Request, @Res() res: Response) {
    if (req.method === 'HEAD') return res.status(200).end();
    const out = await this.cards.callback(provider, { query: req.query as Record<string, unknown>, body: req.body, headers: req.headers, ip: req.ip });
    return res.status(out.statusCode).json(out.body);
  }
}

/** Thành viên đã đăng nhập: gửi thẻ + xem lịch sử */
@Controller('account/card-topup')
@RequireFeature('wallet', 'accounts')
export class AccountCardTopupController {
  constructor(private readonly cards: CardTopupService) {}

  @Get()
  mine(@CurrentUser() user: AuthUser, @Query() q: CardTopupQuery) {
    return this.cards.mine(user.id, q);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Body() dto: SubmitCardDto, @Req() req: Request) {
    return this.cards.submit(user, dto, req.ip);
  }
}

/** Admin: danh sách thẻ, thống kê, kiểm tra lại, duyệt / từ chối tay */
@Controller('admin/card-topup')
@RequirePermissions('admin.access')
export class AdminCardTopupController {
  constructor(private readonly cards: CardTopupService) {}

  /** Nhà cung cấp hỗ trợ + URL callback — cho cả người cấu hình (settings.manage) lẫn người xem giao dịch */
  @Get('providers')
  providers(@CurrentUser() user: AuthUser) {
    if (!hasPermission(user.permissions, 'payments.read') && !hasPermission(user.permissions, 'settings.payments')) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
    }
    return this.cards.providers();
  }

  @RequirePermissions('payments.read')
  @Get()
  list(@Query() q: AdminCardTopupQuery) {
    return this.cards.list(q);
  }

  @RequirePermissions('payments.read')
  @Get('stats')
  stats() {
    return this.cards.stats();
  }

  @RequirePermissions('users.wallet')
  @Post(':id/recheck')
  @HttpCode(200)
  recheck(@Param('id', ParseUUIDPipe) id: string) {
    return this.cards.recheck(id);
  }

  @RequirePermissions('users.wallet')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveCardDto, @CurrentUser() user: AuthUser) {
    return this.cards.approve(id, dto, user);
  }

  @RequirePermissions('users.wallet')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectCardDto, @CurrentUser() user: AuthUser) {
    return this.cards.reject(id, dto.reason, user);
  }
}
