import { Global, Module } from '@nestjs/common';
import { DigitalCodesService } from './digital-codes.service.js';
import { DigitalCodesAdminController, DigitalCodesPublicController } from './digital-codes.controller.js';

/**
 * Kho mã số: key bản quyền, tài khoản, acc game, thẻ cào, gift card...
 * - nhập mã hàng loạt (mã hoá AES-256-GCM, chống trùng), tồn kho sản phẩm = số mã còn trong kho
 * - giữ mã khi đặt hàng (trong transaction checkout), giao khi đơn thanh toán, nhả khi huỷ
 * - khách xem mã ở trang đơn / tài khoản, báo lỗi trong thời gian bảo hành; admin đổi mã, thu hồi, giao tay
 * Global để OrdersService / OrdersAdminService gọi giữ mã trong transaction mà không vướng vòng import.
 */
@Global()
@Module({ controllers: [DigitalCodesAdminController, DigitalCodesPublicController], providers: [DigitalCodesService], exports: [DigitalCodesService] })
export class DigitalCodesModule {}
