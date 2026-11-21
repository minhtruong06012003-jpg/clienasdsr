import { describe, expect, it } from 'vitest';
import { isBot, isExcludedPath, normalizePath, parseUserAgent, referrerHost, visitorHash } from './analytics.util.js';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const COCCOC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/120.0.0 Chrome/120.0.0.0 Safari/537.36';
const ZALO_ANDROID = 'Mozilla/5.0 (Linux; Android 12; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Zalo android/12100800 ZaloTheme/light';

describe('analytics.util', () => {
  it('isBot: nhận ra bot, công cụ, UA rỗng; không chặn trình duyệt thật', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBot('curl/8.4.0')).toBe(true);
    expect(isBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot(CHROME_WIN)).toBe(false);
    expect(isBot(SAFARI_IPHONE)).toBe(false);
    // CUBOT là hãng điện thoại, không phải bot
    expect(isBot('Mozilla/5.0 (Linux; Android 11; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')).toBe(false);
  });

  it('parseUserAgent: thiết bị, trình duyệt, hệ điều hành', () => {
    expect(parseUserAgent(CHROME_WIN)).toEqual({ device: 'desktop', browser: 'Chrome', os: 'Windows' });
    expect(parseUserAgent(SAFARI_IPHONE)).toEqual({ device: 'mobile', browser: 'Safari', os: 'iOS' });
    expect(parseUserAgent(ANDROID_TABLET)).toEqual({ device: 'tablet', browser: 'Chrome', os: 'Android' });
    expect(parseUserAgent(COCCOC).browser).toBe('Cốc Cốc');
    expect(parseUserAgent(ZALO_ANDROID)).toEqual({ device: 'mobile', browser: 'Zalo', os: 'Android' });
  });

  it('visitorHash: ổn định trong ngày, đổi khi sang ngày khác', () => {
    const a = visitorHash('s', '2026-10-04', '1.2.3.4', CHROME_WIN);
    expect(a).toHaveLength(20);
    expect(visitorHash('s', '2026-10-04', '1.2.3.4', CHROME_WIN)).toBe(a);
    expect(visitorHash('s', '2026-10-05', '1.2.3.4', CHROME_WIN)).not.toBe(a);
  });

  it('normalizePath: bỏ query, hash, "/" cuối; từ chối URL tuyệt đối', () => {
    expect(normalizePath('/en/blog/?utm_source=fb#top')).toBe('/en/blog');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/s%E1%BA%A3n-ph%E1%BA%A9m')).toBe('/sản-phẩm');
    expect(normalizePath('https://evil.com/x')).toBeNull();
    expect(normalizePath(123)).toBeNull();
  });

  it('referrerHost: bỏ www, bỏ referrer cùng tên miền', () => {
    expect(referrerHost('https://www.google.com/search?q=x', 'shop.vn')).toBe('google.com');
    expect(referrerHost('https://shop.vn/abc', 'www.shop.vn')).toBeNull();
    expect(referrerHost('android-app://com.google.android.gm/', null)).toBe('com.google.android.gm');
    expect(referrerHost('javascript:alert(1)', null)).toBeNull();
    expect(referrerHost('', null)).toBeNull();
  });

  it('isExcludedPath: khớp tiền tố theo đoạn đường dẫn', () => {
    const rules = '/tai-khoan\n/en/account/*\n';
    expect(isExcludedPath('/tai-khoan', rules)).toBe(true);
    expect(isExcludedPath('/tai-khoan/don-hang', rules)).toBe(true);
    expect(isExcludedPath('/tai-khoan-moi', rules)).toBe(false);
    expect(isExcludedPath('/en/account/orders', rules)).toBe(true);
    expect(isExcludedPath('/blog', '')).toBe(false);
  });
});
