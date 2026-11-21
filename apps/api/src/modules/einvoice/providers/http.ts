/**
 * Tiện ích HTTP/SOAP dùng chung cho các adapter nhà cung cấp HĐĐT:
 * - fetch có timeout, tự parse JSON/text, ném EInvoiceProviderError kèm response thô
 * - dựng/đọc SOAP envelope đơn giản (VNPT, BKAV dùng SOAP .asmx)
 * - escape XML, lấy nội dung tag bằng regex (đủ dùng cho response phẳng của NCC)
 */
import { EInvoiceProviderError } from './provider.interface.js';

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** object -> JSON; string -> gửi nguyên văn */
  body?: unknown;
  timeoutMs?: number;
  /** Trả về Buffer (tải PDF/ZIP) thay vì parse */
  binary?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  text: string;
  buffer?: Buffer;
}

/** Nối base URL + path, tránh "//" */
export function joinUrl(base: string, path: string): string {
  return `${String(base ?? '').replace(/\/+$/, '')}/${String(path ?? '').replace(/^\/+/, '')}`;
}

/** Gọi HTTP với timeout; không ném lỗi theo status (adapter tự kiểm tra `ok`) */
export async function httpRequest<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  const headers: Record<string, string> = { Accept: 'application/json, text/xml, */*', ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === 'string') body = opts.body;
    else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] ??= 'application/json';
    }
  }
  try {
    const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: ctrl.signal });
    if (opts.binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, ok: res.ok, headers: res.headers, data: undefined as T, text: '', buffer: buf };
    }
    const text = await res.text();
    let data: unknown = text;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json') || /^[\s]*[[{]/.test(text)) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, data: data as T, text };
  } catch (err) {
    const e = err as Error;
    const timeout = e.name === 'AbortError';
    throw new EInvoiceProviderError(timeout ? `Hết thời gian chờ khi gọi ${url}` : `Không kết nối được ${url}: ${e.message}`, { url, error: e.message }, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Ném lỗi chuẩn nếu HTTP status không ok; 5xx/429 coi là retryable */
export function assertOk(res: HttpResponse, what = 'yêu cầu'): void {
  if (res.ok) return;
  const retryable = res.status >= 500 || res.status === 429;
  const msg = extractMessage(res.data) || res.text?.slice(0, 300) || `HTTP ${res.status}`;
  throw new EInvoiceProviderError(`${what} thất bại (HTTP ${res.status}): ${msg}`, res.data ?? res.text, retryable);
}

/** Cố lấy message lỗi từ các kiểu response phổ biến */
export function extractMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data.slice(0, 300) : null;
  const o = data as Record<string, unknown>;
  for (const k of ['message', 'Message', 'errorMessage', 'error_description', 'description', 'Description', 'error', 'ErrorMessage', 'msg', 'reason']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      const inner = extractMessage(v);
      if (inner) return inner;
    }
  }
  return null;
}

/** Header Basic Auth */
export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

// ---------------------------------------------------------------------------
// XML / SOAP
// ---------------------------------------------------------------------------
export function xmlEscape(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Giải mã entity cơ bản (response SOAP thường escape XML lồng nhau) */
export function xmlUnescape(v: string): string {
  return String(v ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** `<tag>` với các cặp key/value (bỏ qua undefined/null) */
export function xmlTag(name: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

/** Dựng XML từ object phẳng theo thứ tự key (giữ thứ tự vì nhiều NCC validate theo XSD) */
export function xmlFromObject(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => (v && typeof v === 'object' && !(v instanceof Date) ? `<${k}>${xmlFromObject(v as Record<string, unknown>)}</${k}>` : xmlTag(k, v instanceof Date ? v.toISOString() : v)))
    .join('');
}

/** Lấy nội dung text của tag đầu tiên (không phân biệt namespace prefix) */
export function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml ?? '');
  return m ? m[1].trim() : null;
}

/** Lấy mọi block của tag (vd nhiều <Item>) */
export function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml ?? ''))) out.push(m[1]);
  return out;
}

/** Bọc body vào SOAP 1.1 envelope */
export function soapEnvelope(body: string, ns = 'http://tempuri.org/'): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body.replace('__NS__', ns)}</soap:Body></soap:Envelope>`;
}

/**
 * Gọi SOAP 1.1 (.asmx): `action` là tên method, `params` là các tham số theo thứ tự WSDL.
 * Trả về text trong `<{action}Result>` (đã unescape).
 */
export async function soapCall(url: string, action: string, params: Record<string, unknown>, opts: { ns?: string; timeoutMs?: number } = {}): Promise<{ result: string; raw: string }> {
  const ns = opts.ns ?? 'http://tempuri.org/';
  const body = `<${action} xmlns="${ns}">${xmlFromObject(params)}</${action}>`;
  const res = await httpRequest<string>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${ns.replace(/\/$/, '')}/${action}` },
    body: soapEnvelope(body, ns),
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  const raw = typeof res.data === 'string' ? res.data : res.text;
  if (!res.ok) {
    const fault = xmlText(raw, 'faultstring') ?? raw.slice(0, 300);
    throw new EInvoiceProviderError(`SOAP ${action} lỗi (HTTP ${res.status}): ${fault}`, raw, res.status >= 500);
  }
  const result = xmlText(raw, `${action}Result`) ?? '';
  return { result: xmlUnescape(result), raw };
}

/** Lấy giá trị lồng theo đường dẫn "a.b.0.c" an toàn */
export function pick<T = unknown>(obj: unknown, path: string): T | undefined {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj) as T | undefined;
}

/** Chuẩn hoá chuỗi (bỏ undefined -> '') */
export function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}
