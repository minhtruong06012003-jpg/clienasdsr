import { Injectable } from '@nestjs/common';
import type { CarrierConfig, CarrierMeta, ShippingCarrier } from './carrier.interface.js';
import { BUILTIN_CARRIERS } from './index.js';

/**
 * Sổ đăng ký adapter hãng vận chuyển: adapter lõi khai báo ở carriers/index.ts (BUILTIN_CARRIERS);
 * module khác có thể đăng ký thêm lúc chạy qua `register(carrier)` (trả hàm gỡ).
 */
@Injectable()
export class CarrierRegistry {
  private carriers = new Map<string, { carrier: ShippingCarrier }>();

  constructor() {
    for (const c of BUILTIN_CARRIERS) this.carriers.set(c.meta.key, { carrier: c });
  }

  register(carrier: ShippingCarrier) {
    this.carriers.set(carrier.meta.key, { carrier });
    return () => this.carriers.delete(carrier.meta.key);
  }

  get(key: string): ShippingCarrier | null {
    return this.carriers.get(key)?.carrier ?? null;
  }

  list(): CarrierMeta[] {
    return [...this.carriers.values()].map((v) => v.carrier.meta);
  }

  /** Ghép cấu hình settings.shipping.carriers[key] + môi trường, điền default theo meta; `enabled` giữ nguyên */
  buildConfig(key: string, settings: { environment?: string; carriers?: Record<string, Record<string, unknown>> }): CarrierConfig | null {
    const c = this.get(key);
    if (!c) return null;
    const raw = settings.carriers?.[key] ?? {};
    const cfg: CarrierConfig = { environment: settings.environment === 'production' ? 'production' : 'sandbox' };
    for (const f of c.meta.fields) {
      const v = raw[f.key];
      cfg[f.key] = v === undefined || v === null || v === '' ? f.default : v;
    }
    for (const [k, v] of Object.entries(raw)) if (!(k in cfg)) cfg[k] = v;
    return cfg;
  }

  missingFields(key: string, cfg: CarrierConfig): string[] {
    const c = this.get(key);
    if (!c) return [];
    return c.meta.fields.filter((f) => f.required && (!f.env || f.env === cfg.environment) && (cfg[f.key] === undefined || cfg[f.key] === null || cfg[f.key] === '')).map((f) => f.label);
  }
}
