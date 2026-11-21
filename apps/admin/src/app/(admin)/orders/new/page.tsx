'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/commerce/number-input';
import { CustomerPicker, type CustomerForm } from '@/components/commerce/order-customer-picker';
import { calcTotals, defaultShipping, linesToPayload, OrderLineEditor, type CommerceCalc, type OrderLine } from '@/components/commerce/order-line-editor';
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, type Address } from '@/components/commerce/utils';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useUnsavedGuard } from '@/hooks/use-unsaved';

interface Bootstrap {
  settings: { commerce?: CommerceCalc & { currency?: string; paymentMethods?: { key: string; enabled: boolean; label: Record<string, string> }[] } };
}
interface PaymentMethod {
  key: string;
  type: 'offline' | 'online';
  label: string;
}

const ADDRESS_FIELDS: { key: keyof Address; label: string; full?: boolean; required?: boolean }[] = [
  { key: 'fullName', label: 'Người nhận', required: true },
  { key: 'phone', label: 'Điện thoại', required: true },
  { key: 'line1', label: 'Địa chỉ', full: true, required: true },
  { key: 'line2', label: 'Địa chỉ bổ sung', full: true },
  { key: 'ward', label: 'Phường / Xã' },
  { key: 'district', label: 'Quận / Huyện' },
  { key: 'city', label: 'Tỉnh / Thành phố' },
  { key: 'country', label: 'Quốc gia' },
];
/** Trạng thái được phép khi tạo đơn thủ công */
const CREATABLE = ORDER_STATUSES.filter((s) => !['CANCELLED', 'REFUNDED'].includes(s.value));
const EMPTY_ADDRESS: Address = { fullName: '', phone: '', line1: '', line2: '', ward: '', district: '', city: '', country: 'VN' };

/** Tạo đơn thủ công (giống "Add order" của WooCommerce) */
interface ShippingZoneLite {
  id: string;
  name: string;
  methods: { id: string; name: Record<string, string>; type: string; cost: number | string; isActive: boolean }[];
}

export default function NewOrderPage() {
  const router = useRouter();
  const { can } = useAuth();
  const boot = useQuery({ queryKey: ['public-bootstrap'], queryFn: () => api.get<Bootstrap>('/public/bootstrap'), staleTime: 10 * 60_000 });
  const methods = useQuery({ queryKey: ['payment-methods'], queryFn: () => api.get<PaymentMethod[]>('/public/payment-methods'), staleTime: 5 * 60_000 });
  const commerce = useMemo(() => boot.data?.settings.commerce ?? {}, [boot.data]);
  const currency = commerce.currency ?? 'VND';

  const [customer, setCustomer] = useState<CustomerForm>({ userId: null, name: '', email: '', phone: '' });
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [sameAsCustomer, setSameAsCustomer] = useState(true);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [discount, setDiscount] = useState<number | null>(null);
  const [shipping, setShipping] = useState<number | null>(null);
  const [shippingName, setShippingName] = useState('');
  const [shippingMethodId, setShippingMethodId] = useState('');
  const zones = useQuery({ queryKey: ['shipping-zones'], queryFn: () => api.get<ShippingZoneLite[]>('/admin/shipping/zones'), staleTime: 5 * 60_000 });
  const shippingOptions = (zones.data ?? []).flatMap((z) => z.methods.filter((m) => m.isActive).map((m) => ({ id: m.id, zone: z.name, name: m.name?.vi ?? m.name?.en ?? Object.values(m.name ?? {})[0] ?? '', type: m.type, cost: Number(m.cost) })));
  const [paymentMethod, setPaymentMethod] = useState('cod');
  const [paymentStatus, setPaymentStatus] = useState('UNPAID');
  const [status, setStatus] = useState('PENDING');
  const [note, setNote] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [sendEmail, setSendEmail] = useState(true);

  const subtotal = useMemo(() => lines.reduce((s, l) => s + l.price * l.quantity, 0), [lines]);
  const autoShipping = defaultShipping(subtotal, commerce);
  const totals = useMemo(() => calcTotals(lines, discount ?? 0, shipping ?? autoShipping, commerce), [lines, discount, shipping, autoShipping, commerce]);
  const money = (v: number) => formatMoney(v, currency);

  // danh sách phương thức: offline trong Cài đặt (kể cả đang tắt) + cổng online đang hoạt động
  const paymentOptions = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of commerce.paymentMethods ?? []) out.set(m.key, m.label?.vi ?? Object.values(m.label ?? {})[0] ?? PAYMENT_METHODS[m.key] ?? m.key);
    for (const m of methods.data ?? []) if (!out.has(m.key)) out.set(m.key, m.type === 'online' ? `${m.label} (online)` : m.label);
    if (!out.size) for (const [k, v] of Object.entries(PAYMENT_METHODS)) out.set(k, v);
    return [...out.entries()];
  }, [commerce.paymentMethods, methods.data]);

  const create = useMutation({
    mutationFn: (body: unknown) => api.post<{ id: string; code: string; emailSent?: boolean }>('/admin/orders', body),
    onSuccess: (o, body) => {
      toast.success(`Đã tạo đơn #${o.code}${(body as { sendEmail?: boolean }).sendEmail ? (o.emailSent ? ' và gửi email cho khách' : ' (email chưa gửi: SMTP chưa cấu hình hoặc thiếu email)') : ''}`);
      router.replace(`/orders/${o.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = () => {
    try {
      if (!customer.name.trim() || !customer.phone.trim()) throw new Error('Vui lòng nhập tên và số điện thoại khách hàng');
      if (!lines.length) throw new Error('Đơn hàng phải có ít nhất một sản phẩm');
      const ship: Address = sameAsCustomer ? { ...address, fullName: customer.name.trim(), phone: customer.phone.trim() } : address;
      if (!ship.fullName?.trim() || !ship.phone?.trim() || !ship.line1?.trim()) throw new Error('Vui lòng nhập người nhận, điện thoại và địa chỉ giao hàng');
      if (sendEmail && !customer.email.trim()) throw new Error('Cần email khách để gửi xác nhận, hoặc bỏ chọn "Gửi email"');
      create.mutate({
        userId: customer.userId ?? undefined,
        customerName: customer.name.trim(),
        customerEmail: customer.email.trim() || undefined,
        customerPhone: customer.phone.trim(),
        shippingAddress: ship,
        items: linesToPayload(lines),
        discountTotal: discount ?? 0,
        shippingTotal: shipping ?? undefined,
        shippingMethod: shippingName.trim() || undefined,
        shippingMethodId: shippingMethodId || undefined,
        paymentMethod,
        paymentStatus,
        status,
        note: note.trim() || undefined,
        adminNote: adminNote.trim() || undefined,
        sendEmail,
      });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const dirty = (lines.length > 0 || !!customer.name || !!customer.phone) && !create.isSuccess;
  useUnsavedGuard(dirty, submit);

  if (!can('orders.write')) {
    return (
      <>
        <PageHeader title="Tạo đơn hàng" breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }]} />
        <PageBody>
          <p className="text-sm text-muted-foreground">Bạn không có quyền tạo đơn hàng.</p>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Tạo đơn hàng"
        description="Tạo đơn thủ công cho khách đặt qua điện thoại, Zalo, tại quầy..."
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Tạo đơn' }]}
        actions={
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Save />}
            Tạo đơn
          </Button>
        }
      />
      <PageBody>
        <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <div className="min-w-0 space-y-6">
            <Section title="Khách hàng" description="Chọn thành viên có sẵn hoặc nhập thông tin khách lẻ">
              <CustomerPicker
                value={customer}
                onChange={setCustomer}
                onPickAddress={(a) => {
                  setAddress(a);
                  setSameAsCustomer(false);
                  toast.success('Đã điền địa chỉ giao hàng');
                }}
              />
            </Section>

            <Section
              title="Địa chỉ giao hàng"
              actions={
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={sameAsCustomer} onCheckedChange={(v) => setSameAsCustomer(v === true)} />
                  Người nhận là khách hàng
                </label>
              }
            >
              <div className="grid grid-cols-2 gap-3">
                {ADDRESS_FIELDS.filter((f) => !(sameAsCustomer && (f.key === 'fullName' || f.key === 'phone'))).map((f) => (
                  <Field key={f.key} label={f.label} required={f.required} className={f.full ? 'col-span-2' : undefined}>
                    <Input value={address[f.key] ?? ''} onChange={(e) => setAddress({ ...address, [f.key]: e.target.value })} />
                  </Field>
                ))}
              </div>
            </Section>

            <Section title={`Sản phẩm${lines.length ? ` (${lines.length})` : ''}`} description="Giá lấy theo giá đang bán, có thể ghi đè từng dòng. Kho sẽ được trừ khi tạo đơn.">
              <OrderLineEditor value={lines} onChange={setLines} currency={currency} />
            </Section>

            <div className="grid gap-6 md:grid-cols-2">
              <Section title="Ghi chú của khách">
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Hiển thị cho khách trên hoá đơn / email" />
              </Section>
              <Section title="Ghi chú nội bộ" description="Chỉ quản trị viên nhìn thấy">
                <Textarea rows={3} value={adminNote} onChange={(e) => setAdminNote(e.target.value)} placeholder="Vd: Khách đặt qua Zalo, giao sau 17h" />
              </Section>
            </div>
          </div>

          <div className="space-y-6">
            <Section title="Tổng tiền">
              <Field label="Giảm giá thủ công">
                <MoneyInput value={discount} onChange={setDiscount} placeholder="0" suffix={currency === 'VND' ? '₫' : currency} />
              </Field>
              <Field label="Phí vận chuyển" help={shipping == null ? `Để trống = theo cài đặt (${money(autoShipping)})` : undefined}>
                <MoneyInput value={shipping} onChange={setShipping} placeholder={String(autoShipping)} suffix={currency === 'VND' ? '₫' : currency} />
              </Field>
              <Field label="Phương thức vận chuyển" help={shippingOptions.length ? 'Chọn từ vùng vận chuyển đã cấu hình hoặc nhập tên tự do' : undefined}>
                {shippingOptions.length > 0 && (
                  <Select
                    value={shippingMethodId || 'manual'}
                    onValueChange={(v) => {
                      if (v === 'manual') {
                        setShippingMethodId('');
                        return;
                      }
                      const opt = shippingOptions.find((o) => o.id === v);
                      setShippingMethodId(v);
                      if (opt) {
                        setShippingName(opt.name);
                        if (opt.type === 'FLAT' || opt.type === 'PICKUP' || opt.type === 'FREE') setShipping(opt.type === 'FLAT' ? opt.cost : 0);
                      }
                    }}
                  >
                    <SelectTrigger className="mb-2 w-full">
                      <SelectValue placeholder="Chọn phương thức" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Nhập tay</SelectItem>
                      {shippingOptions.map((o) => (
                        <SelectItem key={o.id} value={o.id}>
                          {o.name} · {o.zone} {o.type === 'FLAT' ? `(${money(o.cost)})` : o.type === 'FREE' || o.type === 'PICKUP' ? '(miễn phí)' : '(theo bảng giá)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Input value={shippingName} onChange={(e) => setShippingName(e.target.value)} placeholder="Vd: Giao hàng nhanh" />
              </Field>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-t pt-3 text-sm">
                <dt className="text-muted-foreground">Tạm tính</dt>
                <dd className="text-right tabular-nums">{money(totals.subtotal)}</dd>
                {totals.discountTotal > 0 && (
                  <>
                    <dt className="text-muted-foreground">Giảm giá</dt>
                    <dd className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">-{money(totals.discountTotal)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">Phí vận chuyển</dt>
                <dd className="text-right tabular-nums">{totals.shippingTotal > 0 ? money(totals.shippingTotal) : 'Miễn phí'}</dd>
                {totals.taxTotal > 0 && (
                  <>
                    <dt className="text-muted-foreground">Thuế{commerce.pricesIncludeTax ? ' (đã gồm)' : ''}</dt>
                    <dd className="text-right tabular-nums">{money(totals.taxTotal)}</dd>
                  </>
                )}
                <dt className="border-t pt-2 font-semibold">Tổng cộng</dt>
                <dd className="border-t pt-2 text-right text-lg font-bold tabular-nums">{money(totals.total)}</dd>
              </dl>
            </Section>

            <Section title="Thanh toán & trạng thái">
              <Field label="Phương thức thanh toán">
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentOptions.map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Trạng thái thanh toán">
                <Select value={paymentStatus} onValueChange={setPaymentStatus}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_STATUSES.filter((s) => ['UNPAID', 'PAID'].includes(s.value)).map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Trạng thái đơn">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CREATABLE.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={sendEmail} onCheckedChange={(v) => setSendEmail(v === true)} />
                Gửi email xác nhận cho khách
              </label>
              <Button className="w-full" onClick={submit} disabled={create.isPending}>
                {create.isPending ? <Loader2 className="animate-spin" /> : <Save />}
                Tạo đơn {totals.total > 0 && `· ${money(totals.total)}`}
              </Button>
            </Section>
          </div>
        </div>
      </PageBody>
    </>
  );
}
