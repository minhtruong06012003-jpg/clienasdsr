/**
 * Danh sách adapter hãng vận chuyển có sẵn trong lõi (thứ tự = thứ tự hiển thị ở admin).
 * Thêm hãng mới: tạo `<key>.carrier.ts` implements ShippingCarrier rồi thêm vào mảng này.
 */
import type { ShippingCarrier } from './carrier.interface.js';
import { AhamoveCarrier } from './ahamove.carrier.js';
import { BestCarrier } from './best.carrier.js';
import { GhnCarrier } from './ghn.carrier.js';
import { GhtkCarrier } from './ghtk.carrier.js';
import { GoshipCarrier } from './goship.carrier.js';
import { JtCarrier } from './jt.carrier.js';
import { ManualCarrier } from './manual.carrier.js';
import { NinjaVanCarrier } from './ninjavan.carrier.js';
import { SupershipCarrier } from './supership.carrier.js';
import { ViettelPostCarrier } from './viettelpost.carrier.js';
import { VnpostCarrier } from './vnpost.carrier.js';

export const BUILTIN_CARRIERS: ShippingCarrier[] = [
  new GhnCarrier(),
  new GhtkCarrier(),
  new ViettelPostCarrier(),
  new GoshipCarrier(),
  new AhamoveCarrier(),
  new VnpostCarrier(),
  new NinjaVanCarrier(),
  new JtCarrier(),
  new BestCarrier(),
  new SupershipCarrier(),
  new ManualCarrier(),
];
