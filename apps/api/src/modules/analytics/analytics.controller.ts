import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { ReportRangeDto } from '../reports/reports.dto.js';
import { AnalyticsService } from './analytics.service.js';
import { SiteReportsService } from './site-reports.service.js';
import { SiteExportDto, SitePagesDto, SiteSeriesDto, TrackDto } from './analytics.dto.js';

/** Storefront gửi lượt xem trang (không cần đăng nhập, giới hạn tần suất theo IP) */
@Controller('public/track')
export class PublicTrackController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  @HttpCode(204)
  async track(@Body() dto: TrackDto, @Req() req: Request) {
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    await this.analytics.track(dto, {
      ip: req.ip,
      userAgent: header('user-agent'),
      // chỉ đọc header quốc gia do CDN gắn khi cấu hình ANALYTICS_COUNTRY_HEADER (vd cf-ipcountry); không thì client giả mạo được
      country: process.env.ANALYTICS_COUNTRY_HEADER ? header(process.env.ANALYTICS_COUNTRY_HEADER.trim().toLowerCase()) : undefined,
      origin: header('origin'),
    });
  }
}

/** Báo cáo toàn website — quyền reports.view */
@Controller('admin/analytics')
export class SiteReportsController {
  constructor(private readonly reports: SiteReportsService) {}

  @RequirePermissions('reports.view')
  @Get('overview')
  overview(@Query() q: ReportRangeDto, @CurrentUser() user: AuthUser) {
    return this.reports.overview(q, user?.permissions ?? []);
  }

  @RequirePermissions('reports.view')
  @Get('traffic')
  traffic(@Query() q: SiteSeriesDto) {
    return this.reports.traffic(q);
  }

  @RequirePermissions('reports.view')
  @Get('hours')
  hours(@Query() q: ReportRangeDto) {
    return this.reports.hours(q);
  }

  @RequirePermissions('reports.view')
  @Get('realtime')
  realtime() {
    return this.reports.realtime();
  }

  @RequirePermissions('reports.view')
  @Get('pages')
  pages(@Query() q: SitePagesDto) {
    return this.reports.pages(q);
  }

  @RequirePermissions('reports.view')
  @Get('sources')
  sources(@Query() q: ReportRangeDto) {
    return this.reports.sources(q);
  }

  @RequirePermissions('reports.view')
  @Get('devices')
  devices(@Query() q: ReportRangeDto) {
    return this.reports.devices(q);
  }

  @RequirePermissions('reports.view')
  @Get('content')
  content(@Query() q: SiteSeriesDto) {
    return this.reports.content(q);
  }

  @RequirePermissions('reports.view')
  @Get('members')
  members(@Query() q: SiteSeriesDto, @CurrentUser() user: AuthUser) {
    return this.reports.members(q, user?.permissions ?? []);
  }

  @RequirePermissions('reports.view')
  @Get('engagement')
  engagement(@Query() q: SiteSeriesDto) {
    return this.reports.engagement(q);
  }

  @RequirePermissions('reports.view')
  @Get('emails')
  emails(@Query() q: SiteSeriesDto, @CurrentUser() user: AuthUser) {
    return this.reports.emails(q, user?.permissions ?? []);
  }

  @RequirePermissions('reports.view')
  @Get('export.csv')
  async export(@Query() q: SiteExportDto, @Res() res: Response) {
    const { filename, content } = await this.reports.exportCsv(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }
}
