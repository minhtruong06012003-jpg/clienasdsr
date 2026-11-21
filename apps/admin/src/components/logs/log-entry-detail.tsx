'use client';

import type { ReactNode } from 'react';
import { Copy, Filter } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import { sourceLabel, type LogEntry, type LogRequest } from './log-types';

/** Nhãn tiếng Việt cho các trường request */
const REQUEST_LABEL: Record<keyof LogRequest, string> = {
  method: 'Phương thức',
  url: 'Đường dẫn',
  status: 'Mã trạng thái',
  ip: 'Địa chỉ IP',
  userId: 'Mã người dùng',
  userEmail: 'Email người dùng',
  userAgent: 'Trình duyệt',
  referer: 'Trang giới thiệu',
};

/** Nhãn tiếng Việt cho khoá meta hay gặp; khoá lạ hiện nguyên */
const META_LABEL: Record<string, string> = {
  digest: 'Mã digest (Next.js)',
  componentStack: 'Component stack',
  url: 'Trang',
  page: 'Trang',
  pathname: 'Đường dẫn',
  jobId: 'Mã tác vụ',
  jobName: 'Tên tác vụ',
  job: 'Tác vụ',
  attempts: 'Số lần thử',
  cron: 'Tác vụ định kỳ',
  durationMs: 'Thời gian (ms)',
  ms: 'Thời gian (ms)',
  code: 'Mã lỗi',
  name: 'Tên lỗi',
  pid: 'PID',
  userAgent: 'Trình duyệt',
};

/** Sao chép toàn bộ dòng log dạng JSON vào clipboard */
async function copyEntry(entry: LogEntry) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
    toast.success('Đã sao chép dòng log');
  } catch {
    toast.error('Không thể sao chép (trình duyệt chặn quyền clipboard)');
  }
}

/** Hiển thị giá trị meta: object/chuỗi nhiều dòng thì dùng khối pre */
function MetaValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Có' : 'Không'}</span>;
  if (typeof value === 'object' || (typeof value === 'string' && value.includes('\n'))) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return <pre className="max-h-60 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">{text}</pre>;
  }
  return <span className="break-all font-mono">{String(value)}</span>;
}

/** Khối tiêu đề nhỏ cho từng phần trong chi tiết */
function Block({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
        {actions}
      </div>
      {children}
    </div>
  );
}

/**
 * Chi tiết một dòng log khi mở rộng: message đầy đủ, stack trace, thông tin request, meta,
 * nút sao chép JSON và lọc nhanh theo nguồn.
 */
export function LogEntryDetail({ entry, onFilterSource }: { entry: LogEntry; onFilterSource?: (source: string) => void }) {
  const requestRows = entry.request ? (Object.keys(REQUEST_LABEL) as (keyof LogRequest)[]).filter((k) => entry.request?.[k] !== undefined && entry.request?.[k] !== null && entry.request?.[k] !== '') : [];
  const metaRows = Object.entries(entry.meta ?? {});

  return (
    <div className="space-y-4 rounded-lg border bg-background p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatDate(entry.time, 'dd/MM/yyyy HH:mm:ss')}</span>
          <span>
            Nguồn: <span className="font-medium text-foreground">{sourceLabel(entry.source)}</span>
            {entry.context && <span className="font-mono"> · {entry.context}</span>}
          </span>
          <span className="font-mono">#{entry.id}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {onFilterSource && (
            <Button variant="ghost" size="sm" onClick={() => onFilterSource(entry.source)}>
              <Filter /> Lọc nguồn này
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void copyEntry(entry)}>
            <Copy /> Sao chép
          </Button>
        </div>
      </div>

      <Block title="Nội dung">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{entry.message}</pre>
      </Block>

      {entry.stack && (
        <Block title="Stack trace">
          {/* cuộn ngang để giữ nguyên dòng stack, giới hạn chiều cao */}
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed">{entry.stack}</pre>
        </Block>
      )}

      {requestRows.length > 0 && (
        <Block title="Request">
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            {requestRows.map((k) => (
              <div key={k} className="contents">
                <dt className="font-medium text-muted-foreground">{REQUEST_LABEL[k]}</dt>
                <dd className="break-all font-mono">{String(entry.request?.[k])}</dd>
              </div>
            ))}
          </dl>
        </Block>
      )}

      {metaRows.length > 0 && (
        <Block title="Thông tin thêm">
          <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
            {metaRows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-medium text-muted-foreground">{META_LABEL[k] ?? k}</dt>
                <dd className="min-w-0">
                  <MetaValue value={v} />
                </dd>
              </div>
            ))}
          </dl>
        </Block>
      )}
    </div>
  );
}
