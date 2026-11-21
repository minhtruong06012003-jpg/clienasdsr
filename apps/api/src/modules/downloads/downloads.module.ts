import { Module } from '@nestjs/common';
import { DownloadsController } from './downloads.controller.js';
import { DownloadsService } from './downloads.service.js';

/**
 * Sản phẩm số: cấp quyền tải file khi đơn được thanh toán (sự kiện `order.paid`),
 * link tải theo token, danh sách file cho thành viên / khách vãng lai, admin cấp lại.
 * (Prisma, Media, Mail, Hooks là module global.)
 */
@Module({ controllers: [DownloadsController], providers: [DownloadsService], exports: [DownloadsService] })
export class DownloadsModule {}
