'use client';

/**
 * Popup xem nhanh chi tiết 1 tác vụ AI trong Web Admin (dùng chung ở trang Tác vụ AI `/ai/tasks`
 * và bấm trực tiếp từ mã đơn trong trang Ticket hỗ trợ `/ai/tickets` — T-202 & T-203).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/common/confirm-dialog';
import { CREDIT_TXN, TASK_STATUS, TONE, ToneBadge, fmtCredits } from '@/components/ai/shared';
import { QuickEditToolDialog } from '@/components/ai/quick-edit-tool-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth';

export interface AdminTaskOutputFile {
  url: string;
  type: string;
}

export interface TaskViolationInfo {
  flagged: boolean;
  source: 'auto' | 'manual';
  categories: ('nsfw' | 'kyc' | 'illegal' | 'policy_blocked')[];
  label: string;
  matches: string[];
  note?: string;
  updatedAt?: string;
}

export interface TaskAutoCheckInfo {
  checked: boolean;
  checkedAt: string;
  kind: 'auto_healed' | 'fixed_code' | 'upstream_policy' | 'upstream_transient' | 'input_invalid' | 'checked';
  summary: string;
}

export interface TaskUpstreamCancelInfo {
  attemptedAt: string;
  trigger: 'admin' | 'user' | 'timeout' | 'retro_sync';
  ok: boolean;
  httpStatus?: number;
  upstreamStatus?: string;
  note: string;
}

export interface TaskStuckCheckInfo {
  checkedAt: string;
  updatedAt: string;
  upstreamStatus: string;
  progress?: number;
  checkCount: number;
  summary: string;
}

export interface TaskUpstreamLiveStatus {
  state: 'processing' | 'queued' | 'succeeded' | 'failed' | 'cancelled' | 'no_task_id' | 'not_supported' | 'unknown';
  refundState?: 'not_charged' | 'refunded' | 'charged' | 'holding' | 'unknown';
  refundNote?: string;
  rawStatus?: string;
  progress?: number;
  resultUrl?: string;
  message?: string;
  checkedAt: string;
}

export interface AdminTaskRow {
  id: string;
  rawId?: string;
  siteCode?: string;
  siteDomain?: string;
  isFromChildSite?: boolean;
  code: string;
  toolKey: string;
  provider: string;
  providerLabel?: string;
  providerDomain?: string;
  status: string;
  credits: number;
  refunded: boolean;
  error: string | null;
  providerTaskId: string | null;
  startedAt?: string | null;
  createdAt: string;
  completedAt: string | null;
  isPublic: boolean;
  publicBlocked: boolean;
  progress?: number;
  output?: { files?: AdminTaskOutputFile[]; text?: string } | null;
  violation?: TaskViolationInfo | null;
  autoCheck?: TaskAutoCheckInfo | null;
  upstreamCancel?: TaskUpstreamCancelInfo | null;
  stuckCheck?: TaskStuckCheckInfo | null;
  upstreamLive?: TaskUpstreamLiveStatus | null;
  user: { id: string; name: string; email: string };
  tool: { name: string; demoVideo?: string | null } | null;
}

export interface AdminTaskDetail extends AdminTaskRow {
  hideProviders?: boolean;
  input: Record<string, unknown>;
  output: { files?: AdminTaskOutputFile[]; text?: string };
  providerData: unknown;
  progress: number;
  pollCount: number;
  creditTxns: { id: string; type: string; amount: number; balanceAfter: number; note: string | null; createdAt: string }[];
}

export const TASK_VISIBILITY: Record<string, { label: string; className: string }> = {
  public: { label: 'Công khai', className: TONE.sky },
  blocked: { label: 'Đã ẩn', className: TONE.red },
};

export const taskVisibilityOf = (r: { isPublic: boolean; publicBlocked: boolean }) =>
  r.publicBlocked ? 'blocked' : r.isPublic ? 'public' : null;

export function AdminAiTaskDialog({ id, onClose, backLabel }: { id: string | null; onClose: () => void; backLabel?: string }) {
  const qc = useQueryClient();
  const { user, can } = useAuth();
  const confirm = useConfirm();
  const [editingToolKey, setEditingToolKey] = useState<string | null>(null);
  const canEditTools = can('ai.tools');

  const q = useQuery({
    queryKey: ['ai-task', id],
    queryFn: () => api.get<AdminTaskDetail>(`/admin/ai/tasks/${id}`),
    enabled: !!id,
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/admin/ai/tasks/${id}/cancel`, {}),
    onSuccess: (updated) => {
      const cancelNote = (updated as AdminTaskDetail | undefined)?.upstreamCancel?.note;
      toast.success(
        cancelNote
          ? `Đã hoàn tiền & báo khách · ${cancelNote}`
          : 'Đã hoàn tiền vào ví & tự gửi thông báo cho khách',
      );
      void qc.invalidateQueries({ queryKey: ['ai-task', id] });
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'ticket'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tickets'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const moderate = useMutation({
    mutationFn: (hidden: boolean) => api.put(`/admin/ai/tasks/${id}/moderation`, { hidden }),
    onSuccess: (_, hidden) => {
      toast.success(hidden ? 'Đã ẩn tác phẩm khỏi Cộng đồng' : 'Đã bỏ ẩn, tác phẩm hiển thị lại trên Cộng đồng');
      void qc.invalidateQueries({ queryKey: ['ai-task', id] });
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!id) return null;

  const t = q.data;
  const hideInternalTags = Boolean(user?.isChildSite || t?.hideProviders);
  const running = t && (t.status === 'PENDING' || t.status === 'PROCESSING');
  const canRefundSucceeded = t && t.status === 'SUCCEEDED' && !t.refunded && t.credits > 0;
  const canCancelOrRefund = !!(running || canRefundSucceeded);
  const vis = t && taskVisibilityOf(t);

  const handleCancelOrRefund = async () => {
    if (!t) return;
    if (canRefundSucceeded) {
      const ok = await confirm({
        title: `Huỷ & hoàn tiền tác vụ ${t.code}?`,
        description: `Hệ thống sẽ tự động hoàn lại chính xác ${fmtCredits(t.credits)} vào ví của ${t.user.email} và chuyển tác vụ sang trạng thái Đã huỷ.`,
        confirmText: 'Huỷ & hoàn tiền',
        destructive: true,
      });
      if (!ok) return;
    }
    cancel.mutate();
  };

  return (
    <>
      <Dialog open={!!id && !editingToolKey} onOpenChange={(o) => !o && !editingToolKey && onClose()}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="min-w-0 shrink-0 border-b px-4 py-3.5 text-left sm:px-5">
            <DialogTitle className="flex flex-wrap items-center gap-2 pr-6 text-base break-words">
              Tác vụ {t?.code} {t && <ToneBadge map={TASK_STATUS} value={t.status} />} {vis && <ToneBadge map={TASK_VISIBILITY} value={vis} />}
            </DialogTitle>
            <DialogDescription className="text-xs break-words">
              {t ? (
                <>
                  {canEditTools ? (
                    <button
                      type="button"
                      onClick={() => setEditingToolKey(t.toolKey)}
                      title="Bấm để mở ngay hộp Sửa công cụ"
                      className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-medium text-foreground underline-offset-2 transition hover:bg-primary/10 hover:text-primary hover:underline"
                    >
                      <span>{t.tool?.name ?? t.toolKey}</span>
                      <Pencil className="size-3 shrink-0 opacity-70" />
                    </button>
                  ) : (
                    <span>{t.tool?.name ?? t.toolKey}</span>
                  )}{' '}
                  · {t.user.email} · {formatDate(t.createdAt)}
                </>
              ) : (
                'Đang tải...'
              )}
            </DialogDescription>
          </DialogHeader>

        {q.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          t && (
            <>
              <div className="min-h-0 min-w-0 flex-1 space-y-3.5 overflow-x-hidden overflow-y-auto px-4 py-4 text-sm sm:px-5">
                <div className={hideInternalTags ? 'grid gap-2 sm:grid-cols-2' : 'grid gap-2 sm:grid-cols-4'}>
                  <Info label="Chi phí" value={fmtCredits(t.credits)} />
                  {!hideInternalTags && <Info label="Nguồn" value={t.providerLabel || t.provider || '—'} mono />}
                  {!hideInternalTags && <Info label="Mã phía NCC" value={t.providerTaskId ?? '—'} mono />}
                  <Info label="Tiến độ / Số lần hỏi" value={`${t.status === 'SUCCEEDED' ? 100 : (t.progress ?? 0)}% · ${t.pollCount} lần`} />
                </div>
                {t.error && (
                  <div className="rounded-lg bg-red-50 p-3 text-xs break-words text-red-700 dark:bg-red-950/40 dark:text-red-300">
                    {!hideInternalTags && t.status === 'FAILED' && (
                      <div className="mb-1 inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10.5px] font-bold text-amber-900 dark:text-amber-200">
                        {/chính sách|bộ lọc|từ bị cấm|nhạy cảm/i.test(t.error)
                          ? 'Ghi chú: Bộ lọc tự động phía nguồn từ chối (vd dính tên người nổi tiếng / bản quyền / va chạm — không phải kết luận khách vi phạm)'
                          : 'Ghi chú: Lỗi báo trực tiếp từ phía nguồn AI'}
                      </div>
                    )}
                    <div>{t.error}</div>
                    {!hideInternalTags && t.autoCheck?.checked && (
                      <div className="mt-2 flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-300">
                        <span className="shrink-0 font-semibold">
                          {t.autoCheck.kind === 'auto_healed' || t.autoCheck.kind === 'fixed_code'
                            ? '✓ Đã tự động kiểm tra & sửa lỗi:'
                            : '✓ Đã kiểm tra tự động:'}
                        </span>
                        <span>{t.autoCheck.summary}</span>
                      </div>
                    )}
                  </div>
                )}
                {!hideInternalTags && t.upstreamCancel && (
                  <div
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      t.upstreamCancel.ok
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'
                    }`}
                  >
                    <div className="font-semibold">
                      {t.upstreamCancel.ok ? '✓ Huỷ đơn bên API nguồn thành công' : 'ℹ️ Trạng thái huỷ bên API nguồn'}
                      {t.upstreamCancel.attemptedAt ? ` · ${formatDate(t.upstreamCancel.attemptedAt, 'HH:mm:ss dd/MM/yyyy')}` : ''}
                    </div>
                    <div className="mt-0.5">{t.upstreamCancel.note}</div>
                  </div>
                )}
                {!hideInternalTags && running && t.stuckCheck && (
                  <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-800 dark:text-sky-300">
                    <div className="font-semibold">
                      ✓ Đã quét nguồn: {formatDate(t.stuckCheck.checkedAt, 'HH:mm:ss dd/MM')} · Cập nhật cuối: {formatDate(t.stuckCheck.updatedAt, 'HH:mm:ss dd/MM')}
                    </div>
                    <div className="mt-0.5">{t.stuckCheck.summary}</div>
                  </div>
                )}
                {!!t.output?.files?.length && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {t.output.files.map((f) => (
                      <div key={f.url} className="space-y-2 rounded-xl border bg-muted/20 p-2.5">
                        {f.type === 'video' ? (
                          <video src={f.url} controls className="max-h-64 w-full rounded-lg bg-black object-contain" />
                        ) : f.type === 'audio' ? (
                          <audio src={f.url} controls className="w-full" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={f.url} alt="" className="max-h-64 w-full rounded-lg border bg-black/5 object-contain" />
                        )}
                        <div className="flex items-center justify-end">
                          <Button asChild type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs">
                            <a href={f.url} target="_blank" rel="noreferrer">
                              <ExternalLink className="size-3.5" /> Mở gốc
                            </a>
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <Block title="Dữ liệu khách nhập" value={t.input} />
                {!t.hideProviders && <Block title="Phản hồi gần nhất của nhà cung cấp" value={t.providerData} />}
                <div>
                  <div className="mb-1 text-xs font-semibold">Biến động số dư</div>
                  <div className="space-y-1">
                    {t.creditTxns.map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-xs">
                        <ToneBadge map={CREDIT_TXN} value={c.type} />
                        <span className="flex-1 truncate">{c.note}</span>
                        <span className="font-semibold tabular-nums">
                          {c.amount > 0 ? '+' : ''}
                          {fmtCredits(c.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {((can('ai.tasks.manage') && (canCancelOrRefund || vis)) || backLabel) && (
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-card px-5 py-3">
                  <div>
                    {backLabel && (
                      <Button size="sm" variant="outline" onClick={onClose}>
                        ← {backLabel}
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {can('ai.tasks.manage') && vis === 'public' && (
                      <Button size="sm" variant="outline" onClick={() => moderate.mutate(true)} disabled={moderate.isPending}>
                        Ẩn khỏi Cộng đồng
                      </Button>
                    )}
                    {can('ai.tasks.manage') && vis === 'blocked' && (
                      <Button size="sm" variant="outline" onClick={() => moderate.mutate(false)} disabled={moderate.isPending}>
                        Bỏ ẩn (hiển thị lại)
                      </Button>
                    )}
                    {can('ai.tasks.manage') && canCancelOrRefund && (
                      <Button size="sm" variant="destructive" onClick={() => void handleCancelOrRefund()} disabled={cancel.isPending}>
                        Huỷ & hoàn tiền
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )
        )}
        </DialogContent>
      </Dialog>
      <QuickEditToolDialog
        toolKey={editingToolKey}
        onClose={() => {
          setEditingToolKey(null);
          void q.refetch();
          void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
        }}
      />
    </>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={mono ? 'truncate font-mono text-xs' : 'font-medium'}>{value}</div>
    </div>
  );
}

function Block({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold">{title}</div>
      <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-[11px] whitespace-pre-wrap">{value ? JSON.stringify(value, null, 2) : '—'}</pre>
    </div>
  );
}
