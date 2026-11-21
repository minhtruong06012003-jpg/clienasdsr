import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../../common/decorators/current-user.decorator.js';
import { ShippingCarriersService } from './carriers.service.js';
import { ShippingLocationsService } from './locations.service.js';
import { BulkShipmentActionDto, CancelShipmentDto, CreateShipmentDto, LocationsQueryDto, ManualShipmentDto, RateOrderDto, ShipmentQueryDto, SyncLocationsDto, TestCarrierDto } from './carriers.dto.js';
import { RequireFeature } from '../../../common/decorators/feature.decorator.js';

/** Public: danh mục địa chỉ cho checkout + webhook hãng */
@Controller('public/shipping')
export class PublicCarriersController {
  constructor(
    private readonly carriers: ShippingCarriersService,
    private readonly locations: ShippingLocationsService,
  ) {}

  /** Cấp con của một mã (bỏ trống = các tỉnh đã có dữ liệu) — storefront dựng select quận/phường */
  @Public()
  @Get('locations')
  @RequireFeature('shop')
  locationsList(@Query() q: LocationsQueryDto) {
    return this.locations.children(q.parent ?? null);
  }

  /** Webhook cập nhật trạng thái từ hãng: /api/public/shipping/webhook/:carrier?key=<webhookSecret> */
  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post('webhook/:carrier')
  @HttpCode(200)
  webhook(@Param('carrier') carrier: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.carriers.handleWebhook(carrier, { headers: req.headers, body: req.body, rawBody: req.rawBody?.toString('utf8'), query: req.query as Record<string, unknown> });
  }

  /** Một số hãng gọi GET để xác minh URL webhook */
  @Public()
  @Get('webhook/:carrier')
  webhookVerify() {
    return { ok: true };
  }
}

/** Admin: cấu hình hãng, danh mục địa chỉ, báo giá, vận đơn */
@Controller('admin/shipping')
export class AdminCarriersController {
  constructor(
    private readonly carriers: ShippingCarriersService,
    private readonly locations: ShippingLocationsService,
  ) {}

  /** Meta hãng (không chứa secret) — trang vận đơn cũng cần nên chỉ yêu cầu shipments.read */
  @RequirePermissions('shipments.read')
  @Get('carriers')
  list() {
    return this.carriers.carriers();
  }

  @RequirePermissions('settings.shipping')
  @Post('carriers/test')
  test(@Body() dto: TestCarrierDto) {
    return this.carriers.testConnection(dto);
  }

  @RequirePermissions('settings.shipping')
  @Get('locations/stats')
  locationStats() {
    return this.locations.stats();
  }

  /** Đồng bộ danh mục địa chỉ từ hãng (job nền) */
  @RequirePermissions('settings.shipping')
  @Post('locations/sync')
  async syncLocations(@Body() dto: SyncLocationsDto) {
    await this.carriers.enqueueSyncLocations(dto.carrier);
    return { queued: true };
  }

  @RequirePermissions('orders.read')
  @Get('locations')
  locationsList(@Query() q: LocationsQueryDto) {
    return q.q ? this.locations.search(q.q, q.level, q.parent) : this.locations.children(q.parent ?? null);
  }

  /** Báo giá các hãng cho một đơn hàng (trước khi tạo vận đơn) */
  @RequirePermissions('shipments.write')
  @Post('rates')
  rates(@Body() dto: RateOrderDto) {
    return this.carriers.quoteOrder(dto);
  }
}

@Controller('admin/shipments')
export class AdminShipmentsController {
  constructor(private readonly carriers: ShippingCarriersService) {}

  @RequirePermissions('shipments.read')
  @Get('stats')
  stats() {
    return this.carriers.stats();
  }

  @RequirePermissions('shipments.read')
  @Get()
  list(@Query() q: ShipmentQueryDto) {
    return this.carriers.list(q);
  }

  @RequirePermissions('shipments.read')
  @Get('order/:orderId')
  forOrder(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.carriers.forOrder(orderId);
  }

  @RequirePermissions('shipments.write')
  @Post()
  create(@Body() dto: CreateShipmentDto, @CurrentUser() actor: AuthUser) {
    return this.carriers.create(dto, actor);
  }

  /** Đồng bộ hàng loạt */
  @RequirePermissions('shipments.read')
  @Post('bulk-sync')
  async bulkSync(@Body() dto: BulkShipmentActionDto, @CurrentUser() actor: AuthUser) {
    const results: Record<string, unknown>[] = [];
    for (const id of dto.ids) {
      try {
        await this.carriers.sync(id, actor);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, error: (err as Error).message });
      }
    }
    return { results };
  }

  @RequirePermissions('shipments.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.carriers.get(id);
  }

  @RequirePermissions('shipments.read')
  @Post(':id/sync')
  sync(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.carriers.sync(id, actor);
  }

  @RequirePermissions('shipments.write')
  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelShipmentDto, @CurrentUser() actor: AuthUser) {
    return this.carriers.cancel(id, dto, actor);
  }

  @RequirePermissions('shipments.write')
  @Put(':id/manual')
  manual(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualShipmentDto, @CurrentUser() actor: AuthUser) {
    return this.carriers.manual(id, dto, actor);
  }

  /** Nhãn / phiếu giao: trả file PDF hoặc chuyển hướng tới URL của hãng */
  @RequirePermissions('shipments.read')
  @Get(':id/label')
  async label(@Param('id', ParseUUIDPipe) id: string, @Query('inline') inline: string | undefined, @Res() res: Response) {
    const r = await this.carriers.label(id);
    if (r.buffer) {
      res.setHeader('Content-Type', r.mimeType ?? 'application/pdf');
      res.setHeader('Content-Disposition', `${inline === '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(r.fileName ?? 'label.pdf')}"`);
      res.end(r.buffer);
      return;
    }
    if (r.url) {
      if (inline === 'json') res.json({ url: r.url });
      else res.redirect(r.url);
      return;
    }
    res.status(404).json({ message: 'Không có nhãn' });
  }
}
