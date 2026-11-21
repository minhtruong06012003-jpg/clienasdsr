'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, ChevronDown, CreditCard, Plus, ReceiptText, Trash2 } from 'lucide-react';
import { slugify } from '@cmsnt/shared';
import { Field, Section } from '@/components/common/field';
import { I18nInput } from '@/components/common/i18n-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { i18n } from '@/lib/format';
import type { I18nText } from '@/lib/types';
import { useLanguages } from '@/hooks/use-languages';
import { cn } from '@/lib/utils';
import { EmailListInput, SwitchRow } from './inputs';
import { SettingsGroup, type Values } from './settings-group';

interface PaymentMethod {
  key: string;
  enabled: boolean;
  label: I18nText;
  description: I18nText;
}

const CURRENCIES = [
  { code: 'VND', symbol: '₫' },
  { code: 'USD', symbol: '$' },
  { code: 'EUR', symbol: '€' },
  { code: 'JPY', symbol: '¥' },
  { code: 'KRW', symbol: '₩' },
  { code: 'THB', symbol: '฿' },
  { code: 'CNY', symbol: '¥' },
];

/** Định dạng giá theo cấu hình hiện tại để xem trước */
function formatPreview(v: Values, n: number) {
  const decimals = Number(v.decimals) || 0;
  const [int, dec] = n.toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, v.thousandSeparator ?? '.');
  const num = dec ? `${grouped}${v.decimalSeparator ?? ','}${dec}` : grouped;
  return v.currencyPosition === 'before' ? `${v.currencySymbol}${num}` : `${num}${v.currencySymbol}`;
}

/** Ô số; `min`: cho gõ tự do, khi rời ô mới kéo lên giá trị tối thiểu (không nhảy số giữa lúc đang gõ) */
function NumberInput({ value, onChange, suffix, className, min = 0 }: { value: unknown; onChange: (n: number) => void; suffix?: string; className?: string; min?: number }) {
  return (
    <div className={cn('flex items-stretch overflow-hidden rounded-lg border focus-within:ring-3 focus-within:ring-ring/50', className)}>
      <Input
        type="number"
        min={min}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        onBlur={(e) => {
          if ((Number(e.target.value) || 0) < min) onChange(min);
        }}
        className="rounded-none border-0 shadow-none focus-visible:ring-0"
      />
      {suffix && <span className="flex items-center bg-muted px-2.5 text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

const newRowId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

function PaymentMethods({ value, onChange }: { value: PaymentMethod[]; onChange: (v: PaymentMethod[]) => void }) {
  const { defaultLocale } = useLanguages();
  const [open, setOpen] = useState<string | null>(null);
  // key React ổn định cho từng phương thức (không dùng index / m.key vì có thể sắp xếp, xoá, sửa key)
  const [ids, setIds] = useState<string[]>(() => value.map(newRowId));
  if (ids.length !== value.length) setIds(value.length > ids.length ? [...ids, ...Array.from({ length: value.length - ids.length }, newRowId)] : ids.slice(0, value.length));
  const keyOf = (i: number) => ids[i] ?? `row-${i}`;
  const patch = (i: number, p: Partial<PaymentMethod>) => onChange(value.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    const nextIds = [...ids];
    [nextIds[i], nextIds[i + d]] = [nextIds[i + d], nextIds[i]];
    setIds(nextIds);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {value.map((m, i) => (
        <div key={keyOf(i)} className={cn('rounded-lg border', !m.enabled && 'bg-muted/30')}>
          <div className="flex items-center gap-3 p-3">
            <CreditCard className={cn('size-5', m.enabled ? 'text-primary' : 'text-muted-foreground')} />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === keyOf(i) ? null : keyOf(i))}>
              <div className="truncate text-sm font-medium">{i18n(m.label, defaultLocale) || '(chưa đặt tên)'}</div>
              <div className="font-mono text-xs text-muted-foreground">{m.key}</div>
            </button>
            <div className="flex items-center gap-0.5">
              <Button type="button" variant="ghost" size="icon-xs" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Lên">
                <ArrowUp />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" disabled={i === value.length - 1} onClick={() => move(i, 1)} aria-label="Xuống">
                <ArrowDown />
              </Button>
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => setOpen(open === keyOf(i) ? null : keyOf(i))} aria-label="Mở rộng">
                <ChevronDown className={cn('transition', open === keyOf(i) && 'rotate-180')} />
              </Button>
            </div>
            <Switch checked={m.enabled} onCheckedChange={(enabled) => patch(i, { enabled })} aria-label="Bật/tắt" />
          </div>
          {open === keyOf(i) && (
            <div className="space-y-3 border-t p-3">
              <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
                <Field label="Mã (key)" help="Dùng trong đơn hàng, không nên đổi">
                  <Input value={m.key} onChange={(e) => patch(i, { key: e.target.value })} onBlur={(e) => patch(i, { key: slugify(e.target.value).replace(/-/g, '_') })} className="font-mono text-sm" />
                </Field>
                <Field label="Tên hiển thị">
                  <I18nInput value={m.label} onChange={(label) => patch(i, { label })} />
                </Field>
              </div>
              <Field label="Hướng dẫn thanh toán" help="Hiển thị khi khách chọn phương thức này (vd: số tài khoản ngân hàng)">
                <I18nInput multiline value={m.description} onChange={(description) => patch(i, { description })} />
              </Field>
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => {
                  setIds(ids.filter((_, j) => j !== i));
                  onChange(value.filter((_, j) => j !== i));
                }}>
                <Trash2 /> Xoá phương thức
              </Button>
            </div>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const id = newRowId();
          setIds([...ids.slice(0, value.length), id]);
          onChange([...value, { key: `method_${value.length + 1}`, enabled: true, label: { [defaultLocale]: 'Phương thức mới' }, description: {} }]);
          setOpen(id);
        }}
      >
        <Plus /> Thêm phương thức thanh toán
      </Button>
    </div>
  );
}

export function CommerceTab({ onDirtyChange }: { onDirtyChange: (d: boolean) => void }) {
  return (
    <SettingsGroup group="commerce" onDirtyChange={onDirtyChange}>
      {(v, set) => (
        <>
          <Section title="Tiền tệ" description={`Xem trước: ${formatPreview(v, 1234567.89)}`}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Đơn vị tiền tệ">
                <Select
                  value={v.currency ?? 'VND'}
                  onValueChange={(currency) => {
                    const c = CURRENCIES.find((x) => x.code === currency);
                    set({ currency, currencySymbol: c?.symbol ?? v.currencySymbol, ...(currency === 'VND' ? { decimals: 0 } : {}) });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.code} ({c.symbol})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Ký hiệu">
                <Input value={v.currencySymbol ?? ''} onChange={(e) => set({ currencySymbol: e.target.value })} className="w-24" />
              </Field>
              <Field label="Vị trí ký hiệu">
                <Select value={v.currencyPosition ?? 'after'} onValueChange={(currencyPosition) => set({ currencyPosition })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="before">Trước số ({v.currencySymbol}100)</SelectItem>
                    <SelectItem value="after">Sau số (100{v.currencySymbol})</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Phân cách hàng nghìn">
                <Input value={v.thousandSeparator ?? ''} onChange={(e) => set({ thousandSeparator: e.target.value })} className="w-20 text-center font-mono" maxLength={2} />
              </Field>
              <Field label="Phân cách thập phân">
                <Input value={v.decimalSeparator ?? ''} onChange={(e) => set({ decimalSeparator: e.target.value })} className="w-20 text-center font-mono" maxLength={2} />
              </Field>
              <Field label="Số chữ số thập phân">
                <Input type="number" min={0} max={4} value={v.decimals ?? 0} onChange={(e) => set({ decimals: Math.max(0, Math.min(4, Number(e.target.value) || 0)) })} className="w-20" />
              </Field>
            </div>
          </Section>

          <Section title="Giỏ hàng & thanh toán">
            <div className="grid gap-3 md:grid-cols-2">
              <SwitchRow label="Bật giỏ hàng" description="Tắt để dùng website như catalog giới thiệu sản phẩm" checked={v.enableCart !== false} onChange={(enableCart) => set({ enableCart })} />
              <SwitchRow label="Cho phép khách vãng lai đặt hàng" description="Khách không cần tạo tài khoản khi thanh toán" checked={!!v.enableGuestCheckout} onChange={(enableGuestCheckout) => set({ enableGuestCheckout })} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Tiền tố mã đơn hàng" help={`Vd: ${v.orderCodePrefix || 'DH'}261007K7M2Q9XA (tiền tố + ngày yymmdd + 8 ký tự chữ/số ngẫu nhiên)`}>
                <Input value={v.orderCodePrefix ?? ''} onChange={(e) => set({ orderCodePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} className="w-32 font-mono" maxLength={8} placeholder="DH" />
              </Field>
              <Field label="Ngưỡng cảnh báo sắp hết hàng">
                <NumberInput value={v.lowStockThreshold} onChange={(lowStockThreshold) => set({ lowStockThreshold })} suffix="sản phẩm" className="w-48" />
              </Field>
            </div>
          </Section>

          <Section title="Vận chuyển & thuế">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Phí vận chuyển cố định">
                <NumberInput value={v.shippingFlatRate} onChange={(shippingFlatRate) => set({ shippingFlatRate })} suffix={v.currencySymbol} />
              </Field>
              <Field label="Miễn phí vận chuyển từ" help="0 = không áp dụng">
                <NumberInput value={v.freeShippingThreshold} onChange={(freeShippingThreshold) => set({ freeShippingThreshold })} suffix={v.currencySymbol} />
              </Field>
            </div>
            {/* Thuế (thuế suất chung, giá đã gồm thuế, thuế theo vùng / lớp thuế) chuyển sang tab riêng để không bị trùng */}
            <Link href="/settings?tab=tax" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              Cấu hình thuế ở tab Thuế <ArrowRight className="size-3.5" />
            </Link>
          </Section>

          <Section title="Phương thức thanh toán offline" description="Thanh toán thủ công (COD, chuyển khoản tự đối soát): bật/tắt, đổi thứ tự hiển thị ở trang thanh toán">
            <PaymentMethods value={(v.paymentMethods as PaymentMethod[]) ?? []} onChange={(paymentMethods) => set({ paymentMethods })} />
          </Section>

          <Section title="Thanh toán online" description="Áp dụng cho các cổng thanh toán tự động (Web2M)">
            <Link href="/settings?tab=payments" className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm transition hover:border-primary/40">
              <CreditCard className="size-5 shrink-0 text-primary" />
              <span className="flex-1">
                <span className="font-medium">Cổng thanh toán (Web2M) bật & cấu hình tại Cài đặt › Cổng thanh toán</span>
                <span className="block text-xs text-muted-foreground">Nhập khoá API, xem URL webhook cần khai báo ở trang quản lý của từng cổng.</span>
              </span>
              <ArrowRight className="size-4 text-primary" />
            </Link>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Thời hạn thanh toán" help="Tối thiểu 5 phút. Sau thời gian này, link / mã QR thanh toán hết hạn và khách phải tạo lại.">
                <NumberInput value={v.paymentExpireMinutes ?? 30} min={5} onChange={(paymentExpireMinutes) => set({ paymentExpireMinutes })} suffix="phút" className="w-40" />
              </Field>
              <Field label="Tự động huỷ đơn chưa thanh toán sau" help="0 = tắt. Chỉ áp dụng cho đơn chọn thanh toán online còn “Chờ xác nhận” và chưa thanh toán; kho & mã giảm giá được hoàn lại.">
                <NumberInput value={v.autoCancelUnpaidMinutes ?? 0} onChange={(autoCancelUnpaidMinutes) => set({ autoCancelUnpaidMinutes })} suffix="phút" className="w-40" />
              </Field>
            </div>
            <SwitchRow
              label="Tự động xác nhận đơn khi đã thanh toán"
              description="Đơn “Chờ xác nhận” chuyển sang “Đã xác nhận” ngay khi cổng báo đã nhận đủ tiền."
              checked={v.autoConfirmPaidOrders !== false}
              onChange={(autoConfirmPaidOrders) => set({ autoConfirmPaidOrders })}
            />
            <SwitchRow
              label="Cho phép thanh toán bằng số dư ví"
              description="Thành viên có tiền trong ví (admin nạp ở trang Thành viên) thấy thêm phương thức “Số dư ví” khi đặt hàng; đơn được trừ ví và thanh toán ngay."
              checked={v.walletPaymentEnabled !== false}
              onChange={(walletPaymentEnabled) => set({ walletPaymentEnabled })}
            />
          </Section>

          <Section title="Hoá đơn điện tử" description="Cho khách khai thông tin xuất hoá đơn (công ty / cá nhân, MST) ngay ở trang thanh toán">
            <div className="grid gap-3 md:grid-cols-2">
              <SwitchRow label="Cho khách yêu cầu xuất hoá đơn" description="Hiện ô “Xuất hoá đơn điện tử” ở trang thanh toán và trong tài khoản khách." checked={!!v.invoiceRequestEnabled} onChange={(invoiceRequestEnabled) => set({ invoiceRequestEnabled })} />
              <SwitchRow label="Bắt buộc mã số thuế với công ty" description="Khách chọn xuất hoá đơn cho công ty phải nhập MST hợp lệ (10 hoặc 13 số)." checked={v.invoiceRequireTaxCode !== false} onChange={(invoiceRequireTaxCode) => set({ invoiceRequireTaxCode })} disabled={!v.invoiceRequestEnabled} />
            </div>
            <Link href="/settings?tab=einvoice" className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm transition hover:border-primary/40">
              <ReceiptText className="size-5 shrink-0 text-primary" />
              <span className="flex-1">
                <span className="font-medium">Nhà cung cấp, người bán, ký hiệu và tự động phát hành cấu hình ở tab Hoá đơn điện tử</span>
              </span>
              <ArrowRight className="size-4 text-primary" />
            </Link>
          </Section>

          <Section title="Đánh giá sản phẩm" description="Khách hàng đánh giá & chấm sao sản phẩm trên website">
            <div className="grid gap-3 md:grid-cols-2">
              <SwitchRow label="Bật đánh giá sản phẩm" description="Hiển thị khu vực đánh giá và cho phép khách gửi đánh giá" checked={v.enableReviews !== false} onChange={(enableReviews) => set({ enableReviews })} />
              <SwitchRow label="Tự động duyệt đánh giá" description="Đánh giá mới hiển thị ngay, không cần duyệt thủ công" checked={!!v.reviewAutoApprove} onChange={(reviewAutoApprove) => set({ reviewAutoApprove })} disabled={v.enableReviews === false} />
              <SwitchRow label="Yêu cầu đăng nhập" description="Chỉ thành viên đã đăng nhập mới được đánh giá" checked={!!v.reviewRequireLogin} onChange={(reviewRequireLogin) => set({ reviewRequireLogin })} disabled={v.enableReviews === false} />
              <SwitchRow label="Chỉ khách đã mua hàng" description="Chỉ khách có đơn “Hoàn thành” chứa sản phẩm mới được đánh giá" checked={!!v.reviewRequirePurchase} onChange={(reviewRequirePurchase) => set({ reviewRequirePurchase })} disabled={v.enableReviews === false} />
            </div>
            <Link href="/products/reviews" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              Quản lý đánh giá <ArrowRight className="size-3.5" />
            </Link>
          </Section>

          <Section title="Thông báo đơn hàng">
            <Field label="Email nhận thông báo đơn mới" help="Danh sách email nhận thông báo khi có đơn mới (cần cấu hình SMTP). Bật/tắt và tuỳ chọn email gửi khách ở Cài đặt › Thông báo email (ô email riêng ở đó được ưu tiên nếu có).">
              <EmailListInput value={v.orderNotifyEmails} onChange={(orderNotifyEmails) => set({ orderNotifyEmails })} />
            </Field>
          </Section>
        </>
      )}
    </SettingsGroup>
  );
}
