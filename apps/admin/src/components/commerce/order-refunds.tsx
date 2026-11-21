'use client';

import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Section } from '@/components/common/field';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AdminOrder, RefundRow } from './order-dialogs';
import { toNum } from './utils';

const REFUND_STATUS: Record<RefundRow['status'], { label: string; className: string }> = {
  COMPLETED: { label: 'Đã hoàn', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  PENDING: { label: 'Cổng đang xử lý', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  FAILED: { label: 'Thất bại', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
};

/** Khối "Hoàn tiền" ở trang chi tiết đơn: liệt kê các lần hoàn + tổng đã hoàn / còn lại */
export function RefundsSection({ order, actions }: { order: AdminOrder; actions?: React.ReactNode }) {
  const money = (v: unknown) => formatMoney(toNum(v), order.currency);
  const refunded = toNum(order.refundedTotal);
  if (!order.refunds.length && !actions) return null;
  return (
    <Section title="Hoàn tiền" description={refunded > 0 ? `Đã hoàn ${money(refunded)} / ${money(order.total)} · còn lại ${money(order.remainingRefundable)}` : 'Chưa có lần hoàn tiền nào'} actions={actions}>
      {order.refunds.length === 0 ? (
        <p className="text-sm text-muted-foreground">Chưa hoàn tiền cho đơn này.</p>
      ) : (
        <div className="-mx-4 -my-4 divide-y">
          {order.refunds.map((r) => {
            const st = REFUND_STATUS[r.status] ?? REFUND_STATUS.COMPLETED;
            return (
              <div key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <RotateCcw className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold tabular-nums">-{money(r.amount)}</span>
                    <Badge className={cn('border-transparent font-medium', st.className)}>{st.label}</Badge>
                    <Badge variant="outline" className="font-normal">
                      {r.method === 'gateway' ? 'Qua cổng' : r.method === 'wallet' ? 'Vào ví' : 'Thủ công'}
                    </Badge>
                    {r.restock && (
                      <Badge variant="outline" className="font-normal">
                        Đã hoàn kho
                      </Badge>
                    )}
                  </div>
                  {r.reason && <p className="text-sm">{r.reason}</p>}
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{formatDate(r.createdAt)}</span>
                    {r.createdBy && <span>bởi {r.createdBy.name}</span>}
                    {r.providerRef && (
                      <span>
                        Mã cổng: <span className="font-mono text-foreground">{r.providerRef}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
