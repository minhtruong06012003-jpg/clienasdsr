/**
 * safeFetch — gọi HTTP(S) tới URL do người dùng/quản trị nhập mà không mở lỗ SSRF.
 *
 * - Chỉ nhận http/https.
 * - Chặn mọi địa chỉ nội bộ: loopback, mạng riêng, link-local (gồm metadata 169.254.169.254), CGNAT,
 *   multicast/broadcast, dải tài liệu/benchmark, IPv6 ULA/link-local, IPv4-mapped/NAT64/6to4 trỏ về IP nội bộ.
 * - Chống DNS rebinding: kiểm IP ngay trong hàm `lookup` của socket (IP được kiểm chính là IP được nối tới),
 *   không resolve một lần rồi để fetch tự resolve lại. IP literal trong URL được kiểm trước khi gửi.
 * - redirect tự theo tối đa `maxRedirects` bước (mặc định 3, trần 5), kiểm lại URL + IP ở MỖI bước.
 * - Timeout tổng cho cả chuỗi redirect, giới hạn dung lượng phản hồi (lỗi hoặc cắt bớt tuỳ `truncate`).
 *
 * Dùng node:http/https (không dùng fetch/undici) vì cần móc `lookup` mà không phải thêm dependency.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export type SafeFetchErrorCode = 'BAD_URL' | 'BLOCKED' | 'TIMEOUT' | 'TOO_LARGE' | 'TOO_MANY_REDIRECTS' | 'NETWORK';

/** Lỗi của safeFetch, `code` để nơi gọi phân biệt (vd. "Quá thời gian chờ") */
export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Timeout tổng (ms) cho cả chuỗi redirect, mặc định 20s */
  timeoutMs?: number;
  /** Dung lượng phản hồi tối đa (byte), mặc định 10MB */
  maxBytes?: number;
  /** true = vượt maxBytes thì cắt bớt (truncated=true) thay vì báo lỗi — dùng khi chỉ cần đoạn đầu (log webhook) */
  truncate?: boolean;
  /** Số lần theo redirect tối đa (0 = trả nguyên phản hồi 3xx), mặc định 3, trần 5 */
  maxRedirects?: number;
  /** Bỏ chặn IP nội bộ (chỉ bật có chủ đích, vd môi trường dev) */
  allowPrivate?: boolean;
}

export interface SafeFetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  /** URL cuối cùng sau redirect */
  url: string;
  headers: IncomingMessage['headers'];
  /** content-type đã bỏ tham số, chữ thường ('' nếu không có) */
  mime: string;
  body: Buffer;
  /** true nếu body đã bị cắt vì vượt maxBytes (chỉ khi truncate=true) */
  truncated: boolean;
  text(): string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Hiển thị dung lượng gọn: KB khi dưới 1MB */
const fmtSize = (n: number) => (n >= 1048576 ? `${Math.round(n / 1048576)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const HARD_MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Phân loại địa chỉ IP
// ---------------------------------------------------------------------------

/** IPv4 thuộc dải không được phép gọi ra (nội bộ / đặc biệt / không định tuyến công khai) */
function isBlockedIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return (
    a === 0 || // 0.0.0.0/8 "mạng này" (0.0.0.0 trỏ về máy chủ trên Linux)
    a === 10 || // 10/8 mạng riêng
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local, gồm metadata cloud 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 mạng riêng
    (a === 192 && b === 0 && c === 0) || // 192.0.0/24 IETF
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // 192.168/16 mạng riêng
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmark
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast 224/4 + dự phòng 240/4 + broadcast
  );
}

/** Đổi IPv6 (kể cả dạng rút gọn "::" và đuôi IPv4 chấm) thành 16 byte; null nếu sai định dạng */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // đuôi dạng a.b.c.d -> 2 nhóm hex
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const n = v4[1].split('.').map(Number);
    if (n.some((x) => x > 255)) return null;
    s = s.slice(0, -v4[1].length) + `${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes;
}

/** IPv6 thuộc dải nội bộ / đặc biệt, hoặc nhúng một IPv4 nội bộ */
function isBlockedIpv6(ip: string): boolean {
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const v4 = (o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::/96 (IPv4-compatible, gồm :: và ::1) và ::ffff:0:0/96 (IPv4-mapped) -> xét IPv4 nhúng
  if (zeros(0, 12)) return isBlockedIpv4(v4(12));
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4(v4(12));
  // 64:ff9b::/96 NAT64 -> xét IPv4 nhúng; 64:ff9b:1::/48 NAT64 nội bộ -> chặn
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return zeros(4, 12) ? isBlockedIpv4(v4(12)) : true;
  // 2002::/16 6to4 -> xét IPv4 nhúng ở byte 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedIpv4(v4(2));
  // 2001:0::/32 Teredo (IPv4 bị che) và 2001:db8::/32 tài liệu -> chặn
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true;
  // 100::/64 discard
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return true;
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (cũ)
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** true nếu không được phép gọi tới địa chỉ này (chuỗi không phải IP cũng coi là chặn) */
export function isBlockedAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '');
  const v = isIP(host.split('%')[0]);
  if (v === 4) return isBlockedIpv4(host);
  if (v === 6) return isBlockedIpv6(host);
  return true;
}

// ---------------------------------------------------------------------------
// Gửi request
// ---------------------------------------------------------------------------

/** `lookup` cho socket: resolve DNS rồi từ chối nếu có bất kỳ IP nào bị chặn (chống DNS rebinding) */
function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as unknown as LookupAddress[];
      if (!list.length) return callback(new SafeFetchError('NETWORK', `Không phân giải được ${hostname}`), '', 0);
      if (!allowPrivate && list.some((a) => isBlockedAddress(a.address))) {
        return callback(new SafeFetchError('BLOCKED', 'Không được gọi tới địa chỉ nội bộ'), '', 0);
      }
      // net.connect có autoSelectFamily sẽ hỏi all=true; còn lại trả 1 địa chỉ
      if (options.all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

/** Kiểm URL trước khi gửi: chỉ http/https, IP literal phải là địa chỉ công khai */
function checkUrl(raw: string | URL, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError('BAD_URL', 'URL không hợp lệ');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SafeFetchError('BAD_URL', 'Chỉ hỗ trợ URL http/https');
  if (!u.hostname) throw new SafeFetchError('BAD_URL', 'URL thiếu tên máy chủ');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // socket bỏ qua lookup khi host là IP literal -> phải tự kiểm ở đây
  if (!allowPrivate && isIP(host) && isBlockedAddress(host)) throw new SafeFetchError('BLOCKED', 'Không được gọi tới địa chỉ nội bộ');
  return u;
}

interface HopResult {
  res: IncomingMessage;
  body: Buffer;
  truncated: boolean;
}

/** Một lượt request (không theo redirect) */
function requestOnce(u: URL, opts: Required<Pick<SafeFetchOptions, 'maxBytes' | 'truncate' | 'allowPrivate'>> & { method: string; headers: Record<string, string>; body?: string | Buffer; deadline: number }): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) return reject(new SafeFetchError('TIMEOUT', 'Quá thời gian chờ'));
    const mod = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['content-length'] = String(Buffer.byteLength(opts.body));
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        headers,
        lookup: guardedLookup(opts.allowPrivate),
        // không dùng chung pool keep-alive: socket trong pool có thể được mở bởi request khác chưa qua kiểm IP
        agent: false,
      },
      (res) => {
        const declared = Number(res.headers['content-length'] ?? 0);
        if (!opts.truncate && declared > opts.maxBytes) {
          req.destroy();
          return done(() => reject(new SafeFetchError('TOO_LARGE', `Phản hồi quá lớn (${fmtSize(declared)})`)));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (size + chunk.length > opts.maxBytes) {
            if (opts.truncate) {
              chunks.push(chunk.subarray(0, opts.maxBytes - size));
              req.destroy();
              return done(() => resolve({ res, body: Buffer.concat(chunks), truncated: true }));
            }
            req.destroy();
            return done(() => reject(new SafeFetchError('TOO_LARGE', `Phản hồi quá lớn (> ${fmtSize(opts.maxBytes)})`)));
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on('end', () => done(() => resolve({ res, body: Buffer.concat(chunks), truncated: false })));
        res.on('error', (err) => done(() => reject(wrapError(err))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new SafeFetchError('TIMEOUT', 'Quá thời gian chờ')));
    }, remaining);
    req.on('error', (err) => done(() => reject(wrapError(err))));
    if (opts.body != null) req.end(opts.body);
    else req.end();
  });
}

/** Giữ nguyên SafeFetchError (vd. BLOCKED từ lookup), lỗi mạng khác gói lại kèm mã lỗi hệ thống */
function wrapError(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const e = err as NodeJS.ErrnoException;
  return new SafeFetchError('NETWORK', `${e.message}${e.code && !e.message.includes(e.code) ? ` (${e.code})` : ''}`);
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Gọi URL an toàn (xem mô tả đầu file). Ném SafeFetchError khi URL/IP bị chặn, quá thời gian, quá dung lượng,
 * redirect quá nhiều hoặc lỗi mạng. Phản hồi HTTP lỗi (4xx/5xx) KHÔNG ném — kiểm `ok`/`status`.
 */
export async function safeFetch(url: string | URL, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const allowPrivate = !!options.allowPrivate;
  const maxRedirects = Math.min(HARD_MAX_REDIRECTS, Math.max(0, options.maxRedirects ?? 3));
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let method = (options.method ?? 'GET').toUpperCase();
  let body = options.body;
  let headers = { ...(options.headers ?? {}) };
  let current = checkUrl(url, allowPrivate);

  for (let hop = 0; ; hop++) {
    const canFollow = hop < maxRedirects;
    // body của phản hồi redirect cũng bị giới hạn maxBytes như phản hồi thường
    const probe = await requestOnce(current, { method, headers, body, deadline, maxBytes, truncate: !!options.truncate, allowPrivate });
    const { res } = probe;
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (REDIRECT_STATUS.has(status) && location && maxRedirects > 0) {
      if (!canFollow) throw new SafeFetchError('TOO_MANY_REDIRECTS', 'Chuyển hướng quá nhiều lần');
      const next = checkUrl(new URL(location, current), allowPrivate);
      // 303 (và 301/302 với POST theo thói quen trình duyệt) -> chuyển sang GET, bỏ body
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(length|type)$/i.test(k)));
      }
      // sang host khác thì bỏ header xác thực để không lộ token cho bên thứ ba
      if (next.host !== current.host) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie)$/i.test(k)));
      current = next;
      continue;
    }
    const mime = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    return {
      status,
      statusText: res.statusMessage ?? '',
      ok: status >= 200 && status < 300,
      url: current.toString(),
      headers: res.headers,
      mime,
      body: probe.body,
      truncated: probe.truncated,
      text: () => probe.body.toString('utf8'),
    };
  }
}
