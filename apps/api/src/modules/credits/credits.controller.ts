import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { CreditsService } from './credits.service.js';
import { AdjustCreditsDto, BuyCreditsDto, CheckoutPlanDto, CheckoutTopupDto, CreditTxnQueryDto, CustomDiscountDto, PurchasePlanDto, PurchaseQueryDto, UpsertPlanDto } from './credits.dto.js';

/** Bảng giá gói credits công khai (đăng nhập thì kèm giá sau giảm giá riêng) */
@Controller('public/plans')
export class PublicPlansController {
  constructor(private readonly credits: CreditsService) {}

  @Public()
  @Get()
  list(@CurrentUser() user?: AuthUser) {
    return this.credits.publicPlans(user?.id);
  }
}

/** Thành viên: credits, gói đang dùng, mua gói */
@Controller('account/credits')
export class AccountCreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Get()
  async summary(@CurrentUser() user: AuthUser, @Req() req: Request) {
    const s = await this.credits.summary(user.id);
    if ((req as Request & { authMethod?: string }).authMethod === 'api_key') {
      return { ...s, concurrency: Math.max(60, s.concurrency) };
    }
    return s;
  }

  @Get('transactions')
  transactions(@CurrentUser() user: AuthUser, @Query() q: CreditTxnQueryDto) {
    return this.credits.transactions(user.id, q);
  }

  @Get('purchases')
  purchases(@CurrentUser() user: AuthUser, @Query() q: PurchaseQueryDto) {
    return this.credits.purchases(user.id, q);
  }

  /** Mua gói credits bằng số dư ví */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('purchase')
  @HttpCode(200)
  purchase(@CurrentUser() user: AuthUser, @Body() dto: PurchasePlanDto) {
    return this.credits.purchase(user, dto.planId);
  }

  /** Trang thanh toán: trả gói credits qua cổng (QR / chuyển khoản số còn thiếu) — nhận tiền xong tự cộng credits */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout')
  @HttpCode(200)
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutPlanDto, @Query('locale') locale?: string) {
    return this.credits.checkout(user, dto, locale);
  }

  /** Nạp credits theo số tiền tự do bằng số dư ví (credits gốc + khuyến mãi theo mốc / chương trình) */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('buy')
  @HttpCode(200)
  buy(@CurrentUser() user: AuthUser, @Body() dto: BuyCreditsDto) {
    return this.credits.buyCredits(user, dto.amount);
  }

  /** Nạp credits theo số tiền tự do qua cổng (QR / chuyển khoản phần còn thiếu) — nhận tiền xong tự cộng credits */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('buy/checkout')
  @HttpCode(200)
  buyCheckout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutTopupDto, @Query('locale') locale?: string) {
    return this.credits.checkoutTopup(user, dto, locale);
  }

  /** Các cổng thanh toán dùng được ở trang thanh toán gói + số tiền tối thiểu mỗi lần thanh toán (khai báo trước `checkout/:id`) */
  @Get('checkout/options')
  checkoutOptions(@Query('locale') locale?: string) {
    return this.credits.checkoutOptions(locale);
  }

  /** Trạng thái thanh toán gói qua cổng (đã nhận tiền chưa, đã kích hoạt gói chưa) */
  @Get('checkout/:id')
  checkoutStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.credits.checkoutStatus(user.id, id);
  }
}

/** Admin: gói cước, lịch sử mua, sổ cái credits */
@Controller('admin/credits')
export class AdminCreditsController {
  constructor(private readonly credits: CreditsService) {}

  @RequirePermissions('credits.read')
  @Get('stats')
  stats() {
    return this.credits.adminStats();
  }

  @RequirePermissions('credits.plans')
  @Get('plans')
  plans() {
    return this.credits.adminPlans();
  }

  @RequirePermissions('credits.plans')
  @Post('plans')
  createPlan(@Body() dto: UpsertPlanDto) {
    return this.credits.savePlan(dto);
  }

  @RequirePermissions('credits.plans')
  @Put('plans/:id')
  updatePlan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertPlanDto) {
    return this.credits.savePlan(dto, id);
  }

  @RequirePermissions('credits.plans')
  @Delete('plans/:id')
  deletePlan(@Param('id', ParseUUIDPipe) id: string) {
    return this.credits.deletePlan(id);
  }

  @RequirePermissions('credits.read')
  @Get('purchases')
  purchases(@Query() q: PurchaseQueryDto) {
    return this.credits.purchases(null, q);
  }

  @RequirePermissions('credits.read')
  @Get('transactions')
  transactions(@Query() q: CreditTxnQueryDto) {
    return this.credits.transactions(null, q);
  }
}

/** Admin: credits của một thành viên (xem, cộng/trừ, giảm giá riêng) */
@Controller('admin/users/:id/credits')
export class AdminUserCreditsController {
  constructor(private readonly credits: CreditsService) {}

  @RequirePermissions('users.read')
  @Get()
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.credits.summary(id);
  }

  @RequirePermissions('users.read')
  @Get('transactions')
  transactions(@Param('id', ParseUUIDPipe) id: string, @Query() q: CreditTxnQueryDto) {
    return this.credits.transactions(id, q);
  }

  @RequirePermissions('users.wallet')
  @Post('adjust')
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustCreditsDto, @CurrentUser() actor: AuthUser) {
    return this.credits.adjust(id, dto, actor);
  }

  @RequirePermissions('users.wallet')
  @Put('discount')
  discount(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomDiscountDto) {
    return this.credits.setCustomDiscount(id, dto.discount);
  }
}
