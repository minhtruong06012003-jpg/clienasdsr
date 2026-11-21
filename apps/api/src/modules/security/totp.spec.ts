import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, generateSecret, hotp, normalizeRecoveryCode, otpauthUrl, totp, verifyTotp } from './totp.js';

/** Secret mẫu trong RFC 4226 / RFC 6238: "12345678901234567890" */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('mã hoá / giải mã khớp RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_B32);
    expect(base32Decode(RFC_SECRET_B32).toString('ascii')).toBe('12345678901234567890');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
  });

  it('secret sinh ra là base32 20 byte', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateSecret()).not.toBe(s);
  });

  it('từ chối ký tự không hợp lệ', () => {
    expect(() => base32Decode('ABC1')).toThrow();
  });
});

describe('hotp (RFC 4226 phụ lục D)', () => {
  const vectors = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(vectors.map((v, i) => [i, v]))('counter %i -> %s', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter as number)).toBe(expected);
  });
});

describe('totp (RFC 6238 phụ lục B, SHA1, 8 số)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('T=%i -> %s', (seconds, expected) => {
    expect(totp(RFC_SECRET_B32, { time: seconds * 1000, digits: 8 })).toBe(expected);
  });

  it('mặc định 6 số, bước 30 giây', () => {
    expect(totp(RFC_SECRET_B32, { time: 59_000 })).toBe('287082');
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;

  it('chấp nhận mã hiện tại và lệch ±1 bước', () => {
    const cur = totp(RFC_SECRET_B32, { time: now });
    const prev = totp(RFC_SECRET_B32, { time: now - 30_000 });
    const next = totp(RFC_SECRET_B32, { time: now + 30_000 });
    expect(verifyTotp(RFC_SECRET_B32, cur, { time: now })).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, prev, { time: now })).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, next, { time: now })).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, `${cur.slice(0, 3)} ${cur.slice(3)}`, { time: now })).toBe(true);
  });

  it('từ chối mã lệch 2 bước, sai định dạng, sai secret', () => {
    const far = totp(RFC_SECRET_B32, { time: now + 60_000 });
    expect(verifyTotp(RFC_SECRET_B32, far, { time: now })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, '12345', { time: now })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, 'abcdef', { time: now })).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, '', { time: now })).toBe(false);
    expect(verifyTotp('not-base32-1', '123456', { time: now })).toBe(false);
    const cur = totp(RFC_SECRET_B32, { time: now });
    expect(verifyTotp(generateSecret(), cur, { time: now })).toBe(false);
  });

  it('cửa sổ 0 chỉ nhận đúng bước hiện tại', () => {
    const prev = totp(RFC_SECRET_B32, { time: now - 30_000 });
    expect(verifyTotp(RFC_SECRET_B32, prev, { time: now, window: 0 })).toBe(false);
  });
});

describe('otpauthUrl', () => {
  it('dựng đúng định dạng otpauth://totp', () => {
    const url = otpauthUrl({ issuer: 'CMSNT', label: 'admin@cmsnt.local', secret: RFC_SECRET_B32 });
    expect(url.startsWith('otpauth://totp/CMSNT%3Aadmin%40cmsnt.local?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('secret')).toBe(RFC_SECRET_B32);
    expect(params.get('issuer')).toBe('CMSNT');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});

describe('mã dự phòng', () => {
  it('sinh 10 mã dạng xxxxx-xxxxx, không trùng', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
    expect(new Set(codes).size).toBe(10);
  });

  it('chuẩn hoá mã người dùng nhập', () => {
    expect(normalizeRecoveryCode(' ABCDE FGHJK ')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('abcde-fghjk');
    expect(normalizeRecoveryCode('abc')).toBe('abc');
  });
});
