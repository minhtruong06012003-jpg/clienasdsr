'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Field } from '@/components/common/field';
import { invalidateDigital } from '@/components/digital-codes/shared';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { MoneyInput, NumberInput } from './number-input';
import { calcTotals, lineKey, linesToPayload, OrderLineEditor, type CommerceCalc, type OrderLine } from './order-line-editor';
import { toNum, type Address } from './utils';

export const SOURCE_LABELS: Record<string, string> = { web: 'Website', admin: 'Admin', pos: 'POS' };

export const EMAIL_TEMPLATES: { key: string; label: string }[] = [
  { key: 'order.placed', label: 'Xác nhận đặt hàng' },
  { key: 'order.confirmed', label: 'Đơn đã được xác nhận' },
  { key: 'order.paid', label: 'Đã nhận thanh toán' },
  { key: 'order.shipping', label: 'Đơn đang giao' },
  { key: 'order.completed', label: 'Đơn hoàn thành' },
  { key: 'order.cancelled', label: 'Đơn đã huỷ' },
  { key: 'order.refunded', label: 'Đã hoàn tiền' },
  { key: 'order.invoice', label: 'Hoá đơn' },
];

/** Đơn ở trạng thái này không được sửa dòng hàng / tiền (API cũng chặn) */
export const LOCKED_STATUSES = ['COMPLETED', 'CANCELLED', 'REFUNDED'];

export interface AdminOrderItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  name: string;
  sku: string | null;
  optionValues: Record<string, string> | null;
  image: string | null;
  price: unknown;
  quantity: number;
  total: unknown;
}

export interface RefundRow {
  id: string;
  amount: unknown;
  reason: string | null;
  method: 'manual' | 'gateway' | 'wallet';
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  providerRef: string | null;
  restock: boolean;
  createdAt: string;
  createdBy?: { id: string; name: string } | null;
}

/** Đơn hàng chi tiết từ GET /admin/orders/:id (bản mở rộng) */
export interface AdminOrder {
  id: string;
  code: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  currency: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string;
  shippingAddress: Address | null;
  billingAddress: Address | null;
  shippingMethod: string | null;
  shippingMethodId: string | null;
  shippingMethodName: string | null;
  subtotal: unknown;
  discountTotal: unknown;
  shippingTotal: unknown;
  taxTotal: unknown;
  total: unknown;
  refundedTotal: unknown;
  remainingRefundable: number;
  canRefundViaGateway: boolean;
  /** Đơn thuộc thành viên -> có thể hoàn vào ví */
  canRefundViaWallet?: boolean;
  source: string;
  createdBy: { id: string; name: string; email: string } | null;
  items: AdminOrderItem[];
  refunds: RefundRow[];
}

interface Bootstrap {
  settings: { commerce?: CommerceCalc };
}

function useCommerce() {
  const boot = useQuery({ queryKey: ['public-bootstrap'], queryFn: () => api.get<Bootstrap>('/public/bootstrap'), staleTime: 10 * 60_000 });
  return boot.data?.settings.commerce ?? {};
}

function useOrderMutation<TVars, TRes = unknown>(orderId: string, fn: (vars: TVars) => Promise<TRes>, success: string, onDone: () => void) {
  const qc = useQueryClient();
  return useMutation<TRes, Error, TVars>({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['order-refunds', orderId] });
      // sửa dòng hàng / hoàn tiền có thể giữ thêm hoặc trả mã về kho (event chạy bất đồng bộ)
      // -> làm mới dữ liệu kho mã ngay và thêm một lần sau ~1,5 giây
      invalidateDigital(qc, orderId);
      setTimeout(() => invalidateDigital(qc, orderId), 1500);
      toast.success(success);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Mở hoá đơn HTML (API cần token nên tải bằng fetch rồi ghi vào tab mới) */
export async function openInvoice(orderId: string, print = false) {
  // mở tab ngay trong sự kiện click để không bị chặn popup
  const w = window.open('', '_blank');
  try {
    const res = await api.raw(`/admin/orders/${orderId}/invoice`, { print: print ? '1' : undefined });
    if (!res.ok) throw new Error('Không tải được hoá đơn');
    const html = await res.text();
    if (!w) throw new Error('Trình duyệt chặn mở tab mới');
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (e) {
    w?.close();
    toast.error(errorMessage(e));
  }
}

export function PrintInvoiceButton({ orderId, size = 'sm' }: { orderId: string; size?: 'sm' | 'default' }) {
  return (
    <Button variant="outline" size={size} onClick={() => void openInvoice(orderId, true)}>
      <Printer /> In hoá đơn
    </Button>
  );
}

// ---------------- sửa dòng hàng ----------------

export function EditItemsDialog({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  const commerce = useCommerce();
  const [lines, setLines] = useState<OrderLine[]>(() =>
    order.items.map((it) => ({ key: lineKey(), id: it.id, productId: it.productId, variantId: it.variantId, name: it.name, sku: it.sku, optionValues: it.optionValues ?? {}, image: it.image, price: toNum(it.price), quantity: it.quantity })),
  );
  const [note, setNote] = useState('');
  const totals = useMemo(() => calcTotals(lines, toNum(order.discountTotal), toNum(order.shippingTotal), commerce), [lines, order, commerce]);
  const money = (v: number) => formatMoney(v, order.currency);
  const save = useOrderMutation(order.id, (body: unknown) => api.put(`/admin/orders/${order.id}/items`, body), 'Đã cập nhật dòng hàng', onClose);

  const submit = () => {
    try {
      if (!lines.length) throw new Error('Đơn hàng phải có ít nhất một dòng');
      save.mutate({ items: linesToPayload(lines), note: note.trim() || undefined });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Sửa dòng hàng — #{order.code}</DialogTitle>
          <DialogDescription>Thêm / xoá sản phẩm, đổi số lượng hoặc đơn giá. Kho sẽ được điều chỉnh theo chênh lệch; giảm giá và phí vận chuyển giữ nguyên.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <OrderLineEditor value={lines} onChange={setLines} currency={order.currency} />
          <dl className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Tạm tính</dt>
            <dd className="text-right tabular-nums">{money(totals.subtotal)}</dd>
            {totals.discountTotal > 0 && (
              <>
                <dt className="text-muted-foreground">Giảm giá</dt>
                <dd className="text-right tabular-nums">-{money(totals.discountTotal)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Phí vận chuyển</dt>
            <dd className="text-right tabular-nums">{money(totals.shippingTotal)}</dd>
            {totals.taxTotal > 0 && (
              <>
                <dt className="text-muted-foreground">Thuế</dt>
                <dd className="text-right tabular-nums">{money(totals.taxTotal)}</dd>
              </>
            )}
            <dt className="border-t pt-1 font-semibold">Tổng mới</dt>
            <dd className="border-t pt-1 text-right font-bold tabular-nums">{money(totals.total)}</dd>
          </dl>
          <Field label="Ghi chú thay đổi" help="Lưu vào lịch sử đơn hàng">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vd: Khách đổi size" />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="button" onClick={submit} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu dòng hàng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- sửa thông tin khách / thanh toán ----------------

const BILLING_FIELDS: { key: keyof Address; label: string; full?: boolean }[] = [
  { key: 'fullName', label: 'Họ tên' },
  { key: 'phone', label: 'Điện thoại' },
  { key: 'line1', label: 'Địa chỉ', full: true },
  { key: 'ward', label: 'Phường / Xã' },
  { key: 'district', label: 'Quận / Huyện' },
  { key: 'city', label: 'Tỉnh / Thành phố' },
  { key: 'country', label: 'Quốc gia' },
];

export function EditDetailsDialog({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  const locked = LOCKED_STATUSES.includes(order.status);
  const commerce = useCommerce();
  const [name, setName] = useState(order.customerName);
  const [email, setEmail] = useState(order.customerEmail ?? '');
  const [phone, setPhone] = useState(order.customerPhone);
  const [billing, setBilling] = useState<Address>({ ...(order.billingAddress ?? {}) });
  const [useBilling, setUseBilling] = useState(!!order.billingAddress && Object.values(order.billingAddress).some(Boolean));
  const [discount, setDiscount] = useState<number | null>(toNum(order.discountTotal));
  const [shipping, setShipping] = useState<number | null>(toNum(order.shippingTotal));
  const [shippingName, setShippingName] = useState(order.shippingMethod ?? '');
  const totals = useMemo(() => calcTotals(order.items.map((i) => ({ price: toNum(i.price), quantity: i.quantity })), discount ?? 0, shipping ?? 0, commerce), [order.items, discount, shipping, commerce]);
  const save = useOrderMutation(order.id, (body: unknown) => api.patch(`/admin/orders/${order.id}/details`, body), 'Đã cập nhật thông tin đơn', onClose);

  const submit = () => {
    if (!name.trim() || !phone.trim()) return toast.error('Vui lòng nhập tên và số điện thoại khách');
    const body: Record<string, unknown> = { customerName: name.trim(), customerEmail: email.trim() || null, customerPhone: phone.trim(), billingAddress: useBilling ? billing : null, shippingMethod: shippingName.trim() || null };
    if (!locked) {
      body.discountTotal = discount ?? 0;
      body.shippingTotal = shipping ?? 0;
    }
    save.mutate(body);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sửa thông tin đơn — #{order.code}</DialogTitle>
          <DialogDescription>Thông tin khách, địa chỉ thanh toán{locked ? '' : ', giảm giá và phí vận chuyển thủ công'}.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Tên khách hàng" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Điện thoại" required>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={useBilling} onCheckedChange={(v) => setUseBilling(v === true)} />
              Địa chỉ thanh toán khác địa chỉ giao hàng
            </label>
            {useBilling && (
              <div className="grid grid-cols-2 gap-3">
                {BILLING_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} className={f.full ? 'col-span-2' : undefined}>
                    <Input value={billing[f.key] ?? ''} onChange={(e) => setBilling({ ...billing, [f.key]: e.target.value })} />
                  </Field>
                ))}
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Phương thức vận chuyển" help="Tên hiển thị trên đơn / hoá đơn">
              <Input value={shippingName} onChange={(e) => setShippingName(e.target.value)} placeholder="Vd: Giao hàng nhanh" />
            </Field>
            <Field label="Giảm giá thủ công" help={locked ? 'Đơn đã khoá, không sửa được' : undefined}>
              <MoneyInput value={discount} onChange={setDiscount} disabled={locked} suffix={order.currency === 'VND' ? '₫' : order.currency} />
            </Field>
            <Field label="Phí vận chuyển">
              <MoneyInput value={shipping} onChange={setShipping} disabled={locked} suffix={order.currency === 'VND' ? '₫' : order.currency} />
            </Field>
          </div>
          {!locked && (
            <p className="text-right text-sm">
              Tổng mới: <b className="tabular-nums">{formatMoney(totals.total, order.currency)}</b>
              {totals.taxTotal > 0 && <span className="text-muted-foreground"> (thuế {formatMoney(totals.taxTotal, order.currency)})</span>}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="button" onClick={submit} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu thay đổi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- hoàn tiền ----------------

type RefundMethod = 'manual' | 'gateway' | 'wallet';

export function RefundDialog({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  const remaining = order.remainingRefundable ?? toNum(order.total) - toNum(order.refundedTotal);
  const [amount, setAmount] = useState<number | null>(remaining);
  const [reason, setReason] = useState('');
  // ưu tiên: đơn trả bằng ví -> hoàn ví; có cổng -> qua cổng; còn lại thủ công
  const [method, setMethod] = useState<RefundMethod>(order.paymentMethod === 'wallet' && order.canRefundViaWallet ? 'wallet' : order.canRefundViaGateway ? 'gateway' : 'manual');
  const [restock, setRestock] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [sendEmail, setSendEmail] = useState(!!order.customerEmail);
  const money = (v: unknown) => formatMoney(toNum(v), order.currency);
  const save = useOrderMutation(order.id, (body: unknown) => api.post(`/admin/orders/${order.id}/refunds`, body), 'Đã ghi nhận hoàn tiền', onClose);

  /** Điền số tiền = tổng các dòng đang chọn hoàn kho */
  const fillFromItems = () => {
    const sum = order.items.reduce((s, it) => s + toNum(it.price) * (qty[it.id] ?? 0), 0);
    setAmount(Math.min(sum, remaining));
  };
  const submit = () => {
    if (!amount || amount <= 0) return toast.error('Nhập số tiền hoàn');
    if (amount > remaining + 0.001) return toast.error(`Tối đa ${money(remaining)}`);
    const items = Object.entries(qty)
      .filter(([, n]) => n > 0)
      .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    if (restock && !items.length) return toast.error('Chọn số lượng hoàn kho cho ít nhất một dòng');
    save.mutate({ amount, reason: reason.trim() || undefined, method, restock, items: restock ? items : undefined, sendEmail });
  };
  const full = amount != null && Math.abs(amount - remaining) < 0.01;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Hoàn tiền — #{order.code}</DialogTitle>
          <DialogDescription>
            Tổng đơn {money(order.total)} · đã hoàn {money(order.refundedTotal)} · còn có thể hoàn <b>{money(remaining)}</b>
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Số tiền hoàn" required action={<button type="button" className="text-xs text-primary hover:underline" onClick={() => setAmount(remaining)}>Hoàn toàn bộ</button>}>
              <MoneyInput value={amount} onChange={setAmount} suffix={order.currency === 'VND' ? '₫' : order.currency} />
            </Field>
            <Field label="Phương thức">
              <RadioGroup value={method} onValueChange={(v) => setMethod(v as RefundMethod)} className="gap-2 pt-1">
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="manual" /> Thủ công (chuyển khoản / tiền mặt)
                </label>
                <label className={`flex items-center gap-2 text-sm ${order.canRefundViaWallet ? '' : 'text-muted-foreground'}`}>
                  <RadioGroupItem value="wallet" disabled={!order.canRefundViaWallet} /> Cộng vào ví thành viên
                  {!order.canRefundViaWallet && <span className="text-xs">(khách vãng lai không có ví)</span>}
                </label>
                <label className={`flex items-center gap-2 text-sm ${order.canRefundViaGateway ? '' : 'text-muted-foreground'}`}>
                  <RadioGroupItem value="gateway" disabled={!order.canRefundViaGateway} /> Qua cổng thanh toán
                  {!order.canRefundViaGateway && <span className="text-xs">(cổng không hỗ trợ)</span>}
                </label>
              </RadioGroup>
            </Field>
          </div>
          <Field label="Lý do">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Vd: Khách trả lại 1 sản phẩm lỗi" />
          </Field>
          <div className="space-y-2 rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={restock} onCheckedChange={(v) => setRestock(v === true)} />
              Hoàn kho sản phẩm trả lại
            </label>
            {restock && (
              <div className="space-y-2">
                <div className="divide-y rounded-md border">
                  {order.items.map((it) => (
                    <div key={it.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-1 font-medium">{it.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {Object.values(it.optionValues ?? {}).join(' / ')}
                          {it.sku && ` · ${it.sku}`} · {money(it.price)} × {it.quantity}
                          {!it.productId && ' · dòng tuỳ ý (không có kho)'}
                        </div>
                      </div>
                      <NumberInput className="w-24" value={qty[it.id] ?? null} integer min={0} placeholder="0" disabled={!it.productId} onChange={(v) => setQty({ ...qty, [it.id]: Math.min(it.quantity, Math.max(0, v ?? 0)) })} />
                    </div>
                  ))}
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={fillFromItems}>
                  Điền số tiền theo dòng đã chọn
                </Button>
              </div>
            )}
          </div>
          <label className={`flex items-center gap-2 text-sm ${order.customerEmail ? '' : 'text-muted-foreground'}`}>
            <Checkbox checked={sendEmail} disabled={!order.customerEmail} onCheckedChange={(v) => setSendEmail(v === true)} />
            Gửi email thông báo hoàn tiền cho khách{!order.customerEmail && ' (đơn không có email)'}
          </label>
          {full && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">Hoàn toàn bộ: đơn sẽ chuyển sang trạng thái “Hoàn tiền” và không thể mở lại.</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Hoàn {amount ? money(amount) : 'tiền'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- gửi lại email ----------------

export function ResendEmailDialog({ order, onClose }: { order: AdminOrder; onClose: () => void }) {
  const [key, setKey] = useState(order.paymentStatus === 'PAID' ? 'order.paid' : 'order.placed');
  const [message, setMessage] = useState('');
  const send = useOrderMutation(order.id, (body: unknown) => api.post<{ success: boolean; skipped: boolean; reason?: string }>(`/admin/orders/${order.id}/resend-email`, body), 'Đã gửi email cho khách', onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Gửi lại email — #{order.code}</DialogTitle>
          <DialogDescription>Gửi tới {order.customerEmail ?? '(đơn không có email khách)'}</DialogDescription>
        </DialogHeader>
        <Field label="Mẫu email">
          <Select value={key} onValueChange={setKey}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMAIL_TEMPLATES.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {key === 'order.invoice' && (
          <Field label="Lời nhắn thêm" help="Hiển thị trong email (tuỳ chọn)">
            <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Vd: Hoá đơn VAT sẽ gửi sau khi giao hàng." />
          </Field>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            type="button"
            disabled={!order.customerEmail || send.isPending}
            onClick={() =>
              send.mutate(
                { key, message: key === 'order.invoice' && message.trim() ? message.trim() : undefined },
                {
                  onSuccess: (r) => {
                    if (r.skipped) toast.warning(`Email chưa được gửi: ${r.reason ?? 'SMTP chưa cấu hình'} (đã ghi vào lịch sử đơn)`);
                  },
                },
              )
            }
          >
            {send.isPending && <Loader2 className="animate-spin" />}
            Gửi email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
