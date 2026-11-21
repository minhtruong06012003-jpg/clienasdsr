'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

type Status = 'ok' | 'warn' | 'error';

interface HealthItem {
  key: string;
  group: string;
  label: string;
  status: Status;
  value: string;
  hint?: string;
}

interface HealthReport {
  score: number;
  counts: Record<Status, number>;
  items: HealthItem[];
  generatedAt: string;
}

const GROUPS: Record<string, string> = {
  system: 'Hệ thống',
  database: 'Database',
  storage: 'Lưu trữ & sao lưu',
  security: 'Bảo mật & cấu hình',
  services: 'Dịch vụ',
};

const STATUS: Record<Status, { icon: typeof CheckCircle2; className: string; label: string }> = {
  ok: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400', label: 'Tốt' },
  warn: { icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-400', label: 'Cần chú ý' },
  error: { icon: XCircle, className: 'text-red-600 dark:text-red-400', label: 'Lỗi' },
};

/** Tab Site Health: điểm tổng + danh sách kiểm tra theo nhóm */
export function HealthTab() {
  const q = useQuery({ queryKey: ['site-health'], queryFn: () => api.get<HealthReport>('/admin/tools/health'), staleTime: 30_000 });
  const d = q.data;

  if (q.isLoading)
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Đang kiểm tra hệ thống...
      </div>
    );
  if (!d) return <p className="text-sm text-destructive">Không tải được báo cáo.</p>;

  const scoreColor = d.score >= 90 ? 'text-emerald-600 dark:text-emerald-400' : d.score >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
  const groups = [...new Set(d.items.map((i) => i.group))];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-6 rounded-xl border bg-card p-5">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Điểm tổng</p>
          <p className={cn('text-4xl font-bold tabular-nums', scoreColor)}>
            {d.score}
            <span className="text-base font-normal text-muted-foreground">/100</span>
          </p>
        </div>
        <div className="min-w-56 flex-1 space-y-2">
          <Progress value={d.score} />
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            {(['ok', 'warn', 'error'] as Status[]).map((s) => {
              const S = STATUS[s];
              return (
                <span key={s} className="inline-flex items-center gap-1">
                  <S.icon className={cn('size-3.5', S.className)} /> {d.counts[s]} {S.label.toLowerCase()}
                </span>
              );
            })}
            <span>Kiểm tra lúc {formatDate(d.generatedAt, 'HH:mm:ss dd/MM')}</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />} Kiểm tra lại
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((g) => (
          <section key={g} className="rounded-xl border bg-card">
            <h3 className="border-b px-4 py-2.5 text-sm font-semibold">{GROUPS[g] ?? g}</h3>
            <ul className="divide-y">
              {d.items
                .filter((i) => i.group === g)
                .map((i) => {
                  const S = STATUS[i.status];
                  return (
                    <li key={i.key} className="flex items-start gap-3 px-4 py-2.5">
                      <S.icon className={cn('mt-0.5 size-4 shrink-0', S.className)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="text-sm font-medium">{i.label}</span>
                          <span className="break-all text-right text-sm text-muted-foreground">{i.value}</span>
                        </div>
                        {i.hint && <p className={cn('mt-0.5 text-xs', i.status === 'ok' ? 'text-muted-foreground' : S.className)}>{i.hint}</p>}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
