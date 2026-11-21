import { cn } from '@/lib/utils';
import { LEVEL_META, type LogLevel } from './log-types';

/** Nhãn màu theo mức độ log (fatal tím, error đỏ, warn vàng, info xanh, debug xám) */
export function LogLevelBadge({ level, className }: { level: LogLevel; className?: string }) {
  const meta = LEVEL_META[level] ?? LEVEL_META.debug;
  return <span className={cn('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide', meta.badge, className)}>{meta.label}</span>;
}
