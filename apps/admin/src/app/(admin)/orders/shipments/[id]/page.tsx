'use client';

/**
 * Chi tiết vận đơn (`/orders/shipments/[id]`): thông tin vận đơn, người nhận, kho lấy hàng, kiện hàng, phí/COD,
 * timeline hành trình (events), hành động theo trạng thái × khả năng hãng × quyền
 * (đồng bộ, huỷ, in nhãn, nhập tay, mở tra cứu hãng), link đơn hàng và JSON meta để soi lỗi.
 */

import Link from 'next/link';
import { use, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ChevronDown, ClipboardEdit, Copy, ExternalLink, Loader2, MapPin, Package, Printer, RefreshCw, ShoppingCart, Truck, Warehouse, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { StatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { formatAddress, PAYMENT_METHODS, toNum } from '@/components/commerce/utils';
import { CancelShipmentDialog, ManualShipmentDialog } from '@/components/commerce/shipment-dialogs';
import {
  CANCELLABLE_SHIPMENT_STATUSES,
  canTrack,
  carrierAddressText,
  copyText,
  estimatedDaysText,
  FINAL_SHIPMENT_STATUSES,
  hasLabel,
  INSPECTION_OPTIONS,
  openShipmentLabel,
  parcelText,
  PAYER_LABEL,
  SHIPMENT_STATUS_LABEL,
  ShipmentStatusBadge,
  type CarrierAddress,
  type ShipmentDetail,
  type ShipmentEvent,
} from '@/components/commerce/shipments';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

type DialogKind = 'cancel' | 'manual' | null;

const CRUMBS = [
  { label: 'Đơn hàng', href: '/orders' },
  { label: 'Vận đơn', href: '/orders/shipments' },
];

/** Danh sách nhãn – giá trị (bỏ dòng trống) */
function Dl({ rows }: { rows: { label: string; value?: React.ReactNode; mono?: boolean }[] }) {
  const list = rows.filter((r) => r.value !== undefined && r.value !== null && r.value !== '');
  if (!list.length) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {list.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className={cn('min-w-0 break-words', r.mono && 'font-mono')}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Nút sao chép nhỏ */
function CopyBtn({ text }: { text: string }) {
  return (
    <button type="button" className="text-muted-foreground hover:text-foreground" title="Sao chép" onClick={() => copyText(text)}>
      <Copy className="size-3" />
    </button>
  );
}

/** Địa chỉ hãng (kho / người nhận) */
function AddressView({ a, icon: Icon }: { a: CarrierAddress | null; icon: typeof MapPin }) {
  if (!a) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <div className="flex gap-2 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="font-medium">
          {a.name}
          {a.phone && (
            <a href={`tel:${a.phone}`} className="font-normal text-muted-foreground hover:text-primary">
              {' '}
              · {a.phone}
            </a>
          )}
        </div>
        <div className="text-muted-foreground">{carrierAddressText(a) || '—'}</div>
        {a.email && <div className="text-xs text-muted-foreground">{a.email}</div>}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { system: 'Hệ thống', carrier: 'Hãng', webhook: 'Webhook hãng', manual: 'Nhập tay', admin: 'Quản trị viên' };

/** Timeline hành trình (mới nhất trên cùng) */
function EventsTimeline({ events }: { events: ShipmentEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">Chưa có cập nhật hành trình.</p>;
  const sorted = [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return (
    <ol className="relative space-y-4 border-l pl-5">
      {sorted.map((e, i) => {
        const bad = e.status === 'FAILED' || e.status === 'CANCELLED';
        return (
          <li key={`${e.at}-${i}`} className="relative">
            <span className={cn('absolute -left-[27px] top-1 size-4 rounded-full border-2 border-background', bad ? 'bg-red-500' : i === 0 ? 'bg-primary' : 'bg-muted-foreground/40')} />
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <ShipmentStatusBadge status={e.status} className="text-[10px]" />
              {e.statusCode && <span className="font-mono text-[10px] text-muted-foreground">{e.statusCode}</span>}
              <span className="ml-auto text-xs text-muted-foreground" title={formatDate(e.at, 'dd/MM/yyyy HH:mm:ss')}>
                {formatDate(e.at)} · {timeAgo(e.at)}
              </span>
            </div>
            {e.message && <p className={cn('mt-0.5 text-sm', bad && 'text-red-600 dark:text-red-400')}>{e.message}</p>}
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              {e.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3" /> {e.location}
                </span>
              )}
              {e.source && <span>{SOURCE_LABEL[e.source] ?? e.source}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ShipmentPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canWrite = can('shipments.write');
  const query = useQuery({ queryKey: ['shipment', id], queryFn: () => api.get<ShipmentDetail>(`/admin/shipments/${id}`) });
  const sh = query.data;
  const [dialog, setDialog] = useState<DialogKind>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shipment', id] });
    void qc.invalidateQueries({ queryKey: ['shipments'] });
    void qc.invalidateQueries({ queryKey: ['shipment-stats'] });
    if (sh?.orderId) void qc.invalidateQueries({ queryKey: ['order', sh.orderId] });
  };
  const sync = useMutation({
    mutationFn: () => api.post(`/admin/shipments/${id}/sync`),
    onSuccess: () => {
      toast.success('Đã đồng bộ trạng thái từ hãng');
      refresh();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refresh();
    },
  });

  if (query.isLoading) {
    return (
      <>
        <PageHeader title="Vận đơn" breadcrumbs={CRUMBS} />
        <PageBody>
          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <div className="space-y-6">
              <Skeleton className="h-40 rounded-xl" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
            <Skeleton className="h-64 rounded-xl" />
          </div>
        </PageBody>
      </>
    );
  }
  if (!sh) {
    return (
      <>
        <PageHeader title="Vận đơn" breadcrumbs={CRUMBS} />
        <PageBody>
          <EmptyState
            icon={Truck}
            title="Không tìm thấy vận đơn"
            description={query.error ? errorMessage(query.error) : undefined}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/orders/shipments">Về danh sách</Link>
              </Button>
            }
          />
        </PageBody>
      </>
    );
  }

  const caps = sh.capabilities;
  const isManual = sh.carrier === 'manual';
  const isFinal = FINAL_SHIPMENT_STATUSES.includes(sh.status);
  // đồng bộ chỉ cần quyền xem (API shipments.read); huỷ luôn cho phép vì có tuỳ chọn "chỉ đánh dấu trong hệ thống"
  const canSync = canTrack(sh, caps);
  const canCancel = canWrite && CANCELLABLE_SHIPMENT_STATUSES.includes(sh.status);
  const canLabel = hasLabel(sh, caps);
  // nhập tay: hãng manual luôn được; hãng API chỉ khi chưa kết thúc (sửa mã / trạng thái khi webhook lỗi)
  const canManual = canWrite && (isManual || !isFinal);
  const currency = 'VND';
  const events = Array.isArray(sh.events) ? sh.events : [];
  const Spinner = <Loader2 className="animate-spin" />;
  const inspection = (sh.meta as { allowInspection?: string } | null)?.allowInspection;
  // JSON meta để soi lỗi (bỏ order + events đã hiện riêng)
  const metaJson = JSON.stringify({ ...sh, order: undefined, events: undefined, capabilities: undefined }, null, 2);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {sh.trackingCode ? <span className="font-mono">{sh.trackingCode}</span> : 'Vận đơn (chưa có mã)'}
            <ShipmentStatusBadge status={sh.status} />
          </span>
        }
        description={`${sh.carrierName}${sh.serviceName ? ` · ${sh.serviceName}` : ''} · Tạo ${formatDate(sh.createdAt)}${sh.lastSyncAt ? ` · Đồng bộ ${timeAgo(sh.lastSyncAt)}` : ''}`}
        breadcrumbs={[...CRUMBS, { label: sh.trackingCode ?? 'Chi tiết' }]}
        actions={
          <>
            {canSync && (
              <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
                {sync.isPending ? Spinner : <RefreshCw />} Đồng bộ
              </Button>
            )}
            {canLabel && (
              <Button size="sm" variant="outline" onClick={() => void openShipmentLabel(sh.id)}>
                <Printer /> In nhãn
              </Button>
            )}
            {sh.trackingUrl && (
              <Button size="sm" variant="outline" asChild>
                <a href={sh.trackingUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Tra cứu hãng
                </a>
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          {/* Cột trái */}
          <div className="min-w-0 space-y-6">
            {sh.status === 'FAILED' && sh.errorMessage && (
              <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">Hãng từ chối / lỗi khi tạo vận đơn</p>
                  <p className="break-words">{sh.errorMessage}</p>
                  <p className="mt-1 text-xs opacity-80">Kiểm tra địa chỉ, kiện hàng và cấu hình hãng rồi tạo lại vận đơn mới từ đơn hàng; vận đơn lỗi này có thể huỷ để không chặn việc tạo mới.</p>
                </div>
              </div>
            )}
            {sh.status === 'PENDING' && !sh.trackingCode && !isManual && (
              <div className="flex gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300">
                <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                <p>Hãng đã nhận yêu cầu nhưng chưa cấp mã vận đơn. Bấm “Đồng bộ” để cập nhật.</p>
              </div>
            )}
            {isManual && !sh.trackingCode && sh.status === 'PENDING' && (
              <div className="rounded-xl border bg-muted/40 p-4 text-sm">
                Vận đơn nhập tay chưa có mã. Tạo đơn trên app/web của hãng rồi bấm <strong>“Nhập tay”</strong> để ghi mã vận đơn và link tra cứu cho khách.
              </div>
            )}

            <Section title="Thông tin vận đơn">
              <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
                <Dl
                  rows={[
                    {
                      label: 'Mã vận đơn',
                      value: sh.trackingCode ? (
                        <span className="inline-flex items-center gap-1 font-semibold">
                          {sh.trackingCode} <CopyBtn text={sh.trackingCode} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Chưa có</span>
                      ),
                      mono: true,
                    },
                    { label: 'Mã đơn hãng', value: sh.carrierOrderId, mono: true },
                    { label: 'Hãng', value: sh.carrierName },
                    { label: 'Dịch vụ', value: sh.serviceName ? `${sh.serviceName} (${sh.service})` : sh.service },
                    { label: 'Trạng thái', value: `${SHIPMENT_STATUS_LABEL[sh.status] ?? sh.status}${sh.statusCode ? ` · mã hãng ${sh.statusCode}` : ''}` },
                    { label: 'Thông điệp hãng', value: sh.statusMessage },
                  ]}
                />
                <Dl
                  rows={[
                    { label: 'Phí vận chuyển', value: <span className="font-semibold tabular-nums">{formatMoney(toNum(sh.fee), currency)}</span> },
                    { label: 'Thu hộ COD', value: toNum(sh.codAmount) > 0 ? <span className="tabular-nums">{formatMoney(toNum(sh.codAmount), currency)}</span> : 'Không' },
                    { label: 'Khai giá', value: toNum(sh.insuranceValue) > 0 ? <span className="tabular-nums">{formatMoney(toNum(sh.insuranceValue), currency)}</span> : undefined },
                    { label: 'Người trả phí', value: sh.payer ? PAYER_LABEL[sh.payer] ?? sh.payer : undefined },
                    { label: 'Xem hàng', value: inspection ? INSPECTION_OPTIONS.find((o) => o.value === inspection)?.label ?? inspection : undefined },
                    { label: 'Dự kiến giao', value: sh.expectedDeliveryAt ? formatDate(sh.expectedDeliveryAt) : estimatedDaysText(sh.order?.shippingMeta?.estimatedDays) ?? undefined },
                    { label: 'Đã lấy hàng', value: sh.pickedAt ? formatDate(sh.pickedAt) : undefined },
                    { label: 'Đã giao', value: sh.deliveredAt ? <span className="text-emerald-700 dark:text-emerald-400">{formatDate(sh.deliveredAt)}</span> : undefined },
                    { label: 'Đã huỷ', value: sh.cancelledAt ? formatDate(sh.cancelledAt) : undefined },
                    { label: 'Ghi chú shipper', value: sh.note },
                  ]}
                />
              </div>
            </Section>

            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Người nhận">
                <AddressView a={sh.recipient} icon={MapPin} />
                {sh.order?.shippingAddress && formatAddress(sh.order.shippingAddress) !== carrierAddressText(sh.recipient) && (
                  <p className="border-t pt-2 text-xs text-muted-foreground">
                    Địa chỉ gốc trên đơn: <span className="text-foreground">{formatAddress(sh.order.shippingAddress)}</span>
                  </p>
                )}
              </Section>
              <Section title="Kho lấy hàng">
                <AddressView a={sh.pickup} icon={Warehouse} />
              </Section>
            </div>

            <Section title="Kiện hàng">
              <div className="flex items-center gap-3 text-sm">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Package className="size-5 text-muted-foreground" />
                </div>
                <div>
                  <div className="font-medium">{parcelText(sh)}</div>
                  <div className="text-xs text-muted-foreground">Cân nặng và kích thước đã khai với hãng (có thể khác thực tế hãng cân lại).</div>
                </div>
              </div>
            </Section>

            <Section title="Hành trình" description="Cập nhật từ hãng (webhook / đồng bộ) và thao tác của quản trị viên">
              <EventsTimeline events={events} />
            </Section>

            <Collapsible className="rounded-xl border bg-card">
              <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold hover:text-primary [&[data-state=open]>svg]:rotate-180">
                Dữ liệu kỹ thuật (JSON) <ChevronDown className="size-4 transition" />
              </CollapsibleTrigger>
              <CollapsibleContent className="border-t p-4">
                <div className="mb-2 flex items-center justify-end">
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => copyText(metaJson)}>
                    <Copy className="size-3" /> Sao chép
                  </button>
                </div>
                <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">{metaJson}</pre>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Cột phải */}
          <div className="space-y-6">
            {(canSync || canCancel || canLabel || canManual || sh.trackingUrl) && (
              <Section title="Thao tác">
                <div className="grid gap-2">
                  {canSync && (
                    <Button className="w-full" disabled={sync.isPending} onClick={() => sync.mutate()}>
                      {sync.isPending ? Spinner : <RefreshCw />} Đồng bộ trạng thái
                    </Button>
                  )}
                  {canManual && (
                    <Button variant="outline" className="w-full" onClick={() => setDialog('manual')}>
                      <ClipboardEdit /> Nhập tay mã / trạng thái
                    </Button>
                  )}
                  {canLabel && (
                    <Button variant="outline" className="w-full" onClick={() => void openShipmentLabel(sh.id)}>
                      <Printer /> In nhãn / phiếu giao
                    </Button>
                  )}
                  {sh.trackingUrl && (
                    <Button variant="outline" className="w-full" asChild>
                      <a href={sh.trackingUrl} target="_blank" rel="noreferrer">
                        <ExternalLink /> Mở tra cứu của hãng
                      </a>
                    </Button>
                  )}
                  {canCancel && (
                    <Button variant="destructive" className="w-full" onClick={() => setDialog('cancel')}>
                      <Ban /> Huỷ vận đơn
                    </Button>
                  )}
                </div>
                {!caps?.track && !isManual && <p className="text-xs text-muted-foreground">Hãng này không hỗ trợ tra cứu tự động — cập nhật trạng thái bằng “Nhập tay”.</p>}
              </Section>
            )}

            {sh.order && (
              <Section title="Đơn hàng">
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/orders/${sh.order.id}`} className="font-mono font-semibold hover:text-primary">
                      #{sh.order.code}
                    </Link>
                    <span className="font-semibold tabular-nums">{formatMoney(toNum(sh.order.total), currency)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={sh.order.status} />
                    <StatusBadge status={sh.order.paymentStatus} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {sh.order.customerName}
                    {sh.order.customerPhone && ` · ${sh.order.customerPhone}`}
                    <br />
                    Thanh toán: {PAYMENT_METHODS[sh.order.paymentMethod] ?? sh.order.paymentMethod}
                  </div>
                  {sh.order.shippingMeta?.carrier && (
                    <p className="rounded-lg border bg-muted/40 p-2.5 text-xs">
                      Khách chọn: <span className="font-medium">{sh.order.shippingMeta.carrierName ?? sh.order.shippingMeta.carrier}</span>
                      {sh.order.shippingMeta.serviceName && ` · ${sh.order.shippingMeta.serviceName}`}
                      {sh.order.shippingMeta.quotedFee != null && ` · phí báo ${formatMoney(toNum(sh.order.shippingMeta.quotedFee), currency)}`}
                    </p>
                  )}
                  <Button variant="outline" size="sm" asChild className="w-full">
                    <Link href={`/orders/${sh.order.id}`}>
                      <ShoppingCart /> Mở đơn hàng
                    </Link>
                  </Button>
                </div>
              </Section>
            )}

            <Section title="Thông tin khác">
              <Dl
                rows={[
                  { label: 'Mã nội bộ', value: <span className="text-xs">{sh.id}</span>, mono: true },
                  { label: 'Tạo lúc', value: formatDate(sh.createdAt) },
                  { label: 'Đồng bộ lần cuối', value: sh.lastSyncAt ? formatDate(sh.lastSyncAt) : 'Chưa' },
                  { label: 'Nhận webhook', value: caps?.webhook ? 'Có' : 'Không' },
                ]}
              />
            </Section>
          </div>
        </div>
      </PageBody>

      {dialog === 'cancel' && <CancelShipmentDialog shipment={sh} onClose={() => setDialog(null)} />}
      {dialog === 'manual' && <ManualShipmentDialog shipment={sh} onClose={() => setDialog(null)} />}
    </>
  );
}

export default function ShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ShipmentPage id={id} />;
}
