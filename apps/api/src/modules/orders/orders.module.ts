import { Module } from '@nestjs/common';
import { OrdersController, PublicOrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersAdminController } from './orders-admin.controller.js';
import { OrdersAdminService } from './orders-admin.service.js';

/**
 * OrdersAdminController đứng trước OrdersController để các route trùng (`GET admin/orders`, `GET admin/orders/:id`)
 * dùng bản mở rộng (lọc source / shippingMethodId, kèm refunds / createdBy) và `GET admin/orders/export.csv` không bị
 * `:id` (ParseUUIDPipe) bắt trước.
 */
@Module({ controllers: [OrdersAdminController, OrdersController, PublicOrdersController], providers: [OrdersService, OrdersAdminService], exports: [OrdersService, OrdersAdminService] })
export class OrdersModule {}
