import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { WalletService } from './wallet.service.js';
import { AdjustWalletDto, CreateTopupDto, TopupQueryDto, WalletQueryDto } from './wallet.dto.js';
import { PaymentsService } from '../payments/payments.service.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

/** Admin: xem và điều chỉnh ví của một thành viên */
@Controller('admin/users/:id/wallet')
export class AdminWalletController {
  constructor(private readonly wallet: WalletService) {}

  @RequirePermissions('users.read')
  @Get()
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.wallet.summary(id);
  }

  @RequirePermissions('users.read')
  @Get('transactions')
  transactions(@Param('id', ParseUUIDPipe) id: string, @Query() q: WalletQueryDto) {
    return this.wallet.transactions(id, q);
  }

  @RequirePermissions('users.wallet')
  @Post('adjust')
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustWalletDto, @CurrentUser() actor: AuthUser) {
    return this.wallet.adjust(id, dto, actor);
  }
}

/** Thành viên (storefront): xem ví của chính mình — chỉ cần đăng nhập */
@Controller('account/wallet')
@RequireFeature('wallet', 'accounts')
export class AccountWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly payments: PaymentsService,
  ) {}

  @Get()
  summary(@CurrentUser() user: AuthUser) {
    return this.wallet.summary(user.id);
  }

  @Get('transactions')
  transactions(@CurrentUser() user: AuthUser, @Query() q: WalletQueryDto) {
    return this.wallet.transactions(user.id, q);
  }

  // ---------------- nạp tiền vào ví qua cổng thanh toán ----------------

  /** Cấu hình form nạp ví: bật/tắt, số tiền tối thiểu / tối đa, các cổng dùng được */
  @Get('topup/options')
  topupOptions(@Query('locale') locale?: string) {
    return this.payments.topupOptions(locale);
  }

  /**
   * Tạo giao dịch nạp ví -> trả link / QR / nội dung chuyển khoản (tối đa 3 giao dịch chờ cùng lúc).
   * `?locale=` (tuỳ chọn): ngôn ngữ khách đang xem — link quay về từ cổng sẽ có tiền tố ngôn ngữ đó.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('topup')
  @HttpCode(200)
  createTopup(@CurrentUser() user: AuthUser, @Body() dto: CreateTopupDto, @Query('locale') locale?: string) {
    return this.payments.createTopup(user, dto, locale);
  }

  /** Lịch sử nạp ví qua cổng của chính mình */
  @Get('topups')
  topups(@CurrentUser() user: AuthUser, @Query() q: TopupQueryDto) {
    return this.payments.myTopups(user.id, q);
  }

  /** Trạng thái một giao dịch nạp ví (trang quay về từ cổng hỏi định kỳ; tự hỏi cổng nếu webhook chưa tới) */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('topups/:id')
  topup(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('walletId') walletId?: string) {
    return this.payments.myTopup(user.id, id, walletId);
  }
}
