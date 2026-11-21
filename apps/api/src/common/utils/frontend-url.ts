import type { ConfigService } from '@nestjs/config';
import { localePrefix } from '@cmsnt/shared';

/** Phần tối thiểu của SettingsService cần dùng (tránh import vòng giữa module) */
interface SettingsReader {
  get<T = Record<string, unknown>>(group: string): Promise<T>;
}

/**
 * Phần tối thiểu của LanguagesService: tra ngôn ngữ mặc định; `resolve` (nếu có) dùng để
 * bỏ ngôn ngữ không hợp lệ / đã tắt (vd. User.locale cũ) → quay về ngôn ngữ mặc định, tránh link 404.
 */
export interface DefaultLocaleReader {
  defaultLocale(): Promise<string>;
  resolve?(locale?: string | null): Promise<string>;
}

/**
 * Ngôn ngữ của link frontend.
 * - `locale`: ngôn ngữ đích (order.locale, User.locale, ngôn ngữ request...). Bỏ trống = ngôn ngữ mặc định.
 * - `defaultLocale`: ngôn ngữ mặc định đã biết sẵn (đỡ tra lại); nếu không có thì tra qua `languages`.
 * Quy ước chung của dự án (`localePrefix` trong @cmsnt/shared): ngôn ngữ mặc định không có tiền tố,
 * ngôn ngữ khác có tiền tố `/{locale}` — vd. `/account` (vi, mặc định) và `/en/account`.
 */
export interface FrontendLocaleOptions {
  locale?: string | null;
  defaultLocale?: string | null;
  languages?: DefaultLocaleReader;
}

/**
 * Địa chỉ gốc của website khách (frontend riêng của từng dự án), không có "/" ở cuối.
 * Thứ tự ưu tiên: biến môi trường WEB_URL → Cài đặt › Chung › Địa chỉ website (general.siteUrl).
 * Trả chuỗi rỗng khi chưa cấu hình — nơi gọi phải tự xử lý (bỏ link / báo lỗi cấu hình),
 * tuyệt đối không ghép thành đường dẫn tương đối.
 */
export async function frontendBaseUrl(config: ConfigService, settings: SettingsReader): Promise<string> {
  const fromEnv = config.get<string>('web.url') || '';
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const general = await settings.get<{ siteUrl?: string }>('general');
  return (general.siteUrl || '').trim().replace(/\/$/, '');
}

/**
 * Tính tiền tố ngôn ngữ ("" hoặc "/en") theo quy ước chung.
 * Không truyền locale hoặc không biết ngôn ngữ mặc định → "" (link ngôn ngữ mặc định).
 */
export async function frontendLocalePrefix(opts?: FrontendLocaleOptions | null): Promise<string> {
  let locale = opts?.locale?.trim();
  if (!locale) return '';
  // chuẩn hoá qua LanguagesService.resolve: ngôn ngữ chưa bật/không tồn tại -> ngôn ngữ mặc định (không tiền tố)
  if (opts?.languages?.resolve) locale = await opts.languages.resolve(locale);
  const def = opts?.defaultLocale || (opts?.languages ? await opts.languages.defaultLocale() : '');
  if (!def) return '';
  return localePrefix(locale, def);
}

/**
 * Ghép tiền tố ngôn ngữ vào đường dẫn (thuần hàm, không I/O).
 * `/account` + en → `/en/account`; `/` hoặc "" + en → `/en`; ngôn ngữ mặc định giữ nguyên.
 * Phần query/hash giữ nguyên: `/account?x=1#a` + en → `/en/account?x=1#a`.
 */
export function withLocalePrefix(path: string, prefix: string): string {
  const p = !path ? '/' : path.startsWith('/') ? path : `/${path}`;
  if (!prefix) return p;
  // trang chủ của ngôn ngữ phụ là "/en" (không có "/" cuối), giống buildPath('home') trong @cmsnt/shared
  if (p === '/') return prefix;
  if (p.startsWith('/?') || p.startsWith('/#')) return `${prefix}${p.slice(1)}`;
  return `${prefix}${p}`;
}

/**
 * Địa chỉ gốc frontend kèm tiền tố ngôn ngữ (vd. `https://shop.vn/en`) — dùng khi một chỗ cần ghép
 * nhiều đường dẫn (giỏ hàng, mẫu email). Trả "" khi chưa cấu hình địa chỉ website.
 */
export async function frontendLocaleBaseUrl(config: ConfigService, settings: SettingsReader, locale?: FrontendLocaleOptions | null): Promise<string> {
  const base = await frontendBaseUrl(config, settings);
  if (!base) return '';
  return `${base}${await frontendLocalePrefix(locale)}`;
}

/**
 * Ghép đường dẫn vào địa chỉ frontend; trả null khi chưa cấu hình địa chỉ website.
 * Tham số thứ 4 (tuỳ chọn) gắn tiền tố ngôn ngữ — bỏ qua thì giữ hành vi cũ (không tiền tố).
 */
export async function frontendUrl(config: ConfigService, settings: SettingsReader, path: string, locale?: FrontendLocaleOptions | null): Promise<string | null> {
  const base = await frontendBaseUrl(config, settings);
  if (!base) return null;
  return `${base}${withLocalePrefix(path, await frontendLocalePrefix(locale))}`;
}
