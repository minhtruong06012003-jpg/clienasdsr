'use client';

import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** % thay đổi so với kỳ trước; `invert` khi giảm là tốt (vd. tỉ lệ huỷ) */
/** `unit` = '%' (thay đổi tương đối) hoặc ' điểm' (chênh lệch điểm % của một tỉ lệ, vd tỉ lệ thoát) */
export function Delta({ value, invert = false, unit = '%', className }: { value: number | null | undefined; invert?: boolean; unit?: string; className?: string }) {
  if (value == null) return null;
  const good = invert ? value <= 0 : value >= 0;
  const flat = value === 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums',
        flat ? 'bg-muted text-muted-foreground' : good ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
        className,
      )}
      aria-label={`${value >= 0 ? 'Tăng' : 'Giảm'} ${Math.abs(value)}${unit} so với kỳ trước`}
    >
      {flat ? <Minus className="size-3" /> : value > 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {Math.abs(value).toLocaleString('vi-VN')}
      {unit}
    </span>
  );
}

/** Thẻ chỉ số: tiêu đề, số lớn, % so với kỳ trước, chú thích */
export function KpiCard({
  title,
  value,
  change,
  invert,
  changeUnit,
  hint,
  icon: Icon,
  loading,
}: {
  title: string;
  value: ReactNode;
  change?: number | null;
  invert?: boolean;
  changeUnit?: string;
  hint?: ReactNode;
  icon?: React.ElementType;
  loading?: boolean;
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-muted-foreground">{title}</span>
          {Icon && <Icon className="size-4 shrink-0 text-muted-foreground/70" />}
        </div>
        {loading ? (
          <>
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-4 w-20" />
          </>
        ) : (
          <>
            <div className="truncate text-2xl font-bold tabular-nums tracking-tight">{value}</div>
            <div className="flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Delta value={change} invert={invert} unit={changeUnit} />
              {change != null && <span>so với kỳ trước</span>}
              {hint && <span className={cn(change != null && 'before:mx-1 before:content-["·"]')}>{hint}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
