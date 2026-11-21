/**
 * Chuẩn bị payload callback nạp thẻ trước khi ghi vào nhật ký webhook (payment_webhook_logs):
 * - che giữa các trường nhạy cảm (mã thẻ / PIN, serial, chữ ký) để người xem nhật ký không lấy được thẻ;
 * - cắt ngắn payload quá lớn (≤ 20KB) giống webhook cổng thanh toán, chống làm phình DB.
 */

/** Giới hạn kích thước payload lưu nhật ký (ký tự JSON) */
export const CARD_LOG_MAX = 20_000;

/** Khoá chứa dữ liệu nhạy cảm của thẻ: mã thẻ (pin/code/card_code...), serial, chữ ký callback */
const SENSITIVE_KEY = /^(pin|code|card_?code|card_?pin|cardcode|ma_?the|mathe|password|serial|seri|sign|callback_?sign|signature)$/i;

/** Che phần giữa chuỗi: giữ 2 ký tự đầu + 2 ký tự cuối (chuỗi ngắn ≤ 6 ký tự thì che hết) */
export function maskMiddle(value: unknown): string {
  const s = String(value ?? '');
  if (!s) return s;
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 4)}${s.slice(-2)}`;
}

/** Duyệt đệ quy object/mảng, che giá trị của các khoá nhạy cảm (giới hạn độ sâu tránh payload lồng vô hạn) */
export function maskCardPayload(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskCardPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = maskMiddle(v);
    else if (SENSITIVE_KEY.test(k) && Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' || typeof x === 'number' ? maskMiddle(x) : maskCardPayload(x, depth + 1)));
    else out[k] = maskCardPayload(v, depth + 1);
  }
  return out;
}

/**
 * Payload lưu nhật ký: request không hợp lệ / nhà cung cấp không tồn tại -> `{}` (không lưu rác của người lạ);
 * hợp lệ -> che trường nhạy cảm rồi cắt ngắn nếu vượt CARD_LOG_MAX.
 */
export function cardCallbackLogPayload(input: { query?: unknown; body?: unknown }, valid: boolean): object {
  if (!valid) return {};
  const masked = maskCardPayload({ query: input.query ?? {}, body: input.body ?? {} });
  const raw = JSON.stringify(masked);
  return raw.length > CARD_LOG_MAX ? { truncated: true, preview: raw.slice(0, CARD_LOG_MAX) } : (masked as object);
}
