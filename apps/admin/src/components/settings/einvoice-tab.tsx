'use client';

/**
 * Cài đặt > Hoá đơn điện tử (nhóm `einvoice`): nhà cung cấp (form động theo meta của adapter),
 * người bán, mẫu số & ký hiệu & thuế, tự động xuất hoá đơn.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ExternalLink, Eye, EyeOff, Info, Loader2, PlugZap, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Field, Section } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useEInvoiceProviders, type ProviderField, type ProviderMeta } from '@/components/commerce/einvoice';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

type TabProps = { onDirtyChange: (d: boolean) => void };

const SIGNING_LABEL: Record<ProviderMeta['signing'], string> = {
  hsm: 'Ký số HSM trên máy chủ nhà cung cấp — phát hành tự động hoàn toàn',
  server: 'Nhà cung cấp ký bằng chứng thư số đã cấu hình — phát hành tự động',
  usb: 'Cần USB token phía bạn — hệ thống chỉ tạo nháp, bạn ký trên cổng nhà cung cấp',
  none: 'Không ký số qua hệ thống này',
};

const AUTO_ISSUE_OPTIONS = [
  { value: 'manual', label: 'Không tự động', desc: 'Nhân viên tự lập hoá đơn từ trang Đơn hàng / Hoá đơn điện tử' },
  { value: 'paid', label: 'Khi đơn được thanh toán', desc: 'Phát hành ngay khi trạng thái thanh toán chuyển “Đã thanh toán”' },
  { value: 'completed', label: 'Khi đơn hoàn thành', desc: 'Phát hành khi đơn chuyển sang “Hoàn thành” (đã giao xong)' },
];

const PAYMENT_MAP: { key: string; label: string }[] = [
  { key: 'cod', label: 'COD (tiền mặt khi nhận)' },
  { key: 'bank_transfer', label: 'Chuyển khoản' },
  { key: 'wallet', label: 'Số dư ví' },
  { key: 'default', label: 'Phương thức khác / cổng online' },
];

const SELLER_FIELDS: { key: string; label: string; placeholder?: string; full?: boolean; mono?: boolean; required?: boolean }[] = [
  { key: 'name', label: 'Tên đơn vị bán hàng', placeholder: 'CÔNG TY TNHH ...', full: true, required: true },
  { key: 'taxCode', label: 'Mã số thuế', placeholder: '0123456789', mono: true, required: true },
  { key: 'phone', label: 'Điện thoại' },
  { key: 'address', label: 'Địa chỉ', placeholder: 'Theo giấy đăng ký kinh doanh', full: true, required: true },
  { key: 'email', label: 'Email' },
  { key: 'bankAccount', label: 'Số tài khoản', mono: true },
  { key: 'bankName', label: 'Ngân hàng', full: true },
];

/** Ô nhập cho một field cấu hình nhà cung cấp (theo meta.fields) */
function ProviderFieldInput({ field, value, onChange }: { field: ProviderField; value: unknown; onChange: (v: unknown) => void }) {
  const [show, setShow] = useState(false);
  const str = value == null ? '' : String(value);
  switch (field.type) {
    case 'boolean':
      return (
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3">
          <span className="text-sm">
            <span className="font-medium">{field.label}</span>
            {field.help && <span className="block text-xs text-muted-foreground">{field.help}</span>}
          </span>
          <Switch checked={value == null ? !!field.default : !!value} onCheckedChange={onChange} />
        </label>
      );
    case 'select':
      return (
        <Field label={field.label} required={field.required} help={field.help}>
          <Select value={str || String(field.default ?? '')} onValueChange={onChange}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={field.placeholder ?? 'Chọn...'} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      );
    case 'textarea':
      return (
        <Field label={field.label} required={field.required} help={field.help} className="sm:col-span-2">
          <Textarea value={str} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} rows={4} className="font-mono text-xs" spellCheck={false} />
        </Field>
      );
    case 'password':
      return (
        <Field label={field.label} required={field.required} help={field.help}>
          <div className="relative">
            <Input type={show ? 'text' : 'password'} value={str} onChange={(e) => onChange(e.target.value.trim())} placeholder={field.placeholder} autoComplete="new-password" spellCheck={false} className="pr-9 font-mono text-sm" />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShow((s) => !s)} aria-label={show ? 'Ẩn' : 'Hiện'}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>
      );
    case 'number':
      return (
        <Field label={field.label} required={field.required} help={field.help}>
          <Input type="number" value={str} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} placeholder={field.placeholder ?? (field.default != null ? String(field.default) : undefined)} />
        </Field>
      );
    default:
      return (
        <Field label={field.label} required={field.required} help={field.help} className={field.type === 'url' ? 'sm:col-span-2' : undefined}>
          <Input type={field.type === 'url' ? 'url' : 'text'} value={str} onChange={(e) => onChange(e.target.value.trim())} placeholder={field.placeholder ?? (field.default != null ? String(field.default) : undefined)} autoComplete="off" spellCheck={false} className="font-mono text-sm" />
        </Field>
      );
  }
}

/** Form cấu hình nhà cung cấp đang chọn + nút kiểm tra kết nối */
function ProviderConfig({ meta, environment, config, onChange }: { meta: ProviderMeta; environment: 'sandbox' | 'production'; config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void }) {
  const { can } = useAuth();
  const fields = meta.fields.filter((f) => !f.env || f.env === environment);
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string; details?: Record<string, unknown> }>('/admin/einvoices/test-connection', { provider: meta.key, config: { ...config, environment }, environment }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message || 'Kết nối thành công');
      else toast.error(r.message || 'Kết nối thất bại');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const result = test.data;
  const missing = fields.filter((f) => f.required && (config[f.key] == null || config[f.key] === ''));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">{meta.name}</p>
          <div className="flex items-center gap-3 text-xs">
            {meta.website && (
              <a href={meta.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                Website <ExternalLink className="size-3" />
              </a>
            )}
            {meta.docsUrl && (
              <a href={meta.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                Tài liệu tích hợp <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta.description}</p>
        <p className="mt-1 text-xs text-muted-foreground">Ký số: {SIGNING_LABEL[meta.signing]}</p>
        {meta.notes && meta.notes.length > 0 && (
          <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
            {meta.notes.map((n, i) => (
              <li key={i} className="flex gap-1.5">
                <Info className="mt-0.5 size-3 shrink-0 text-sky-600 dark:text-sky-400" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {fields.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <ProviderFieldInput key={f.key} field={f} value={config[f.key]} onChange={(v) => onChange({ ...config, [f.key]: v })} />
          ))}
        </div>
      )}
      {missing.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">Chưa điền: {missing.map((f) => f.label).join(', ')} — không thể phát hành hoá đơn cho tới khi điền đủ.</p>}

      {meta.capabilities.testConnection && can('einvoice.settings') && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Kiểm tra kết nối
          </Button>
          {result && (
            <span className={cn('inline-flex items-center gap-1 text-xs', result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
              {result.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />} {result.message}
            </span>
          )}
          <span className="text-xs text-muted-foreground">Dùng cấu hình đang nhập (chưa cần lưu).</span>
        </div>
      )}
      {result?.ok && result.details && Object.keys(result.details).length > 0 && (
        <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{JSON.stringify(result.details, null, 2)}</pre>
      )}
    </div>
  );
}

export function EInvoiceTab({ onDirtyChange }: TabProps) {
  const providers = useEInvoiceProviders();
  return (
    <SettingsGroup group="einvoice" onDirtyChange={onDirtyChange}>
      {(v, set) => {
        const providerKey: string = v.provider || 'none';
        const environment: 'sandbox' | 'production' = v.environment === 'production' ? 'production' : 'sandbox';
        const meta = providers.data?.providers.find((p) => p.key === providerKey);
        const allConfigs = (v.providers as Record<string, Record<string, unknown>>) ?? {};
        const seller = (v.seller as Record<string, string>) ?? {};
        const pm = (v.paymentMethodMap as Record<string, string>) ?? {};
        const vatRates = providers.data?.vatRates ?? [];
        const autoOn = v.autoIssue && v.autoIssue !== 'manual';
        return (
          <>
            <Section title="Nhà cung cấp" description="Chọn đơn vị cung cấp dịch vụ hoá đơn điện tử và nhập thông tin kết nối do họ cấp. Hãy thử trên môi trường thử nghiệm (sandbox) trước khi chuyển sang chính thức.">
              {providers.isLoading ? (
                <Skeleton className="h-10 rounded-lg" />
              ) : providers.error ? (
                <p className="text-sm text-destructive">Không tải được danh sách nhà cung cấp: {errorMessage(providers.error)}</p>
              ) : (
                <div className="grid gap-4 md:grid-cols-[1fr_220px]">
                  <Field label="Nhà cung cấp">
                    <Select value={providerKey} onValueChange={(provider) => set({ provider })}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          <span className="font-medium">Chưa dùng hoá đơn điện tử</span>
                        </SelectItem>
                        {providers.data?.providers.map((p) => (
                          <SelectItem key={p.key} value={p.key}>
                            <span className="font-medium">{p.name}</span>
                            <span className="ml-1 text-xs text-muted-foreground">— {p.description}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Môi trường">
                    <Select value={environment} onValueChange={(environment) => set({ environment })}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sandbox">Thử nghiệm (sandbox)</SelectItem>
                        <SelectItem value="production">Chính thức (production)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              )}
              {environment === 'production' && providerKey !== 'none' && (
                <p className="text-xs text-amber-600 dark:text-amber-400">Môi trường chính thức: hoá đơn phát hành có giá trị pháp lý và được gửi tới cơ quan thuế.</p>
              )}
              {meta && <ProviderConfig key={meta.key} meta={meta} environment={environment} config={allConfigs[meta.key] ?? {}} onChange={(c) => set({ providers: { ...allConfigs, [meta.key]: c } })} />}
            </Section>

            <Section title="Người bán" description="Thông tin đơn vị bán hàng in trên hoá đơn — phải khớp đăng ký thuế và tài khoản tại nhà cung cấp.">
              <div className="grid gap-4 sm:grid-cols-2">
                {SELLER_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} required={f.required} className={f.full ? 'sm:col-span-2' : undefined}>
                    <Input value={seller[f.key] ?? ''} onChange={(e) => set({ seller: { ...seller, [f.key]: e.target.value } })} placeholder={f.placeholder} className={f.mono ? 'font-mono' : undefined} />
                  </Field>
                ))}
              </div>
            </Section>

            <Section title="Mẫu số, ký hiệu & thuế" description="Theo Thông tư 78: mẫu số “1” (hoá đơn GTGT), ký hiệu dạng C25TAA do nhà cung cấp cấp khi đăng ký phát hành.">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Mẫu số">
                  <Input value={v.templateCode ?? ''} onChange={(e) => set({ templateCode: e.target.value })} className="font-mono" maxLength={20} placeholder="1" />
                </Field>
                <Field label="Ký hiệu hoá đơn">
                  <Input value={v.serial ?? ''} onChange={(e) => set({ serial: e.target.value.toUpperCase() })} className="font-mono" maxLength={20} placeholder="C25TAA" />
                </Field>
                <Field label="Thuế suất mặc định">
                  <Select value={String(v.defaultVatRate ?? 10)} onValueChange={(r) => set({ defaultVatRate: Number(r) })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(vatRates.length ? vatRates : [{ value: 10, label: '10%', code: '10' }]).map((r) => (
                        <SelectItem key={r.value} value={String(r.value)}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Đơn vị tính mặc định">
                  <Input value={v.defaultUnit ?? ''} onChange={(e) => set({ defaultUnit: e.target.value })} maxLength={50} placeholder="Cái" />
                </Field>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <SwitchRow label="Giá sản phẩm đã gồm VAT" description="Hệ thống tách ngược giá chưa thuế khi lập hoá đơn. Tắt nếu giá bán trên web là giá chưa thuế." checked={v.pricesIncludeVat !== false} onChange={(pricesIncludeVat) => set({ pricesIncludeVat })} />
                <SwitchRow label="Phí vận chuyển thành một dòng hàng" description="Tắt thì phí vận chuyển không xuất hiện trên hoá đơn." checked={v.shippingAsLine !== false} onChange={(shippingAsLine) => set({ shippingAsLine })} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Tên dòng phí vận chuyển">
                  <Input value={v.shippingLineName ?? ''} onChange={(e) => set({ shippingLineName: e.target.value })} disabled={v.shippingAsLine === false} placeholder="Phí vận chuyển" />
                </Field>
                <Field label="Cách thể hiện giảm giá" help="Phân bổ: trừ vào từng dòng theo tỉ lệ. Dòng riêng: thêm một dòng chiết khấu thương mại.">
                  <Select value={v.discountMode ?? 'perLine'} onValueChange={(discountMode) => set({ discountMode })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="perLine">Phân bổ vào từng dòng</SelectItem>
                      <SelectItem value="separate">Dòng chiết khấu riêng</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Hình thức thanh toán trên hoá đơn" help="Ánh xạ phương thức thanh toán của đơn hàng sang mã trên hoá đơn: TM (tiền mặt), CK (chuyển khoản), TM/CK...">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {PAYMENT_MAP.map((m) => (
                    <div key={m.key} className="space-y-1">
                      <span className="block text-xs text-muted-foreground">{m.label}</span>
                      <Input value={pm[m.key] ?? ''} onChange={(e) => set({ paymentMethodMap: { ...pm, [m.key]: e.target.value.toUpperCase() } })} className="font-mono" maxLength={20} placeholder={m.key === 'cod' ? 'TM' : m.key === 'default' ? 'TM/CK' : 'CK'} />
                    </div>
                  ))}
                </div>
              </Field>
            </Section>

            <Section title="Tự động xuất hoá đơn" description="Hệ thống tự lập và phát hành hoá đơn theo sự kiện của đơn hàng (chạy nền, có thể thử lại khi lỗi).">
              <Field label="Thời điểm tự động phát hành">
                <div className="grid gap-2 md:grid-cols-3">
                  {AUTO_ISSUE_OPTIONS.map((o) => {
                    const active = (v.autoIssue ?? 'manual') === o.value;
                    return (
                      <button key={o.value} type="button" onClick={() => set({ autoIssue: o.value })} className={cn('rounded-lg border p-3 text-left transition hover:bg-muted/50', active && 'border-primary bg-primary/5 ring-1 ring-primary')}>
                        <span className="block text-sm font-medium">{o.label}</span>
                        <span className="block text-xs text-muted-foreground">{o.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <SwitchRow label="Chỉ khi khách yêu cầu xuất hoá đơn" description="Bỏ qua các đơn khách không tích “Xuất hoá đơn” lúc đặt hàng. Tắt để xuất cho mọi đơn." checked={v.autoIssueOnlyWhenRequested !== false} onChange={(autoIssueOnlyWhenRequested) => set({ autoIssueOnlyWhenRequested })} disabled={!autoOn} />
                <SwitchRow label="Tự huỷ hoá đơn khi đơn bị huỷ / hoàn tiền toàn bộ" description="Gọi nhà cung cấp huỷ hoá đơn đã phát hành của đơn đó." checked={!!v.autoCancelOnRefund} onChange={(autoCancelOnRefund) => set({ autoCancelOnRefund })} />
                <SwitchRow label="Gửi email hoá đơn cho khách" description="Sau khi phát hành thành công, gửi email kèm số hoá đơn, mã tra cứu và PDF (nếu có)." checked={v.sendEmailToBuyer !== false} onChange={(sendEmailToBuyer) => set({ sendEmailToBuyer })} />
              </div>
              <Field label="Trễ sau sự kiện" help="Chờ bao nhiêu phút sau khi thanh toán / hoàn thành mới phát hành, để kịp sửa hoặc huỷ đơn. 0 = phát hành ngay.">
                <div className="flex items-stretch overflow-hidden rounded-lg border focus-within:ring-3 focus-within:ring-ring/50 sm:max-w-[12rem]">
                  <Input type="number" min={0} max={10080} value={v.autoIssueDelayMinutes ?? 0} onChange={(e) => set({ autoIssueDelayMinutes: Math.max(0, Math.min(10080, Number(e.target.value) || 0)) })} disabled={!autoOn} className="rounded-none border-0 shadow-none focus-visible:ring-0" />
                  <span className="flex items-center bg-muted px-2.5 text-xs text-muted-foreground">phút</span>
                </div>
              </Field>
              <Link href="/settings?tab=commerce" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                Cho khách nhập thông tin xuất hoá đơn ở trang thanh toán (Cài đặt › Bán hàng) <ArrowRight className="size-3.5" />
              </Link>
            </Section>
          </>
        );
      }}
    </SettingsGroup>
  );
}

