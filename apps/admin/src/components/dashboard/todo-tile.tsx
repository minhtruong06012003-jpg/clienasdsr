import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export const TODO_TONES = {
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
} as const;

/** Ô "việc cần làm": số lớn + nút xử lý — chủ web nhìn là biết cần làm gì trước */
export function TodoTile({
  count,
  label,
  href,
  icon: Icon,
  tone,
  action,
  hint,
}: {
  count: number;
  label: string;
  href: string;
  icon: React.ElementType;
  tone: keyof typeof TODO_TONES;
  action: string;
  /** Dòng phụ nhỏ dưới nhãn (vd số tiền chờ rút) */
  hint?: React.ReactNode;
}) {
  const active = count > 0;
  return (
    <Link href={href} className={cn('group flex items-center gap-4 rounded-xl border bg-card p-4 transition hover:-translate-y-0.5 hover:shadow-md', !active && 'opacity-70 hover:opacity-100')}>
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', active ? TODO_TONES[tone] : 'bg-muted text-muted-foreground')}>
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-2xl font-bold leading-none tabular-nums">{count}</span>
        <span className="mt-1 block text-sm leading-snug text-muted-foreground">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
        {active && (
          <span className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary">
            {action} <ArrowRight className="size-3 transition group-hover:translate-x-0.5" />
          </span>
        )}
      </span>
    </Link>
  );
}
