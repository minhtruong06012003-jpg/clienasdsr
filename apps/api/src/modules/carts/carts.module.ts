import { Module } from '@nestjs/common';
import { AdminCartsController, PublicCartsController } from './carts.controller.js';
import { CartsService } from './carts.service.js';

/** Giỏ hàng lưu máy chủ + nhắc giỏ bỏ dở (cron) + trang quản trị giỏ bỏ dở */
@Module({
  controllers: [PublicCartsController, AdminCartsController],
  providers: [CartsService],
  exports: [CartsService],
})
export class CartsModule {}
