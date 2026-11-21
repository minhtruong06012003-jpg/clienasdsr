import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module.js';
import { AnalyticsService } from './analytics.service.js';
import { SiteReportsService } from './site-reports.service.js';
import { PublicTrackController, SiteReportsController } from './analytics.controller.js';

/** Thống kê truy cập tự lưu (ghi lượt xem từ storefront) + báo cáo toàn website */
@Module({
  imports: [ReportsModule],
  controllers: [PublicTrackController, SiteReportsController],
  providers: [AnalyticsService, SiteReportsService],
  exports: [AnalyticsService, SiteReportsService],
})
export class AnalyticsModule {}
