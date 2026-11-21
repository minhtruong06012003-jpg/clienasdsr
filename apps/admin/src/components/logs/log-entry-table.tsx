'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { LogEntryDetail } from './log-entry-detail';
import { LogLevelBadge } from './log-level-badge';
import { sourceLabel, type LogEntry } from './log-types';

/** Màu mã trạng thái HTTP: 5xx đỏ, 4xx vàng, còn lại xám */
function statusClass(status: number) {
  if (status >= 500) return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
  if (status >= 400) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
}

/** Viền trái theo level để quét mắt nhanh các dòng nghiêm trọng */
const ROW_ACCENT: Record<string, string> = {
  fatal: 'border-l-purple-600',
  error: 'border-l-red-500',
  warn: 'border-l-amber-500',
  info: 'border-l-blue-500',
  debug: 'border-l-slate-300 dark:border-l-slate-700',
};

/**
 * Bảng dòng log: nhấn một dòng để mở rộng chi tiết (stack trace, request, meta).
 * Tự vẽ bảng thay vì DataTable vì cần dòng chi tiết trải hết chiều ngang.
 */
export function LogEntryTable({
  entries,
  meta,
  loading,
  fetching,
  onPageChange,
  onLimitChange,
  onFilterSource,
  empty,
}: {
  entries: LogEntry[] | undefined;
  meta?: { page: number; limit: number; total: number; totalPages: number };
  loading?: boolean;
  fetching?: boolean;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  onFilterSource?: (source: string) => void;
  empty: ReactNode;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows = entries ?? [];

  // bật/tắt mở rộng một dòng
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-3">
      <div className={cn('overflow-hidden rounded-xl border bg-card transition-opacity', fetching && !loading && 'opacity-70')}>
        <div className="overflow-x-auto">
          <Table className="min-w-[720px] table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-8" />
                <TableHead className="w-32 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Thời gian</TableHead>
                <TableHead className="w-24 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Level</TableHead>
                <TableHead className="w-40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Nguồn</TableHead>
                <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Nội dung</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-40 text-center">
                    <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="whitespace-normal p-6">
                    {empty}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => {
                  const open = expanded.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <TableRow className={cn('cursor-pointer border-l-2 align-top', ROW_ACCENT[r.level], open && 'bg-muted/40')} onClick={() => toggle(r.id)} aria-expanded={open}>
                        <TableCell className="pr-0 text-muted-foreground">{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="whitespace-nowrap text-xs">{timeAgo(r.time)}</span>
                            </TooltipTrigger>
                            <TooltipContent>{formatDate(r.time, 'dd/MM/yyyy HH:mm:ss')}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <LogLevelBadge level={r.level} />
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <span className="block truncate text-xs font-medium">{sourceLabel(r.source)}</span>
                          {r.context && <span className="block truncate font-mono text-[11px] text-muted-foreground">{r.context}</span>}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <p className="line-clamp-2 break-words text-sm">{r.message}</p>
                          {r.request && (r.request.method || r.request.url) && (
                            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span className="truncate font-mono">
                                {r.request.method && <span className="font-semibold">{r.request.method} </span>}
                                {r.request.url}
                              </span>
                              {r.request.status != null && <span className={cn('shrink-0 rounded px-1 font-mono font-semibold', statusClass(r.request.status))}>{r.request.status}</span>}
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow className="border-l-2 border-l-transparent bg-muted/20 hover:bg-muted/20">
                          <TableCell colSpan={5} className="whitespace-normal p-2 md:p-3">
                            <LogEntryDetail entry={r} onFilterSource={onFilterSource} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {meta && meta.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <div>
            Hiển thị {(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} / {meta.total.toLocaleString('vi-VN')} dòng
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(meta.limit)} onValueChange={(v) => onLimitChange(Number(v))}>
              <SelectTrigger size="sm" className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100, 200].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} / trang
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon-sm" disabled={meta.page <= 1} onClick={() => onPageChange(meta.page - 1)} aria-label="Trang trước">
              <ChevronLeft />
            </Button>
            <span className="min-w-16 text-center">
              {meta.page} / {Math.max(1, meta.totalPages)}
            </span>
            <Button variant="outline" size="icon-sm" disabled={meta.page >= meta.totalPages} onClick={() => onPageChange(meta.page + 1)} aria-label="Trang sau">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
