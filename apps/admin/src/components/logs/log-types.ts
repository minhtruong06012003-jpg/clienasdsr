/**
 * Kiểu dữ liệu + nhãn tiếng Việt dùng chung cho trang Nhật ký lỗi (/logs).
 * Khớp hợp đồng API `/admin/logs/*`.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

/** Thứ tự level từ nặng tới nhẹ (dùng cho chip lọc) */
export const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug'];

/** Thông tin request HTTP gắn kèm dòng log (nếu lỗi phát sinh trong request) */
export interface LogRequest {
  method?: string;
  url?: string;
  status?: number;
  ip?: string;
  userId?: string;
  userEmail?: string;
  userAgent?: string;
  referer?: string;
}

/** Một dòng log */
export interface LogEntry {
  id: string;
  time: string;
  level: LogLevel;
  source: string;
  context?: string;
  message: string;
  stack?: string;
  request?: LogRequest;
  meta?: Record<string, unknown>;
}

/** Một file log theo ngày */
export interface LogFile {
  name: string;
  date: string;
  size: number;
  mtime: string;
  counts: Partial<Record<LogLevel, number>>;
}

/** Response GET /admin/logs/files */
export interface LogFilesResponse {
  data: LogFile[];
  dir: string;
  totalSize: number;
}

/** Response GET /admin/logs/entries */
export interface LogEntriesResponse {
  data: LogEntry[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  counts: Partial<Record<LogLevel, number>>;
  sources: string[];
}

/** Nhãn + màu từng level (màu cứng luôn kèm biến thể dark theo quy ước) */
export const LEVEL_META: Record<LogLevel, { label: string; badge: string; dot: string }> = {
  fatal: { label: 'Nghiêm trọng', badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300', dot: 'bg-purple-600' },
  error: { label: 'Lỗi', badge: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', dot: 'bg-red-500' },
  warn: { label: 'Cảnh báo', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', dot: 'bg-amber-500' },
  info: { label: 'Thông tin', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', dot: 'bg-blue-500' },
  debug: { label: 'Gỡ lỗi', badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400', dot: 'bg-slate-400' },
};

/** Nhãn tiếng Việt cho nguồn log; nguồn lạ hiện nguyên */
export const SOURCE_LABEL: Record<string, string> = {
  api: 'API',
  http: 'Request HTTP',
  process: 'Tiến trình',
  cron: 'Tác vụ định kỳ',
  job: 'Tác vụ nền',
  'web-server': 'Website (máy chủ)',
  'web-client': 'Website (trình duyệt)',
  'admin-client': 'Trang quản trị',
};

export function sourceLabel(source: string) {
  return SOURCE_LABEL[source] ?? source;
}

/** Ngày dạng yyyy-MM-dd -> dd/MM/yyyy (tách chuỗi để không lệch múi giờ) */
export function formatLogDate(date: string) {
  const [y, m, d] = date.split('-');
  return y && m && d ? `${d}/${m}/${y}` : date;
}

/** "Hôm nay" / "Hôm qua" cho file log gần nhất (so theo giờ máy người xem) */
export function relativeDayLabel(date: string) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  if (date === key(now)) return 'Hôm nay';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (date === key(y)) return 'Hôm qua';
  return null;
}
