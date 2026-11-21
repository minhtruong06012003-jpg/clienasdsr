import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StorefrontCapabilities, StorefrontStatusView } from '@cmsnt/shared';
import { appVersion } from '../../config/app-version.js';

type ThemeInfo = NonNullable<StorefrontCapabilities['theme']>;

/** Hỏi frontend riêng chỉ chờ ngắn: nó nằm cùng máy hoặc cùng mạng nội bộ. */
const STOREFRONT_TIMEOUT_MS = 5_000;

/**
 * Khả năng của frontend riêng (nếu có) đang chạy, lấy từ `GET <web>/api/capabilities`:
 * theme (vị trí menu, vùng widget...), block render được, lõi lúc build.
 * Cache ngắn phần theme để admin mở trang không gọi frontend liên tục;
 * frontend không phản hồi / không có endpoint này → coi như theme không khai báo thêm gì.
 */
@Injectable()
export class ThemeCapabilitiesService {
  private cache: { at: number; ttl: number; theme: ThemeInfo | null } | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Hỏi frontend riêng `/api/capabilities` (qua URL nội bộ) để biết nó build với lõi nào và hỗ trợ block gì. */
  async storefront(): Promise<StorefrontStatusView> {
    const coreVersion = appVersion();
    const base = this.config.get<string>('web.internalUrl') || this.config.get<string>('web.url') || '';
    if (!base) return { reachable: false, url: '', error: 'Chưa cấu hình WEB_URL', coreVersion, capabilities: null };
    const url = `${base}/api/capabilities`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(STOREFRONT_TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!res.ok) return { reachable: false, url: base, error: res.status === 404 ? 'Frontend riêng không có /api/capabilities (tuỳ chọn — chỉ cần khi frontend khai báo vị trí menu / vùng widget / block hỗ trợ)' : `HTTP ${res.status}`, coreVersion, capabilities: null };
      const body = (await res.json()) as Partial<StorefrontCapabilities>;
      const capabilities: StorefrontCapabilities = {
        coreVersion: typeof body.coreVersion === 'string' ? body.coreVersion : null,
        blocks: Array.isArray(body.blocks) ? body.blocks.filter((b): b is string => typeof b === 'string') : [],
        builtAt: typeof body.builtAt === 'string' ? body.builtAt : null,
        storefrontVersion: typeof body.storefrontVersion === 'string' ? body.storefrontVersion : null,
        theme: parseThemeInfo(body.theme),
      };
      return { reachable: true, url: base, error: null, coreVersion, capabilities };
    } catch (e) {
      return { reachable: false, url: base, error: e instanceof Error ? e.message : 'Không kết nối được', coreVersion, capabilities: null };
    }
  }

  async theme(): Promise<ThemeInfo | null> {
    if (this.cache && Date.now() - this.cache.at < this.cache.ttl) return this.cache.theme;
    let theme: ThemeInfo | null = null;
    let ok = false;
    try {
      const s = await this.storefront();
      theme = s.capabilities?.theme ?? null;
      ok = s.reachable;
    } catch {
      theme = null;
    }
    // thành công: giữ 60s; lỗi: thử lại sau 15s
    this.cache = { at: Date.now(), ttl: ok ? 60_000 : 15_000, theme };
    return theme;
  }

  async menuLocations(): Promise<{ key: string; label: string }[]> {
    return (await this.theme())?.menuLocations ?? [];
  }

  async widgetAreas(): Promise<{ key: string; label: string; description?: string }[]> {
    return (await this.theme())?.widgetAreas ?? [];
  }
}

/** Làm sạch thông tin theme storefront gửi về (dữ liệu ngoài, không tin tuyệt đối) */
export function parseThemeInfo(raw: unknown): StorefrontCapabilities['theme'] {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const str = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
  const list = <T>(v: unknown, map: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.slice(0, 100).map((x) => (x && typeof x === 'object' ? map(x as Record<string, unknown>) : null)).filter((x): x is T => x !== null) : [];
  const keyLabel = (x: Record<string, unknown>) => {
    const key = str(x.key, 64);
    return key && /^[a-z0-9][a-z0-9_-]*$/i.test(key) ? { key, label: str(x.label) ?? key, description: str(x.description, 500) } : null;
  };
  return {
    name: str(t.name, 100) ?? 'unknown',
    label: str(t.label),
    version: str(t.version, 50) ?? '0.0.0',
    requiresCore: str(t.requiresCore, 100),
    components: Array.isArray(t.components) ? t.components.filter((c): c is string => typeof c === 'string').slice(0, 100) : [],
    menuLocations: list(t.menuLocations, (x) => {
      const v = keyLabel(x);
      return v ? { key: v.key, label: v.label } : null;
    }),
    widgetAreas: list(t.widgetAreas, keyLabel),
    contentTypes: Array.isArray(t.contentTypes) ? t.contentTypes.filter((c): c is string => typeof c === 'string').slice(0, 100) : [],
  };
}
