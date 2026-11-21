/**
 * TOTP (RFC 6238) / HOTP (RFC 4226) tự cài đặt bằng HMAC-SHA1 — không cần thư viện ngoài.
 * Tương thích Google Authenticator, Authy, 1Password, Microsoft Authenticator...
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Mã hoá base32 (RFC 4648, không padding) — định dạng secret mà app xác thực đọc được */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Giải mã base32; bỏ qua khoảng trắng, dấu gạch và padding, không phân biệt hoa thường */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Secret base32 không hợp lệ');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Sinh secret ngẫu nhiên (mặc định 20 byte = 160 bit, chuẩn SHA1) dạng base32 */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** HOTP: mã OTP từ secret + bộ đếm (RFC 4226, dynamic truncation) */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  // counter 64-bit big-endian (an toàn tới 2^53)
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export interface TotpOptions {
  /** mốc thời gian (ms) — mặc định hiện tại */
  time?: number;
  /** độ dài bước (giây) */
  step?: number;
  digits?: number;
}

/** TOTP: mã OTP tại thời điểm `time` */
export function totp(secretBase32: string, opts: TotpOptions = {}): string {
  const { time = Date.now(), step = 30, digits = 6 } = opts;
  return hotp(base32Decode(secretBase32), Math.floor(time / 1000 / step), digits);
}

/**
 * Kiểm tra mã TOTP với cửa sổ ±`window` bước (mặc định ±1 = chấp nhận lệch đồng hồ 30 giây).
 * So sánh timing-safe; trả về false với mã sai định dạng.
 */
export function verifyTotp(secretBase32: string, code: string, opts: TotpOptions & { window?: number } = {}): boolean {
  const { time = Date.now(), step = 30, digits = 6, window: win = 1 } = opts;
  const input = String(code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(input)) return false;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const counter = Math.floor(time / 1000 / step);
  const expected = Buffer.from(input);
  let ok = false;
  for (let i = -win; i <= win; i++) {
    const candidate = Buffer.from(hotp(secret, counter + i, digits));
    // không return sớm để thời gian xử lý không lộ vị trí khớp
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) ok = true;
  }
  return ok;
}

/**
 * Như `verifyTotp` nhưng trả về BƯỚC THỜI GIAN (counter = floor(unix / step)) của mã khớp, không khớp -> null.
 * Dùng để chống dùng lại mã: chỉ chấp nhận mã có bước lớn hơn bước đã dùng gần nhất (`User.totpLastStep`).
 * Duyệt hết cửa sổ (không return sớm) để thời gian xử lý không lộ vị trí khớp.
 */
export function matchTotpStep(secretBase32: string, code: string, opts: TotpOptions & { window?: number } = {}): number | null {
  const { time = Date.now(), step = 30, digits = 6, window: win = 1 } = opts;
  const input = String(code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(input)) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  const counter = Math.floor(time / 1000 / step);
  const expected = Buffer.from(input);
  let matched: number | null = null;
  for (let i = -win; i <= win; i++) {
    const candidate = Buffer.from(hotp(secret, counter + i, digits));
    // nhiều bước cùng khớp (hiếm) -> lấy bước lớn nhất để chặn dùng lại chắc chắn hơn
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = counter + i;
  }
  return matched;
}

/** URL otpauth:// để app xác thực quét QR */
export function otpauthUrl({ issuer, label, secret, digits = 6, period = 30 }: { issuer: string; label: string; secret: string; digits?: number; period?: number }): string {
  const name = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  return `otpauth://totp/${name}?${params.toString()}`;
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // bỏ i, l, o, 0, 1 dễ nhầm

/** Sinh mã dự phòng dạng `xxxxx-xxxxx` (≈ 49 bit entropy mỗi mã) */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let s = '';
    for (let j = 0; j < 10; j++) s += RECOVERY_ALPHABET[bytes[j] % RECOVERY_ALPHABET.length];
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return codes;
}

/** Chuẩn hoá mã dự phòng người dùng nhập (bỏ khoảng trắng, chữ thường) */
export function normalizeRecoveryCode(code: string): string {
  const s = String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : s;
}
