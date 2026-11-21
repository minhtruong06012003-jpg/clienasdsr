/**
 * Xác minh Google ID token (đăng nhập bằng Google cho khách) — không cần thư viện ngoài:
 * tải khoá công khai JWKS của Google, kiểm tra chữ ký RS256 bằng `node:crypto`, rồi kiểm tra
 * `iss`, `aud` (= Client ID cấu hình), `exp`, `iat` và `email_verified`.
 * JWKS được cache theo `Cache-Control: max-age` mà Google trả về.
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Các giá trị `iss` hợp lệ theo tài liệu Google Identity */
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
/** Lệch đồng hồ cho phép khi so exp / iat (giây) */
const CLOCK_SKEW_S = 60;
/** Cache JWKS mặc định khi Google không gửi max-age */
const DEFAULT_JWKS_TTL_MS = 60 * 60_000;
/** Không tải lại JWKS quá 1 lần / khoảng này khi gặp `kid` lạ (chống bị ép gọi Google liên tục) */
const MIN_REFETCH_MS = 60_000;

/** Thông tin cần dùng trong payload ID token của Google */
export interface GoogleIdentity {
  /** id tài khoản Google (ổn định, không đổi theo email) */
  sub: string;
  email: string;
  emailVerified: true;
  name?: string;
  picture?: string;
}

/** Lỗi xác minh ID token (nơi gọi đổi thành 401 với câu báo chung) */
export class GoogleTokenError extends Error {}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

const b64urlJson = (part: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object') throw new Error('not object');
    return v as Record<string, unknown>;
  } catch {
    throw new GoogleTokenError('ID token không đúng định dạng');
  }
};

/** Đọc max-age (giây) từ header Cache-Control */
export function parseMaxAge(cacheControl: string | null | undefined): number | null {
  const m = /max-age=(\d+)/i.exec(cacheControl ?? '');
  return m ? Number(m[1]) : null;
}

export class GoogleIdTokenVerifier {
  private keys = new Map<string, KeyObject>();
  private expiresAt = 0;
  private lastFetchAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = (url) => fetch(url),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Tải JWKS (gộp các lần gọi đồng thời thành 1 request) */
  private async loadKeys(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      this.lastFetchAt = this.now();
      const res = await this.fetchImpl(GOOGLE_JWKS_URL);
      if (!res.ok) throw new GoogleTokenError(`Không tải được khoá công khai Google (HTTP ${res.status})`);
      const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string; alg?: string; use?: string })[] };
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (!jwk.kid || jwk.kty !== 'RSA') continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          /* khoá hỏng -> bỏ qua */
        }
      }
      if (!next.size) throw new GoogleTokenError('JWKS của Google không có khoá hợp lệ');
      this.keys = next;
      const maxAge = parseMaxAge(res.headers.get('cache-control'));
      this.expiresAt = this.now() + (maxAge != null ? maxAge * 1000 : DEFAULT_JWKS_TTL_MS);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Lấy khoá theo `kid`: hết hạn cache thì tải lại; `kid` lạ (Google vừa xoay khoá) thì tải lại có giới hạn tần suất */
  private async keyFor(kid: string): Promise<KeyObject> {
    if (!this.keys.size || this.now() >= this.expiresAt) await this.loadKeys();
    let key = this.keys.get(kid);
    if (!key && this.now() - this.lastFetchAt >= MIN_REFETCH_MS) {
      await this.loadKeys();
      key = this.keys.get(kid);
    }
    if (!key) throw new GoogleTokenError('Khoá ký của ID token không hợp lệ');
    return key;
  }

  /** Xác minh ID token; hợp lệ -> trả danh tính Google, không hợp lệ -> ném GoogleTokenError */
  async verify(idToken: string, clientId: string): Promise<GoogleIdentity> {
    if (!clientId) throw new GoogleTokenError('Chưa cấu hình Google Client ID');
    const parts = String(idToken ?? '').split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) throw new GoogleTokenError('ID token không đúng định dạng');
    const [h, p, s] = parts;
    const header = b64urlJson(h);
    // chỉ chấp nhận RS256 (chặn "alg: none" / HS256 dùng khoá công khai làm secret)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleTokenError('Thuật toán ký không được hỗ trợ');
    const key = await this.keyFor(header.kid);
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw new GoogleTokenError('Chữ ký ID token không hợp lệ');

    const payload = b64urlJson(p);
    const nowS = Math.floor(this.now() / 1000);
    if (!GOOGLE_ISSUERS.has(String(payload.iss))) throw new GoogleTokenError('Nhà phát hành ID token không hợp lệ');
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
    if (!audOk) throw new GoogleTokenError('ID token không cấp cho website này');
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) throw new GoogleTokenError('ID token đã hết hạn');
    if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > nowS) throw new GoogleTokenError('ID token chưa có hiệu lực');
    if (typeof payload.sub !== 'string' || !payload.sub) throw new GoogleTokenError('ID token thiếu định danh');
    // Google có thể trả boolean hoặc chuỗi "true"
    const verified = payload.email_verified === true || payload.email_verified === 'true';
    if (typeof payload.email !== 'string' || !payload.email || !verified) throw new GoogleTokenError('Email Google chưa được xác minh');
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase().trim(),
      emailVerified: true,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
  }
}
