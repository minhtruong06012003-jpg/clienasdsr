import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { OrdersService } from './orders.service.js';
import { CheckoutDto, CouponQueryDto, OrderQueryDto, QuoteDto, SaveCouponDto, UpdateOrderDto } from './orders.dto.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

class LookupDto {
  @IsString() @MaxLength(40) code: string;
  @IsString() @MaxLength(30) phone: string;
}

@Controller('admin')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // GET admin/orders và admin/orders/:id nằm ở OrdersAdminController (có lọc nguồn, hoàn tiền, vận chuyển)

  @RequirePermissions('orders.write')
  @Patch('orders/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.update(id, dto, user);
  }

  @RequirePermissions('coupons.manage')
  @Get('coupons')
  coupons(@Query() q: CouponQueryDto) {
    return this.orders.coupons(q);
  }

  @RequirePermissions('coupons.manage')
  @Post('coupons')
  createCoupon(@Body() dto: SaveCouponDto) {
    return this.orders.saveCoupon(undefined, dto);
  }

  @RequirePermissions('coupons.manage')
  @Patch('coupons/:id')
  updateCoupon(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveCouponDto) {
    return this.orders.saveCoupon(id, dto);
  }

  @RequirePermissions('coupons.manage')
  @Delete('coupons/:id')
  removeCoupon(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.removeCoupon(id);
  }
}

@Controller()
@RequireFeature('shop')
export class PublicOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Public()
  @Post('public/cart/quote')
  quote(@Body() dto: QuoteDto, @CurrentUser() user: AuthUser | undefined) {
    return this.orders.quote(dto, { userId: user?.id });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/orders')
  checkout(@Body() dto: CheckoutDto, @CurrentUser() user: AuthUser | undefined, @Req() req: Request) {
    return this.orders.checkout(dto, user, req.ip);
  }

  /**
   * Tra cứu đơn với SĐT trong body (không lộ trong URL / access log). 10 lần/phút/IP: chống dò mã đơn + SĐT.
   * Cache-Control `private, no-store` do PublicCacheInterceptor gắn cho mọi request ghi dưới /api/public.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/orders/lookup')
  @HttpCode(200)
  lookupPost(@Body() dto: LookupDto) {
    return this.orders.lookup(dto.code ?? '', dto.phone ?? '');
  }

  /**
   * @deprecated Bản cũ, SĐT nằm trên query (`?code=&phone=`) -> lộ trong URL / access log. Giữ để tương thích,
   * dùng `POST public/orders/lookup`. Trả thêm header `Deprecation: true`.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('public/orders/lookup')
  @Header('Deprecation', 'true')
  @ApiOperation({ deprecated: true, summary: 'Đã thay bằng POST /api/public/orders/lookup (body { code, phone })' })
  lookup(@Query('code') code: string, @Query('phone') phone: string) {
    return this.orders.lookup(code ?? '', phone ?? '');
  }

  @RequireFeature('accounts')
  @Get('account/orders')
  myOrders(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.orders.myOrders(user.id, q);
  }

  @RequireFeature('accounts')
  @Get('account/orders/:code')
  myOrder(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.orders.myOrder(user.id, code);
  }

  @RequireFeature('accounts')
  @Post('account/orders/:code/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.orders.cancelMyOrder(user.id, code);
  }
}
