/**
 * Danh sách adapter nhà cung cấp HĐĐT có sẵn trong lõi.
 * Thêm adapter mới: tạo file `<key>.provider.ts` implements EInvoiceProvider rồi thêm vào mảng này.
 * Thứ tự = thứ tự hiển thị khi admin chọn nhà cung cấp.
 */
import type { EInvoiceProvider } from './provider.interface.js';
import { ViettelProvider } from './viettel.provider.js';
import { VnptProvider } from './vnpt.provider.js';
import { MisaProvider } from './misa.provider.js';
import { BkavProvider } from './bkav.provider.js';
import { EasyInvoiceProvider } from './easyinvoice.provider.js';
import { FptProvider } from './fpt.provider.js';
import { MobifoneProvider } from './mobifone.provider.js';
import { CustomWebhookProvider } from './custom.provider.js';
import { ManualProvider } from './manual.provider.js';

export const BUILTIN_PROVIDERS: EInvoiceProvider[] = [
  new ViettelProvider(),
  new VnptProvider(),
  new MisaProvider(),
  new BkavProvider(),
  new EasyInvoiceProvider(),
  new FptProvider(),
  new MobifoneProvider(),
  new CustomWebhookProvider(),
  new ManualProvider(),
];
