import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ShippingService } from './shipping.service.js';
import { ReorderIdsDto, SaveMethodDto, SaveZoneDto, UpdateZoneDto } from './shipping.dto.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

/** Danh mục tỉnh/thành + quốc gia cho Select ở checkout (dữ liệu tĩnh, cache 1 giờ) */
@Controller('public/shipping')
@RequireFeature('shop')
export class PublicShippingController {
  constructor(private readonly shipping: ShippingService) {}

  @Public()
  @Get('regions')
  @Header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
  regions() {
    return this.shipping.regions();
  }
}

@Controller('admin/shipping')
@RequireAnyPermission('settings.shipping', 'settings.tax')
export class ShippingAdminController {
  constructor(private readonly shipping: ShippingService) {}

  /** Danh mục đầy đủ cho admin chọn vùng */
  @Get('regions')
  regions() {
    return this.shipping.allRegions();
  }

  @Get('zones')
  zones() {
    return this.shipping.zones();
  }

  @Post('zones')
  createZone(@Body() dto: SaveZoneDto) {
    return this.shipping.createZone(dto);
  }

  @Post('zones/quick-setup')
  quickSetup() {
    return this.shipping.quickSetup();
  }

  @Post('zones/reorder')
  reorderZones(@Body() dto: ReorderIdsDto) {
    return this.shipping.reorderZones(dto);
  }

  @Patch('zones/:id')
  updateZone(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateZoneDto) {
    return this.shipping.updateZone(id, dto);
  }

  @Delete('zones/:id')
  removeZone(@Param('id', ParseUUIDPipe) id: string) {
    return this.shipping.removeZone(id);
  }

  @Post('zones/:zoneId/methods')
  createMethod(@Param('zoneId', ParseUUIDPipe) zoneId: string, @Body() dto: SaveMethodDto) {
    return this.shipping.createMethod(zoneId, dto);
  }

  @Post('methods/reorder')
  reorderMethods(@Body() dto: ReorderIdsDto) {
    return this.shipping.reorderMethods(dto);
  }

  @Patch('methods/:id')
  updateMethod(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveMethodDto) {
    return this.shipping.updateMethod(id, dto);
  }

  @Delete('methods/:id')
  removeMethod(@Param('id', ParseUUIDPipe) id: string) {
    return this.shipping.removeMethod(id);
  }
}
