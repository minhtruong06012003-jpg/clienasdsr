import { Injectable } from '@nestjs/common';
import type { EInvoiceProvider, ProviderConfig, ProviderMeta } from './provider.interface.js';
import { BUILTIN_PROVIDERS } from './index.js';

/**
 * Sổ đăng ký adapter nhà cung cấp HĐĐT.
 * - Adapter lõi nằm ở providers/index.ts (BUILTIN_PROVIDERS) — thêm nhà cung cấp mới thì khai báo ở đó.
 * - Module khác có thể đăng ký thêm lúc chạy qua `register(provider)` (trả hàm gỡ).
 */
@Injectable()
export class EInvoiceProviderRegistry {
  private providers = new Map<string, { provider: EInvoiceProvider }>();

  constructor() {
    for (const p of BUILTIN_PROVIDERS) this.providers.set(p.meta.key, { provider: p });
  }

  register(provider: EInvoiceProvider) {
    this.providers.set(provider.meta.key, { provider });
    return () => this.providers.delete(provider.meta.key);
  }

  get(key: string): EInvoiceProvider | null {
    return this.providers.get(key)?.provider ?? null;
  }

  has(key: string) {
    return this.providers.has(key);
  }

  /** Meta mọi nhà cung cấp (admin render danh sách chọn + form cấu hình) */
  list(): ProviderMeta[] {
    return [...this.providers.values()].map((v) => v.provider.meta);
  }

  /**
   * Ghép cấu hình nhà cung cấp từ settings `einvoice.providers[key]` + môi trường, điền default theo meta.
   * Trả về null nếu nhà cung cấp không tồn tại.
   */
  buildConfig(key: string, settings: { environment?: string; providers?: Record<string, Record<string, unknown>> }): ProviderConfig | null {
    const p = this.get(key);
    if (!p) return null;
    const raw = settings.providers?.[key] ?? {};
    const cfg: ProviderConfig = { environment: settings.environment === 'production' ? 'production' : 'sandbox' };
    for (const f of p.meta.fields) {
      const v = raw[f.key];
      cfg[f.key] = v === undefined || v === null || v === '' ? f.default : v;
    }
    // giữ cả key không khai báo trong meta (field ẩn)
    for (const [k, v] of Object.entries(raw)) if (!(k in cfg)) cfg[k] = v;
    return cfg;
  }

  /** Kiểm tra các field bắt buộc đã nhập; trả về danh sách label thiếu */
  missingFields(key: string, cfg: ProviderConfig): string[] {
    const p = this.get(key);
    if (!p) return [];
    return p.meta.fields.filter((f) => f.required && (!f.env || f.env === cfg.environment) && (cfg[f.key] === undefined || cfg[f.key] === null || cfg[f.key] === '')).map((f) => f.label);
  }
}
