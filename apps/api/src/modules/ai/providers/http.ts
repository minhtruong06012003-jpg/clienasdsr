import { AiProviderError, type AiProviderConfig } from '../ai.types.js';

/** Tuỳ chọn một lần gọi API nhà cung cấp */
export interface ProviderRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Body JSON (tự đặt Content-Type) hoặc FormData (multipart) */
  json?: unknown;
  form?: FormData;
  /** Header xác thực; mặc định `Authorization: Bearer <apiKey>` */
  headers?: Record<string, string>;
  /** Timeout (ms), mặc định 60s */
  timeoutMs?: number;
}

/** Ghép baseUrl (bỏ "/" cuối) với path */
export const joinUrl = (base: string, path: string) => (/^https?:\/\//i.test(path) ? path : `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);

/**
 * Gọi API nhà cung cấp, trả JSON đã parse.
 * - Lỗi mạng / timeout / HTTP 5xx / 429 -> AiProviderError retryable (tác vụ được thử lại ở lần hỏi sau).
 * - HTTP 4xx -> AiProviderError không retry, message lấy từ phản hồi (message / error / detail) nếu có.
 */
export async function providerFetch<T = any>(config: AiProviderConfig, path: string, opts: ProviderRequest = {}): Promise<T> {
  if (!config.apiKey) throw new AiProviderError('Nhà cung cấp AI chưa được cấu hình khoá API');
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? { Authorization: `Bearer ${config.apiKey}` }) };
  let body: string | FormData | undefined;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  let text: string;
  const method = opts.method ?? (body ? 'POST' : 'GET');
  try {
    res = await fetch(joinUrl(config.baseUrl, path), { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
    // đọc body cũng nằm trong timeout: nhà cung cấp trả header rồi treo phần body vẫn bị ngắt -> xử lý như quá giờ
    text = await res.text();
  } catch (err) {
    // request tạo job (POST) bị quá giờ: nhà cung cấp có thể ĐÃ nhận -> không tự gửi lại (tránh tạo job trùng, tính phí 2 lần)
    const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    if (timedOut && method !== 'GET') throw new AiProviderError('Nhà cung cấp AI phản hồi quá lâu, tiền đã được hoàn lại', { error: (err as Error).message, timeout: true }, false);
    throw new AiProviderError('Không kết nối được nhà cung cấp AI, hệ thống sẽ thử lại', { error: (err as Error).message }, true);
  }
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { body: text.slice(0, 2000) };
  }
  if (!res.ok) {
    // khoá API sai / hết hạn / thiếu gói: lỗi cấu hình phía website -> không lộ chi tiết cho khách (admin xem ở providerData)
    if (res.status === 401) throw new AiProviderError('Công cụ đang bảo trì, vui lòng thử lại sau. Credits đã được hoàn lại.', { status: res.status, data }, false);
    const msg = pickMessage(data) || `Nhà cung cấp AI báo lỗi HTTP ${res.status}`;
    throw new AiProviderError(msg, { status: res.status, data }, res.status >= 500 || res.status === 429);
  }
  return data as T;
}

/** Lấy thông báo lỗi từ các kiểu phản hồi thường gặp */
export function pickMessage(data: any): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const m = data.message ?? data.error?.message ?? data.error ?? data.detail ?? data.msg ?? data.data?.message;
  return typeof m === 'string' && m.trim() ? m.trim().slice(0, 300) : undefined;
}

/** Đoán kiểu file kết quả từ đuôi URL */
export function guessType(url: string, fallback: 'image' | 'video' | 'audio' = 'image'): 'image' | 'video' | 'audio' {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  return fallback;
}

/** Chuẩn hoá giá trị chuỗi từ input */
export const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();
