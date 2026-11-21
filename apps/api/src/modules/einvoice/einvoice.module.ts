import { Global, Module } from '@nestjs/common';
import { EInvoiceService } from './einvoice.service.js';
import { AccountEInvoiceController, AdminEInvoiceController } from './einvoice.controller.js';
import { EInvoiceProviderRegistry } from './providers/registry.js';

/**
 * Hoá đơn điện tử: adapter nhiều nhà cung cấp VN (Viettel, VNPT, MISA, BKAV, EasyInvoice, FPT, MobiFone, webhook tuỳ biến, nhập tay),
 * tự động phát hành theo sự kiện đơn hàng, huỷ/thay thế/điều chỉnh, PDF/XML, email cho khách.
 * Global để OrdersService và module khác dùng registry & service.
 */
@Global()
@Module({
  controllers: [AdminEInvoiceController, AccountEInvoiceController],
  providers: [EInvoiceProviderRegistry, EInvoiceService],
  exports: [EInvoiceService, EInvoiceProviderRegistry],
})
export class EInvoiceModule {}
