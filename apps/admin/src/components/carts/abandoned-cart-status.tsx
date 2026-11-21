import { ABANDONED_CART_STATUS_LABELS, type AbandonedCartStatus } from '@cmsnt/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Màu badge theo trạng thái giỏ (kèm biến thể dark mode theo quy ước) */
const TONE: Record<AbandonedCartStatus, string> = {
  active: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  abandoned: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  recovered: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  converted: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  expired: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

export function AbandonedCartStatusBadge({ status, className }: { status: AbandonedCartStatus; className?: string }) {
  return <Badge className={cn('border-transparent', TONE[status], className)}>{ABANDONED_CART_STATUS_LABELS[status]}</Badge>;
}
