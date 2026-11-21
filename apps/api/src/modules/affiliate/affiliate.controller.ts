import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { AffiliateService } from './affiliate.service.js';
import { AdjustAffiliateDto, AffiliatePayoutQuery, AffiliateTxnQuery, CreateAffiliatePayoutDto, ProcessAffiliatePayoutDto } from './affiliate.dto.js';

/** Tiếp thị liên kết của khách: thông tin + ví hoa hồng, lịch sử, yêu cầu rút */
@Controller('account/affiliate')
@RequireFeature('accounts')
export class AccountAffiliateController {
  constructor(private readonly affiliate: AffiliateService) {}

  @Get()
  info(@CurrentUser() user: AuthUser) {
    return this.affiliate.overview(user.id);
  }

  @Get('transactions')
  transactions(@CurrentUser() user: AuthUser, @Query() q: AffiliateTxnQuery) {
    return this.affiliate.myTransactions(user.id, q);
  }

  @Get('payouts')
  payouts(@CurrentUser() user: AuthUser, @Query() q: AffiliatePayoutQuery) {
    return this.affiliate.myPayouts(user.id, q);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('payouts')
  requestPayout(@CurrentUser() user: AuthUser, @Body() dto: CreateAffiliatePayoutDto) {
    return this.affiliate.requestPayout(user.id, dto);
  }

  @Post('payouts/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.affiliate.cancelPayout(user.id, id);
  }
}

/** Trang admin Tiếp thị liên kết (quyền affiliate.manage) */
@Controller('admin/affiliate')
export class AdminAffiliateController {
  constructor(private readonly affiliate: AffiliateService) {}

  @RequirePermissions('affiliate.manage')
  @Get('stats')
  stats() {
    return this.affiliate.adminStats();
  }

  @RequirePermissions('affiliate.manage')
  @Get('transactions')
  transactions(@Query() q: AffiliateTxnQuery) {
    return this.affiliate.adminTransactions(q);
  }

  @RequirePermissions('affiliate.manage')
  @Get('payouts')
  payouts(@Query() q: AffiliatePayoutQuery) {
    return this.affiliate.adminPayouts(q);
  }

  @RequirePermissions('affiliate.manage')
  @Post('payouts/:id/approve')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProcessAffiliatePayoutDto, @CurrentUser() actor: AuthUser) {
    return this.affiliate.approvePayout(id, actor.id, dto.adminNote);
  }

  @RequirePermissions('affiliate.manage')
  @Post('payouts/:id/reject')
  @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProcessAffiliatePayoutDto, @CurrentUser() actor: AuthUser) {
    return this.affiliate.rejectPayout(id, actor.id, dto.adminNote);
  }

  /** Cộng / trừ tay ví hoa hồng của khách */
  @RequirePermissions('affiliate.manage')
  @Post('users/:id/adjust')
  @HttpCode(200)
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustAffiliateDto, @CurrentUser() actor: AuthUser) {
    return this.affiliate.adjust(id, dto, actor.id);
  }

  /** Rà soát & lọc tự động các cặp khách hàng dùng chính mình lập 2 nick cày Affiliate (T-431) */
  @RequirePermissions('affiliate.manage')
  @Get('self-referrals')
  selfReferrals(@Query('mode') mode?: string, @Query('search') search?: string) {
    return this.affiliate.adminSelfReferralAudit(mode !== 'all', search);
  }

  /** Gỡ liên kết giới thiệu của cặp Aff 2 nick (kèm tuỳ chọn thu hồi hoa hồng đã nhận) */
  @RequirePermissions('affiliate.manage')
  @Post('self-referrals/:childId/unlink')
  @HttpCode(200)
  unlinkSelfReferral(
    @Param('childId', ParseUUIDPipe) childId: string,
    @Body() body: { revokeEarned?: boolean },
    @CurrentUser() actor: AuthUser,
  ) {
    return this.affiliate.adminUnlinkSelfReferral(childId, body?.revokeEarned !== false, actor.id);
  }
}
