'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Gauge, Loader2, PauseCircle, RotateCcw, Send, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Số liệu hàng chờ email (GET /admin/email-logs/queue/stats) */
export interface MailQueueStats {
  hostConfigured: boolean;
  paused: boolean;
  rateLimitPerMinute: number;
  maxAttempts: number;
  queued: number;
  retrying: number;
  sending: number;
  sent24h: number;
  failed24h: number;
  sentLastMinute: number;
  oldestQueuedAt: string | null;
  nextAttemptAt: string | null;
}

/** Đọc số liệu hàng chờ; tự làm mới mỗi 5 giây khi còn email chờ/đang gửi, 30 giây khi rảnh */
export function useMailQueueStats() {
  return useQuery({
    queryKey: ['email-logs', 'queue-stats'],
    queryFn: () => api.get<MailQueueStats>('/admin/email-logs/queue/stats'),
    refetchInterval: (q) => (q.state.data && q.state.data.queued + q.state.data.sending > 0 ? 5000 : 30_000),
  });
}

/** Một ô số liệu nhỏ */
function Stat({ icon: Icon, label, value, hint, tone }: { icon: typeof Clock; label: string; value: number | string; hint?: string; tone?: 'amber' | 'emerald' | 'red' | 'sky' }) {
  const toneClass = { amber: 'text-amber-600 dark:text-amber-400', emerald: 'text-emerald-600 dark:text-emerald-400', red: 'text-red-600 dark:text-red-400', sky: 'text-sky-600 dark:text-sky-400' }[tone ?? 'sky'];
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn('size-3.5', toneClass)} />
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums leading-tight">{value}</div>
      {hint && <div className="truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * Bảng tóm tắt hàng chờ gửi email: số đang chờ / đang gửi / đã gửi / thất bại trong 24h, tốc độ,
 * cảnh báo (tạm dừng, chưa cấu hình SMTP) và thao tác hàng loạt (thử lại email lỗi, huỷ hàng chờ).
 * Dùng ở Cài đặt › Email SMTP (compact) và tab Nhật ký email.
 */
export function MailQueuePanel({ compact = false }: { compact?: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useMailQueueStats();
  const s = q.data;
  const manage = can('settings.mail') || can('settings.emails');

  const refresh = () => qc.invalidateQueries({ queryKey: ['email-logs'] });
  const retryFailed = useMutation({
    mutationFn: () => api.post<{ count: number }>('/admin/email-logs/queue/retry-failed'),
    onSuccess: (r) => {
      toast.success(r.count ? `Đã đưa ${r.count} email lỗi trở lại hàng chờ` : 'Không có email lỗi nào trong 7 ngày gần đây để gửi lại');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancelAll = useMutation({
    mutationFn: () => api.post<{ count: number }>('/admin/email-logs/queue/cancel-all'),
    onSuccess: (r) => {
      toast.success(`Đã huỷ ${r.count} email đang chờ`);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!s) return <div className="h-[92px] animate-pulse rounded-xl border bg-muted/40" />;

  const waiting = s.queued + s.sending;
  const rate = s.rateLimitPerMinute > 0 ? `${s.sentLastMinute}/${s.rateLimitPerMinute} email/phút` : `${s.sentLastMinute} email/phút · không giới hạn`;

  return (
    <div className="space-y-3">
      {!s.hostConfigured && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>Chưa cấu hình máy chủ SMTP — email mới sẽ bị bỏ qua (không xếp hàng). Cấu hình tại Cài đặt › Email SMTP.</p>
        </div>
      )}
      {s.hostConfigured && s.paused && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <PauseCircle className="mt-0.5 size-4 shrink-0" />
          <p>
            Hàng chờ đang <b>tạm dừng</b>: email mới vẫn được xếp hàng nhưng chưa gửi đi{waiting ? ` (${waiting} email đang chờ)` : ''}. Bật lại trong Cài đặt › Email SMTP.
          </p>
        </div>
      )}
      <div className={cn('grid gap-2', compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 md:grid-cols-5')}>
        <Stat icon={Clock} tone="amber" label="Đang chờ" value={s.queued} hint={s.retrying ? `${s.retrying} chờ thử lại` : s.oldestQueuedAt ? `cũ nhất ${timeAgo(s.oldestQueuedAt)}` : 'trống'} />
        <Stat icon={Send} tone="sky" label="Đang gửi" value={s.sending} hint={rate} />
        <Stat icon={CheckCircle2} tone="emerald" label="Đã gửi 24h" value={s.sent24h} />
        <Stat icon={XCircle} tone="red" label="Thất bại 24h" value={s.failed24h} hint={`thử tối đa ${s.maxAttempts} lần`} />
        {!compact && <Stat icon={Gauge} label="Tốc độ" value={s.rateLimitPerMinute > 0 ? `${s.rateLimitPerMinute}/phút` : '∞'} hint={s.paused ? 'đang tạm dừng' : 'gửi nền mỗi 2 giây'} />}
      </div>
      {(manage || compact) && (
        <div className="flex flex-wrap items-center gap-2">
          {manage && s.failed24h > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={retryFailed.isPending || !s.hostConfigured}
              onClick={async () => {
                if (await confirm({ title: 'Gửi lại email lỗi?', description: 'Đưa mọi email thất bại trong 7 ngày gần đây (còn lưu nội dung) trở lại hàng chờ để gửi lại.', confirmText: 'Gửi lại' })) retryFailed.mutate();
              }}
            >
              {retryFailed.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Gửi lại email lỗi
            </Button>
          )}
          {manage && s.queued > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={cancelAll.isPending}
              onClick={async () => {
                if (await confirm({ title: 'Huỷ toàn bộ hàng chờ?', description: `${s.queued} email đang chờ sẽ không được gửi. Có thể gửi lại từng email trong nhật ký sau.`, confirmText: 'Huỷ hàng chờ', destructive: true })) cancelAll.mutate();
              }}
            >
              <XCircle /> Huỷ hàng chờ
            </Button>
          )}
          {compact && (
            <Button type="button" variant="link" size="sm" className="ml-auto px-0" asChild>
              <Link href="/settings/emails?tab=logs">Xem nhật ký email →</Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
