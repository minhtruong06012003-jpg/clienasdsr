import { Body, Controller, Get, Param, ParseUUIDPipe, PipeTransform, BadRequestException, Post, Put, Query, Injectable } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { CartsService } from './carts.service.js';
import { AbandonedCartQueryDto, AbandonedStatsQueryDto, SyncCartDto } from './carts.dto.js';

/** Mã giỏ do trình duyệt sinh (uuid) — chỉ cho ký tự an toàn */
@Injectable()
class CartTokenPipe implements PipeTransform<string, string> {
  transform(value: string) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(value)) throw new BadRequestException('Mã giỏ hàng không hợp lệ');
    return value;
  }
}

/** Storefront: đồng bộ giỏ hàng lên máy chủ (khách vãng lai theo token, thành viên theo tài khoản) */
@Controller('public/cart')
@RequireFeature('shop')
export class PublicCartsController {
  constructor(private readonly carts: CartsService) {}

  @Public()
  @Get(':token')
  get(@Param('token', CartTokenPipe) token: string, @CurrentUser() user?: AuthUser) {
    return this.carts.get(token, user);
  }

  @Public()
  // trình duyệt chỉ đồng bộ sau 1,5 giây kể từ thay đổi cuối -> 30 lần/phút/IP là dư; chặn script tạo giỏ hàng loạt
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Put(':token')
  sync(@Param('token', CartTokenPipe) token: string, @Body() dto: SyncCartDto, @CurrentUser() user?: AuthUser) {
    return this.carts.sync(token, dto, user);
  }
}

/** Admin: giỏ hàng bỏ dở (Đơn hàng › Giỏ hàng bỏ dở) */
@Controller('admin/abandoned-carts')
export class AdminCartsController {
  constructor(private readonly carts: CartsService) {}

  @RequirePermissions('orders.read')
  @Get()
  list(@Query() q: AbandonedCartQueryDto) {
    return this.carts.list(q);
  }

  @RequirePermissions('orders.read')
  @Get('stats')
  stats(@Query() q: AbandonedStatsQueryDto) {
    return this.carts.stats(q.days ?? 30);
  }

  @RequirePermissions('orders.read')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.carts.detail(id);
  }

  /** Gửi email nhắc ngay (cần quyền sửa đơn vì gửi email cho khách) */
  @RequirePermissions('orders.write')
  @Post(':id/remind')
  remind(@Param('id', ParseUUIDPipe) id: string) {
    return this.carts.remindNow(id);
  }
}
