import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Báo cáo bán hàng: doanh thu, sản phẩm, danh mục, khách hàng, thanh toán, vận chuyển, coupon, tồn kho, xuất CSV */
@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
