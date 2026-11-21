import { format, formatDistanceToNow } from 'date-fns';
import { vi } from 'date-fns/locale';

export function formatMoney(value: number | string | null | undefined, currency = 'VND') {
  const n = Number(value ?? 0);
  if (currency === 'VND') return `${n.toLocaleString('vi-VN')}đ`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

export function formatDate(value: string | Date | null | undefined, pattern = 'dd/MM/yyyy HH:mm') {
  if (!value) return '—';
  return format(new Date(value), pattern, { locale: vi });
}

export function timeAgo(value: string | Date | null | undefined) {
  if (!value) return '—';
  return formatDistanceToNow(new Date(value), { addSuffix: true, locale: vi });
}

export function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** Lấy bản dịch theo locale (fallback bản đầu tiên) */
export function pickTr<T extends { locale: string }>(translations: T[] | undefined, locale: string): T | undefined {
  return translations?.find((t) => t.locale === locale) ?? translations?.[0];
}

/** Lấy chuỗi từ object đa ngôn ngữ {vi, en} */
export function i18n(value: Record<string, string> | string | null | undefined, locale = 'vi') {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value[locale] ?? Object.values(value).find(Boolean) ?? '';
}
