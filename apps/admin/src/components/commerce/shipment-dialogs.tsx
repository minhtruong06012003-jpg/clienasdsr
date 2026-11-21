'use client';

/**
 * Các hộp thoại hành động trên vận đơn:
 * - CreateShipmentDialog: báo giá các hãng (POST /admin/shipping/rates), sửa kiện hàng, chọn dịch vụ → POST /admin/shipments;
 * - CancelShipmentDialog: huỷ với lý do, tuỳ chọn chỉ đánh dấu trong hệ thống;
 * - ManualShipmentDialog: nhập tay mã vận đơn / trạng thái / link tra cứu / phí.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Loader2, PackageSearch, RefreshCw, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { MoneyInput, NumberInput } from './number-input';
import {
  ACTIVE_SHIPMENT_STATUSES,
  carrierAddressText,
  carrierLabel,
  estimatedDaysText,
  INSPECTION_OPTIONS,
  SHIPMENT_STATUSES,
  ShipmentStatusBadge,
  useCarriers,
  type RateQuote,
  type RatesResponse,
  type ShipmentDetail,
  type ShipmentRow,
  type ShipmentStatus,
} from './shipments';

/** Làm mới mọi cache liên quan vận đơn + đơn hàng */
function useInvalidateShipments() {
  const qc = useQueryClient();
  return (orderId?: string | null, shipmentId?: string) => {
    void qc.invalidateQueries({ queryKey: ['shipments'] });
    void qc.invalidateQueries({ queryKey: ['shipment-stats'] });
    void qc.invalidateQueries({ queryKey: ['admin-badges'] });
    if (shipmentId) void qc.invalidateQueries({ queryKey: ['shipment', shipmentId] });
    if (orderId) void qc.invalidateQueries({ queryKey: ['order', orderId] });
  };
}

/** Dòng checkbox có nhãn */
function CheckRow({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/50">
      <Checkbox checked={checked} onCheckedChange={(c) => onChange(c === true)} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Tạo vận đơn
// ---------------------------------------------------------------------------

interface ParcelForm {
  weight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  codAmount: number | null;
  insuranceValue: number | null;
}

/** Ghép body ghi đè kiện hàng (bỏ giá trị trống) */
function parcelBody(p: ParcelForm) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) if (v != null && Number.isFinite(v)) out[k] = v;
  return out;
}

export function CreateShipmentDialog({ orderId, orderCode, currency = 'VND', onClose, onCreated }: { orderId: string; orderCode: string; currency?: string; onClose: () => void; onCreated?: (sh: ShipmentDetail) => void }) {
  const { can } = useAuth();
  // meta hãng cần quyền cài đặt; không có thì nhóm theo key hãng trong báo giá
  const carriers = useCarriers(can('settings.manage'));
  const metaUnknown = !carriers.data;
  const invalidate = useInvalidateShipments();
  const [parcel, setParcel] = useState<ParcelForm>({ weight: null, length: null, width: null, height: null, codAmount: null, insuranceValue: null });
  const [parcelLoaded, setParcelLoaded] = useState(false);
  const [selected, setSelected] = useState<{ carrier: string; service: string } | null>(null);
  const [note, setNote] = useState('');
  const [inspection, setInspection] = useState<'default' | 'allow' | 'deny' | 'try'>('default');
  const [payer, setPayer] = useState<'shop' | 'customer'>('shop');
  const [pickupMode, setPickupMode] = useState<'pickup' | 'dropoff'>('pickup');
  const [trackingCode, setTrackingCode] = useState('');

  const rates = useMutation({
    mutationFn: (p: ParcelForm) => api.post<RatesResponse>('/admin/shipping/rates', { orderId, ...parcelBody(p) }),
    onSuccess: (r) => {
      // lần đầu: nạp kiện hàng API tính được vào form để người dùng thấy & sửa
      if (!parcelLoaded) {
        setParcel({ weight: r.parcel.weight, length: r.parcel.length, width: r.parcel.width, height: r.parcel.height, codAmount: r.parcel.codAmount, insuranceValue: r.parcel.value });
        setParcelLoaded(true);
      }
      // bỏ chọn nếu dịch vụ đã chọn không còn trong báo giá mới
      setSelected((s) => (s && !r.quotes.some((q) => q.carrier === s.carrier && q.serviceCode === s.service) && s.carrier !== 'manual' ? null : s));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  // báo giá ngay khi mở
  useEffect(() => {
    rates.mutate(parcel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Chưa chọn dịch vụ vận chuyển');
      return api.post<ShipmentDetail>('/admin/shipments', {
        orderId,
        carrier: selected.carrier,
        service: selected.service,
        ...parcelBody(parcel),
        note: note.trim() || undefined,
        allowInspection: inspection === 'default' ? undefined : inspection,
        payer,
        pickupMode,
        trackingCode: selected.carrier === 'manual' && trackingCode.trim() ? trackingCode.trim() : undefined,
      });
    },
    onSuccess: (sh) => {
      toast.success(sh.trackingCode ? `Đã tạo vận đơn ${sh.trackingCode}` : 'Đã tạo vận đơn');
      invalidate(orderId, sh.id);
      onCreated?.(sh);
      onClose();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      // tạo lỗi vẫn sinh bản ghi FAILED -> tải lại đơn
      invalidate(orderId);
    },
  });

  const data = rates.data;
  const list = carriers.data?.carriers ?? [];
  const enabled = list.filter((c) => c.enabled);
  // không đọc được meta -> vẫn cho chọn nhập tay (API sẽ từ chối nếu hãng chưa bật)
  const manualMeta = enabled.find((c) => c.key === 'manual') ?? (metaUnknown ? { key: 'manual', name: 'Nhập tay (hãng khác)' } : undefined);
  // nhóm báo giá theo hãng (giữ thứ tự hãng trong cài đặt)
  const grouped = useMemo(() => {
    const map = new Map<string, RateQuote[]>();
    for (const q of data?.quotes ?? []) map.set(q.carrier, [...(map.get(q.carrier) ?? []), q]);
    return [...map.entries()].sort((a, b) => enabled.findIndex((c) => c.key === a[0]) - enabled.findIndex((c) => c.key === b[0]));
  }, [data, enabled]);
  const errors = Object.entries(data?.errors ?? {});
  // hãng đã bật nhưng không có báo giá & không lỗi (vd hãng manual phí 0, hãng không hỗ trợ rates)
  const silent = enabled.filter((c) => c.key !== 'manual' && !grouped.some(([k]) => k === c.key) && !data?.errors?.[c.key]);
  const active = (data?.existing ?? []).filter((s) => ACTIVE_SHIPMENT_STATUSES.includes(s.status));
  const cheapest = data?.quotes.length ? Math.min(...data.quotes.map((q) => q.fee)) : null;
  const money = (v: number) => formatMoney(v, currency);
  const isManualSelected = selected?.carrier === 'manual';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Tạo vận đơn cho đơn #{orderCode}</DialogTitle>
          <DialogDescription>Hệ thống hỏi phí các hãng đã bật theo địa chỉ khách và kiện hàng. Chọn một dịch vụ rồi bấm “Tạo vận đơn”.</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {active.length > 0 && (
            <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                Đơn đang có vận đơn {active.map((s) => s.trackingCode || s.carrier).join(', ')} chưa kết thúc. Hãy huỷ vận đơn cũ trước khi tạo mới, nếu không API sẽ từ chối.
              </p>
            </div>
          )}

          {/* người nhận */}
          {data?.recipient && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Người nhận</p>
              <p className="mt-0.5 font-medium">
                {data.recipient.name} <span className="font-normal text-muted-foreground">· {data.recipient.phone}</span>
              </p>
              <p className="text-muted-foreground">{carrierAddressText(data.recipient) || '—'}</p>
              {!data.recipient.provinceCode && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Không khớp được tỉnh/thành với danh mục địa chỉ — hãng có thể từ chối hoặc tính phí sai. Kiểm tra lại địa chỉ giao hàng của đơn.</p>}
            </div>
          )}

          {/* kiện hàng */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Kiện hàng</p>
              <Button type="button" variant="outline" size="sm" disabled={rates.isPending} onClick={() => rates.mutate(parcel)}>
                {rates.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Báo giá lại
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Field label="Cân nặng">
                <NumberInput value={parcel.weight} onChange={(weight) => setParcel({ ...parcel, weight })} min={1} integer suffix="g" />
              </Field>
              <Field label="Dài">
                <NumberInput value={parcel.length} onChange={(length) => setParcel({ ...parcel, length })} min={1} integer suffix="cm" />
              </Field>
              <Field label="Rộng">
                <NumberInput value={parcel.width} onChange={(width) => setParcel({ ...parcel, width })} min={1} integer suffix="cm" />
              </Field>
              <Field label="Cao">
                <NumberInput value={parcel.height} onChange={(height) => setParcel({ ...parcel, height })} min={1} integer suffix="cm" />
              </Field>
              <Field label="Thu hộ COD">
                <MoneyInput value={parcel.codAmount} onChange={(codAmount) => setParcel({ ...parcel, codAmount })} placeholder="0" />
              </Field>
              <Field label="Khai giá">
                <MoneyInput value={parcel.insuranceValue} onChange={(insuranceValue) => setParcel({ ...parcel, insuranceValue })} placeholder="0" />
              </Field>
            </div>
            {data?.parcel.items?.length ? <p className="text-xs text-muted-foreground">{data.parcel.items.length} dòng hàng: {data.parcel.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}</p> : null}
          </div>

          {/* bảng dịch vụ */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Dịch vụ vận chuyển</p>
            {rates.isPending && !data ? (
              <div className="flex h-24 items-center justify-center rounded-lg border">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-2">
                {grouped.map(([key, quotes]) => (
                  <div key={key} className="overflow-hidden rounded-lg border">
                    <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold">
                      <Truck className="size-3.5 text-muted-foreground" /> {carrierLabel(key, list)}
                    </div>
                    <div className="divide-y">
                      {quotes.map((q) => {
                        const on = selected?.carrier === q.carrier && selected.service === q.serviceCode;
                        return (
                          <label key={q.serviceCode} className={cn('flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition hover:bg-muted/50', on && 'bg-primary/5')}>
                            <input type="radio" name="ship-service" className="accent-primary" checked={on} onChange={() => setSelected({ carrier: q.carrier, service: q.serviceCode })} />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{q.serviceName}</span>
                                <span className="font-mono text-[10px] text-muted-foreground">{q.serviceCode}</span>
                                {cheapest != null && q.fee === cheapest && grouped.length + quotes.length > 2 && <span className="rounded bg-emerald-100 px-1.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Rẻ nhất</span>}
                              </div>
                              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                                {estimatedDaysText(q.estimatedDays) && (
                                  <span className="inline-flex items-center gap-1">
                                    <Clock className="size-3" /> {estimatedDaysText(q.estimatedDays)}
                                  </span>
                                )}
                                {q.expectedDeliveryAt && <span>Dự kiến {formatDate(q.expectedDeliveryAt, 'dd/MM')}</span>}
                                {q.breakdown && (q.breakdown.insurance || q.breakdown.cod) ? <span>Gồm{q.breakdown.insurance ? ` bảo hiểm ${money(q.breakdown.insurance)}` : ''}{q.breakdown.cod ? ` · phí COD ${money(q.breakdown.cod)}` : ''}</span> : null}
                              </div>
                            </div>
                            <span className="whitespace-nowrap font-semibold tabular-nums">{money(q.fee)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {/* hãng nhập tay: luôn cho chọn nếu đã bật */}
                {manualMeta && (
                  <div className={cn('rounded-lg border', isManualSelected && 'border-primary bg-primary/5')}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                      <input type="radio" name="ship-service" className="accent-primary" checked={isManualSelected} onChange={() => setSelected({ carrier: 'manual', service: 'standard' })} />
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">{manualMeta.name}</span>
                        <span className="block text-xs text-muted-foreground">Tự tạo đơn trên app/web của hãng rồi nhập mã vận đơn vào đây để khách tra cứu.</span>
                      </div>
                    </label>
                    {isManualSelected && (
                      <div className="border-t px-3 py-2">
                        <Field label="Mã vận đơn" help="Có thể để trống và nhập sau ở trang chi tiết vận đơn">
                          <Input value={trackingCode} onChange={(e) => setTrackingCode(e.target.value.trim())} placeholder="VD: GHN123456789" className="font-mono" />
                        </Field>
                      </div>
                    )}
                  </div>
                )}

                {errors.map(([key, msg]) => (
                  <div key={key} className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <p>
                      <span className="font-medium">{carrierLabel(key, list)}:</span> {msg}
                    </p>
                  </div>
                ))}
                {silent.length > 0 && <p className="text-xs text-muted-foreground">Không có dịch vụ từ: {silent.map((c) => c.name).join(', ')} (không phục vụ tuyến này hoặc không hỗ trợ báo giá).</p>}
                {!grouped.length && !manualMeta && !errors.length && data && (
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    <PackageSearch className="size-6" />
                    {enabled.length || metaUnknown ? 'Không hãng nào trả báo giá cho địa chỉ / kiện hàng này.' : 'Chưa bật hãng vận chuyển nào.'}
                    <Link href="/settings?tab=shipping&section=carriers" className="text-primary hover:underline">
                      Mở cài đặt đơn vị vận chuyển
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* tuỳ chọn */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Cho xem hàng">
              <Select value={inspection} onValueChange={(v) => setInspection(v as typeof inspection)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Theo cài đặt chung</SelectItem>
                  {INSPECTION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Người trả phí ship">
              <Select value={payer} onValueChange={(v) => setPayer(v as typeof payer)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shop">Shop trả (đã thu trong đơn)</SelectItem>
                  <SelectItem value="customer">Người nhận trả khi nhận</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Giao hàng cho hãng">
              <Select value={pickupMode} onValueChange={(v) => setPickupMode(v as typeof pickupMode)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pickup">Shipper tới kho lấy</SelectItem>
                  <SelectItem value="dropoff">Shop mang ra bưu cục</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Ghi chú cho shipper">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder="VD: Gọi trước khi giao, hàng dễ vỡ..." />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button disabled={!selected || create.isPending || active.length > 0} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Tạo vận đơn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Huỷ vận đơn
// ---------------------------------------------------------------------------

export function CancelShipmentDialog({ shipment, onClose }: { shipment: ShipmentRow | ShipmentDetail; onClose: () => void }) {
  const invalidate = useInvalidateShipments();
  const isManual = shipment.carrier === 'manual';
  const [reason, setReason] = useState('');
  const [localOnly, setLocalOnly] = useState(isManual);
  const m = useMutation({
    mutationFn: () => api.post(`/admin/shipments/${shipment.id}/cancel`, { reason: reason.trim() || undefined, localOnly: localOnly || undefined }),
    onSuccess: () => {
      toast.success('Đã huỷ vận đơn');
      invalidate(shipment.orderId, shipment.id);
      onClose();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      invalidate(shipment.orderId, shipment.id);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Huỷ vận đơn {shipment.trackingCode ?? ''}</DialogTitle>
          <DialogDescription>Hãng thường chỉ cho huỷ trước khi lấy hàng / đang giao. Sau khi huỷ bạn có thể tạo vận đơn mới cho đơn này.</DialogDescription>
        </DialogHeader>
        <Field label="Lý do huỷ">
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="VD: Khách đổi địa chỉ / huỷ đơn" />
        </Field>
        <CheckRow checked={localOnly} onChange={setLocalOnly} label="Chỉ đánh dấu huỷ trong hệ thống" description={isManual ? 'Hãng nhập tay không có API — nhớ huỷ trên hệ thống hãng.' : 'Không gọi API hãng — dùng khi đã huỷ tay trên app/web của hãng.'} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button variant="destructive" disabled={m.isPending} onClick={() => m.mutate()}>
            {m.isPending && <Loader2 className="animate-spin" />} Huỷ vận đơn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Nhập tay mã vận đơn / trạng thái
// ---------------------------------------------------------------------------

export function ManualShipmentDialog({ shipment, onClose }: { shipment: ShipmentRow | ShipmentDetail; onClose: () => void }) {
  const invalidate = useInvalidateShipments();
  const [form, setForm] = useState({
    trackingCode: shipment.trackingCode ?? '',
    status: shipment.status as ShipmentStatus,
    message: '',
    trackingUrl: shipment.trackingUrl ?? '',
    fee: (Number(shipment.fee ?? 0) || null) as number | null,
  });
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const m = useMutation({
    mutationFn: () =>
      api.put(`/admin/shipments/${shipment.id}/manual`, {
        trackingCode: form.trackingCode.trim() || undefined,
        status: form.status !== shipment.status ? form.status : undefined,
        message: form.message.trim() || undefined,
        trackingUrl: form.trackingUrl.trim() || undefined,
        fee: form.fee != null && form.fee !== Number(shipment.fee ?? 0) ? form.fee : undefined,
      }),
    onSuccess: () => {
      toast.success('Đã cập nhật vận đơn');
      invalidate(shipment.orderId, shipment.id);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nhập tay vận đơn</DialogTitle>
          <DialogDescription>Ghi mã vận đơn / trạng thái lấy từ app hoặc web của hãng. Thay đổi được ghi vào hành trình và (nếu bật) đồng bộ sang trạng thái đơn hàng.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mã vận đơn">
            <Input autoFocus value={form.trackingCode} onChange={(e) => set({ trackingCode: e.target.value.trim() })} placeholder="VD: GHN123456789" className="font-mono" maxLength={60} />
          </Field>
          <Field label="Trạng thái">
            <Select value={form.status} onValueChange={(v) => set({ status: v as ShipmentStatus })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHIPMENT_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    <ShipmentStatusBadge status={s.value} className="text-[10px]" />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Ghi chú hành trình" help="Hiện trong timeline, vd “Shipper đã gọi khách, hẹn giao chiều mai”">
          <Textarea value={form.message} onChange={(e) => set({ message: e.target.value })} rows={2} maxLength={500} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="Link tra cứu">
            <Input type="url" value={form.trackingUrl} onChange={(e) => set({ trackingUrl: e.target.value.trim() })} placeholder="https://..." maxLength={500} />
          </Field>
          <Field label="Phí thực tế">
            <MoneyInput value={form.fee} onChange={(fee) => set({ fee })} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button disabled={m.isPending} onClick={() => m.mutate()}>
            {m.isPending && <Loader2 className="animate-spin" />} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
