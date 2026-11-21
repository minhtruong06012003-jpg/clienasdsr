/**
 * Tiện ích thống kê truy cập: nhận diện bot, phân tích User-Agent, mã khách ẩn danh, chuẩn hoá đường dẫn/nguồn.
 * Không phụ thuộc Prisma/Nest để test đơn vị.
 */
import { createHash } from 'node:crypto';

/** Bot, crawler, công cụ đo hiệu năng, trình duyệt không giao diện -> không ghi nhận ("cubot" là hãng điện thoại, không phải bot) */
const BOT_RE =
  /(?<!cu)bot|crawl|spider|slurp|archiver|facebookexternalhit|facebookcatalog|embedly|preview|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl|wget|python|axios|node-fetch|undici|go-http|java\/|okhttp|httpclient|scrapy|postman|insomnia|zgrab|masscan/i;

export function isBot(ua: string | undefined | null): boolean {
  if (!ua || ua.length < 20) return true;
  return BOT_RE.test(ua);
}

export interface UaInfo {
  device: 'desktop' | 'mobile' | 'tablet';
  browser: string | null;
  os: string | null;
}

/** Phân tích User-Agent gọn nhẹ (đủ cho báo cáo, không cần thư viện) */
export function parseUserAgent(ua: string): UaInfo {
  const s = ua || '';
  let device: UaInfo['device'] = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk|Kindle|SM-T\d/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini|IEMobile/i.test(s)) device = 'mobile';

  let os: string | null = null;
  if (/Windows NT|Windows Phone/i.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';

  // thứ tự quan trọng: trình duyệt nhân Chromium đều chứa "Chrome", Chrome chứa "Safari"
  const browsers: [RegExp, string][] = [
    [/Zalo/i, 'Zalo'],
    [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
    [/Instagram/i, 'Instagram'],
    [/TikTok|musical_ly|Bytedance/i, 'TikTok'],
    [/coc_coc_browser/i, 'Cốc Cốc'],
    [/Edg(e|A|iOS)?\//i, 'Edge'],
    [/OPR\/|Opera/i, 'Opera'],
    [/SamsungBrowser/i, 'Samsung Internet'],
    [/YaBrowser/i, 'Yandex'],
    [/UCBrowser/i, 'UC Browser'],
    [/Firefox|FxiOS/i, 'Firefox'],
    [/Chrome|CriOS|Chromium/i, 'Chrome'],
    [/Safari/i, 'Safari'],
  ];
  const browser = browsers.find(([re]) => re.test(s))?.[1] ?? null;
  return { device, browser, os };
}

/**
 * Mã khách ẩn danh: băm (bí mật + ngày + IP + UA). Đổi mỗi ngày nên không theo dõi được người dùng lâu dài,
 * không lưu IP. Khách quay lại ngày khác được đếm là khách mới (giống Plausible/Fathom).
 */
export function visitorHash(secret: string, day: string, ip: string, ua: string): string {
  return createHash('sha256').update(`${secret}|${day}|${ip}|${ua}`).digest('hex').slice(0, 20);
}

/** Đường dẫn chuẩn: bỏ query/hash, bỏ "/" cuối, giới hạn độ dài; không hợp lệ -> null */
export function normalizePath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (!p.startsWith('/')) return null;
  p = p.split(/[?#]/)[0];
  try {
    p = decodeURI(p);
  } catch {
    /* giữ nguyên nếu không giải mã được */
  }
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.slice(0, 500) || '/';
}

/** Tên miền nguồn giới thiệu (bỏ www, chữ thường); trùng tên miền website hoặc không hợp lệ -> null */
export function referrerHost(referrer: unknown, siteHost?: string | null): string | null {
  if (typeof referrer !== 'string' || !referrer) return null;
  try {
    const u = new URL(referrer);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      // ứng dụng Android gửi referrer dạng android-app://com.google.android.gm
      return u.protocol === 'android-app:' ? u.hostname.toLowerCase() || null : null;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (siteHost && host === siteHost.toLowerCase().replace(/^www\./, '')) return null;
    return host || null;
  } catch {
    return null;
  }
}

/** Đường dẫn khớp một trong các tiền tố loại trừ (mỗi dòng một tiền tố, hỗ trợ * ở cuối) */
export function isExcludedPath(path: string, rules: string | undefined): boolean {
  if (!rules) return false;
  return rules
    .split(/\r?\n|,/)
    .map((r) => r.trim().replace(/\*+$/, ''))
    .filter(Boolean)
    .some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || (prefix.endsWith('/') && path.startsWith(prefix)));
}

/** Cắt chuỗi tuỳ chọn, rỗng -> null */
export function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}
