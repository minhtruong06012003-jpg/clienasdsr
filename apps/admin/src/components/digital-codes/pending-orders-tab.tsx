'use client';

/**
 * Tab "Đơn chờ mã": đơn đã thanh toán nhưng còn thiếu mã (codeStatus pending / partial).
 * GET admin/orders lọc sẵn theo codeStatus=pending,partial + đã thanh toán (100 đơn mới nhất);
 * phía trình duyệt chỉ bỏ thêm đơn đã huỷ / hoàn tiền. Tổng số chính xác lấy từ summary.pendingOrders.
 */

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, PackageCheck, PackageX } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminOrderCodes } from '@cmsnt/shared';
import { EmptyState } from '@/components/common/empty-state';
import { StatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatMoney, timeAgo } from '@/lib/format';
import { DIGITAL_QK, invalidateDigital, OrderCodeStatusBadge } from './shared';

interface PendingOrderRow {
  id: string;
  code: string;
  status: string;
  paymentStatus: string;
  codeStatus?: string | null;
  customerName: string;
  customerEmail: string | null;
  total: unknown;
  currency: string;
  createdAt: string;
}

export function PendingOrdersTab({ pendingCount, canManage }: { pendingCount?: number; canManage: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: [DIGITAL_QK, 'pending-orders'],
    queryFn: () => api.get<Paginated<PendingOrderRow>>('/admin/orders', { paymentStatus: 'PAID', codeStatus: 'pending,partial', limit: 100, sort: 'createdAt', order: 'desc' }),
  });
  // bỏ đơn đã huỷ / hoàn tiền (không còn cần giao mã)
  // hiển thị đơn cũ nhất trước (được ưu tiên giao bù trước)
  const rows = (list.data?.data ?? []).filter((o) => (o.codeStatus === 'pending' || o.codeStatus === 'partial') && !['CANCELLED', 'REFUNDED'].includes(o.status)).reverse();

  /** Giao mã ngay cho một đơn (cấp từ kho hiện có) */
  const deliver = useMutation({
    mutationFn: (orderId: string) => api.post<AdminOrderCodes>(`/admin/digital-codes/by-order/${orderId}/deliver`, {}),
    onSuccess: (r) => {
      toast.success(r.codeStatus === 'delivered' ? `Đã giao đủ mã cho đơn #${r.orderCode}` : `Đơn #${r.orderCode} vẫn còn thiếu mã — hãy nhập thêm mã vào kho`);
      invalidateDigital(qc, r.orderId);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 text-sm">
        <PackageX className="size-5 shrink-0 text-orange-600 dark:text-orange-400" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{(pendingCount ?? 0).toLocaleString('vi-VN')} đơn đã thanh toán đang chờ mã</p>
          <p className="text-xs text-muted-foreground">Nhập thêm mã cho sản phẩm thiếu — nếu bật “Tự giao bù” trong Cài đặt, các đơn cũ nhất sẽ được giao trước ngay khi nhập.</p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/orders?paymentStatus=PAID">
            <ExternalLink /> Danh sách đơn
          </Link>
        </Button>
      </div>

      {list.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={PackageCheck} title="Không có đơn nào chờ mã" description={pendingCount ? 'Các đơn chờ mã nằm ngoài 100 đơn đã thanh toán gần nhất — mở danh sách đơn để xem.' : 'Mọi đơn đã thanh toán đều đã được giao đủ mã.'} />
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {rows.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/orders/${o.id}`} className="font-mono font-semibold hover:text-primary">
                    #{o.code}
                  </Link>
                  <StatusBadge status={o.status} className="text-[10px]" />
                  <OrderCodeStatusBadge status={o.codeStatus} className="text-[10px]" />
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {o.customerName}
                  {o.customerEmail ? ` · ${o.customerEmail}` : ''} · {timeAgo(o.createdAt)}
                </div>
              </div>
              <span className="whitespace-nowrap font-semibold tabular-nums">{formatMoney(Number(o.total ?? 0), o.currency)}</span>
              <div className="flex gap-2">
                {canManage && (
                  <Button size="sm" onClick={() => deliver.mutate(o.id)} disabled={deliver.isPending}>
                    {deliver.isPending && deliver.variables === o.id ? <Loader2 className="animate-spin" /> : <PackageCheck />} Giao mã ngay
                  </Button>
                )}
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/orders/${o.id}`}>Mở đơn</Link>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
