import { frontendBaseUrl, frontendLocaleBaseUrl, frontendLocalePrefix, frontendUrl, withLocalePrefix } from './frontend-url.js';
import { buildOrderVars } from '../../modules/mail/order-vars.js';

/** Dựng ConfigService/SettingsService giả: WEB_URL và Cài đặt › Chung › siteUrl */
const make = (webUrl: string, siteUrl = '') => ({
  config: { get: (k: string) => (k === 'web.url' ? webUrl : undefined) } as never,
  settings: { get: async () => ({ siteUrl }) as never },
});

/** LanguagesService giả: vi mặc định, vi/en đang bật */
const languages = {
  defaultLocale: async () => 'vi',
  resolve: async (l?: string | null) => (l && ['vi', 'en'].includes(l) ? l : 'vi'),
};

describe('withLocalePrefix', () => {
  it('ngôn ngữ mặc định giữ nguyên đường dẫn', () => {
    expect(withLocalePrefix('/account', '')).toBe('/account');
    expect(withLocalePrefix('account', '')).toBe('/account');
  });

  it('ngôn ngữ khác thêm /{locale}, giữ query/hash', () => {
    expect(withLocalePrefix('/account?x=1#a', '/en')).toBe('/en/account?x=1#a');
    expect(withLocalePrefix('/', '/en')).toBe('/en');
    expect(withLocalePrefix('', '/en')).toBe('/en');
    expect(withLocalePrefix('/?ref=mail', '/en')).toBe('/en?ref=mail');
  });
});

describe('frontendLocalePrefix', () => {
  it('không truyền locale -> không tiền tố', async () => {
    expect(await frontendLocalePrefix()).toBe('');
    expect(await frontendLocalePrefix({ locale: null, languages })).toBe('');
  });

  it('mặc định không tiền tố, ngôn ngữ khác /{locale}', async () => {
    expect(await frontendLocalePrefix({ locale: 'vi', languages })).toBe('');
    expect(await frontendLocalePrefix({ locale: 'en', languages })).toBe('/en');
    expect(await frontendLocalePrefix({ locale: 'en', defaultLocale: 'en' })).toBe('');
  });

  it('ngôn ngữ đã tắt / không tồn tại -> quay về mặc định (không tiền tố)', async () => {
    expect(await frontendLocalePrefix({ locale: 'fr', languages })).toBe('');
  });

  it('không biết ngôn ngữ mặc định -> không tiền tố', async () => {
    expect(await frontendLocalePrefix({ locale: 'en' })).toBe('');
  });
});

describe('frontendUrl / frontendLocaleBaseUrl', () => {
  it('WEB_URL ưu tiên hơn Cài đặt, bỏ "/" cuối', async () => {
    const { config, settings } = make('https://shop.vn/', 'https://other.vn');
    expect(await frontendBaseUrl(config, settings)).toBe('https://shop.vn');
  });

  it('không có WEB_URL -> dùng general.siteUrl', async () => {
    const { config, settings } = make('', ' https://site.vn/ ');
    expect(await frontendBaseUrl(config, settings)).toBe('https://site.vn');
  });

  it('giữ chữ ký cũ (không tiền tố) khi không truyền locale', async () => {
    const { config, settings } = make('https://shop.vn');
    expect(await frontendUrl(config, settings, '/account/wallet?topup=1')).toBe('https://shop.vn/account/wallet?topup=1');
  });

  it('gắn tiền tố theo locale', async () => {
    const { config, settings } = make('https://shop.vn');
    expect(await frontendUrl(config, settings, '/account#downloads', { locale: 'en', languages })).toBe('https://shop.vn/en/account#downloads');
    expect(await frontendUrl(config, settings, '/account#downloads', { locale: 'vi', languages })).toBe('https://shop.vn/account#downloads');
    expect(await frontendLocaleBaseUrl(config, settings, { locale: 'en', languages })).toBe('https://shop.vn/en');
  });

  it('chưa cấu hình địa chỉ website -> null / chuỗi rỗng', async () => {
    const { config, settings } = make('');
    expect(await frontendUrl(config, settings, '/account', { locale: 'en', languages })).toBeNull();
    expect(await frontendLocaleBaseUrl(config, settings, { locale: 'en', languages })).toBe('');
  });
});

describe('buildOrderVars: link theo ngôn ngữ đơn', () => {
  const order = { id: 'o1', code: 'DH001', status: 'PENDING', paymentStatus: 'UNPAID', paymentMethod: 'payos', locale: 'en', items: [] };

  it('ngôn ngữ khác mặc định -> /en/order-tracking, /en/order-success', () => {
    const v = buildOrderVars(order, { webUrl: 'https://shop.vn', defaultLocale: 'vi', isOnlinePayment: true });
    expect(v.trackingUrl).toBe('https://shop.vn/en/order-tracking?code=DH001');
    expect(v.payUrl).toBe('https://shop.vn/en/order-success?code=DH001');
  });

  it('ngôn ngữ mặc định -> không tiền tố', () => {
    const v = buildOrderVars({ ...order, locale: 'vi' }, { webUrl: 'https://shop.vn', defaultLocale: 'vi' });
    expect(v.trackingUrl).toBe('https://shop.vn/order-tracking?code=DH001');
  });

  it('không truyền defaultLocale -> giữ hành vi cũ (webUrl dùng nguyên)', () => {
    const v = buildOrderVars(order, { webUrl: 'https://shop.vn/en' });
    expect(v.trackingUrl).toBe('https://shop.vn/en/order-tracking?code=DH001');
  });
});
