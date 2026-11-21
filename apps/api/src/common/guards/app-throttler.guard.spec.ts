import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { Throttle, ThrottlerException } from '@nestjs/throttler';
import { AppThrottlerGuard, matchesServerSecret, throttleOptionsFromEnv, trustedClientIp } from './app-throttler.guard.js';

/** Controller giả: một route không có @Throttle riêng, một route giới hạn 2 lần/phút (như đăng nhập) */
class FakeController {
  plain() {}
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  login() {}
}

/** Bộ đếm trong bộ nhớ thay ThrottlerStorageService */
function memoryStorage() {
  const hits = new Map<string, number>();
  return {
    hits,
    increment: vi.fn(async (key: string, ttl: number, limit: number) => {
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { totalHits: n, timeToExpire: ttl / 1000, isBlocked: n > limit, timeToBlockExpire: n > limit ? ttl / 1000 : 0 };
    }),
  };
}

async function setup(limit = 3, validKey = false) {
  const storage = memoryStorage();
  const apiKeys = { authenticate: vi.fn(async () => (validKey ? { id: 'u1' } : null)) };
  const guard = new AppThrottlerGuard({ throttlers: [{ ttl: 60_000, limit }] }, storage as never, new Reflector(), apiKeys as never);
  await guard.onModuleInit();
  const call = (handler: 'plain' | 'login', headers: Record<string, string> = {}, ip = '10.0.0.1') => {
    const req = { headers, ip };
    const res = { header: vi.fn() };
    const ctx = {
      getHandler: () => FakeController.prototype[handler],
      getClass: () => FakeController,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };
    return guard.canActivate(ctx as never);
  };
  return { guard, storage, apiKeys, call };
}

describe('AppThrottlerGuard', () => {
  afterEach(() => {
    delete process.env.SERVER_API_SECRET;
    delete process.env.THROTTLE_LIMIT;
    delete process.env.THROTTLE_TTL;
  });

  it('request thường vẫn bị giới hạn toàn cục', async () => {
    const { call } = await setup(2);
    await call('plain');
    await call('plain');
    await expect(call('plain')).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('x-server-secret đúng: miễn giới hạn toàn cục', async () => {
    process.env.SERVER_API_SECRET = 'bi-mat-may-chu-frontend-ssr-123456';
    const { call } = await setup(2);
    for (let i = 0; i < 10; i++) await expect(call('plain', { 'x-server-secret': 'bi-mat-may-chu-frontend-ssr-123456' })).resolves.toBe(true);
  });

  it('x-server-secret sai: không được miễn', async () => {
    process.env.SERVER_API_SECRET = 'bi-mat-may-chu-frontend-ssr-123456';
    const { call } = await setup(1);
    await call('plain', { 'x-server-secret': 'sai' });
    await expect(call('plain', { 'x-server-secret': 'sai' })).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('API key hợp lệ: miễn giới hạn toàn cục, tra key có cache', async () => {
    const { call, apiKeys } = await setup(1, true);
    const headers = { 'x-api-key': `cmsnt_${'A'.repeat(32)}` };
    for (let i = 0; i < 5; i++) await expect(call('plain', headers)).resolves.toBe(true);
    expect(apiKeys.authenticate).toHaveBeenCalledTimes(1);
  });

  it('route có @Throttle riêng vẫn áp dụng với request được miễn, đếm theo IP thật trong x-client-ip', async () => {
    process.env.SERVER_API_SECRET = 'bi-mat-may-chu-frontend-ssr-123456';
    const { call } = await setup(100);
    const as = (ip: string) => ({ 'x-server-secret': 'bi-mat-may-chu-frontend-ssr-123456', 'x-client-ip': ip });
    await call('login', as('1.1.1.1'));
    await call('login', as('1.1.1.1'));
    await expect(call('login', as('1.1.1.1'))).rejects.toBeInstanceOf(ThrottlerException);
    // khách khác (IP khác) đi qua cùng máy chủ frontend không bị ảnh hưởng
    await expect(call('login', as('2.2.2.2'))).resolves.toBe(true);
  });

  it('helper: so khớp secret, đọc IP khách, đọc cấu hình env', () => {
    expect(matchesServerSecret('abc', '')).toBe(false);
    expect(matchesServerSecret('abc', 'abc')).toBe(true);
    expect(matchesServerSecret(['abc'], 'abc')).toBe(true);
    expect(trustedClientIp({ headers: { 'x-client-ip': 'khong-phai-ip' }, ip: '9.9.9.9' })).toBe('9.9.9.9');
    expect(trustedClientIp({ headers: { 'x-client-ip': '203.0.113.5, 10.0.0.1' }, ip: '9.9.9.9' })).toBe('203.0.113.5');
    process.env.THROTTLE_LIMIT = '1000';
    process.env.THROTTLE_TTL = '30';
    expect(throttleOptionsFromEnv()).toMatchObject({ throttlers: [{ limit: 1000, ttl: 30_000 }] });
    process.env.THROTTLE_LIMIT = 'abc';
    expect(throttleOptionsFromEnv()).toMatchObject({ throttlers: [{ limit: 300 }] });
  });
});
