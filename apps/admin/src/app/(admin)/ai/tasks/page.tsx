'use client';

/**
 * AI Studio › Tác vụ: mọi lần khách chạy công cụ AI (GET /admin/ai/tasks) — tab theo trạng thái, tìm theo tên sản phẩm / công cụ,
 * mã tác vụ, mã phía nhà cung cấp, email / tên khách.
 * - Cột `Kết quả` hiển thị trực tiếp ảnh / video ngay ngoài bảng để theo dõi nhanh không cần mở từng đơn;
 * - Trong chi tiết tác vụ (và ngay trên kết quả), có nút 1 chạm `Gắn làm video / ảnh mẫu` tự sao lưu vĩnh viễn vào `ai/demos/...`.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, ExternalLink, Film, Loader2, Music, Play, RefreshCw, RotateCcw, ShieldCheck, Undo2, X, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { useConfirm } from '@/components/common/confirm-dialog';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { PermissionGate, TASK_STATUS, ToneBadge, fmtCredits, type PaginatedWithCounts } from '@/components/ai/shared';
import { AdminAiTaskDialog, TASK_VISIBILITY, taskVisibilityOf, type AdminTaskRow, type TaskUpstreamCancelInfo, type TaskUpstreamLiveStatus } from '@/components/ai/task-detail-dialog';
import { UserCell } from '@/components/affiliate/shared';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';

type TaskRow = AdminTaskRow;

const STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

/** Dưới ~1 giờ (< 45 phút) hiện "X phút trước"; từ mốc "khoảng 1 giờ trước" trở đi hiện giờ chi tiết "HH:mm dd/MM/yyyy" */
function formatTaskTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Date.now() - d.getTime() >= 45 * 60_000) {
    return formatDate(d, 'HH:mm dd/MM/yyyy');
  }
  return timeAgo(d);
}

function estimateTaskSec(toolKey: string, toolName?: string | null): number {
  const s = `${toolKey} ${toolName ?? ''}`.toLowerCase();
  if (/tts|voice|giọng|remove-bg|tách nền|chat|viết|dịch/.test(s)) return 25;
  if (/upscale|nét/.test(s)) return /video/.test(s) ? 95 : 30;
  if (/image|ảnh|banana|seedream|flux|midjourney/.test(s) && !/video|motion/.test(s)) return 42;
  if (/motion|kling|seedance|veo|wan|sora/.test(s)) return 145;
  return 90;
}

function liveTaskPct(r: TaskRow, nowMs: number, prevMax?: number): number {
  const raw = Math.max(0, Math.min(97, Math.round(r.progress ?? 0)));
  if (r.status === 'PENDING') return raw > 0 ? Math.min(raw, 4) : 0;
  const startMs = new Date(r.startedAt || r.createdAt).getTime();
  const elapsedSec = Math.max(1, (nowMs - startMs) / 1000);
  const est = estimateTaskSec(r.toolKey, r.tool?.name);
  const curve = Math.min(95, Math.max(4, Math.round(95 * (1 - Math.exp(-elapsedSec / est)))));
  // Nếu nguồn đang báo kẹt mốc cứng thấp (vd 15%) thì nội suy mượt theo thời gian thực tế, luôn tăng đơn điệu tới 97%
  const merged = Math.min(97, Math.max(raw, curve));
  return prevMax !== undefined ? Math.max(prevMax, merged) : merged;
}

function TasksContent() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user, can } = useAuth();
  const canTools = can('ai.tools');
  const canManageTasks = can('ai.tasks.manage');
  const { params, set, page, limit } = useListParams<Record<string, string>>({ status: '', search: '', visibility: '', provider: '', day: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Record<string, boolean>>({});
  const [pinnedTools, setPinnedTools] = useState<Record<string, boolean>>({});
  const pinRowDemo = useMutation({
    mutationFn: (payload: { taskId: string; toolKey: string; toolName: string; url: string; hasDemo?: boolean }) =>
      api.put(`/admin/ai/tools/${encodeURIComponent(payload.toolKey)}`, { demoVideo: payload.url }),
    onSuccess: (_d, vars) => {
      setPinnedIds((prev) => ({ ...prev, [vars.taskId]: true }));
      setPinnedTools((prev) => ({ ...prev, [vars.toolKey]: true }));
      toast.success(
        vars.hasDemo
          ? `Đã đổi video / ảnh mẫu cho "${vars.toolName}"!`
          : `Đã gắn làm video / ảnh mẫu cho "${vars.toolName}"!`,
      );
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runAutoCheck = useMutation({
    mutationFn: () =>
      api.post<{ checkedCount: number; healedCount: number; healedTools?: string[]; scannedCount?: number; resolvedCount?: number }>(
        '/admin/ai/tasks/auto-check',
        {},
      ),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
      const stuckMsg = res.scannedCount ? ` · Quét ${res.scannedCount} đơn >30p` : '';
      if (res.healedCount > 0) {
        toast.success(`Đã kiểm tra ${res.checkedCount} đơn lỗi & tự khoá bảo trì ${res.healedCount} model lỗi nguồn${stuckMsg}`);
      } else if (res.checkedCount > 0 || (res.scannedCount ?? 0) > 0) {
        toast.success(`Đã tự động kiểm tra ${res.checkedCount} đơn lỗi${stuckMsg}`);
      } else {
        toast.success('Tất cả đơn lỗi & đơn đang xử lý đều đã được quét cập nhật mới nhất ✓');
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const lastStuckScanRef = useRef(0);
  useEffect(() => {
    if (params.status !== 'STUCK') return;
    if (Date.now() - lastStuckScanRef.current < 25_000) return;
    lastStuckScanRef.current = Date.now();
    void api
      .post('/admin/ai/tasks/scan-stuck', {})
      .then(() => qc.invalidateQueries({ queryKey: ['ai-tasks'] }))
      .catch(() => undefined);
  }, [params.status, qc]);
  const isChildSite = !!user?.isChildSite;
  const q = useQuery({
    placeholderData: keepPreviousData,
    staleTime: 2_500,
    queryKey: ['ai-tasks', params.status, params.search, params.visibility, params.provider, params.day, page, limit],
    queryFn: () =>
      api.get<
        PaginatedWithCounts<TaskRow> & {
          hideProviders?: boolean;
          visibility?: { public: number; blocked: number };
          providers?: { key: string; name: string; count: number }[];
        }
      >('/admin/ai/tasks', {
        status: params.status,
        search: params.search,
        visibility: params.visibility,
        provider: params.provider,
        day: params.day,
        page,
        limit,
      }),
    refetchInterval: 4_000,
    refetchOnWindowFocus: true,
  });
  const counts = q.data?.counts ?? {};
  const vis = q.data?.visibility;
  const hideProviders = Boolean(isChildSite || q.data?.hideProviders);
  const providers = hideProviders ? [] : (q.data?.providers ?? []);
  const isRealtimeUpstreamTab = !hideProviders && (params.status === 'FAILED' || params.status === 'CANCELLED' || params.status === 'STUCK');

  const [liveUpstreamMap, setLiveUpstreamMap] = useState<Record<string, TaskUpstreamLiveStatus>>({});
  const [liveCancelMap, setLiveCancelMap] = useState<Record<string, TaskUpstreamCancelInfo>>({});
  const [probingUpstreamIds, setProbingUpstreamIds] = useState<Record<string, boolean>>({});
  const probingLockRef = useRef(false);

  const cancelUpstreamMut = useMutation({
    mutationFn: (taskId: string) =>
      api.post<{ upstreamCancel?: TaskUpstreamCancelInfo | null; upstreamLive?: TaskUpstreamLiveStatus | null; taskStatus?: string }>(
        `/admin/ai/tasks/${encodeURIComponent(taskId)}/cancel-upstream-only`,
        {},
      ),
    onSuccess: (res, taskId) => {
      if (res.upstreamCancel) {
        setLiveCancelMap((prev) => ({ ...prev, [taskId]: res.upstreamCancel! }));
        if (res.upstreamCancel.ok) {
          toast.success(`Nguồn phản hồi: ${res.upstreamCancel.note}`);
        } else {
          toast.warning(`Nguồn phản hồi: ${res.upstreamCancel.note}`);
        }
      }
      if (res.upstreamLive) {
        setLiveUpstreamMap((prev) => ({ ...prev, [taskId]: res.upstreamLive! }));
      }
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const refundCustomerMut = useMutation({
    mutationFn: (payload: { id: string; code: string }) =>
      api.post(`/admin/ai/tasks/${encodeURIComponent(payload.id)}/cancel`, {
        reason: 'Tác vụ xử lý quá lâu bên nguồn — quản trị viên đã huỷ & hoàn tiền vào ví',
      }),
    onSuccess: (_d, vars) => {
      toast.success(`Đã huỷ & hoàn tiền vào ví khách cho đơn ${vars.code}`);
      void qc.invalidateQueries({ queryKey: ['ai-tasks'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const probeUpstreamIds = useCallback(
    async (ids: string[], force = false) => {
      const clean = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      if (!clean.length) return;
      if (!force && probingLockRef.current) return;
      if (!force) probingLockRef.current = true;
      setProbingUpstreamIds((prev) => {
        const next = { ...prev };
        for (const id of clean) next[id] = true;
        return next;
      });
      try {
        const res = await api.post<{ items?: Record<string, TaskUpstreamLiveStatus> }>('/admin/ai/tasks/live-upstream', {
          ids: clean,
          force,
        });
        if (res?.items) {
          setLiveUpstreamMap((prev) => ({ ...prev, ...res.items }));
        }
      } catch {
        /* bỏ qua lỗi mạng tạm */
      } finally {
        if (!force) probingLockRef.current = false;
        setProbingUpstreamIds((prev) => {
          const next = { ...prev };
          for (const id of clean) delete next[id];
          return next;
        });
      }
    },
    [],
  );

  useEffect(() => {
    if (!isRealtimeUpstreamTab) return;
    const rows = q.data?.data ?? [];
    if (!rows.length) return;

    const pickIds = () =>
      rows
        .filter((r) => {
          if (!r.providerTaskId || r.isFromChildSite) return false;
          const cur = liveUpstreamMap[r.id] ?? r.upstreamLive;
          if (!cur || !cur.checkedAt) return true;
          return cur.state === 'processing' || cur.state === 'queued' || cur.state === 'unknown';
        })
        .map((r) => r.id)
        .slice(0, 25);

    const initial = pickIds();
    if (initial.length) void probeUpstreamIds(initial, false);

    const timer = setInterval(() => {
      const due = pickIds();
      if (due.length) void probeUpstreamIds(due, false);
    }, 6_000);
    return () => clearInterval(timer);
  }, [isRealtimeUpstreamTab, q.data?.data, liveUpstreamMap, probeUpstreamIds]);

  const hasActiveRows = (q.data?.data ?? []).some((r) => r.status === 'PENDING' || r.status === 'PROCESSING');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const maxPctRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!hasActiveRows) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveRows]);

  const columns: Column<TaskRow>[] = [
    {
      key: 'code',
      header: 'Mã',
      mobile: 'primary',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="font-mono font-semibold">{r.code}</div>
          {r.isFromChildSite && r.siteDomain && (
            <div className="mt-0.5 inline-flex items-center rounded border border-sky-500/35 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
              🌐 {r.siteDomain}
            </div>
          )}
          <div className="text-[11px] text-muted-foreground" title={formatDate(r.createdAt, 'HH:mm:ss dd/MM/yyyy')}>
            {formatTaskTime(r.createdAt)}
          </div>
        </div>
      ),
    },
    { key: 'user', header: 'Khách', className: 'min-w-[170px]', cell: (r) => <UserCell user={r.user} /> },
    {
      key: 'tool',
      header: 'Công cụ',
      className: 'min-w-[200px]',
      cell: (r) => (
        <div>
          <div className="text-sm font-medium">{r.tool?.name ?? r.toolKey}</div>
          {!hideProviders && (r.providerLabel || r.provider) && (
            <div className="font-mono text-[11px] text-muted-foreground">{r.providerLabel || r.provider}</div>
          )}
          {!hideProviders && r.providerTaskId && (
            <button
              type="button"
              className="block max-w-56 truncate font-mono text-[11px] text-muted-foreground hover:text-foreground"
              title={`Mã NCC: ${r.providerTaskId} (bấm để chép)`}
              onClick={(e) => {
                e.stopPropagation();
                void navigator.clipboard?.writeText(r.providerTaskId ?? '').then(() => toast.success('Đã chép mã NCC'));
              }}
            >
              NCC: {r.providerTaskId}
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'result',
      header: 'Kết quả',
      cell: (r) => {
        const files = r.output?.files ?? [];
        const first = files[0];
        if (!first) {
          if (r.status === 'PENDING' || r.status === 'PROCESSING') {
            const isQueued = r.status === 'PENDING' || (r.progress !== undefined && r.progress <= 3 && !r.startedAt);
            const pct = isQueued ? 0 : liveTaskPct(r, nowMs, maxPctRef.current[r.id]);
            if (pct > 0) maxPctRef.current[r.id] = pct;
            return (
              <div className="w-28 space-y-1">
                <div className="flex items-center justify-between gap-1 text-xs">
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="size-3 animate-spin text-primary" />
                    {isQueued ? 'Chờ luồng' : 'Đang tạo'}
                  </span>
                  {!isQueued && pct > 0 && (
                    <span className="font-mono text-[11px] font-bold text-primary tabular-nums">{pct}%</span>
                  )}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${isQueued ? 'animate-pulse bg-amber-500/75' : 'bg-primary'}`}
                    style={{ width: `${isQueued ? 18 : Math.max(pct, 6)}%` }}
                  />
                </div>
              </div>
            );
          }
          if (r.output?.text) {
            return <span className="line-clamp-2 max-w-44 text-xs text-muted-foreground">{r.output.text}</span>;
          }
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        if (first.type === 'audio') {
          return (
            <span className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs font-medium">
              <Music className="size-3.5 text-primary" /> Audio
            </span>
          );
        }
        return (
          <div className="flex items-center gap-1.5">
            <div className="group relative h-12 w-20 shrink-0 overflow-hidden rounded-md border bg-black shadow-2xs">
              {first.type === 'video' ? (
                <>
                  <video
                    src={`${first.url}#t=0.1`}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
                    onMouseLeave={(e) => {
                      e.currentTarget.pause();
                      e.currentTarget.currentTime = 0.1;
                    }}
                    className="h-full w-full object-cover"
                  />
                  <span className="pointer-events-none absolute top-1 right-1 inline-flex size-4 items-center justify-center rounded-full bg-black/65 text-white">
                    <Play className="size-2.5 fill-current" />
                  </span>
                </>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={first.url} alt="" loading="lazy" className="h-full w-full object-cover" />
              )}
              {files.length > 1 && (
                <span className="pointer-events-none absolute right-1 bottom-1 rounded bg-black/75 px-1 py-0.2 text-[10px] font-bold text-white">
                  +{files.length - 1}
                </span>
              )}
            </div>
          </div>
        );
      },
    },
    ...(hideProviders
      ? []
      : [
          {
            key: 'pinDemo',
            header: 'Gắn mẫu',
            cell: (r: TaskRow) => {
              const first = r.output?.files?.[0];
              if (!canTools || !first || (first.type !== 'video' && first.type !== 'image')) {
                return <span className="text-xs text-muted-foreground">—</span>;
              }
              const busy = pinRowDemo.isPending && pinRowDemo.variables?.taskId === r.id;
              const done = !!pinnedIds[r.id];
              const hasDemo = Boolean(r.tool?.demoVideo || pinnedTools[r.toolKey]);
              return (
                <div onClick={(e) => e.stopPropagation()}>
                  <Button
                    type="button"
                    size="sm"
                    variant={done ? 'secondary' : 'outline'}
                    disabled={busy}
                    onClick={() =>
                      pinRowDemo.mutate({
                        taskId: r.id,
                        toolKey: r.toolKey,
                        toolName: r.tool?.name ?? r.toolKey,
                        url: first.url,
                        hasDemo,
                      })
                    }
                    title={
                      hasDemo
                        ? `Model "${r.tool?.name ?? r.toolKey}" đã có mẫu — bấm để đổi sang kết quả đơn ${r.code}`
                        : `Gắn kết quả đơn ${r.code} làm video / ảnh mẫu cho "${r.tool?.name ?? r.toolKey}"`
                    }
                    className={
                      done
                        ? 'h-7 gap-1 border-emerald-300 bg-emerald-50 px-2.5 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : hasDemo
                          ? 'h-7 gap-1 border-amber-300 bg-amber-50/70 px-2.5 text-xs text-amber-700 hover:bg-amber-100 hover:text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                          : 'h-7 gap-1 border-primary/35 px-2.5 text-xs text-primary hover:bg-primary hover:text-primary-foreground'
                    }
                  >
                    {busy ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : done ? (
                      <Check className="size-3" />
                    ) : hasDemo ? (
                      <RefreshCw className="size-3" />
                    ) : (
                      <Film className="size-3" />
                    )}
                    {done ? 'Đã gắn' : hasDemo ? 'Đổi mẫu' : 'Gắn mẫu'}
                  </Button>
                </div>
              );
            },
          },
        ]),
    { key: 'credits', header: 'Chi phí', cell: (r) => <span className="tabular-nums">{fmtCredits(r.credits)}</span> },
    { key: 'status', header: 'Trạng thái', mobile: 'action', cell: (r) => <ToneBadge map={TASK_STATUS} value={r.status} /> },
    {
      key: 'visibility',
      header: 'Hiển thị',
      cell: (r) => {
        const v = taskVisibilityOf(r);
        return v ? <ToneBadge map={TASK_VISIBILITY} value={v} /> : <span className="text-xs text-muted-foreground">Riêng tư</span>;
      },
    },
    {
      key: 'error',
      header: 'Ghi chú',
      cell: (r) => {
        if (!r.error && (!r.upstreamCancel || hideProviders)) return null;
        const isUpstreamPolicy = r.status === 'FAILED' && !!r.error && /chính sách|bộ lọc|từ bị cấm|nhạy cảm/i.test(r.error);
        const isUpstreamErr = r.status === 'FAILED' && !!r.error;
        return (
          <div className="max-w-64 space-y-1 text-xs">
            {!hideProviders && isUpstreamErr && (
              <span className="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                {isUpstreamPolicy ? 'Bộ lọc từ nguồn từ chối' : 'Lỗi báo từ nguồn'}
              </span>
            )}
            {r.error && <div className="line-clamp-2 text-muted-foreground">{r.error}</div>}
            {!hideProviders && r.upstreamCancel && (
              <div
                title={r.upstreamCancel.note}
                className={`line-clamp-2 rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                  r.upstreamCancel.ok
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                }`}
              >
                {r.upstreamCancel.ok ? '✓ Nguồn: ' : 'Nguồn: '}
                {r.upstreamCancel.note}
              </div>
            )}
          </div>
        );
      },
    },
    ...(isRealtimeUpstreamTab
      ? [
          {
            key: 'upstreamLive',
            header: (
              <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span>Trạng thái nguồn</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                  Live
                </span>
              </div>
            ),
            cell: (r: TaskRow) => {
              const live = liveUpstreamMap[r.id] ?? r.upstreamLive;
              const isProbing = !!probingUpstreamIds[r.id];

              if (!r.providerTaskId) {
                return (
                  <div className="space-y-0.5 text-[11px] whitespace-nowrap" title="Đơn lỗi trước khi gửi sang nguồn hoặc không tạo mã job bên nguồn">
                    <div className="text-muted-foreground">Chưa gửi nguồn</div>
                    <div className="font-medium text-emerald-600 dark:text-emerald-400">✓ Không tốn phí nguồn</div>
                  </div>
                );
              }

              const renderRefreshBtn = () => (
                <button
                  type="button"
                  title="Hỏi lại trạng thái trực tiếp trên API nguồn ngay lập tức"
                  disabled={isProbing}
                  onClick={(e) => {
                    e.stopPropagation();
                    void probeUpstreamIds([r.id], true);
                  }}
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className={`size-3 ${isProbing ? 'animate-spin text-primary' : ''}`} />
                </button>
              );

              if (!live || (live.state === 'unknown' && isProbing)) {
                return (
                  <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                    <Loader2 className="size-3 animate-spin text-primary" />
                    <span>Đang hỏi nguồn...</span>
                  </div>
                );
              }

              const isFlat = r.provider === 'fable' || r.provider === 'tavtavvideo';
              const refundState =
                live.refundState ??
                (isFlat
                  ? 'not_charged'
                  : live.state === 'succeeded'
                    ? 'charged'
                    : live.state === 'failed' || live.state === 'cancelled'
                      ? 'refunded'
                      : live.state === 'processing' || live.state === 'queued'
                        ? 'holding'
                        : 'unknown');

              // T-504: Bỏ huy hiệu đỏ "Đã dừng / lỗi nguồn" gây rối mắt; khi nguồn đã lỗi/huỷ chỉ hiển thị dòng xanh "✓ Nguồn đã hoàn phí" gọn gàng
              if (live.state === 'failed' || live.state === 'cancelled') {
                return (
                  <div className="space-y-0.5 text-[11px] whitespace-nowrap" title={live.refundNote || live.message || undefined}>
                    <div className="flex items-center gap-1">
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        ✓ {isFlat ? 'Thuê luồng (0đ/đơn)' : live.refundNote?.includes('xác nhận') ? 'Nguồn xác nhận đã hoàn' : 'Nguồn đã hoàn phí'}
                      </span>
                      {renderRefreshBtn()}
                    </div>
                    <div className="text-[10.5px] text-muted-foreground tabular-nums">
                      {live.checkedAt ? `Live: ${formatDate(live.checkedAt, 'HH:mm:ss')}` : 'Tức thì'}
                    </div>
                  </div>
                );
              }

              let badgeClass = 'border-border bg-muted/40 text-muted-foreground';
              let label = 'Chưa rõ';
              let icon: React.ReactNode = null;

              if (live.state === 'processing') {
                badgeClass = 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300';
                label = `Đang chạy${live.progress ? ` ${live.progress}%` : ''}`;
                icon = <Loader2 className="size-3 shrink-0 animate-spin" />;
              } else if (live.state === 'queued') {
                badgeClass = 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300';
                label = 'Đang chờ luồng';
                icon = <Loader2 className="size-3 shrink-0 animate-spin" />;
              } else if (live.state === 'succeeded') {
                badgeClass = 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
                label = 'Đã xong trên nguồn';
                icon = <CheckCircle2 className="size-3 shrink-0" />;
              } else if (live.state === 'not_supported') {
                badgeClass = 'border-border bg-muted/40 text-muted-foreground';
                label = 'Đồng bộ (không lưu job)';
              } else {
                label = live.rawStatus || 'Đang kiểm tra';
              }

              return (
                <div className="space-y-1 text-[11px] whitespace-nowrap" title={live.refundNote || live.message || label}>
                  <div className="flex items-center gap-1">
                    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${badgeClass}`}>
                      {icon}
                      <span>{label}</span>
                    </span>
                    {renderRefreshBtn()}
                  </div>
                  {refundState === 'not_charged' && (
                    <div className="font-medium text-emerald-600 dark:text-emerald-400">
                      ✓ {isFlat ? 'Thuê luồng (0đ/đơn)' : 'Không tốn phí nguồn'}
                    </div>
                  )}
                  {refundState === 'charged' && (
                    <div className="font-semibold text-red-600 dark:text-red-400">
                      ⚠ Nguồn KHÔNG hoàn (đã trừ phí)
                    </div>
                  )}
                  {refundState === 'holding' && (
                    <div className="font-medium text-amber-600 dark:text-amber-400">
                      ⏳ Nguồn đang giữ phí
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground tabular-nums">
                    {live.checkedAt ? <span>Live: {formatDate(live.checkedAt, 'HH:mm:ss')}</span> : <span>Tức thì</span>}
                    {live.resultUrl && (
                      <a
                        href={live.resultUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                      >
                        File <ExternalLink className="size-2.5" />
                      </a>
                    )}
                  </div>
                </div>
              );
            },
          },
          {
            key: 'upstreamAction',
            header: 'Thao tác nguồn',
            cell: (r: TaskRow) => {
              const live = liveUpstreamMap[r.id] ?? r.upstreamLive;
              const uc = liveCancelMap[r.id] ?? r.upstreamCancel;
              const busyUpstream = cancelUpstreamMut.isPending && cancelUpstreamMut.variables === r.id;
              const busyCustomer = refundCustomerMut.isPending && refundCustomerMut.variables?.id === r.id;
              const canRefundCustomer = canManageTasks && !r.refunded && (r.status === 'PENDING' || r.status === 'PROCESSING');

              if (!canManageTasks) {
                return <span className="text-xs text-muted-foreground">—</span>;
              }

              // T-505: Chỉ hiện nút "Huỷ đơn nguồn" khi đơn bên nguồn thực sự ĐANG CHẠY / CHỜ LUỒNG (hoặc chưa rõ);
              // nếu nguồn đã hoàn phí hoặc đã tạo xong thì ghi rõ bằng tiếng Việt dễ hiểu, không hiện mã lỗi HTTP 404 gây lú
              const renderRefundCustomerBtn = () =>
                canRefundCustomer ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busyCustomer}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Hoàn tiền đơn ${r.code} cho khách?`,
                        description: `Hệ thống sẽ chuyển đơn ${r.code} sang Đã huỷ và hoàn ${fmtCredits(r.credits)} về ví khách.`,
                        confirmText: 'Hoàn cho khách',
                        destructive: true,
                      });
                      if (ok) refundCustomerMut.mutate({ id: r.id, code: r.code });
                    }}
                    title="Huỷ đơn trên web & hoàn tiền lại vào ví khách"
                    className="h-7 gap-1 border-amber-500/40 bg-amber-500/10 px-2 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
                  >
                    {busyCustomer ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
                    Hoàn khách
                  </Button>
                ) : null;

              if (!r.providerTaskId || r.isFromChildSite) {
                return (
                  <div className="space-y-1 text-[11px]" onClick={(e) => e.stopPropagation()}>
                    {renderRefundCustomerBtn() ?? <span className="text-muted-foreground">—</span>}
                  </div>
                );
              }

              if (live?.state === 'failed' || live?.state === 'cancelled') {
                return (
                  <div className="space-y-1 text-[11px]" onClick={(e) => e.stopPropagation()}>
                    <span className="text-muted-foreground">Đã dừng bên nguồn</span>
                    {renderRefundCustomerBtn()}
                  </div>
                );
              }

              if (live?.state === 'succeeded') {
                return (
                  <div className="space-y-1 text-[11px]" onClick={(e) => e.stopPropagation()}>
                    <span className="text-muted-foreground">Nguồn đã chạy xong (không huỷ được)</span>
                    {renderRefundCustomerBtn()}
                  </div>
                );
              }

              const cleanNote = uc?.note
                ? /404|405|không cho huỷ|không hỗ trợ/i.test(uc.note)
                  ? 'Nguồn này không hỗ trợ huỷ giữa chừng (đơn vẫn đang chạy)'
                  : uc.note
                : '';

              return (
                <div className="max-w-56 space-y-1.5 text-[11px]" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busyUpstream}
                      onClick={() => cancelUpstreamMut.mutate(r.id)}
                      title="Gửi lệnh yêu cầu dừng / huỷ đơn đang chạy sang bên nguồn"
                      className="h-7 gap-1 px-2 text-xs"
                    >
                      {busyUpstream ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                      {uc ? 'Thử huỷ lại' : 'Huỷ đơn nguồn'}
                    </Button>
                    {renderRefundCustomerBtn()}
                  </div>

                  {uc && (
                    <div
                      title={cleanNote}
                      className={`rounded border px-1.5 py-1 leading-snug ${
                        uc.ok
                          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 font-semibold">
                        <span>{uc.ok ? '✓ Đã huỷ bên nguồn' : '⚠ Nguồn không cho huỷ giữa chừng'}</span>
                        {uc.attemptedAt && (
                          <span className="font-normal opacity-80 tabular-nums">{formatDate(uc.attemptedAt, 'HH:mm:ss')}</span>
                        )}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[10.5px] opacity-90">{cleanNote}</div>
                    </div>
                  )}
                </div>
              );
            },
          },
        ]
      : []),
    ...(hideProviders
      ? []
      : [
          {
            key: 'autoCheck',
            header: 'Kiểm tra / Cập nhật',
            cell: (r: TaskRow) => {
              if (r.status === 'PENDING' || r.status === 'PROCESSING') {
                const sc = r.stuckCheck;
                if (sc) {
                  return (
                    <div title={sc.summary} className="space-y-0.5 text-[11px] whitespace-nowrap">
                      <div className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-medium text-sky-700 dark:text-sky-300">
                        <CheckCircle2 className="size-3 shrink-0" />
                        <span>Check: {formatDate(sc.checkedAt, 'HH:mm:ss')}</span>
                      </div>
                      <div className="text-muted-foreground tabular-nums">
                        Cập nhật: {formatDate(sc.updatedAt, 'HH:mm:ss')}
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="space-y-0.5 text-[11px] text-muted-foreground whitespace-nowrap">
                    <div className="inline-flex items-center gap-1">
                      <Loader2 className="size-3 animate-spin" /> Đang theo dõi
                    </div>
                    <div className="tabular-nums">Tạo: {formatDate(r.createdAt, 'HH:mm:ss')}</div>
                  </div>
                );
              }
              if (r.status === 'CANCELLED') {
                const uc = r.upstreamCancel;
                return (
                  <div title={uc?.note || 'Đơn đã huỷ & hoàn tiền'} className="space-y-0.5 text-[11px] whitespace-nowrap">
                    <div
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium ${
                        uc?.ok
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-border bg-muted/40 text-foreground'
                      }`}
                    >
                      <CheckCircle2 className="size-3 shrink-0" />
                      <span>{uc ? (uc.ok ? 'Đã huỷ nguồn' : 'Đã báo huỷ') : 'Đã hoàn tiền'}</span>
                    </div>
                    {(uc?.attemptedAt || r.completedAt) && (
                      <div className="text-muted-foreground tabular-nums">
                        {formatDate(uc?.attemptedAt || r.completedAt, 'HH:mm:ss dd/MM')}
                      </div>
                    )}
                  </div>
                );
              }
              if (r.status !== 'FAILED') {
                return <span className="text-xs text-muted-foreground">—</span>;
              }
              if (r.autoCheck?.checked) {
                const isHealed = r.autoCheck.kind === 'auto_healed' || r.autoCheck.kind === 'fixed_code';
                return (
                  <div title={r.autoCheck.summary} className="space-y-0.5 text-[11px] whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="size-3.5 shrink-0" />
                      <span>{isHealed ? 'Đã tự fix' : 'Đã check'}</span>
                    </div>
                    {r.autoCheck.checkedAt && (
                      <div className="text-muted-foreground tabular-nums">
                        {formatDate(r.autoCheck.checkedAt, 'HH:mm:ss dd/MM')}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                  <Loader2 className="size-3 animate-spin" /> Đang check
                </span>
              );
            },
          },
        ]),
  ];

  return (
    <>
      <PageHeader
        title="Tác vụ AI"
        description="Lịch sử chạy công cụ AI của khách; tác vụ lỗi / quá hạn tự hoàn tiền vào ví & hệ thống tự động kiểm tra xử lý lỗi nguồn"
        breadcrumbs={[{ label: 'AI Studio' }, { label: 'Tác vụ' }]}
        actions={
          !hideProviders ? (
            <Button size="sm" variant="outline" disabled={runAutoCheck.isPending} onClick={() => runAutoCheck.mutate()}>
              {runAutoCheck.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5 text-emerald-600" />}
              Quét &amp; Tự xử lý đơn lỗi
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        <PermissionGate permission="ai.tasks">
          <div className="space-y-4">
            <StatusTabs
              value={params.status}
              onChange={(v) => set({ status: v })}
              options={[
                { value: '', label: 'Tất cả' },
                ...STATUSES.map((s) => ({ value: s, label: TASK_STATUS[s].label, count: counts[s] ?? 0, highlight: s === 'PROCESSING' })),
                { value: 'STUCK', label: 'Đang xử lý > 30p', count: counts.STUCK ?? 0, highlight: (counts.STUCK ?? 0) > 0 },
              ]}
            />
            <ListToolbar
              search={params.search}
              onSearchChange={(v) => set({ search: v })}
              placeholder={
                hideProviders
                  ? 'Tìm tên sản phẩm / công cụ, mã tác vụ, email / tên khách...'
                  : 'Tìm tên sản phẩm / công cụ, mã tác vụ, mã NCC, email / tên khách...'
              }
              filters={
                <>
                  {!hideProviders && (
                    <Select value={params.provider || 'all'} onValueChange={(v) => set({ provider: v === 'all' ? '' : v })}>
                      <SelectTrigger className="w-64">
                        <SelectValue placeholder="Nguồn" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Mọi nguồn</SelectItem>
                        {params.provider && !providers.some((p) => p.key === params.provider) && <SelectItem value={params.provider}>{params.provider}</SelectItem>}
                        {providers.map((p) => (
                          <SelectItem key={p.key} value={p.key}>
                            {p.name} ({p.count})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Select value={params.visibility || 'all'} onValueChange={(v) => set({ visibility: v === 'all' ? '' : v })}>
                    <SelectTrigger className="w-52">
                      <SelectValue placeholder="Hiển thị" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Mọi chế độ hiển thị</SelectItem>
                      <SelectItem value="public">Đang công khai{vis ? ` (${vis.public})` : ''}</SelectItem>
                      <SelectItem value="blocked">Đã ẩn khỏi Cộng đồng{vis ? ` (${vis.blocked})` : ''}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={params.day || 'all'} onValueChange={(v) => set({ day: v === 'all' ? '' : v })}>
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Ngày tạo" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Mọi ngày</SelectItem>
                      <SelectItem value="today">Hôm nay</SelectItem>
                      <SelectItem value="yesterday">Hôm qua</SelectItem>
                      <SelectItem value="daybefore">Hôm kia</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              }
            />
            {((!hideProviders && params.provider) || params.visibility || params.day) && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Đang lọc:</span>
                {!hideProviders && params.provider && (
                  <button
                    type="button"
                    onClick={() => set({ provider: '' })}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-medium text-primary hover:bg-primary/15"
                  >
                    Nguồn: {providers.find((p) => p.key === params.provider)?.name ?? params.provider}
                    <X className="size-3" />
                  </button>
                )}
                {params.visibility && (
                  <button
                    type="button"
                    onClick={() => set({ visibility: '' })}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-medium text-primary hover:bg-primary/15"
                  >
                    Hiển thị: {params.visibility === 'public' ? 'Đang công khai' : 'Đã ẩn'}
                    <X className="size-3" />
                  </button>
                )}
                {params.day && (
                  <button
                    type="button"
                    onClick={() => set({ day: '' })}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-medium text-primary hover:bg-primary/15"
                  >
                    Ngày: {params.day === 'today' ? 'Hôm nay' : params.day === 'yesterday' ? 'Hôm qua' : 'Hôm kia'}
                    <X className="size-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => set({ provider: '', visibility: '', day: '' })}
                  className="ml-1 text-xs font-medium text-muted-foreground underline hover:text-foreground"
                >
                  Xoá bộ lọc
                </button>
              </div>
            )}
            <DataTable
              columns={columns}
              data={q.data?.data}
              meta={q.data?.meta}
              loading={q.isLoading}
              error={q.error}
              onRetry={() => void q.refetch()}
              onPageChange={(p) => set({ page: p })}
              onLimitChange={(l) => set({ limit: l })}
              onRowClick={(r) => setOpenId(r.id)}
              emptyTitle="Chưa có tác vụ"
            />
          </div>
          <AdminAiTaskDialog id={openId} onClose={() => setOpenId(null)} />
        </PermissionGate>
      </PageBody>
    </>
  );
}

export default function AiTasksPage() {
  return (
    <Suspense>
      <TasksContent />
    </Suspense>
  );
}
