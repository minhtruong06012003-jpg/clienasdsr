import { api } from '@/lib/api';

/**
 * Gửi lỗi JavaScript của trang quản trị về API để hiện trong Hệ thống › Nhật ký lỗi.
 * Chống spam: mỗi nội dung chỉ gửi 1 lần, tối đa 10 lỗi mỗi lần tải trang; lỗi gửi thất bại thì bỏ qua.
 */
const sent = new Set<string>();
const MAX_PER_PAGE = 10;

/** Lỗi vô hại / không có thông tin (script khác domain, extension trình duyệt) -> không gửi */
const IGNORE = [/ResizeObserver loop/i, /^Script error\.?$/i, /chrome-extension:\/\//i, /moz-extension:\/\//i];

export function reportClientError(error: unknown, extra: { digest?: string; componentStack?: string; level?: 'error' | 'warn' } = {}) {
  if (typeof window === 'undefined') return;
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error ?? 'Lỗi không xác định'));
  const message = err.message || String(error);
  if (IGNORE.some((re) => re.test(message) || re.test(err.stack ?? ''))) return;
  const key = `${err.name}:${message}`;
  if (sent.has(key) || sent.size >= MAX_PER_PAGE) return;
  sent.add(key);
  void api
    .post('/admin/client-errors', {
      message: message.slice(0, 2000),
      name: err.name?.slice(0, 100),
      stack: err.stack?.slice(0, 8000),
      url: window.location.href.slice(0, 1000),
      level: extra.level,
      digest: extra.digest,
      componentStack: extra.componentStack?.slice(0, 4000),
    })
    .catch(() => {
      /* không báo lỗi của việc báo lỗi */
    });
}
