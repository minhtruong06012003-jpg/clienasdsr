'use client';

/**
 * Section "Vận chuyển / Vận đơn" trong trang chi tiết đơn hàng:
 * hãng & dịch vụ khách chọn lúc đặt (shippingMeta), danh sách vận đơn đã tạo (mã, hãng, trạng thái, dự kiến giao,
 * nút chi tiết / nhãn / đồng bộ) và nút "Tạo vận đơn" mở dialog báo giá các hãng.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Clock, ExternalLink, Eye, Loader2, Plus, Printer, RefreshCw, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { CreateShipmentDialog } from './shipment-dialogs';
import { ACTIVE_SHIPMENT_STATUSES, canTrack, carrierServiceText, estimatedDaysText, hasLabel, openShipmentLabel, ShipmentStatusBadge, useCarriers, type OrderShipment, type OrderShippingMeta } from './shipments';
import { toNum } from './utils';

export function OrderShipmentsSection({
  order,
  shipments,
  shippingMeta,
  onChanged,
}: {
  order: { id: string; code: string; status: string; currency: string; shippingMethodName?: string | null };
  shipments: OrderShipment[] | undefined;
  shippingMeta: OrderShippingMeta | null | undefined;
  /** gọi sau khi tạo / đồng bộ để trang cha tải lại đơn */
  onChanged?: () => void;
}) {
  const { can } = useAuth();
  const canRead = can('shipments.read');
  const canWrite = can('shipments.write');
  // meta hãng cần quyền cài đặt; không có thì dùng carrierName / suy đoán khả năng tra cứu
  const carriers = useCarriers(canRead && can('settings.manage'));
  const [creating, setCreating] = useState(false);
  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/admin/shipments/${id}/sync`),
    onSuccess: () => {
      toast.success('Đã đồng bộ trạng thái từ hãng');
      onChanged?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!canRead) return null;

  const list = shipments ?? [];
  const hasActive = list.some((s) => ACTIVE_SHIPMENT_STATUSES.includes(s.status));
  const closed = ['CANCELLED', 'REFUNDED'].includes(order.status);
  const capsOf = (key: string) => carriers.data?.carriers.find((c) => c.key === key)?.capabilities ?? null;

  return (
    <Section
      title="Vận chuyển"
      actions={
        canWrite &&
        !hasActive &&
        !closed && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus /> Tạo vận đơn
          </Button>
        )
      }
    >
      {/* hãng / dịch vụ khách chọn ở trang thanh toán */}
      {shippingMeta?.carrier ? (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs dark:border-sky-900 dark:bg-sky-950/30">
          <p className="mb-1 flex items-center gap-1 font-medium text-sky-800 dark:text-sky-300">
            <Truck className="size-3.5" /> Khách chọn: {carrierServiceText({ carrier: shippingMeta.carrier, carrierName: shippingMeta.carrierName, service: shippingMeta.service, serviceName: shippingMeta.serviceName }, carriers.data?.carriers)}
          </p>
          <div className="flex flex-wrap gap-x-3 text-foreground">
            {shippingMeta.quotedFee != null && <span>Phí báo: {formatMoney(toNum(shippingMeta.quotedFee), order.currency)}</span>}
            {estimatedDaysText(shippingMeta.estimatedDays) && <span>{estimatedDaysText(shippingMeta.estimatedDays)}</span>}
            {shippingMeta.expectedDeliveryAt && <span>Dự kiến {formatDate(shippingMeta.expectedDeliveryAt, 'dd/MM/yyyy')}</span>}
          </div>
        </div>
      ) : order.shippingMethodName ? (
        <p className="text-xs text-muted-foreground">
          Phương thức khách chọn: <span className="text-foreground">{order.shippingMethodName}</span>
        </p>
      ) : null}

      {list.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Truck className="size-4" /> Chưa tạo vận đơn cho đơn này.
        </p>
      ) : (
        <ul className="divide-y text-sm">
          {list.map((s) => {
            const caps = capsOf(s.carrier);
            const canSync = canTrack(s, caps);
            return (
              <li key={s.id} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/orders/shipments/${s.id}`} className={s.trackingCode ? 'font-mono font-semibold hover:text-primary' : 'text-muted-foreground hover:text-primary'}>
                      {s.trackingCode ?? 'Chưa có mã vận đơn'}
                    </Link>
                    <ShipmentStatusBadge status={s.status} className="text-[10px]" />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>{carrierServiceText(s, carriers.data?.carriers)}</span>
                    {toNum(s.fee) > 0 && <span>· phí {formatMoney(toNum(s.fee), order.currency)}</span>}
                    {toNum(s.codAmount) > 0 && <span>· COD {formatMoney(toNum(s.codAmount), order.currency)}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {s.deliveredAt ? (
                      <span className="text-emerald-700 dark:text-emerald-400">Đã giao {formatDate(s.deliveredAt)}</span>
                    ) : s.expectedDeliveryAt ? (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" /> Dự kiến {formatDate(s.expectedDeliveryAt, 'dd/MM/yyyy')}
                      </span>
                    ) : null}
                    {s.lastSyncAt && <span title={formatDate(s.lastSyncAt)}>· đồng bộ {timeAgo(s.lastSyncAt)}</span>}
                  </div>
                  {s.statusMessage && s.status !== 'FAILED' && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{s.statusMessage}</p>}
                  {s.status === 'FAILED' && s.errorMessage && <p className="mt-0.5 line-clamp-2 text-xs text-red-600 dark:text-red-400">{s.errorMessage}</p>}
                </div>
                <div className="flex items-center">
                  <Button variant="ghost" size="icon-xs" asChild title="Chi tiết vận đơn">
                    <Link href={`/orders/shipments/${s.id}`}>
                      <Eye />
                    </Link>
                  </Button>
                  {s.trackingUrl && (
                    <Button variant="ghost" size="icon-xs" asChild title="Tra cứu trên web hãng">
                      <a href={s.trackingUrl} target="_blank" rel="noreferrer">
                        <ExternalLink />
                      </a>
                    </Button>
                  )}
                  {hasLabel(s, caps) && (
                    <Button variant="ghost" size="icon-xs" title="In nhãn" onClick={() => void openShipmentLabel(s.id)}>
                      <Printer />
                    </Button>
                  )}
                  {canSync && (
                    <Button variant="ghost" size="icon-xs" title="Đồng bộ trạng thái" disabled={sync.isPending} onClick={() => sync.mutate(s.id)}>
                      {sync.isPending && sync.variables === s.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <CreateShipmentDialog orderId={order.id} orderCode={order.code} currency={order.currency} onClose={() => setCreating(false)} onCreated={() => onChanged?.()} />}
    </Section>
  );
}
