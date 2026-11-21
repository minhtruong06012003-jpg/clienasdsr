import type { ContentStatus } from './types';

/** ISO -> giá trị cho input datetime-local (theo múi giờ máy) */
export const toLocalInput = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

/** datetime-local -> ISO (hoặc null) */
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

/** Ngày đăng (giá trị datetime-local) nằm ở tương lai */
export const isFutureDate = (localValue: string) => !!localValue && new Date(localValue).getTime() > Date.now();

/**
 * Trạng thái thực gửi lên API: chọn "Xuất bản" nhưng ngày đăng ở tương lai -> hẹn giờ (SCHEDULED);
 * đang hẹn giờ mà ngày đã qua -> xuất bản luôn.
 */
export function effectiveStatus(status: ContentStatus, publishedAtLocal: string): ContentStatus {
  if (status === 'PUBLISHED' || status === 'SCHEDULED') return isFutureDate(publishedAtLocal) ? 'SCHEDULED' : 'PUBLISHED';
  return status;
}

export const STATUS_LABEL: Record<ContentStatus, string> = { DRAFT: 'Bản nháp', PUBLISHED: 'Đã xuất bản', SCHEDULED: 'Hẹn giờ', ARCHIVED: 'Lưu trữ' };

/** Số đếm theo trạng thái do API trả kèm danh sách (statusCounts) */
export interface StatusCounts {
  ALL: number;
  DRAFT: number;
  PUBLISHED: number;
  SCHEDULED: number;
  ARCHIVED: number;
  TRASH: number;
}

/** Tab trạng thái cho danh sách nội dung: Hẹn giờ / Lưu trữ chỉ hiện khi có bản ghi */
export function contentStatusTabs(counts?: StatusCounts | null) {
  const c = (k: keyof StatusCounts) => counts?.[k];
  const tabs: { value: string; label: string; count?: number }[] = [
    { value: '', label: 'Tất cả', count: c('ALL') },
    { value: 'PUBLISHED', label: 'Đã xuất bản', count: c('PUBLISHED') },
    { value: 'DRAFT', label: 'Bản nháp', count: c('DRAFT') },
  ];
  if ((c('SCHEDULED') ?? 0) > 0) tabs.push({ value: 'SCHEDULED', label: 'Hẹn giờ', count: c('SCHEDULED') });
  if ((c('ARCHIVED') ?? 0) > 0) tabs.push({ value: 'ARCHIVED', label: 'Lưu trữ', count: c('ARCHIVED') });
  tabs.push({ value: 'trash', label: 'Thùng rác', count: c('TRASH') });
  return tabs;
}
