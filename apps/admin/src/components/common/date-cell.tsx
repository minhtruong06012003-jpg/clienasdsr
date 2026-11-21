import { CalendarClock } from 'lucide-react';
import { formatDate } from '@/lib/format';

/**
 * Ô "Ngày" trong danh sách nội dung: hẹn giờ -> "Hẹn giờ dd/MM HH:mm" (màu nổi bật),
 * còn lại hiển thị ngày đăng (hoặc ngày cập nhật khi chưa có).
 */
export function ContentDateCell({ status, publishedAt, fallback, fallbackLabel }: { status: string; publishedAt: string | null; fallback?: string | null; fallbackLabel?: string }) {
  if (status === 'SCHEDULED' && publishedAt) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-sky-700 dark:text-sky-300" title={formatDate(publishedAt)}>
        <CalendarClock className="size-3.5" /> Hẹn giờ {formatDate(publishedAt, 'dd/MM HH:mm')}
      </span>
    );
  }
  if (publishedAt) return <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(publishedAt)}</span>;
  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground" title={fallbackLabel}>
      {fallback ? `${fallbackLabel ? `${fallbackLabel} ` : ''}${formatDate(fallback)}` : '—'}
    </span>
  );
}
