import { describe, expect, it } from 'vitest';
import { mergeVary, publicCacheControl } from './public-cache.interceptor.js';

const PUBLIC = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

describe('publicCacheControl', () => {
  it('GET dữ liệu công khai của khách vãng lai -> cache dùng chung', () => {
    expect(publicCacheControl('GET', '/api/public/products?page=2', {}, 60)).toBe(PUBLIC);
    expect(publicCacheControl('GET', '/api/public/bootstrap', {}, 60)).toBe(PUBLIC);
    expect(publicCacheControl('HEAD', '/api/public/sitemap', {}, 60)).toBe(PUBLIC);
  });

  it('không đụng tới route ngoài /api/public', () => {
    expect(publicCacheControl('GET', '/api/admin/products', {}, 60)).toBeNull();
    expect(publicCacheControl('GET', '/api/publicity', {}, 60)).toBeNull();
    expect(publicCacheControl('POST', '/api/admin/products', {}, 60)).toBeNull();
  });

  it('method ghi dưới /api/public (tra cứu đơn, tải file, đếm lượt xem, form) -> private, no-store', () => {
    for (const url of ['/api/public/orders/lookup', '/api/public/orders/DH1/downloads', '/api/public/posts/abc/view', '/api/public/forms/x/submit']) {
      expect(publicCacheControl('POST', url, {}, 60)).toBe('private, no-store');
    }
    expect(publicCacheControl('DELETE', '/api/public/cart/abc/items/1', {}, 60)).toBe('private, no-store');
  });

  it('đã đăng nhập / gọi bằng API key -> private, no-store', () => {
    expect(publicCacheControl('GET', '/api/public/products', { authorization: 'Bearer x' }, 60)).toBe('private, no-store');
    expect(publicCacheControl('GET', '/api/public/products', { 'x-api-key': 'cmsnt_x' }, 60)).toBe('private, no-store');
  });

  it('endpoint cá nhân hoá -> private, no-store', () => {
    for (const url of ['/api/public/cart/abc', '/api/public/orders/lookup?code=1', '/api/public/orders/DH1/payment', '/api/public/downloads/tok', '/api/public/preview/page/1', '/api/public/posts/x?token=abc']) {
      expect(publicCacheControl('GET', url, {}, 60)).toBe('private, no-store');
    }
  });

  it('PUBLIC_CACHE_SMAXAGE=0 tắt cache dùng chung', () => {
    expect(publicCacheControl('GET', '/api/public/products', {}, 0)).toBe('private, no-store');
  });

  it('mergeVary giữ giá trị cũ, không lặp', () => {
    expect(mergeVary('Origin', ['Authorization', 'X-API-Key'])).toBe('Origin, Authorization, X-API-Key');
    expect(mergeVary('origin, authorization', ['Authorization'])).toBe('origin, authorization');
    expect(mergeVary(undefined, ['Authorization'])).toBe('Authorization');
  });
});
