'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Download, Loader2, MoreHorizontal, PartyPopper, RefreshCw, SearchX, Settings2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody } from '@/components/common/page-header';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { ListToolbar } from '@/components/common/list-toolbar';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LogEntryTable } from '@/components/logs/log-entry-table';
import { LogFileList } from '@/components/logs/log-file-list';
import { LEVEL_META, LOG_LEVELS, sourceLabel, formatLogDate, type LogEntriesResponse, type LogFilesResponse, type LogLevel } from '@/components/logs/log-types';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

/** Chu kỳ tự làm mới khi bật "Tự làm mới" */
const AUTO_REFRESH_MS = 10_000;

/** Giá trị mặc định bộ lọc trên URL (limit mặc định 50 dòng/trang) */
const DEFAULT_PARAMS = { file: '', level: '', source: '', search: '', limit: '50' };

/** Chip lọc theo level, cho chọn nhiều; "Tất cả" = bỏ lọc level */
function LevelChips({ selected, counts, onChange }: { selected: LogLevel[]; counts: Partial<Record<LogLevel, number>> | undefined; onChange: (levels: LogLevel[]) => void }) {
  const total = LOG_LEVELS.reduce((s, l) => s + (counts?.[l] ?? 0), 0);
  const toggle = (l: LogLevel) => onChange(selected.includes(l) ? selected.filter((x) => x !== l) : [...selected, l]);
  const chip = (active: boolean) => cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors', active ? 'border-primary/40 bg-primary/10 text-primary' : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground');
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={chip(selected.length === 0)} onClick={() => onChange([])} aria-pressed={selected.length === 0}>
        Tất cả
        <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{total.toLocaleString('vi-VN')}</span>
      </button>
      {LOG_LEVELS.map((l) => {
        const active = selected.includes(l);
        const n = counts?.[l] ?? 0;
        return (
          <button key={l} type="button" className={cn(chip(active), !active && n === 0 && 'opacity-60')} onClick={() => toggle(l)} aria-pressed={active}>
            <span className={cn('size-2 rounded-full', LEVEL_META[l].dot)} />
            {LEVEL_META[l].label}
            <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{n.toLocaleString('vi-VN')}</span>
          </button>
        );
      })}
    </div>
  );
}

function LogsViewer() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canManage = can('logs.manage');
  const { params, set, page, limit } = useListParams(DEFAULT_PARAMS);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const refetchInterval = autoRefresh ? AUTO_REFRESH_MS : false;

  // level chọn nhiều lưu dạng "error,warn" trên URL
  const levels = params.level ? (params.level.split(',').filter((l) => (LOG_LEVELS as string[]).includes(l)) as LogLevel[]) : [];

  const files = useQuery({
    queryKey: ['logs', 'files'],
    queryFn: () => api.get<LogFilesResponse>('/admin/logs/files'),
    refetchInterval,
  });

  // file trống trên URL = file mới nhất (API cũng tự chọn file mới nhất)
  const fileList = files.data?.data;
  const selectedName = params.file || fileList?.[0]?.name;
  const selectedFile = fileList?.find((f) => f.name === selectedName);
  const noFiles = !!fileList && fileList.length === 0;

  // file trên URL không còn (đã bị xoá/dọn theo lịch) -> quay về file mới nhất
  useEffect(() => {
    if (params.file && fileList && !fileList.some((f) => f.name === params.file)) set({ file: '' });
  }, [params.file, fileList, set]);

  const entries = useQuery({
    queryKey: ['logs', 'entries', { file: params.file, level: params.level, source: params.source, search: params.search, page, limit }],
    queryFn: () => api.get<LogEntriesResponse>('/admin/logs/entries', { file: params.file || undefined, level: params.level || undefined, source: params.source || undefined, search: params.search || undefined, page, limit }),
    enabled: !noFiles,
    placeholderData: keepPreviousData,
    refetchInterval,
  });

  // đánh dấu đã xem để reset badge số lỗi mới trên menu
  const markSeen = () =>
    api
      .post('/admin/logs/seen')
      .then(() => qc.invalidateQueries({ queryKey: ['admin-badges'] }))
      .catch(() => undefined);

  // gọi 1 lần khi mở trang (ref chặn gọi lặp ở StrictMode)
  const seenOnce = useRef(false);
  useEffect(() => {
    if (seenOnce.current) return;
    seenOnce.current = true;
    void markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    void markSeen();
    void files.refetch();
    if (!noFiles) void entries.refetch();
  };

  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (!selectedName) return;
    setDownloading(true);
    try {
      await api.download(`/admin/logs/files/${encodeURIComponent(selectedName)}/download`, selectedName);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDownloading(false);
    }
  };

  // sau khi xoá: tải lại danh sách + badge
  const afterDelete = () => {
    void qc.invalidateQueries({ queryKey: ['logs'] });
    void markSeen();
  };

  const removeFile = useMutation({
    mutationFn: (name: string) => api.delete(`/admin/logs/files/${encodeURIComponent(name)}`),
    onSuccess: (_d, name) => {
      toast.success(`Đã xoá file ${name}`);
      if (params.file === name) set({ file: '' });
      afterDelete();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const removeAll = useMutation({
    mutationFn: () => api.delete('/admin/logs/files'),
    onSuccess: () => {
      toast.success('Đã xoá tất cả file log');
      set({ file: '', level: '', source: '', search: '' });
      afterDelete();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const confirmRemoveFile = async () => {
    if (!selectedFile) return;
    const ok = await confirm({
      title: `Xoá file log ngày ${formatLogDate(selectedFile.date)}?`,
      description: `File ${selectedFile.name} sẽ bị xoá vĩnh viễn khỏi máy chủ và không thể khôi phục.`,
      confirmText: 'Xoá file',
      destructive: true,
    });
    if (ok) removeFile.mutate(selectedFile.name);
  };

  const confirmRemoveAll = async () => {
    const ok = await confirm({
      title: 'Xoá tất cả file log?',
      description: `Toàn bộ ${fileList?.length ?? 0} file nhật ký lỗi sẽ bị xoá vĩnh viễn khỏi máy chủ. Nên tải về các file cần giữ trước khi xoá.`,
      confirmText: 'Xoá tất cả',
      destructive: true,
    });
    if (ok) removeAll.mutate();
  };

  const hasFilter = !!(params.level || params.source || params.search);
  const clearFilters = () => set({ level: '', source: '', search: '' });
  const sources = [...new Set([...(entries.data?.sources ?? []), ...(params.source ? [params.source] : [])])];

  return (
    <>
      <SystemLogsHeader
        tab="errors"
        actions={
          <>
            <label className="flex h-7 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-[0.8rem]">
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} aria-label="Tự làm mới" />
              <span>Tự làm mới</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void markSeen().then(() => toast.success('Đã đánh dấu đã xem nhật ký lỗi'))}
            >
              <CheckCheck /> Đánh dấu đã xem
            </Button>
            <Button variant="outline" size="sm" onClick={refresh} disabled={files.isFetching || entries.isFetching}>
              <RefreshCw className={cn((files.isFetching || entries.isFetching) && 'animate-spin')} /> Làm mới
            </Button>
            <Button variant="outline" size="sm" onClick={() => void download()} disabled={!selectedName || downloading}>
              {downloading ? <Loader2 className="animate-spin" /> : <Download />} Tải file
            </Button>
            {canManage && (
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => void confirmRemoveFile()} disabled={!selectedFile || removeFile.isPending}>
                {removeFile.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Xoá file
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Thêm thao tác">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href="/settings?tab=logging">
                    <Settings2 /> Cài đặt nhật ký lỗi
                  </Link>
                </DropdownMenuItem>
                {canManage && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={noFiles || removeAll.isPending} onClick={() => void confirmRemoveAll()}>
                      <Trash2 /> Xoá tất cả file log
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <PageBody>
        {files.isError ? (
          <EmptyState
            icon={SearchX}
            title="Không tải được danh sách file log"
            description={errorMessage(files.error)}
            action={
              <Button variant="outline" size="sm" onClick={() => void files.refetch()}>
                <RefreshCw /> Thử lại
              </Button>
            }
          />
        ) : noFiles ? (
          <EmptyState
            icon={PartyPopper}
            title="Chưa có lỗi nào được ghi lại 🎉"
            description="Hệ thống đang chạy êm. Khi API, website hoặc trang quản trị phát sinh lỗi, chúng sẽ xuất hiện ở đây theo từng ngày."
            action={
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings?tab=logging">
                  <Settings2 /> Cài đặt nhật ký lỗi
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)]">
            {/* cột trái: danh sách file theo ngày */}
            <div className="lg:sticky lg:top-32">
              <LogFileList files={fileList} selected={selectedName} onSelect={(name) => set({ file: name })} loading={files.isLoading} dir={files.data?.dir} totalSize={files.data?.totalSize} />
            </div>

            {/* cột phải: bộ lọc + bảng dòng log của file đang chọn */}
            <div className="min-w-0 space-y-3">
              <ListToolbar
                search={params.search}
                onSearchChange={(v) => set({ search: v })}
                placeholder="Tìm trong nội dung, stack, đường dẫn..."
                filters={
                  <>
                    <Select value={params.source || 'all'} onValueChange={(v) => set({ source: v === 'all' ? '' : v })}>
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder="Nguồn" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Tất cả nguồn</SelectItem>
                        {sources.map((s) => (
                          <SelectItem key={s} value={s}>
                            {sourceLabel(s)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {hasFilter && (
                      <Button variant="ghost" size="sm" onClick={clearFilters}>
                        <X /> Bỏ lọc
                      </Button>
                    )}
                  </>
                }
              />
              <LevelChips selected={levels} counts={entries.data?.counts} onChange={(l) => set({ level: LOG_LEVELS.filter((x) => l.includes(x)).join(',') })} />
              {entries.isError ? (
                <EmptyState icon={SearchX} title="Không tải được nhật ký" description={errorMessage(entries.error)} />
              ) : (
                <LogEntryTable
                  key={selectedName}
                  entries={entries.data?.data}
                  meta={entries.data?.meta}
                  loading={entries.isLoading || files.isLoading}
                  fetching={entries.isFetching}
                  onPageChange={(p) => set({ page: p })}
                  onLimitChange={(l) => set({ limit: l })}
                  onFilterSource={(s) => set({ source: s })}
                  empty={
                    hasFilter ? (
                      <EmptyState
                        icon={SearchX}
                        title="Không có dòng log phù hợp"
                        description="Thử bỏ bớt bộ lọc level, nguồn hoặc từ khoá tìm kiếm."
                        action={
                          <Button variant="outline" size="sm" onClick={clearFilters}>
                            <X /> Bỏ lọc
                          </Button>
                        }
                      />
                    ) : (
                      <EmptyState icon={PartyPopper} title="File này chưa có dòng log nào" description="Không có lỗi nào được ghi trong ngày này." />
                    )
                  }
                />
              )}
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}

export default function LogsPage() {
  const { isDeveloper } = useAuth();
  const router = useRouter();
  // nhật ký lỗi là mục kỹ thuật: chỉ vai trò Nhà phát triển xem, người khác chuyển về trang nhật ký chung
  useEffect(() => {
    if (!isDeveloper) router.replace('/system-logs');
  }, [isDeveloper, router]);
  if (!isDeveloper) return null;
  return (
    <Suspense>
      <LogsViewer />
    </Suspense>
  );
}
