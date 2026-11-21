'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Loader2, Lock, Monitor, RefreshCw, Send, Smartphone, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';
import { cn } from '@/lib/utils';
import { MailQueuePanel, useMailQueueStats } from '@/components/settings/mail-queue-panel';
import type { EmailLogRow, EmailLogStatus } from './types';

type LogList = Paginated<EmailLogRow> & { statusCounts: Partial<Record<EmailLogStatus, number>>; templates: { key: string; name: string }[] };

const STATUS: Record<EmailLogStatus, { label: string; className: string }> = {
  QUEUED: { label: 'Đang chờ', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  SENDING: { label: 'Đang gửi', className: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  CANCELLED: { label: 'Đã huỷ', className: 'bg-slate-100 text-slate-500 line-through decoration-slate-400 dark:bg-slate-800 dark:text-slate-400' },
  SENT: { label: 'Đã gửi', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  FAILED: { label: 'Thất bại', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  SKIPPED: { label: 'Bỏ qua', className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
};

export function EmailLogStatusBadge({ status }: { status: EmailLogStatus }) {
  const m = STATUS[status] ?? { label: status, className: '' };
  return <Badge className={cn('border-transparent font-medium', m.className)}>{m.label}</Badge>;
}

/** Hộp thoại xem nội dung email đã gửi (từ nhật ký) */
function LogViewDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [mobile, setMobile] = useState(false);
  const q = useQuery({ queryKey: ['email-logs', id], queryFn: () => api.get<EmailLogRow>(`/admin/email-logs/${id}`), enabled: !!id });
  const log = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{log?.subject ?? 'Nội dung email'}</DialogTitle>
          <DialogDescription>
            {log ? (
              <>
                Tới <span className="font-medium text-foreground">{log.to}</span> · {formatDate(log.createdAt)}
                {log.templateName && <> · Mẫu: {log.templateName}</>}
                {log.attempts > 0 && <> · Đã thử {log.attempts}/{log.maxAttempts} lần</>}
                {log.sentAt && <> · Gửi xong {formatDate(log.sentAt)}</>}
              </>
            ) : (
              'Đang tải…'
            )}
          </DialogDescription>
        </DialogHeader>
        {log?.error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{log.error}</p>}
        <div className="flex items-center justify-end gap-1">
          <Button variant={mobile ? 'ghost' : 'secondary'} size="icon" className="size-8" onClick={() => setMobile(false)} aria-label="Xem desktop">
            <Monitor className="size-4" />
          </Button>
          <Button variant={mobile ? 'secondary' : 'ghost'} size="icon" className="size-8" onClick={() => setMobile(true)} aria-label="Xem mobile">
            <Smartphone className="size-4" />
          </Button>
        </div>
        <div className="cms-light min-h-0 flex-1 overflow-auto rounded-lg border bg-zinc-100 p-3">
          {log?.html ? (
            <iframe title="Nội dung email" sandbox="" srcDoc={log.html} className={cn('mx-auto block h-[60vh] rounded-md bg-white shadow-sm transition-all', mobile ? 'w-[390px]' : 'w-full')} />
          ) : (
            <p className="p-6 text-center text-sm text-muted-foreground">{q.isLoading ? 'Đang tải…' : 'Nhật ký này không lưu nội dung email.'}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Tab "Nhật ký email": bảng + lọc + gửi lại */
export function EmailLogsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { params, set, page, limit } = useListParams({ status: '', templateKey: '', search: '' });
  const [viewing, setViewing] = useState<string | null>(null);
  // id các email đang tích chọn cho thao tác hàng loạt (giữ qua các trang)
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();
  // thao tác hàng loạt (gửi lại / huỷ) cần cùng quyền với nút đơn lẻ
  const canBulk = can('settings.emails') || can('settings.mail');

  // còn email chờ / đang gửi → tự làm mới bảng để thấy trạng thái thay đổi
  const stats = useMailQueueStats();
  const live = !!stats.data && stats.data.queued + stats.data.sending > 0;
  const q = useQuery({
    queryKey: ['email-logs', params],
    refetchInterval: live ? 5000 : false,
    queryFn: () => api.get<LogList>('/admin/email-logs', { page, limit, status: params.status, templateKey: params.templateKey, search: params.search }),
    placeholderData: (prev) => prev,
  });

  const resend = useMutation({
    mutationFn: (id: string) => api.post<EmailLogRow>(`/admin/email-logs/${id}/resend`),
    onSuccess: (log) => {
      toast.success(log.status === 'QUEUED' ? `Đã đưa vào hàng chờ, sẽ gửi tới ${log.to} trong giây lát` : `Đã ghi nhận (${STATUS[log.status]?.label ?? log.status})`);
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post<EmailLogRow>(`/admin/email-logs/${id}/cancel`),
    onSuccess: () => {
      toast.success('Đã huỷ email khỏi hàng chờ');
      qc.invalidateQueries({ queryKey: ['email-logs'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /**
   * Gửi lại / gửi ngay hàng loạt: dùng lại endpoint resend đơn lẻ — server tự từ chối email chứa mã,
   * email không lưu nội dung hoặc đang gửi, các mục đó được gom vào toast lỗi.
   */
  const bulkResend = async () => {
    const n = selected.length;
    if (!(await confirm({ title: `Gửi lại ${n} email?`, description: 'Email đã gửi sẽ được gửi thêm lần nữa; email đang chờ được đẩy lên gửi ngay. Email chứa mã hoặc không lưu nội dung sẽ bị bỏ qua.', confirmText: 'Gửi lại' }))) return;
    void bulk.run({
      ids: selected,
      action: (id) => api.post(`/admin/email-logs/${id}/resend`),
      doneLabel: 'Đã đưa vào hàng chờ',
      onDone: () => {
        setSelected([]);
        void qc.invalidateQueries({ queryKey: ['email-logs'] });
      },
    });
  };

  /** Huỷ hàng loạt các email đang chờ (server chỉ huỷ được email QUEUED) */
  const bulkCancel = async () => {
    const n = selected.length;
    if (!(await confirm({ title: `Huỷ ${n} email?`, description: 'Các email đang chờ sẽ không được gửi. Email đã gửi xong hoặc không còn chờ sẽ bị bỏ qua.', confirmText: 'Huỷ email', destructive: true }))) return;
    void bulk.run({
      ids: selected,
      action: (id) => api.post(`/admin/email-logs/${id}/cancel`),
      doneLabel: 'Đã huỷ',
      onDone: () => {
        setSelected([]);
        void qc.invalidateQueries({ queryKey: ['email-logs'] });
      },
    });
  };

  const counts = q.data?.statusCounts ?? {};
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);

  const columns: Column<EmailLogRow>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
      className: 'whitespace-nowrap',
      cell: (r) => (
        <div className="leading-tight">
          <div className="text-sm">{formatDate(r.createdAt)}</div>
          <div className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
    { key: 'to', header: 'Tới', cell: (r) => <span className="block max-w-[220px] truncate text-sm" title={r.to}>{r.to}</span> },
    {
      key: 'subject',
      header: 'Tiêu đề',
      cell: (r) => (
        <div className="min-w-0 max-w-[360px]">
          <div className="truncate text-sm font-medium" title={r.subject}>
            {r.subject}
          </div>
          {r.error && (
            <div className="truncate text-xs text-red-600 dark:text-red-400" title={r.error}>
              {r.error}
            </div>
          )}
        </div>
      ),
    },
    { key: 'templateKey', header: 'Mẫu', cell: (r) => (r.templateKey ? <span className="text-xs text-muted-foreground" title={r.templateKey}>{r.templateName ?? r.templateKey}</span> : <span className="text-xs text-muted-foreground">—</span>) },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="space-y-0.5">
          <EmailLogStatusBadge status={r.status} />
          {/* email giao mã: nội dung có mã / tài khoản nên đã xoá khỏi nhật ký sau khi gửi */}
          {r.sensitive && (
            <div className="flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground" title="Email chứa mã / tài khoản: nội dung không được lưu lại. Gửi lại bằng nút “Gửi lại email” trong thẻ Mã đã giao của đơn hàng.">
              <Lock className="size-3" /> Chứa mã · đã ẩn nội dung
            </div>
          )}
          {r.status === 'QUEUED' && r.attempts > 0 && (
            <div className="whitespace-nowrap text-[11px] text-muted-foreground">
              Lần {r.attempts}/{r.maxAttempts} · thử lại {timeAgo(r.nextAttemptAt)}
            </div>
          )}
          {r.status === 'QUEUED' && r.attempts === 0 && r.priority > 0 && <div className="text-[11px] text-muted-foreground">Ưu tiên cao</div>}
          {(r.status === 'FAILED' || r.status === 'SENT') && r.attempts > 1 && <div className="text-[11px] text-muted-foreground">sau {r.attempts} lần thử</div>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right whitespace-nowrap',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setViewing(r.id)} disabled={!r.canResend} title="Xem nội dung">
            <Eye /> Xem
          </Button>
          {canBulk && r.status === 'QUEUED' && (
            <>
              <Button variant="ghost" size="sm" disabled={resend.isPending} title="Gửi ở lượt kế tiếp, không chờ lịch thử lại" onClick={() => resend.mutate(r.id)}>
                {resend.isPending && resend.variables === r.id ? <Loader2 className="animate-spin" /> : <Zap />} Gửi ngay
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={cancel.isPending}
                onClick={async () => {
                  if (await confirm({ title: 'Huỷ email này?', description: `"${r.subject}" tới ${r.to} sẽ không được gửi.`, confirmText: 'Huỷ email', destructive: true })) cancel.mutate(r.id);
                }}
              >
                <X /> Huỷ
              </Button>
            </>
          )}
          {canBulk && r.status !== 'QUEUED' && r.status !== 'SENDING' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!r.canResend || resend.isPending}
              title={r.canResend ? 'Đưa email này vào hàng chờ để gửi lại' : r.sensitive ? 'Email chứa mã: gửi lại trong đơn hàng › Mã đã giao' : 'Không lưu nội dung, không thể gửi lại'}
              onClick={async () => {
                if (await confirm({ title: 'Gửi lại email?', description: `Gửi lại "${r.subject}" tới ${r.to}.`, confirmText: 'Gửi lại' })) resend.mutate(r.id);
              }}
            >
              {resend.isPending && resend.variables === r.id ? <Loader2 className="animate-spin" /> : <Send />} Gửi lại
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <MailQueuePanel />
      <StatusTabs
        value={params.status}
        onChange={(v) => set({ status: v })}
        options={[
          { value: '', label: 'Tất cả', count: total },
          { value: 'QUEUED', label: 'Đang chờ', count: counts.QUEUED ?? 0 },
          { value: 'SENT', label: 'Đã gửi', count: counts.SENT ?? 0 },
          { value: 'FAILED', label: 'Thất bại', count: counts.FAILED ?? 0, highlight: (counts.FAILED ?? 0) > 0 },
          { value: 'SKIPPED', label: 'Bỏ qua', count: counts.SKIPPED ?? 0 },
          { value: 'CANCELLED', label: 'Đã huỷ', count: counts.CANCELLED ?? 0 },
        ]}
      />
      <ListToolbar
        search={params.search}
        onSearchChange={(v) => set({ search: v })}
        placeholder="Tìm theo email nhận / tiêu đề…"
        selectedCount={selected.length}
        onClearSelection={() => setSelected([])}
        bulkActions={
          canBulk ? (
            <>
              <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => void bulkResend()}>
                {bulk.pending ? <Loader2 className="animate-spin" /> : <Send />} Gửi lại
              </Button>
              <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={() => void bulkCancel()}>
                <X /> Huỷ email chờ
              </Button>
            </>
          ) : undefined
        }
        filters={
          <>
            <Select value={params.templateKey || 'all'} onValueChange={(v) => set({ templateKey: v === 'all' ? '' : v })}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Mẫu email" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả mẫu</SelectItem>
                <SelectItem value="none">Không dùng mẫu</SelectItem>
                {(q.data?.templates ?? []).map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" className="size-9" onClick={() => q.refetch()} aria-label="Tải lại" title="Tải lại">
              <RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} />
            </Button>
          </>
        }
      />
      <DataTable
        columns={columns}
        data={q.data?.data}
        loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        meta={q.data?.meta}
        selectable={canBulk}
        selected={selected}
        onSelectedChange={setSelected}
        onPageChange={(p) => set({ page: p })}
        onLimitChange={(l) => set({ limit: l, page: 1 })}
        emptyTitle="Chưa có email nào được gửi"
        emptyDescription="Nhật ký ghi lại mọi email hệ thống gửi qua hàng chờ (đang chờ, đã gửi, thất bại, bị bỏ qua khi chưa cấu hình SMTP). Email đã xong tự xoá sau 90 ngày."
      />
      <LogViewDialog id={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
