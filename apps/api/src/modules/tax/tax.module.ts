import { Global, Module } from '@nestjs/common';
import { TaxRatesController } from './tax.controller.js';
import { TaxService } from './tax.service.js';

/** Thuế theo vùng. Global để OrdersService (báo giá / checkout) và OrdersAdminService (đơn thủ công) dùng chung. */
@Global()
@Module({
  controllers: [TaxRatesController],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
