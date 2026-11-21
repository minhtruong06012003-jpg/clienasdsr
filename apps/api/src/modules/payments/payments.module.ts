import { All, Body, Controller, ForbiddenException, Get, Global, Header, HttpCode, Module, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { IgnoreAuthHeader, Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { PaymentsService } from './payments.service.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { hasPermission } from '@cmsnt/shared';

class PayDto {
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}

class TransactionQuery extends PaginationQueryDto {
  @IsOptional() @IsIn(['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED']) declare status?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() orderId?: string;
  /** Lọc giao dịch nạp ví của một khách */
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsIn(['1']) needsRefund?: string;
  /** order = thanh toán đơn hàng | wallet = khách nạp ví qua cổng */
  @IsOptional() @IsIn(['order', 'wallet']) purpose?: string;
  /** Lọc nhanh theo thời gian (giờ Việt Nam UTC+7) */
  @IsOptional() @IsIn(['today', 'yesterday', 'daybefore', '7d', '30d', 'this_month', 'last_month']) range?: string;
  /** Từ ngày YYYY-MM-DD (00:00:00 giờ Việt Nam) */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  /** Đến ngày YYYY-MM-DD (23:59:59 giờ Việt Nam) */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

class ConfirmDto {
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
  /** Chỉ dùng cho giao dịch nạp ví: số tiền thực nhận sẽ cộng vào ví (mặc định = số tiền giao dịch) */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) amount?: number;
  /** Mã giao dịch ngân hàng / cổng của lần chuyển tiền (tuỳ chọn) — lưu làm providerTxnId để chặn webhook trùng tới sau */
  @IsOptional() @IsString() @MaxLength(190) bankTxnId?: string;
}

@Controller()
export class PublicPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @RequireFeature('shop')
  @Get('public/payment-methods')
  methods(@Query('locale') locale?: string) {
    return this.payments.methods(locale);
  }

  /** Tạo / lấy lại giao dịch thanh toán online cho đơn (khách chưa đăng nhập phải gửi SĐT đặt hàng) */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireFeature('shop')
  @Post('public/orders/:code/pay')
  @HttpCode(200)
  pay(@Param('code') code: string, @Body() dto: PayDto, @CurrentUser() user?: AuthUser) {
    return this.payments.pay(code, { user, phone: dto.phone });
  }

  /**
   * @deprecated SĐT nằm trên URL (lộ trong access log / lịch sử trình duyệt) — dùng `POST public/orders/:code/payment-status`.
   * Giữ lại để tương thích; trả thêm header `Deprecation: true`.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequireFeature('shop')
  @Get('public/orders/:code/payment')
  @Header('Deprecation', 'true')
  @ApiOperation({ deprecated: true, summary: 'Đã thay bằng POST /api/public/orders/:code/payment-status (body { phone })' })
  status(@Param('code') code: string, @Query('phone') phone?: string, @CurrentUser() user?: AuthUser) {
    return this.payments.status(code, { user, phone });
  }

  /** Như GET .../payment nhưng SĐT gửi trong body (không lộ trong URL / access log) */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequireFeature('shop')
  @Post('public/orders/:code/payment-status')
  @HttpCode(200)
  statusPost(@Param('code') code: string, @Body() dto: PayDto, @CurrentUser() user?: AuthUser) {
    return this.payments.status(code, { user, phone: dto.phone });
  }

  /** Cổng thanh toán gọi về (IPN / webhook). Xác thực bằng chữ ký/khoá của từng cổng. */
  @Public()
  @IgnoreAuthHeader()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @All('payments/webhook/:provider')
  async webhook(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    // cổng gửi callback bằng GET (USDT Gateway) thì xử lý như webhook khi có dữ liệu trên query string
    const getCallback = req.method === 'GET' && this.payments.acceptsGet(provider) && Object.keys(req.query ?? {}).length > 0;
    if ((req.method === 'GET' && !getCallback) || req.method === 'HEAD') return res.status(200).json({ success: true, message: 'Webhook endpoint OK' });
    const out = await this.payments.webhook(provider, { headers: req.headers, body: req.body, rawBody: req.rawBody, query: req.query as Record<string, unknown>, ip: req.ip });
    return res.status(out.statusCode).json(out.body);
  }
}

/**
 * Danh sách cổng thanh toán (trạng thái + URL webhook). Tách controller riêng vì cần quyền HOẶC:
 * người xem giao dịch (payments.read) hoặc người cấu hình cổng ở Cài đặt › Cổng thanh toán (settings.manage).
 */
@Controller('admin/payments')
@RequirePermissions('admin.access')
export class AdminPaymentProvidersController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('providers')
  providers(@CurrentUser() user: AuthUser) {
    if (!hasPermission(user.permissions, 'payments.read') && !hasPermission(user.permissions, 'settings.payments')) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
    }
    return this.payments.providerList();
  }
}

@Controller('admin/payments')
@RequirePermissions('payments.read')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('transactions')
  transactions(@Query() q: TransactionQuery) {
    return this.payments.transactions(q);
  }

  @Get('logs')
  logs(@Query() q: TransactionQuery) {
    return this.payments.webhookLogs(q);
  }

  @RequirePermissions('orders.write')
  @Post('transactions/:id/confirm')
  @HttpCode(200)
  confirm(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmDto, @CurrentUser() user: AuthUser) {
    return this.payments.confirmManually(id, user, dto.reference, dto.amount, dto.bankTxnId);
  }
}

@Global()
@Module({ controllers: [PublicPaymentsController, AdminPaymentProvidersController, AdminPaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
