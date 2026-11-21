import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { ApiKeyAuthService } from './api-key-auth.service.js';
import { effectivePermissions, extractApiKey, generateApiKey, hashApiKey, isApiKeyBlockedRoute, isCustomerApiKeyRoute, displayPrefix } from './api-key.util.js';
import { DenyApiKey } from './deny-api-key.decorator.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { SessionsService } from '../security/sessions.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUserCache } from '../auth/auth-user.cache.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';

const OWNER: AuthUser = { id: 'u1', email: 'a@x.vn', name: 'An', roleId: 'r1', roleSlug: 'editor', permissions: ['admin.access', 'posts.read', 'posts.write'] };

/** Dựng ApiKeyAuthService với Prisma/AuthUserCache giả */
function makeAuth(row: Record<string, unknown> | null, user: AuthUser | null = OWNER) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const update = vi.fn().mockResolvedValue({});
  const prisma = { apiKey: { findUnique, update } } as unknown as PrismaService;
  const users = { get: vi.fn().mockResolvedValue(user) } as unknown as AuthUserCache;
  return { svc: new ApiKeyAuthService(prisma, users), findUnique, update };
}

describe('api-key.util', () => {
  it('sinh key đúng định dạng cmsnt_ + 32 base62, không trùng', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^cmsnt_[0-9A-Za-z]{32}$/);
    expect(a).not.toBe(b);
    expect(displayPrefix(a)).toHaveLength(12);
    expect(hashApiKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lấy key từ Bearer cmsnt_ hoặc X-API-Key; Bearer JWT bỏ qua', () => {
    expect(extractApiKey({ authorization: 'Bearer cmsnt_abc' })).toBe('cmsnt_abc');
    expect(extractApiKey({ 'x-api-key': ' cmsnt_xyz ' })).toBe('cmsnt_xyz');
    expect(extractApiKey({ authorization: 'Bearer eyJhbGciOi' })).toBeUndefined();
    expect(extractApiKey({})).toBeUndefined();
  });

  it('quyền hiệu lực = giao quyền vai trò và quyền key; key rỗng = toàn bộ quyền vai trò', () => {
    expect(effectivePermissions(['a', 'b'], [])).toEqual(['a', 'b']);
    expect(effectivePermissions(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(effectivePermissions(['*'], ['x.y'])).toEqual(['x.y']);
    // key "*" nhưng vai trò không phải admin toàn quyền -> không có gì
    expect(effectivePermissions(['a'], ['*'])).toEqual([]);
  });

  it('chặn route nhạy cảm khi dùng key', () => {
    expect(isApiKeyBlockedRoute('POST', '/api/auth/change-password')).toBe(true);
    expect(isApiKeyBlockedRoute('POST', '/api/auth/2fa/disable')).toBe(true);
    expect(isApiKeyBlockedRoute('GET', '/api/auth/me')).toBe(false);
    expect(isApiKeyBlockedRoute('PATCH', '/api/auth/me')).toBe(true);
    expect(isApiKeyBlockedRoute('POST', '/api/admin/api-keys')).toBe(true);
    expect(isApiKeyBlockedRoute('DELETE', '/api/admin/api-keys/123')).toBe(true);
    expect(isApiKeyBlockedRoute('GET', '/api/admin/api-keys')).toBe(false);
    expect(isApiKeyBlockedRoute('GET', '/api/admin/posts')).toBe(false);
    expect(isApiKeyBlockedRoute('POST', '/api/admin/authors')).toBe(false);
    expect(isApiKeyBlockedRoute('POST', '/api/account/api-keys')).toBe(true);
    expect(isApiKeyBlockedRoute('DELETE', '/api/account/api-keys/123')).toBe(true);
  });

  it('key của khách chỉ gọi được nhóm route AI Studio', () => {
    expect(isCustomerApiKeyRoute('POST', '/api/account/ai/tools/tmc-video/run')).toBe(true);
    expect(isCustomerApiKeyRoute('GET', '/api/account/ai/tasks/T123')).toBe(true);
    expect(isCustomerApiKeyRoute('GET', '/api/public/ai/tools')).toBe(true);
    expect(isCustomerApiKeyRoute('GET', '/api/account/credits')).toBe(true);
    expect(isCustomerApiKeyRoute('GET', '/api/auth/me')).toBe(true);
    expect(isCustomerApiKeyRoute('POST', '/api/account/credits/checkout')).toBe(false);
    expect(isCustomerApiKeyRoute('POST', '/api/account/affiliate/payouts')).toBe(false);
    expect(isCustomerApiKeyRoute('GET', '/api/account/api-keys')).toBe(false);
    expect(isCustomerApiKeyRoute('GET', '/api/admin/users')).toBe(false);
  });
});

describe('ApiKeyAuthService', () => {
  const key = generateApiKey();
  const base = { id: 'k1', userId: 'u1', permissions: [] as string[], expiresAt: null, revokedAt: null };

  it('key hợp lệ -> user kèm quyền hiệu lực và apiKeyId, tra theo sha256', async () => {
    const { svc, findUnique } = makeAuth({ ...base, permissions: ['posts.read', 'orders.read'] });
    const u = await svc.authenticate(key, '1.2.3.4');
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { hash: hashApiKey(key) } }));
    expect(u).toMatchObject({ id: 'u1', apiKeyId: 'k1', permissions: ['posts.read'] });
  });

  it('sai định dạng -> null, không truy vấn DB', async () => {
    const { svc, findUnique } = makeAuth(base);
    await expect(svc.authenticate('cmsnt_ngan')).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('không tìm thấy / đã thu hồi / hết hạn / chủ key bị khoá -> null', async () => {
    await expect(makeAuth(null).svc.authenticate(key)).resolves.toBeNull();
    await expect(makeAuth({ ...base, revokedAt: new Date() }).svc.authenticate(key)).resolves.toBeNull();
    await expect(makeAuth({ ...base, expiresAt: new Date(Date.now() - 1000) }).svc.authenticate(key)).resolves.toBeNull();
    await expect(makeAuth(base, null).svc.authenticate(key)).resolves.toBeNull();
    await expect(makeAuth({ ...base, expiresAt: new Date(Date.now() + 60_000) }).svc.authenticate(key)).resolves.not.toBeNull();
  });

  it('ghi lastUsedAt tối đa 1 lần/phút', async () => {
    const { svc, update } = makeAuth(base);
    await svc.authenticate(key, '1.1.1.1');
    await svc.authenticate(key, '1.1.1.1');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 'k1' }, data: expect.objectContaining({ lastUsedIp: '1.1.1.1' }) });
  });
});

// Controller giả để gắn metadata cho guard
class Ctl {
  list() {}
  @DenyApiKey()
  create() {}
}

describe('JwtAuthGuard + API key', () => {
  function run(headers: Record<string, string>, opts: { handler?: 'list' | 'create'; method?: string; url?: string; keyUser?: unknown; payload?: object } = {}) {
    const req: Record<string, unknown> = { headers, method: opts.method ?? 'GET', originalUrl: opts.url ?? '/api/admin/posts', ip: '9.9.9.9' };
    const ctx = {
      getClass: () => Ctl,
      getHandler: () => Ctl.prototype[opts.handler ?? 'list'],
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const jwt = { verifyAsync: vi.fn().mockResolvedValue(opts.payload ?? { sub: 'u1', sid: 's1' }) } as unknown as JwtService;
    const users = { get: vi.fn().mockResolvedValue(OWNER) } as unknown as AuthUserCache;
    const apiKeys = { authenticate: vi.fn().mockResolvedValue(opts.keyUser === undefined ? { ...OWNER, apiKeyId: 'k1' } : opts.keyUser) } as unknown as ApiKeyAuthService;
    const sessions = { isActive: vi.fn().mockResolvedValue(true) } as unknown as SessionsService;
    const guard = new JwtAuthGuard(new Reflector(), jwt, users, apiKeys, sessions);
    return { result: guard.canActivate(ctx), req, jwt, apiKeys };
  }

  it('Bearer cmsnt_ -> xác thực bằng key, không gọi JWT', async () => {
    const { result, req, jwt } = run({ authorization: 'Bearer cmsnt_x' });
    await expect(result).resolves.toBe(true);
    expect(req.authMethod).toBe('api_key');
    expect((req.user as { apiKeyId: string }).apiKeyId).toBe('k1');
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('X-API-Key sai/thu hồi -> 401', async () => {
    const { result } = run({ 'x-api-key': 'cmsnt_bad' }, { keyUser: null });
    await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('key gọi route @DenyApiKey hoặc đổi mật khẩu -> 403', async () => {
    await expect(run({ 'x-api-key': 'cmsnt_x' }, { handler: 'create', method: 'POST', url: '/api/admin/api-keys' }).result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run({ 'x-api-key': 'cmsnt_x' }, { method: 'POST', url: '/api/auth/change-password' }).result).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('JWT vẫn hoạt động như cũ', async () => {
    const { result, req, apiKeys } = run({ authorization: 'Bearer eyJ.jwt.token' });
    await expect(result).resolves.toBe(true);
    expect(req.user).toEqual(OWNER);
    expect(req.authMethod).toBeUndefined();
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('JWT thiếu sid (token tự ký, không gắn phiên) -> 401', async () => {
    await expect(run({ authorization: 'Bearer eyJ.jwt.token' }, { payload: { sub: 'u1' } }).result).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('API key không lách được route /auth/* bằng chữ hoa', async () => {
    await expect(run({ 'x-api-key': 'cmsnt_x' }, { method: 'POST', url: '/api/Auth/2fa/setup' }).result).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('không token trên route cần đăng nhập -> 401', async () => {
    await expect(run({}).result).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
