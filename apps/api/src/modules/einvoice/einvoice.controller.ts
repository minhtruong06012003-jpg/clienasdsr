import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { EInvoiceService } from './einvoice.service.js';
import { AdjustEInvoiceDto, BulkInvoiceActionDto, BulkIssueDto, CancelEInvoiceDto, CreateEInvoiceDto, EInvoiceQueryDto, InvoiceRequestDto, ManualResultDto, PreviewEInvoiceDto, ReplaceEInvoiceDto, SendEInvoiceEmailDto, TestConnectionDto, UpdateEInvoiceDto } from './einvoice.dto.js';
import { VAT_RATES } from './einvoice.calc.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

/** Gửi file (PDF/XML) về client dưới dạng attachment */
function sendFile(res: Response, file: { buffer: Buffer; mimeType: string; fileName: string }, inline = false) {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.fileName)}"`);
  res.setHeader('Content-Length', String(file.buffer.length));
  res.end(file.buffer);
}

/** Admin: quản lý hoá đơn điện tử */
@Controller('admin/einvoices')
export class AdminEInvoiceController {
  constructor(private readonly svc: EInvoiceService) {}

  /** Meta các nhà cung cấp (form cấu hình động) + thuế suất hợp lệ */
  @RequirePermissions('einvoice.read')
  @Get('providers')
  async providers() {
    return { ...(await this.svc.providers()), vatRates: VAT_RATES };
  }

  @RequirePermissions('einvoice.settings')
  @Post('test-connection')
  testConnection(@Body() dto: TestConnectionDto) {
    return this.svc.testConnection(dto);
  }

  @RequirePermissions('einvoice.read')
  @Get('stats')
  stats() {
    return this.svc.stats();
  }

  /** Bảng kê hoá đơn CSV theo bộ lọc hiện tại (khai báo trước ':id') */
  @RequirePermissions('einvoice.read')
  @Get('export.csv')
  async exportCsv(@Query() q: EInvoiceQueryDto, @Res() res: Response) {
    const file = await this.svc.exportCsv(q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  }

  @RequirePermissions('einvoice.read')
  @Get()
  list(@Query() q: EInvoiceQueryDto) {
    return this.svc.list(q);
  }

  /** Xem trước dữ liệu hoá đơn sẽ lập từ đơn hàng */
  @RequirePermissions('einvoice.write')
  @Post('preview')
  preview(@Body() dto: PreviewEInvoiceDto) {
    return this.svc.preview(dto);
  }

  @RequirePermissions('einvoice.write')
  @Post()
  create(@Body() dto: CreateEInvoiceDto, @CurrentUser() actor: AuthUser) {
    return this.svc.create(dto, actor);
  }

  /** Phát hành hàng loạt theo danh sách đơn hàng (xếp hàng job) */
  @RequirePermissions('einvoice.write')
  @Post('bulk-issue')
  bulkIssue(@Body() dto: BulkIssueDto, @CurrentUser() actor: AuthUser) {
    return this.svc.bulkIssue(dto, actor);
  }

  /** Phát hành lại hàng loạt các hoá đơn nháp/lỗi đã chọn */
  @RequirePermissions('einvoice.write')
  @Post('bulk-retry')
  async bulkRetry(@Body() dto: BulkInvoiceActionDto) {
    for (const id of dto.ids) await this.svc.enqueueIssue(id);
    return { queued: dto.ids.length };
  }

  /** Hoá đơn của một đơn hàng */
  @RequirePermissions('einvoice.read')
  @Get('order/:orderId')
  forOrder(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.svc.forOrder(orderId);
  }

  @RequirePermissions('einvoice.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @RequirePermissions('einvoice.write')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEInvoiceDto, @CurrentUser() actor: AuthUser) {
    return this.svc.update(id, dto, actor);
  }

  @RequirePermissions('einvoice.write')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.svc.remove(id, actor);
  }

  /** Phát hành ngay (đồng bộ, chờ NCC trả kết quả) */
  @RequirePermissions('einvoice.write')
  @Post(':id/issue')
  issue(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.svc.issue(id, actor);
  }

  /** Nhập tay kết quả phát hành (NCC nhập tay / đã thấy số trên cổng NCC) */
  @RequirePermissions('einvoice.write')
  @Put(':id/manual')
  manual(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualResultDto, @CurrentUser() actor: AuthUser) {
    return this.svc.setManualResult(id, dto, actor);
  }

  @RequirePermissions('einvoice.cancel')
  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelEInvoiceDto, @CurrentUser() actor: AuthUser) {
    return this.svc.cancel(id, dto, actor);
  }

  @RequirePermissions('einvoice.cancel')
  @Post(':id/replace')
  replace(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceEInvoiceDto, @CurrentUser() actor: AuthUser) {
    return this.svc.replace(id, dto, actor);
  }

  @RequirePermissions('einvoice.cancel')
  @Post(':id/adjust')
  adjust(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustEInvoiceDto, @CurrentUser() actor: AuthUser) {
    return this.svc.adjust(id, dto, actor);
  }

  @RequirePermissions('einvoice.read')
  @Post(':id/sync')
  sync(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.svc.sync(id, actor);
  }

  @RequirePermissions('einvoice.write')
  @Post(':id/send-email')
  sendEmail(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendEInvoiceEmailDto, @CurrentUser() actor: AuthUser) {
    return this.svc.sendEmail(id, dto, actor);
  }

  @RequirePermissions('einvoice.read')
  @Get(':id/pdf')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    sendFile(res, await this.svc.getFile(id, 'pdf'), inline === '1');
  }

  @RequirePermissions('einvoice.read')
  @Get(':id/xml')
  async xml(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendFile(res, await this.svc.getFile(id, 'xml'));
  }

  /** Bản thể hiện HTML để in / lưu PDF (khi NCC không có PDF hoặc xem nhanh) */
  @RequirePermissions('einvoice.read')
  @Get(':id/print')
  async print(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(await this.svc.printHtml(id));
  }
}

/** Thành viên (storefront): xem hoá đơn của chính mình */
@Controller('account')
@RequireFeature('shop', 'accounts')
export class AccountEInvoiceController {
  constructor(private readonly svc: EInvoiceService) {}

  @Get('einvoices')
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.svc.customerList(user.id, q);
  }

  @Get('einvoices/:id/pdf')
  async pdf(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    sendFile(res, await this.svc.customerFile(user.id, id, 'pdf'), inline === '1');
  }

  @Get('einvoices/:id/xml')
  async xml(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendFile(res, await this.svc.customerFile(user.id, id, 'xml'));
  }

  /** Bản thể hiện HTML của hoá đơn (thành viên) */
  @Get('einvoices/:id/print')
  async print(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(await this.svc.customerPrintHtml(user.id, id));
  }

  /** Cập nhật thông tin xuất hoá đơn cho đơn của mình (khi chưa phát hành) */
  @Put('orders/:orderId/invoice-request')
  async invoiceRequest(@CurrentUser() user: AuthUser, @Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: InvoiceRequestDto) {
    return this.svc.updateInvoiceRequestForUser(user.id, orderId, dto);
  }
}
