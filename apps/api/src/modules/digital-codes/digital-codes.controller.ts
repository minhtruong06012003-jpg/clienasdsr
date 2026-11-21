import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { DigitalCodesService } from './digital-codes.service.js';
import {
  BulkDigitalCodesDto,
  DeliverOrderCodesDto,
  DigitalCodeQueryDto,
  DigitalBatchQueryDto,
  DigitalProductFilterDto,
  DigitalProductSearchDto,
  GuestCodesDto,
  GuestReportCodeDto,
  ImportDigitalCodesDto,
  ManualCodeDto,
  ReplaceCodeDto,
  ReportCodeDto,
  ResolveReportDto,
  RevokeCodeDto,
  UpdateDigitalCodeDto,
} from './digital-codes.dto.js';

/**
 * Admin › Kho mã số. Route tĩnh (summary, batches, products, export.csv, import, bulk, by-order) khai báo TRƯỚC route `:id`.
 * Không đặt @RequireFeature trên route admin (quy ước FeatureGuard: admin vẫn cần khi tính năng tắt).
 */
@Controller('admin/digital-codes')
export class DigitalCodesAdminController {
  constructor(private readonly codes: DigitalCodesService) {}

  @RequirePermissions('digital_codes.read')
  @Get()
  list(@Query() q: DigitalCodeQueryDto, @CurrentUser() user: AuthUser) {
    // truyền quyền người gọi: chỉ người có digital_codes.reveal mới tìm được theo nội dung mã
    return this.codes.list(q, user);
  }

  @RequirePermissions('digital_codes.read')
  @Get('summary')
  summary(@Query() q: DigitalProductFilterDto) {
    return this.codes.summary(q.productId);
  }

  @RequirePermissions('digital_codes.read')
  @Get('batches')
  batches(@Query() q: DigitalBatchQueryDto) {
    return this.codes.batches(q.productId, { search: q.search, page: q.page, limit: q.limit });
  }

  @RequirePermissions('digital_codes.read')
  @Get('products')
  products(@Query() q: DigitalProductSearchDto) {
    return this.codes.products(q.search);
  }

  /** Xuất CSV có nội dung mã (quyền riêng digital_codes.export, ghi nhật ký) */
  @RequirePermissions('digital_codes.export')
  @Get('export.csv')
  async export(@Query() q: DigitalCodeQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const { filename, content } = await this.codes.exportCsv(q, user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(content);
  }

  @RequirePermissions('digital_codes.manage')
  @Post('import')
  import(@Body() dto: ImportDigitalCodesDto, @CurrentUser() user: AuthUser) {
    return this.codes.import(dto, user);
  }

  @RequirePermissions('digital_codes.manage')
  @Post('bulk')
  bulk(@Body() dto: BulkDigitalCodesDto, @CurrentUser() user: AuthUser) {
    return this.codes.bulk(dto, user);
  }

  /** Tính lại bản che (preview) cho mã đã có theo quy tắc che mới — chạy theo lô, ghi nhật ký */
  @RequirePermissions('digital_codes.manage')
  @Post('rebuild-previews')
  @HttpCode(200)
  rebuildPreviews(@CurrentUser() user: AuthUser) {
    return this.codes.rebuildPreviews(user);
  }

  // ---- mã của đơn (thẻ "Mã đã giao" trong chi tiết đơn) ----

  @RequirePermissions('orders.read')
  @Get('by-order/:orderId')
  byOrder(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.codes.byOrder(orderId);
  }

  @RequirePermissions('digital_codes.manage')
  @Post('by-order/:orderId/deliver')
  deliver(@Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: DeliverOrderCodesDto, @CurrentUser() user: AuthUser) {
    return this.codes.deliverNow(orderId, !!dto.force, user);
  }

  @RequirePermissions('digital_codes.manage')
  @Post('by-order/:orderId/manual')
  manual(@Param('orderId', ParseUUIDPipe) orderId: string, @Body() dto: ManualCodeDto, @CurrentUser() user: AuthUser) {
    return this.codes.manual(orderId, dto, user);
  }

  @RequirePermissions('digital_codes.manage')
  @Post('by-order/:orderId/resend')
  resend(@Param('orderId', ParseUUIDPipe) orderId: string, @CurrentUser() user: AuthUser) {
    return this.codes.resend(orderId, user);
  }

  // ---- một mã ----

  /** Xem nội dung (ghi nhật ký hoạt động) */
  @RequirePermissions('digital_codes.reveal')
  @Post(':id/reveal')
  @HttpCode(200)
  reveal(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.codes.reveal(id, user);
  }

  @RequirePermissions('digital_codes.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDigitalCodeDto, @CurrentUser() user: AuthUser) {
    return this.codes.update(id, dto, user);
  }

  @RequirePermissions('digital_codes.manage')
  @Post(':id/replace')
  replace(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceCodeDto, @CurrentUser() user: AuthUser) {
    return this.codes.replace(id, dto, user);
  }

  @RequirePermissions('digital_codes.manage')
  @Post(':id/revoke')
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RevokeCodeDto, @CurrentUser() user: AuthUser) {
    return this.codes.revoke(id, dto, user);
  }

  @RequirePermissions('digital_codes.manage')
  @Post(':id/resolve-report')
  resolveReport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveReportDto, @CurrentUser() user: AuthUser) {
    return this.codes.resolveReport(id, dto, user);
  }
}

/** Khách xem mã đã mua: thành viên (tài khoản) và khách vãng lai (mã đơn + SĐT) */
@Controller()
@RequireFeature('shop')
export class DigitalCodesPublicController {
  constructor(private readonly codes: DigitalCodesService) {}

  @RequireFeature('accounts')
  @Get('account/codes')
  mine(@CurrentUser() user: AuthUser) {
    return this.codes.myCodes(user.id);
  }

  @RequireFeature('accounts')
  @Get('account/orders/:code/codes')
  mineByOrder(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.codes.myOrderCodes(user.id, code);
  }

  @RequireFeature('accounts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('account/codes/:id/report')
  @HttpCode(200)
  reportMine(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportCodeDto) {
    return this.codes.reportMine(user.id, id, dto.note);
  }

  /** SĐT gửi trong body (không lộ trong URL / access log). Giới hạn chặt 5 lần/phút/IP: chống dò mã đơn + SĐT */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('public/orders/codes')
  @HttpCode(200)
  guest(@Body() dto: GuestCodesDto) {
    return this.codes.guestOrderCodes(dto.code, dto.phone);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('public/orders/codes/:id/report')
  @HttpCode(200)
  reportGuest(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GuestReportCodeDto) {
    return this.codes.reportGuest(dto.code, dto.phone, id, dto.note);
  }
}
