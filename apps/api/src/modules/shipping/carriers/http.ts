/**
 * Tiện ích dùng chung cho các adapter hãng vận chuyển:
 * - `call()` bọc `httpRequest` của module einvoice, đổi lỗi mạng/timeout thành `ShippingCarrierError` (retryable)
 * - `ensureOk()` kiểm tra HTTP status, trích message lỗi của hãng
 * - chuyển đổi đơn vị (VND làm tròn, gram -> kg), ghép địa chỉ, parse ngày giờ nhiều định dạng
 * - ký/xác minh chữ ký (HMAC-SHA256, MD5) và cache token đăng nhập theo khoá cấu hình
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { EInvoiceProviderError } from '../../einvoice/providers/provider.interface.js';
import { extractMessage, httpRequest, joinUrl, pick, str, type HttpOptions, type HttpResponse } from '../../einvoice/providers/http.js';
import { ShippingCarrierError, type CarrierAddress, type CarrierConfig } from './carrier.interface.js';

export { extractMessage, joinUrl, pick, str };
export type { HttpOptions, HttpResponse };

/** Gọi HTTP; lỗi kết nối/timeout -> ShippingCarrierError(retryable). Không ném theo status (dùng `ensureOk`). */
export async function call<T = unknown>(url: string, opts: HttpOptions = {}, what = 'Gọi API hãng vận chuyển'): Promise<HttpResponse<T>> {
  try {
    return await httpRequest<T>(url, opts);
  } catch (err) {
    if (err instanceof EInvoiceProviderError) throw new ShippingCarrierError(err.message, err.raw, err.retryable);
    if (err instanceof ShippingCarrierError) throw err;
    throw new ShippingCarrierError(`${what} thất bại: ${(err as Error).message}`, { url, error: (err as Error).message }, true);
  }
}

/** Ném lỗi chuẩn nếu HTTP status không ok; 5xx/429 coi là retryable */
export function ensureOk(res: HttpResponse, what = 'Yêu cầu'): void {
  if (res.ok) return;
  const retryable = res.status >= 500 || res.status === 429;
  const msg = extractMessage(res.data) || res.text?.slice(0, 300) || `HTTP ${res.status}`;
  throw new ShippingCarrierError(`${what} thất bại (HTTP ${res.status}): ${msg}`, res.data ?? res.text, retryable);
}

/** Lấy base URL theo môi trường: ưu tiên giá trị admin nhập, không có thì dùng mặc định */
export function baseUrl(cfg: CarrierConfig, defaults: { sandbox: string; production: string }): string {
  const custom = cfg.environment === 'production' ? cfg.productionUrl : cfg.sandboxUrl;
  const url = String(custom ?? '').trim() || defaults[cfg.environment === 'production' ? 'production' : 'sandbox'];
  return url.replace(/\/+$/, '');
}

/** Làm tròn số tiền VND (hãng có thể trả số lẻ / chuỗi) */
export function vnd(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/** Số nguyên an toàn (gram, cm...) với giá trị tối thiểu */
export function int(n: unknown, min = 0): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(min, v) : min;
}

/** gram -> kg (2 chữ số lẻ, tối thiểu 0.01) */
export function toKg(gram: unknown): number {
  const g = int(gram, 10);
  return Math.max(0.01, Math.round(g / 10) / 100);
}

/** Mã của hãng cho một địa chỉ (đã enrich từ danh mục): { province, district, ward } hoặc {} */
export function codesOf(addr: CarrierAddress, carrierKey: string): Record<string, string> {
  return addr.carrierCodes?.[carrierKey] ?? {};
}

/** Ghép dòng địa chỉ: số nhà/đường (+ phường, quận, tỉnh nếu `full`) */
export function addressLine(addr: CarrierAddress, full = false): string {
  const parts = [addr.line1, addr.line2];
  if (full) parts.push(addr.wardName, addr.districtName, addr.provinceName);
  return parts
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** Chuẩn hoá số điện thoại VN: bỏ ký tự thừa; `intl` = true -> "+84..." */
export function phoneVN(phone: unknown, intl = false): string {
  let p = String(phone ?? '').replace(/[^\d+]/g, '');
  if (p.startsWith('+84')) p = `0${p.slice(3)}`;
  else if (p.startsWith('84') && p.length >= 11) p = `0${p.slice(2)}`;
  if (!intl) return p;
  return p.startsWith('0') ? `+84${p.slice(1)}` : p ? `+${p.replace(/^\+/, '')}` : '';
}

/**
 * Parse ngày giờ nhiều định dạng: Date, unix giây/mili, ISO 8601, "dd/MM/yyyy HH:mm:ss" (giờ VN, UTC+7).
 * Trả null nếu không hiểu.
 */
export function parseDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e11 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (vn) {
    const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = vn;
    return new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${mi}:${ss}+07:00`);
  }
  // "2026-10-05 10:00:00" (không có timezone) -> coi là giờ VN
  const sqlLike = /^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (sqlLike) return new Date(`${sqlLike[1]}T${sqlLike[2]}+07:00`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Cộng số giờ vào thời điểm hiện tại */
export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + Math.max(0, hours) * 3600_000);
}

/** Đọc số ngày dự kiến từ chuỗi kiểu "48 giờ", "2 ngày", "Dự kiến giao 2 ngày", "1-2 ngày" */
export function parseEstimatedDays(text: unknown): number | null {
  const s = String(text ?? '').toLowerCase();
  const h = /(\d+(?:\.\d+)?)\s*(giờ|gio|h\b|hour)/.exec(s);
  if (h) return Math.max(1, Math.ceil(Number(h[1]) / 24));
  const d = /(\d+)(?:\s*-\s*(\d+))?\s*(ngày|ngay|day)/.exec(s);
  if (d) return Number(d[2] ?? d[1]);
  return null;
}

/** Chuỗi form-urlencoded từ object phẳng */
export function formEncode(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`)
    .join('&');
}

/** Query string từ object (bỏ undefined/null/'') */
export function qs(obj: Record<string, unknown>): string {
  const s = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return s ? `?${s}` : '';
}

/** Lấy header không phân biệt hoa thường */
export function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const v = headers[key];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Body webhook có thể là object đã parse, chuỗi JSON hoặc form-urlencoded -> object */
export function bodyObject(body: unknown, rawBody?: string): Record<string, unknown> {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body as Record<string, unknown>;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : (rawBody ?? '');
  if (!text.trim()) return {};
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return j as Record<string, unknown>;
  } catch {
    /* không phải JSON */
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

export function hmacSha256Base64(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64');
}
export function hmacSha256Hex(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}
/** base64(md5 raw 16 byte) — kiểu J&T */
export function md5Base64Raw(data: string): string {
  return createHash('md5').update(data, 'utf8').digest('base64');
}
export function md5Hex(data: string): string {
  return createHash('md5').update(data, 'utf8').digest('hex');
}

/** So sánh chuỗi an toàn thời gian (tránh timing attack) */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Cache token đăng nhập trong bộ nhớ tiến trình (theo khoá = hãng + tài khoản + môi trường) */
export class TokenCache<T = string> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  get(key: string): T | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs: number): T {
    this.store.set(key, { value, expiresAt: Date.now() + Math.max(1_000, ttlMs) });
    return value;
  }

  clear(key: string) {
    this.store.delete(key);
  }
}

/** Giới hạn độ dài chuỗi (hãng giới hạn note / tên) */
export function clip(v: unknown, max: number): string {
  const s = String(v ?? '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** Tổng số lượng sản phẩm trong kiện */
export function totalQuantity(items: { quantity: number }[]): number {
  return Math.max(1, items.reduce((s, i) => s + int(i.quantity, 1), 0));
}

/** Ghi chú ngắn mô tả hàng: "Áo x2, Quần x1" */
export function describeItems(items: { name: string; quantity: number }[], max = 200): string {
  return clip(items.map((i) => `${i.name} x${int(i.quantity, 1)}`).join(', ') || 'Hàng hoá', max);
}

/** Chuỗi so khớp từ khoá trạng thái (bỏ dấu, thường) */
export function fold(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}
