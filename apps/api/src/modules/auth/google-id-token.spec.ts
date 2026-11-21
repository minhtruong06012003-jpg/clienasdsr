import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GoogleIdTokenVerifier, GoogleTokenError, parseMaxAge } from './google-id-token.js';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const NOW = 1_800_000_000_000;

/** Cặp khoá RSA giả lập khoá ký của Google */
function makeKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Ký ID token RS256 như Google */
function signToken(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const p = b64(claims);
  const s = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key.privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '1234567890',
  email: 'Khach@Gmail.com',
  email_verified: true,
  name: 'Khách Test',
  iat: NOW / 1000 - 10,
  exp: NOW / 1000 + 3600,
  ...over,
});

/** fetch giả trả JWKS với Cache-Control tuỳ chọn */
function makeFetch(keys: unknown[], cacheControl = 'public, max-age=600') {
  return vi.fn(async () => ({ ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === 'cache-control' ? cacheControl : null) }, json: async () => ({ keys }) }));
}

describe('GoogleIdTokenVerifier', () => {
  const k1 = makeKey('k1');

  it('chấp nhận token hợp lệ, chuẩn hoá email', async () => {
    const v = new GoogleIdTokenVerifier(makeFetch([k1.jwk]), () => NOW);
    const id = await v.verify(signToken(k1, goodClaims()), CLIENT_ID);
    expect(id).toMatchObject({ sub: '1234567890', email: 'khach@gmail.com', emailVerified: true, name: 'Khách Test' });
  });

  it('chấp nhận iss không có https và email_verified dạng chuỗi', async () => {
    const v = new GoogleIdTokenVerifier(makeFetch([k1.jwk]), () => NOW);
    await expect(v.verify(signToken(k1, goodClaims({ iss: 'accounts.google.com', email_verified: 'true' })), CLIENT_ID)).resolves.toBeTruthy();
  });

  it.each([
    ['sai aud', { aud: 'khac.apps.googleusercontent.com' }],
    ['sai iss', { iss: 'https://evil.example.com' }],
    ['hết hạn', { exp: NOW / 1000 - 3600 }],
    ['iat ở tương lai', { iat: NOW / 1000 + 3600 }],
    ['email chưa xác minh', { email_verified: false }],
    ['thiếu sub', { sub: '' }],
  ])('từ chối token %s', async (_n, over) => {
    const v = new GoogleIdTokenVerifier(makeFetch([k1.jwk]), () => NOW);
    await expect(v.verify(signToken(k1, goodClaims(over)), CLIENT_ID)).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it('từ chối chữ ký sai (ký bằng khoá khác cùng kid) và alg khác RS256', async () => {
    const v = new GoogleIdTokenVerifier(makeFetch([k1.jwk]), () => NOW);
    const forged = makeKey('k1');
    await expect(v.verify(signToken(forged, goodClaims()), CLIENT_ID)).rejects.toThrow(/Chữ ký/);
    const t = signToken(k1, goodClaims(), { alg: 'none' });
    await expect(v.verify(t, CLIENT_ID)).rejects.toThrow(/Thuật toán/);
    await expect(v.verify('abc.def', CLIENT_ID)).rejects.toThrow(/định dạng/);
  });

  it('cache JWKS theo max-age; hết hạn thì tải lại', async () => {
    let now = NOW;
    const f = makeFetch([k1.jwk], 'max-age=600');
    const v = new GoogleIdTokenVerifier(f, () => now);
    await v.verify(signToken(k1, goodClaims()), CLIENT_ID);
    await v.verify(signToken(k1, goodClaims()), CLIENT_ID);
    expect(f).toHaveBeenCalledTimes(1);
    now += 601_000;
    await v.verify(signToken(k1, goodClaims({ exp: now / 1000 + 100 })), CLIENT_ID);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('kid lạ -> tải lại JWKS nhưng giới hạn tần suất', async () => {
    let now = NOW;
    const k2 = makeKey('k2');
    let keys: unknown[] = [k1.jwk];
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => 'max-age=3600' }, json: async () => ({ keys }) }));
    const v = new GoogleIdTokenVerifier(f, () => now);
    await v.verify(signToken(k1, goodClaims()), CLIENT_ID);
    // Google xoay khoá: kid k2 chưa có trong cache, vừa tải xong < 60s -> chưa tải lại
    keys = [k1.jwk, k2.jwk];
    await expect(v.verify(signToken(k2, goodClaims()), CLIENT_ID)).rejects.toThrow(/Khoá ký/);
    expect(f).toHaveBeenCalledTimes(1);
    now += 61_000;
    await expect(v.verify(signToken(k2, goodClaims()), CLIENT_ID)).resolves.toBeTruthy();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('parseMaxAge', () => {
    expect(parseMaxAge('public, max-age=19914, must-revalidate')).toBe(19914);
    expect(parseMaxAge(null)).toBeNull();
  });
});
