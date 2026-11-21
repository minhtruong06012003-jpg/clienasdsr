import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { ReportsService } from './reports.service.js';
import { ExportQueryDto, OverviewQueryDto, ReportRangeDto, SeriesQueryDto, TopQueryDto } from './reports.dto.js';

/** Báo cáo bán hàng — mọi endpoint cần quyền orders.read */
@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions('orders.read')
  @Get('overview')
  overview(@Query() q: OverviewQueryDto) {
    return this.reports.overview(q);
  }

  @RequirePermissions('orders.read')
  @Get('revenue')
  revenue(@Query() q: SeriesQueryDto) {
    return this.reports.revenue(q);
  }

  @RequirePermissions('orders.read')
  @Get('products')
  products(@Query() q: TopQueryDto) {
    return this.reports.products(q);
  }

  @RequirePermissions('orders.read')
  @Get('categories')
  categories(@Query() q: ReportRangeDto) {
    return this.reports.categories(q);
  }

  @RequirePermissions('orders.read')
  @Get('customers')
  customers(@Query() q: TopQueryDto) {
    return this.reports.customers(q);
  }

  @RequirePermissions('orders.read')
  @Get('customers/new')
  newCustomers(@Query() q: SeriesQueryDto) {
    return this.reports.newCustomers(q);
  }

  @RequirePermissions('orders.read')
  @Get('payment-methods')
  paymentMethods(@Query() q: ReportRangeDto) {
    return this.reports.paymentMethods(q);
  }

  @RequirePermissions('orders.read')
  @Get('shipping-methods')
  shippingMethods(@Query() q: ReportRangeDto) {
    return this.reports.shippingMethods(q);
  }

  @RequirePermissions('orders.read')
  @Get('coupons')
  coupons(@Query() q: ReportRangeDto) {
    return this.reports.coupons(q);
  }

  @RequirePermissions('orders.read')
  @Get('statuses')
  statuses(@Query() q: ReportRangeDto) {
    return this.reports.statuses(q);
  }

  @RequirePermissions('orders.read')
  @Get('stock')
  stock(@Query('limit') limit?: string) {
    return this.reports.stock({ limit: Number(limit) || undefined });
  }

  @RequirePermissions('orders.read')
  @Get('export.csv')
  async export(@Query() q: ExportQueryDto, @Res() res: Response) {
    const { filename, content } = await this.reports.exportCsv(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }
}
