'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, Film, Loader2, Music, Play, Search, X } from 'lucide-react';
import { DataTable, type Column } from '@/components/common/data-table';
import { StatusTabs } from '@/components/common/list-toolbar';
import { TASK_STATUS, ToneBadge, fmtCredits, type PaginatedWithCounts } from '@/components/ai/shared';
import { AdminAiTaskDialog, TASK_VISIBILITY, taskVisibilityOf, type AdminTaskRow } from '@/components/ai/task-detail-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate, timeAgo } from '@/lib/format';

export interface UserAiTasksTarget {
  id: string;
  name: string;
  email: string;
  aiTasksCount?: number;
}

const STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

function formatTaskTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  const d = new Date(value);
  if (Date.now() - d.getTime() >= 45 * 60_000) {
    return formatDate(d, 'HH:mm dd/MM/yyyy');
  }
  return timeAgo(d);
}

export function UserAiTasksDialog({
  target,
  onClose,
}: {
  target: UserAiTasksTarget | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const isChildSite = !!user?.isChildSite;

  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [day, setDay] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setStatus('');
    setSearch('');
    setDay('');
    setPage(1);
    setOpenTaskId(null);
  }, [target?.id]);

  const q = useQuery({
    placeholderData: keepPreviousData,
    staleTime: 2_500,
    enabled: !!target?.id,
    queryKey: ['ai-tasks', 'by-user', target?.id, status, search, day, page, limit],
    queryFn: () =>
      api.get<PaginatedWithCounts<AdminTaskRow> & { hideProviders?: boolean }>('/admin/ai/tasks', {
        userId: target!.id,
        status,
        search: search.trim(),
        day,
        page,
        limit,
      }),
    refetchInterval: 5_000,
  });

  const counts = q.data?.counts ?? {};
  const hideProviders = Boolean(isChildSite || q.data?.hideProviders);

  const columns: Column<AdminTaskRow>[] = [
    {
      key: 'code',
      header: 'Mã',
      mobile: 'primary',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="font-mono font-semibold">{r.code}</div>
          <div className="text-[11px] text-muted-foreground" title={formatDate(r.createdAt, 'HH:mm:ss dd/MM/yyyy')}>
            {formatTaskTime(r.createdAt)}
          </div>
        </div>
      ),
    },
    {
      key: 'tool',
      header: 'Công cụ',
      cell: (r) => (
        <div className="max-w-72">
          <div className="truncate text-sm font-medium" title={r.tool?.name ?? r.toolKey}>
            {r.tool?.name ?? r.toolKey}
          </div>
          {!hideProviders && (
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {r.providerLabel || r.provider}
              {r.providerTaskId ? ` · NCC: ${r.providerTaskId.slice(0, 22)}${r.providerTaskId.length > 22 ? '…' : ''}` : ''}
            </div>
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
          if (r.output?.text) {
            return <span className="line-clamp-2 max-w-44 text-xs text-muted-foreground">{r.output.text}</span>;
          }
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        if (first.type === 'audio') {
          return (
            <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5">
              <Music className="size-3.5 shrink-0 text-primary" />
              <audio controls preload="none" src={first.url} className="h-7 w-36" />
            </div>
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
    { key: 'credits', header: 'Chi phí', cell: (r) => <span className="whitespace-nowrap tabular-nums">{fmtCredits(r.credits)}</span> },
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
      className: 'min-w-[180px] whitespace-normal',
      cell: (r) => {
        if (!r.error && (!r.upstreamCancel || hideProviders)) return <span className="text-xs text-muted-foreground">—</span>;
        const isUpstreamPolicy = r.status === 'FAILED' && !!r.error && /chính sách|bộ lọc|từ bị cấm|nhạy cảm/i.test(r.error);
        const isUpstreamErr = r.status === 'FAILED' && !!r.error;
        return (
          <div className="max-w-60 space-y-1 text-xs">
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
    ...(hideProviders
      ? []
      : [
          {
            key: 'autoCheck',
            header: 'Kiểm tra / Cập nhật',
            cell: (r: AdminTaskRow) => {
              if (r.status === 'FAILED' && r.autoCheck?.checked) {
                const isHealed = r.autoCheck.kind === 'auto_healed' || r.autoCheck.kind === 'fixed_code';
                return (
                  <div title={r.autoCheck.summary} className="space-y-0.5 text-[11px] whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="size-3.5 shrink-0" />
                      <span>{isHealed ? 'Đã tự fix' : 'Đã check'}</span>
                    </div>
                    {r.autoCheck.checkedAt && (
                      <div className="text-muted-foreground tabular-nums">{formatDate(r.autoCheck.checkedAt, 'HH:mm:ss dd/MM')}</div>
                    )}
                  </div>
                );
              }
              if (r.status === 'PENDING' || r.status === 'PROCESSING') {
                return (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                    <Loader2 className="size-3 animate-spin" /> Đang xử lý
                  </span>
                );
              }
              return <span className="text-xs text-muted-foreground">—</span>;
            },
          },
        ]),
  ];

  return (
    <>
      <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
          <DialogHeader className="shrink-0 border-b bg-muted/20 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
              <div className="min-w-0">
                <DialogTitle className="flex items-center gap-2 text-base font-bold">
                  <Film className="size-4 text-primary" />
                  <span>Đơn chạy AI của {target?.name}</span>
                </DialogTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {target?.email} · Bấm vào bất kỳ dòng nào để xem chi tiết đầu vào/kết quả hoặc huỷ & hoàn tiền.
                </p>
              </div>
              {target && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/ai/tasks?search=${encodeURIComponent(target.email)}`}>
                    Mở trên trang Tác vụ AI <ExternalLink className="ml-1 size-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          </DialogHeader>

          <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5">
            <StatusTabs
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={[
                { value: '', label: 'Tất cả' },
                ...STATUSES.map((s) => ({ value: s, label: TASK_STATUS[s].label, count: counts[s] ?? 0 })),
                { value: 'STUCK', label: 'Đang xử lý > 30p', count: counts.STUCK ?? 0 },
              ]}
            />

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-52 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Tìm mã đơn, tên công cụ..."
                  className="pl-8 pr-8"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setPage(1);
                    }}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              <Select
                value={day || 'all'}
                onValueChange={(v) => {
                  setDay(v === 'all' ? '' : v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Mọi ngày" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Mọi ngày</SelectItem>
                  <SelectItem value="today">Hôm nay</SelectItem>
                  <SelectItem value="yesterday">Hôm qua</SelectItem>
                  <SelectItem value="daybefore">Hôm kia</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DataTable
              columns={columns}
              data={q.data?.data}
              meta={q.data?.meta}
              loading={q.isLoading}
              error={q.error}
              onRetry={() => void q.refetch()}
              onPageChange={(p) => setPage(p)}
              onLimitChange={(l) => {
                setLimit(l);
                setPage(1);
              }}
              onRowClick={(r) => setOpenTaskId(r.id)}
              emptyTitle="Thành viên này chưa chạy đơn AI nào"
            />
          </div>
        </DialogContent>
      </Dialog>

      <AdminAiTaskDialog id={openTaskId} onClose={() => setOpenTaskId(null)} />
    </>
  );
}
