'use client';

import { FileText, FolderOpen } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBytes, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatLogDate, relativeDayLabel, type LogFile } from './log-types';

/**
 * Cột trái trang Nhật ký lỗi: danh sách file log theo ngày (mới nhất trước).
 * Mỗi file hiện ngày, dung lượng, số lỗi (error + fatal, đỏ) và cảnh báo (warn, vàng).
 * Cuối danh sách là tổng dung lượng + thư mục lưu trên máy chủ.
 */
export function LogFileList({ files, selected, onSelect, loading, dir, totalSize }: { files: LogFile[] | undefined; selected: string | undefined; onSelect: (name: string) => void; loading?: boolean; dir?: string; totalSize?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h3 className="text-sm font-semibold">File log theo ngày</h3>
        {files && <span className="text-xs text-muted-foreground">{files.length} file</span>}
      </div>
      {/* trên mobile giới hạn chiều cao để bảng log không bị đẩy quá xa */}
      <div className="max-h-64 overflow-y-auto p-1.5 lg:max-h-[calc(100vh-16rem)]">
        {loading ? (
          <div className="space-y-1.5 p-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          files?.map((f) => {
            const errors = (f.counts.error ?? 0) + (f.counts.fatal ?? 0);
            const warns = f.counts.warn ?? 0;
            const active = f.name === selected;
            const rel = relativeDayLabel(f.date);
            return (
              <button
                key={f.name}
                type="button"
                onClick={() => onSelect(f.name)}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors', active ? 'bg-primary/10 text-primary' : 'hover:bg-muted')}
                aria-current={active ? 'true' : undefined}
              >
                <FileText className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="text-sm font-medium tabular-nums">{formatLogDate(f.date)}</span>
                    {rel && <span className="text-[11px] text-muted-foreground">{rel}</span>}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block truncate text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {f.name} · cập nhật {formatDate(f.mtime, 'dd/MM/yyyy HH:mm:ss')}
                    </TooltipContent>
                  </Tooltip>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {errors > 0 && (
                    <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-red-100 px-1.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300" title={`${errors} lỗi`}>
                      {errors > 999 ? '999+' : errors}
                    </span>
                  )}
                  {warns > 0 && (
                    <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-amber-100 px-1.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" title={`${warns} cảnh báo`}>
                      {warns > 999 ? '999+' : warns}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>
      {(dir || totalSize != null) && (
        <div className="space-y-0.5 border-t bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          {totalSize != null && (
            <p>
              Tổng dung lượng: <span className="font-medium text-foreground">{formatBytes(totalSize)}</span>
            </p>
          )}
          {dir && (
            <p className="flex items-start gap-1">
              <FolderOpen className="mt-px size-3 shrink-0" />
              <code className="break-all font-mono">{dir}</code>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
