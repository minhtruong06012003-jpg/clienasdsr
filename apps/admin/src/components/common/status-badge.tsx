import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const MAP: Record<string, { label: string; className: string }> = {
  DRAFT: { label: 'Bản nháp', className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  PUBLISHED: { label: 'Đã xuất bản', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  SCHEDULED: { label: 'Hẹn giờ', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  ARCHIVED: { label: 'Lưu trữ', className: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500' },
  // đơn hàng
  PENDING: { label: 'Chờ xác nhận', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  CONFIRMED: { label: 'Đã xác nhận', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  PROCESSING: { label: 'Đang xử lý', className: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' },
  SHIPPING: { label: 'Đang giao', className: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' },
  COMPLETED: { label: 'Hoàn thành', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  CANCELLED: { label: 'Đã huỷ', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  REFUNDED: { label: 'Hoàn tiền', className: 'bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300' },
  // thanh toán
  UNPAID: { label: 'Chưa thanh toán', className: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300' },
  PAID: { label: 'Đã thanh toán', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  PARTIALLY_REFUNDED: { label: 'Hoàn một phần', className: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300' },
  FAILED: { label: 'Thất bại', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  // thành viên
  ACTIVE: { label: 'Hoạt động', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  INACTIVE: { label: 'Ngừng hoạt động', className: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' },
  BANNED: { label: 'Bị khoá', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  // kho / form
  IN_STOCK: { label: 'Còn hàng', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  OUT_OF_STOCK: { label: 'Hết hàng', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
  BACKORDER: { label: 'Đặt trước', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  NEW: { label: 'Mới', className: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' },
  READ: { label: 'Đã đọc', className: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' },
  SPAM: { label: 'Spam', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
};

export const STATUS_LABELS = Object.fromEntries(Object.entries(MAP).map(([k, v]) => [k, v.label]));

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const m = MAP[status] ?? { label: status, className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' };
  return <Badge className={cn('border-transparent font-medium', m.className, className)}>{m.label}</Badge>;
}
