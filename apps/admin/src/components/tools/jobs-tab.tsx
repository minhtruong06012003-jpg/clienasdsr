'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { Section } from '@/components/common/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useBulkAction } from '@/hooks/use-bulk-action';

type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';

interface JobRow {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CronEntry {
  name: string;
  expression: string;
  owner?: string;
  lastRun?: string;
  lastError?: string;
  runs: number;
  nextRun: string | null;
}

interface Stats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  handlers: string[];
  cron: CronEntry[];
}

const JOB_STATUS: Record<JobStatus, { label: string; className: string }> = {
  PENDING: { label: 'Chờ chạy', className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' },
  RUNNING: { label: 'Đang chạy', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' },
  DONE: { label: 'Hoàn tất', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' },
  FAILED: { label: 'Thất bại', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' },
};

/** Tab Tác vụ nền: hàng đợi job + danh sách cron (API /admin/jobs) */
export function JobsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  // id các job đang tích chọn cho thao tác hàng loạt (giữ qua các trang)
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();

  const stats = useQuery({ queryKey: ['jobs-stats'], queryFn: () => api.get<Stats>('/admin/jobs/stats'), refetchInterval: 10_000 });
  const jobs = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['jobs', status, type, page, limit],
    queryFn: () => api.get<Paginated<JobRow>>('/admin/jobs', { status, type, page, limit }),
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/admin/jobs/${id}/retry`),
    onSuccess: () => {
      toast.success('Đã đưa job vào hàng đợi');
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['jobs-stats'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /**
   * Chạy lại hàng loạt: API retry không kiểm tra trạng thái, nên bảng chỉ cho tích chọn job đang FAILED
   * (isRowSelectable, giống nút đơn lẻ chỉ hiện ở dòng Thất bại) để tránh chạy trùng job đang chờ / đang chạy / đã xong.
   */
  const bulkRetry = () => {
    void bulk.run({
      ids: selected,
      action: (id) => api.post(`/admin/jobs/${id}/retry`),
      doneLabel: 'Đã đưa vào hàng đợi',
      onDone: () => {
        setSelected([]);
        void qc.invalidateQueries({ queryKey: ['jobs'] });
        void qc.invalidateQueries({ queryKey: ['jobs-stats'] });
      },
    });
  };

  const s = stats.data;
  const types = [...new Set([...(s?.handlers ?? []), ...(jobs.data?.data.map((j) => j.type) ?? [])])].sort();

  const columns: Column<JobRow>[] = [
    { key: 'type', header: 'Loại', cell: (r) => <code className="text-xs">{r.type}</code> },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => <Badge className={cn('border-transparent font-medium', JOB_STATUS[r.status].className)}>{JOB_STATUS[r.status].label}</Badge>,
    },
    { key: 'attempts', header: 'Lần thử', className: 'w-20 text-center', cell: (r) => <span className="text-sm tabular-nums">{r.attempts}/{r.maxAttempts}</span> },
    {
      key: 'runAt',
      header: 'Chạy lúc',
      cell: (r) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="whitespace-nowrap text-sm">{timeAgo(r.runAt)}</span>
          </TooltipTrigger>
          <TooltipContent>Tạo {formatDate(r.createdAt, 'dd/MM HH:mm:ss')} · cập nhật {formatDate(r.updatedAt, 'dd/MM HH:mm:ss')}</TooltipContent>
        </Tooltip>
      ),
    },
    { key: 'lastError', header: 'Lỗi', cell: (r) => (r.lastError ? <span className="line-clamp-2 max-w-md text-xs text-red-600 dark:text-red-400">{r.lastError}</span> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'actions',
      header: '',
      className: 'w-24 text-right',
      cell: (r) =>
        r.status === 'FAILED' ? (
          <Button size="sm" variant="outline" onClick={() => retry.mutate(r.id)} disabled={retry.isPending}>
            <RotateCcw /> Chạy lại
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-4">
        {(['pending', 'running', 'done', 'failed'] as const).map((k) => {
          const m = JOB_STATUS[k.toUpperCase() as JobStatus];
          return (
            <button key={k} type="button" onClick={() => setStatus(status === k.toUpperCase() ? '' : k.toUpperCase())} className={cn('rounded-xl border bg-card p-4 text-left transition hover:bg-muted/50', status === k.toUpperCase() && 'ring-2 ring-primary')}>
              <p className="text-xs text-muted-foreground">{m.label}</p>
              <p className="text-2xl font-semibold tabular-nums">{s ? s[k] : '—'}</p>
            </button>
          );
        })}
      </div>

      <Section
        title="Hàng đợi job"
        description="Job lưu trong database, chạy nền trong tiến trình API; thất bại sẽ tự thử lại theo backoff"
        actions={
          <Button size="sm" variant="ghost" onClick={() => void Promise.all([jobs.refetch(), stats.refetch()])} disabled={jobs.isFetching}>
            {jobs.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />} Làm mới
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusTabs
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: '', label: 'Tất cả' },
              { value: 'PENDING', label: 'Chờ chạy' },
              { value: 'RUNNING', label: 'Đang chạy' },
              { value: 'DONE', label: 'Hoàn tất' },
              { value: 'FAILED', label: 'Thất bại', count: s?.failed, highlight: true },
            ]}
          />
          <Select
            value={type || 'all'}
            onValueChange={(v) => {
              setType(v === 'all' ? '' : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Loại job" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả loại</SelectItem>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* thanh thao tác hàng loạt — chỉ hiện khi đã tích chọn */}
        <ListToolbar
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            <Button size="sm" variant="outline" disabled={bulk.pending} onClick={bulkRetry}>
              {bulk.pending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Chạy lại job thất bại
            </Button>
          }
        />
        <DataTable
          columns={columns}
          data={jobs.data?.data}
          meta={jobs.data?.meta}
          loading={jobs.isLoading} error={jobs.error} onRetry={() => void jobs.refetch()}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          isRowSelectable={(r) => r.status === 'FAILED'}
          onPageChange={setPage}
          onLimitChange={setLimit}
          emptyTitle="Không có job nào"
          emptyDescription="Job được tạo khi gửi email, sao lưu..."
        />
      </Section>

      <Section title="Tác vụ định kỳ (cron)" description="Đăng ký lúc chạy bởi các module của hệ thống">
        {!s?.cron.length ? (
          <p className="text-sm text-muted-foreground">Chưa có cron nào đăng ký qua CronService (các cron cố định của lõi như xuất bản hẹn giờ, dọn job không hiển thị ở đây).</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên</TableHead>
                <TableHead>Biểu thức</TableHead>
                <TableHead className="text-right">Số lần</TableHead>
                <TableHead>Chạy cuối</TableHead>
                <TableHead>Lần kế</TableHead>
                <TableHead>Lỗi cuối</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.cron.map((c) => (
                <TableRow key={c.name}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="size-3.5 text-muted-foreground" /> {c.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{c.expression}</code>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.runs}</TableCell>
                  <TableCell className="text-sm">{c.lastRun ? timeAgo(c.lastRun) : '—'}</TableCell>
                  <TableCell className="text-sm">{c.nextRun ? formatDate(c.nextRun, 'dd/MM HH:mm') : '—'}</TableCell>
                  <TableCell className="text-xs text-red-600 dark:text-red-400">{c.lastError ?? <span className="text-muted-foreground">—</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {s && (
          <p className="text-xs text-muted-foreground">
            Handler job đã đăng ký: {s.handlers.length ? s.handlers.map((h) => <code key={h} className="mr-1 rounded bg-muted px-1">{h}</code>) : 'không có'}
          </p>
        )}
      </Section>
    </div>
  );
}
