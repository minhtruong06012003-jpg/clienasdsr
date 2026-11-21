import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { WishlistService } from './wishlist.service.js';
import { AddWishlistDto } from './wishlist.dto.js';

/** Thành viên (storefront): danh sách yêu thích của chính mình — cần đăng nhập, tính năng wishlist + tài khoản bật */
@Controller('account/wishlist')
@RequireFeature('wishlist', 'accounts')
export class AccountWishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  /** { ids, data: thẻ sản phẩm } */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('locale') locale?: string) {
    return this.wishlist.list(user.id, locale);
  }

  /** Thêm 1 sản phẩm hoặc gộp danh sách từ localStorage khi vừa đăng nhập */
  @Post()
  add(@CurrentUser() user: AuthUser, @Body() dto: AddWishlistDto) {
    return this.wishlist.add(user.id, [...(dto.productIds ?? []), ...(dto.productId ? [dto.productId] : [])], dto.locale);
  }

  @Delete(':productId')
  remove(@CurrentUser() user: AuthUser, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.wishlist.remove(user.id, productId);
  }
}
