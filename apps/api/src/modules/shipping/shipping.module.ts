import { Global, Module } from '@nestjs/common';
import { PublicShippingController, ShippingAdminController } from './shipping.controller.js';
import { ShippingService } from './shipping.service.js';
import { CarrierRegistry } from './carriers/registry.js';
import { ShippingLocationsService } from './carriers/locations.service.js';
import { ShippingCarriersService } from './carriers/carriers.service.js';
import { AdminCarriersController, AdminShipmentsController, PublicCarriersController } from './carriers/carriers.controller.js';

/**
 * Vùng & phương thức vận chuyển + tích hợp đơn vị vận chuyển (báo giá thật, vận đơn, webhook, danh mục địa chỉ).
 * @Global để OrdersService / module khác dùng ShippingService, ShippingCarriersService, CarrierRegistry không cần import module.
 */
@Global()
@Module({
  controllers: [PublicShippingController, ShippingAdminController, PublicCarriersController, AdminCarriersController, AdminShipmentsController],
  providers: [ShippingService, CarrierRegistry, ShippingLocationsService, ShippingCarriersService],
  exports: [ShippingService, CarrierRegistry, ShippingLocationsService, ShippingCarriersService],
})
export class ShippingModule {}
