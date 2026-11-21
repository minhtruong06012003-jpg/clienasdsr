/**
 * Gọi Telegram Bot API (https://core.telegram.org/bots/api) bằng fetch — không cần thư viện riêng.
 * Tin nhắn gửi dạng HTML: nội dung lấy từ dữ liệu khách nhập phải qua `esc()` trước khi ghép vào.
 */

const API = 'https://api.telegram.org';

/** Lỗi Telegram trả về (`code` = error_code: 403 bị chặn, 409 trùng getUpdates, 429 gửi quá nhanh...) */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

/** Một update nhận qua getUpdates (chỉ các trường đang dùng) */
export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string; first_name?: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
  };
}

/** Thoát ký tự đặc biệt cho parse_mode HTML */
export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Che token khi ghi log / báo lỗi (token nằm trong URL gọi API) */
const hideToken = (msg: string, token: string) => (token ? msg.split(token).join('***') : msg);

/** Gọi một method của Bot API; `timeoutMs` mặc định 15 giây (getUpdates truyền dài hơn thời gian long-poll) */
export async function tgCall<T>(token: string, method: string, body: Record<string, unknown> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  if (!token) throw new TelegramError('Chưa nhập token bot', 401);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (err) {
    throw new TelegramError(hideToken(`Không kết nối được Telegram: ${(err as Error).message}`, token), 0);
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
  if (!data?.ok) {
    const code = data?.error_code ?? res.status;
    // 401/404: token sai hoặc bot đã bị xoá — báo dễ hiểu thay cho "Unauthorized" / "Not Found"
    const msg = code === 401 || code === 404 ? 'Token bot không hợp lệ (kiểm tra lại token từ @BotFather)' : data?.description || `Telegram trả HTTP ${res.status}`;
    throw new TelegramError(hideToken(msg, token), code, data?.parameters?.retry_after);
  }
  return data.result as T;
}

/** Thông tin bot (kiểm tra token, lấy username để dựng link t.me) */
export const getMe = (token: string) => tgCall<{ id: number; username: string; first_name: string }>(token, 'getMe');

/** Gửi tin HTML; không hiện ô xem trước link cho gọn */
export const sendMessage = (token: string, chatId: string | number, html: string) =>
  tgCall(token, 'sendMessage', { chat_id: chatId, text: html.slice(0, 4096), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
