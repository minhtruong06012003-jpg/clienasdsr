'use client';

/**
 * Tab "Báo lỗi": các mã khách báo lỗi trong thời hạn bảo hành (lọc Chờ xử lý / Đã xử lý / Từ chối).
 * Admin đổi mã mới (dialog: lý do, nhập tay nội dung, gửi email) hoặc từ chối kèm phản hồi.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Eye, Loader2, MessageSquareWarning, RefreshCw, XCircle } from 'lucide-react';
import { CODE_REPORT_STATUS_LABELS, type AdminDigitalCode, type CodeReportStatus } from '@cmsnt/shared';
import { EmptyState } from '@/components/common/empty-state';
import { StatusTabs } from '@/components/common/list-toolbar';
import { Button } from '@/components/ui/button';
import { api, type Paginated } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { CodeStatusBadge, DIGITAL_QK, RejectReportDialog, ReplaceCodeDialog, ReportStatusBadge, RevealCodeDialog } from './shared';

export function ReportsTab({ reportStatus, productId, page, onChange, openCount, canManage, canReveal }: { reportStatus: string; productId: string; page: number; onChange: (patch: Partial<Record<string, string | number | undefined>>) => void; openCount?: number; canManage: boolean; canReveal: boolean }) {
  const status = (reportStatus || 'OPEN') as CodeReportStatus;
  const list = useQuery({
    queryKey: [DIGITAL_QK, 'reports', status, productId, page],
    queryFn: () => api.get<Paginated<AdminDigitalCode>>('/admin/digital-codes', { reportStatus: status, productId: productId || undefined, page, limit: 20 }),
  });
  const [replace, setReplace] = useState<AdminDigitalCode | null>(null);
  const [reject, setReject] = useState<AdminDigitalCode | null>(null);
  const [reveal, setReveal] = useState<AdminDigitalCode | null>(null);
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  return (
    <div className="space-y-4">
      <StatusTabs
        value={status}
        onChange={(v) => onChange({ reportStatus: v === 'OPEN' ? '' : v })}
        options={(['OPEN', 'RESOLVED', 'REJECTED'] as CodeReportStatus[]).map((s) => ({ value: s, label: CODE_REPORT_STATUS_LABELS[s], count: s === 'OPEN' ? openCount : undefined, highlight: s === 'OPEN' }))}
      />

      {list.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={MessageSquareWarning} title={status === 'OPEN' ? 'Không có báo lỗi chờ xử lý' : 'Không có báo lỗi nào'} description="Khách báo lỗi mã trong thời hạn bảo hành sẽ hiện ở đây." />
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-start">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.productName}</span>
                  {r.variantLabel && <span className="text-sm text-muted-foreground">· {r.variantLabel}</span>}
                  <CodeStatusBadge status={r.status} />
                  <ReportStatusBadge status={r.reportStatus} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="break-all font-mono text-foreground">{r.preview}</span>
                  {r.orderId && (
                    <Link href={`/orders/${r.orderId}`} className="font-mono font-medium text-primary hover:underline">
                      #{r.orderCode ?? r.orderId.slice(0, 8)}
                    </Link>
                  )}
                  {r.soldAt && <span>Bán {formatDate(r.soldAt, 'dd/MM/yyyy')}</span>}
                  {r.reportedAt && <span title={formatDate(r.reportedAt)}>Báo {timeAgo(r.reportedAt)}</span>}
                  {r.viewedAt ? <span>Khách đã xem mã</span> : <span>Khách chưa xem mã</span>}
                </div>
                <div className="rounded-lg bg-red-50 p-2.5 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-300">
                  <span className="font-medium">Khách báo: </span>
                  <span className="whitespace-pre-line">{r.reportNote || '(không có nội dung)'}</span>
                </div>
                {r.reportReply && (
                  <div className="rounded-lg bg-muted/50 p-2.5 text-sm">
                    <span className="font-medium">Phản hồi: </span>
                    <span className="whitespace-pre-line">{r.reportReply}</span>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 md:flex-col md:items-stretch">
                {canReveal && (
                  <Button size="sm" variant="ghost" onClick={() => setReveal(r)}>
                    <Eye /> Xem mã
                  </Button>
                )}
                {canManage && r.reportStatus === 'OPEN' && (
                  <>
                    <Button size="sm" onClick={() => setReplace(r)} disabled={r.status !== 'SOLD'} title={r.status !== 'SOLD' ? 'Mã không còn ở trạng thái đã giao' : undefined}>
                      <RefreshCw /> Đổi mã mới
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setReject(r)}>
                      <XCircle /> Từ chối
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Button variant="outline" size="icon-sm" disabled={meta.page <= 1} onClick={() => onChange({ page: meta.page - 1 })} aria-label="Trang trước">
            <ChevronLeft />
          </Button>
          <span className="min-w-16 text-center">
            {meta.page} / {meta.totalPages}
          </span>
          <Button variant="outline" size="icon-sm" disabled={meta.page >= meta.totalPages} onClick={() => onChange({ page: meta.page + 1 })} aria-label="Trang sau">
            <ChevronRight />
          </Button>
        </div>
      )}

      <ReplaceCodeDialog code={replace} onClose={() => setReplace(null)} />
      <RejectReportDialog code={reject} onClose={() => setReject(null)} />
      <RevealCodeDialog code={reveal} onClose={() => setReveal(null)} />
    </div>
  );
}
