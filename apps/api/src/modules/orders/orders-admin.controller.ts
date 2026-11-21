import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { OrdersAdminService } from './orders-admin.service.js';
import { AdminOrderQueryDto, BulkOrdersDto, CreateAdminOrderDto, CreateRefundDto, OrderExportQueryDto, ResendEmailDto, UpdateOrderDetailsDto, UpdateOrderItemsDto } from './orders-admin.dto.js';

/**
 * Quản trị đơn hàng nâng cao (tạo thủ công, sửa dòng hàng, bulk, CSV, email, hoàn tiền, hoá đơn).
 * Controller này được đăng ký TRƯỚC OrdersController trong OrdersModule nên `GET admin/orders` và `GET admin/orders/:id`
 * ở đây ghi đè bản cũ (thêm lọc source / shippingMethodId, trả thêm refunds / createdBy / shippingMethodName).
 */
@Controller('admin/orders')
export class OrdersAdminController {
  constructor(private readonly admin: OrdersAdminService) {}

  @RequirePermissions('orders.read')
  @Get()
  list(@Query() q: AdminOrderQueryDto) {
    return this.admin.list(q);
  }

  /** Xuất CSV theo bộ lọc danh sách (?detail=1: mỗi dòng hàng một dòng) */
  @RequirePermissions('orders.read')
  @Get('export.csv')
  async export(@Query() q: OrderExportQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const { filename, content } = await this.admin.exportCsv(q, user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  @RequirePermissions('orders.write')
  @Post()
  create(@Body() dto: CreateAdminOrderDto, @CurrentUser() user: AuthUser) {
    return this.admin.create(dto, user);
  }

  @RequirePermissions('orders.write')
  @Post('bulk')
  @HttpCode(200)
  bulk(@Body() dto: BulkOrdersDto, @CurrentUser() user: AuthUser) {
    return this.admin.bulk(dto, user);
  }

  @RequirePermissions('orders.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.get(id);
  }

  @RequirePermissions('orders.write')
  @Put(':id/items')
  updateItems(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderItemsDto, @CurrentUser() user: AuthUser) {
    return this.admin.updateItems(id, dto, user);
  }

  /** Sửa thông tin khách / địa chỉ thanh toán / giảm giá & phí ship thủ công (PATCH /admin/orders/:id giữ nguyên cho trạng thái) */
  @RequirePermissions('orders.write')
  @Patch(':id/details')
  updateDetails(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderDetailsDto, @CurrentUser() user: AuthUser) {
    return this.admin.updateDetails(id, dto, user);
  }

  @RequirePermissions('orders.write')
  @Post(':id/resend-email')
  @HttpCode(200)
  resendEmail(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResendEmailDto, @CurrentUser() user: AuthUser) {
    return this.admin.resendEmail(id, dto.key, user, dto.message);
  }

  @RequirePermissions('orders.read')
  @Get(':id/refunds')
  refunds(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.refunds(id);
  }

  @RequirePermissions('orders.write')
  @Post(':id/refunds')
  refund(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateRefundDto, @CurrentUser() user: AuthUser) {
    return this.admin.refund(id, dto, user);
  }

  /** HTML hoá đơn in được (?print=1: tự mở hộp thoại in) */
  @RequirePermissions('orders.read')
  @Get(':id/invoice')
  async invoice(@Param('id', ParseUUIDPipe) id: string, @Query('print') print: string | undefined, @Res() res: Response) {
    const html = await this.admin.invoice(id, { autoPrint: print === '1' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  }
}
