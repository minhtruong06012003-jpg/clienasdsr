import { Module } from '@nestjs/common';
import { AccountWishlistController } from './wishlist.controller.js';
import { WishlistService } from './wishlist.service.js';

/** Danh sách yêu thích (wishlist) của thành viên */
@Module({
  controllers: [AccountWishlistController],
  providers: [WishlistService],
  exports: [WishlistService],
})
export class WishlistModule {}
