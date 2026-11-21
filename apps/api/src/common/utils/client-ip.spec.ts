import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientIpMiddleware, forwardedClientIp } from './client-ip.js';

// Kiểm tra middleware thay req.ip bằng IP khách do frontend SSR khai (chỉ khi có x-server-secret đúng)
describe('client-ip', () => {
  const SECRET = 'bi-mat-may-chu-frontend-ssr-123456';
  beforeEach(() => { process.env.SERVER_API_SECRET = SECRET; });
  afterEach(() => { delete process.env.SERVER_API_SECRET; });

  const req = (headers: Record<string, string>, url = '/api/auth/login') => ({ originalUrl: url, ip: '10.0.0.5', headers });

  it('tin x-client-ip khi secret đúng', () => {
    expect(forwardedClientIp(req({ 'x-server-secret': SECRET, 'x-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('bỏ qua khi thiếu/sai secret, IP không hợp lệ hoặc route admin', () => {
    expect(forwardedClientIp(req({ 'x-client-ip': '203.0.113.7' }))).toBeNull();
    expect(forwardedClientIp(req({ 'x-server-secret': 'sai', 'x-client-ip': '203.0.113.7' }))).toBeNull();
    expect(forwardedClientIp(req({ 'x-server-secret': SECRET, 'x-client-ip': 'khong-phai-ip' }))).toBeNull();
    expect(forwardedClientIp(req({ 'x-server-secret': SECRET, 'x-client-ip': '203.0.113.7' }, '/api/admin/users'))).toBeNull();
  });

  it('không cấu hình SERVER_API_SECRET thì không bao giờ tin header', () => {
    delete process.env.SERVER_API_SECRET;
    expect(forwardedClientIp(req({ 'x-server-secret': '', 'x-client-ip': '203.0.113.7' }))).toBeNull();
  });

  it('middleware ghi đè req.ip', () => {
    const r = req({ 'x-server-secret': SECRET, 'x-client-ip': '2001:db8::1' });
    let called = false;
    clientIpMiddleware()(r, {}, () => { called = true; });
    expect(called).toBe(true);
    expect(r.ip).toBe('2001:db8::1');
  });
});
