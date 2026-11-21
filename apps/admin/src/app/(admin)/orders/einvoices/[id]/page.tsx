'use client';

/**
 * Chi tiết hoá đơn điện tử (`/orders/einvoices/[id]`) và lập hoá đơn mới từ đơn hàng
 * (`/orders/einvoices/new?orderId=`): xem/sửa người mua, dòng hàng, tổng hợp thuế;
 * các hành động theo trạng thái (phát hành, huỷ, thay thế, điều chỉnh, đồng bộ, tải PDF/XML, gửi email);
 * hoá đơn liên quan và nhật ký gọi nhà cung cấp.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, use, useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeftRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  ClipboardEdit,
  Copy,
  ExternalLink,
  FileCode2,
  FileDown,
  FileText,
  Loader2,
  Mail,
  Pencil,
  RefreshCw,
  Save,
  Send,
  ShoppingCart,
  Trash2,
  XCircle,
  Printer,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { StatusBadge } from '@/components/common/status-badge';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toNum } from '@/components/commerce/utils';
import {
  ACTIVE_STATUSES,
  downloadEInvoiceFile,
  EDITABLE_STATUSES,
  EInvoiceKindBadge,
  EInvoiceStatusBadge,
  EINVOICE_KIND_LABEL,
  InvoiceTotalsView,
  invoiceNumber,
  LineItemsTable,
  linesToPayload,
  openEInvoicePdf,
  openEInvoicePrint,
  providerLabel,
  summarizeLines,
  toEditableLines,
  useEInvoiceProviders,
  type EditableLine,
  type EInvoiceDetail,
  type EInvoiceLog,
  type EInvoicePreview,
  type InvoiceBuyer,
  type InvoiceSeller,
  type VatRateOption,
} from '@/components/commerce/einvoice';
import { AdjustInvoiceDialog, CancelInvoiceDialog, ManualResultDialog, ReplaceInvoiceDialog, SendInvoiceEmailDialog } from '@/components/commerce/einvoice-dialogs';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useSettingGroup } from '@/hooks/use-settings';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Form dùng chung cho trang tạo & trang sửa nháp
// ---------------------------------------------------------------------------

interface FormState {
  buyer: InvoiceBuyer;
  lines: EditableLine[];
  note: string;
  paymentMethod: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  templateCode: string;
  serial: string;
}

type DialogKind = 'cancel' | 'replace' | 'adjust' | 'manual' | 'email' | null;

const toDay = (v: string | Date | null | undefined) => {
  const d = v ? new Date(v) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Ghép body gửi API từ form */
function formToPayload(f: FormState) {
  const buyer: InvoiceBuyer = {};
  for (const [k, v] of Object.entries(f.buyer)) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) (buyer as Record<string, unknown>)[k] = t;
    } else if (v !== undefined && v !== null) (buyer as Record<string, unknown>)[k] = v;
  }
  return {
    buyer,
    items: linesToPayload(f.lines),
    note: f.note.trim() || undefined,
    paymentMethod: f.paymentMethod.trim() || undefined,
    invoiceDate: f.invoiceDate ? new Date(`${f.invoiceDate}T00:00:00`).toISOString() : undefined,
    templateCode: f.templateCode.trim() || undefined,
    serial: f.serial.trim() || undefined,
  };
}

const BUYER_FIELDS: { key: keyof InvoiceBuyer; label: string; placeholder?: string; full?: boolean; mono?: boolean; help?: string }[] = [
  { key: 'legalName', label: 'Tên đơn vị (công ty)', placeholder: 'Bỏ trống nếu khách là cá nhân', full: true },
  { key: 'name', label: 'Người mua hàng', placeholder: 'Họ tên người mua / người đại diện' },
  { key: 'taxCode', label: 'Mã số thuế', placeholder: '0123456789', mono: true },
  { key: 'address', label: 'Địa chỉ', full: true },
  { key: 'email', label: 'Email nhận hoá đơn' },
  { key: 'phone', label: 'Điện thoại' },
  { key: 'idNumber', label: 'CCCD / Hộ chiếu', help: 'Khách cá nhân không có MST', mono: true },
  { key: 'budgetCode', label: 'Mã quan hệ ngân sách', help: 'Khách là đơn vị nhà nước', mono: true },
];

/** Form người mua (sửa khi hoá đơn còn nháp / lỗi) */
function BuyerForm({ buyer, onChange }: { buyer: InvoiceBuyer; onChange: (b: InvoiceBuyer) => void }) {
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-muted/50">
        <Checkbox checked={!!buyer.anonymous} onCheckedChange={(c) => onChange({ ...buyer, anonymous: c === true })} />
        <span className="text-sm">
          <span className="font-medium">Người mua không lấy hoá đơn</span>
          <span className="block text-xs text-muted-foreground">Khách lẻ không cung cấp thông tin — hoá đơn ghi “Người mua không lấy hoá đơn”.</span>
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {BUYER_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} help={f.help} className={f.full ? 'sm:col-span-2' : undefined}>
            <Input value={(buyer[f.key] as string | undefined) ?? ''} onChange={(e) => onChange({ ...buyer, [f.key]: e.target.value })} placeholder={f.placeholder} className={f.mono ? 'font-mono' : undefined} />
          </Field>
        ))}
      </div>
    </div>
  );
}

/** Danh sách nhãn – giá trị */
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

function BuyerView({ buyer }: { buyer: InvoiceBuyer | null }) {
  if (!buyer) return <p className="text-sm text-muted-foreground">—</p>;
  if (buyer.anonymous && !buyer.taxCode && !buyer.legalName) return <p className="text-sm italic text-muted-foreground">Người mua không lấy hoá đơn</p>;
  return (
    <Dl
      rows={[
        { label: 'Đơn vị', value: buyer.legalName ? <span className="font-medium">{buyer.legalName}</span> : undefined },
        { label: 'Người mua', value: buyer.name },
        { label: 'MST', value: buyer.taxCode, mono: true },
        { label: 'CCCD', value: buyer.idNumber, mono: true },
        { label: 'Địa chỉ', value: buyer.address },
        { label: 'Email', value: buyer.email },
        { label: 'Điện thoại', value: buyer.phone },
        { label: 'Mã QHNS', value: buyer.budgetCode, mono: true },
      ]}
    />
  );
}

function SellerView({ seller }: { seller: InvoiceSeller | null }) {
  if (!seller || !seller.name) return <p className="text-sm text-amber-600 dark:text-amber-400">Chưa khai thông tin người bán (Cài đặt › Hoá đơn điện tử).</p>;
  return (
    <Dl
      rows={[
        { label: 'Đơn vị', value: <span className="font-medium">{seller.name}</span> },
        { label: 'MST', value: seller.taxCode, mono: true },
        { label: 'Địa chỉ', value: seller.address },
        { label: 'Điện thoại', value: seller.phone },
        { label: 'Email', value: seller.email },
        { label: 'Tài khoản', value: seller.bankAccount ? `${seller.bankAccount}${seller.bankName ? ` – ${seller.bankName}` : ''}` : undefined },
      ]}
    />
  );
}

/** Nút sao chép nhỏ */
function CopyBtn({ text }: { text: string }) {
  return (
    <button type="button" className="text-muted-foreground hover:text-foreground" title="Sao chép" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Đã sao chép'))}>
      <Copy className="size-3" />
    </button>
  );
}

/** Ô thông tin mẫu số / ký hiệu / ngày lập... (sửa khi còn nháp) */
function InvoiceMetaFields({ form, setForm }: { form: FormState; setForm: (p: Partial<FormState>) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Mẫu số">
        <Input value={form.templateCode} onChange={(e) => setForm({ templateCode: e.target.value })} className="font-mono" maxLength={20} placeholder="1" />
      </Field>
      <Field label="Ký hiệu">
        <Input value={form.serial} onChange={(e) => setForm({ serial: e.target.value.toUpperCase() })} className="font-mono" maxLength={20} placeholder="C25TAA" />
      </Field>
      <Field label="Ngày lập">
        <Input type="date" value={form.invoiceDate} onChange={(e) => setForm({ invoiceDate: e.target.value })} />
      </Field>
      <Field label="Hình thức thanh toán">
        <Input value={form.paymentMethod} onChange={(e) => setForm({ paymentMethod: e.target.value })} placeholder="TM/CK" maxLength={20} />
      </Field>
      <Field label="Ghi chú trên hoá đơn" className="sm:col-span-2 lg:col-span-4">
        <Textarea value={form.note} onChange={(e) => setForm({ note: e.target.value })} rows={2} maxLength={1000} placeholder="Tuỳ chọn, in trên hoá đơn" />
      </Field>
    </div>
  );
}

/** Cảnh báo (vàng) */
function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <ul className="list-inside list-disc space-y-0.5">
        {items.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trang tạo mới từ đơn hàng
// ---------------------------------------------------------------------------

function NewInvoice() {
  const router = useRouter();
  const sp = useSearchParams();
  const orderId = sp.get('orderId') ?? '';
  const qc = useQueryClient();
  const { can } = useAuth();
  const providers = useEInvoiceProviders();
  // đơn vị / thuế suất mặc định cho dòng mới (chỉ đọc được khi có quyền settings.manage)
  const settings = useSettingGroup<{ defaultUnit?: string; defaultVatRate?: number }>('einvoice', can('settings.manage'));
  const preview = useQuery({
    queryKey: ['einvoice-preview', orderId],
    queryFn: () => api.post<EInvoicePreview>('/admin/einvoices/preview', { orderId }),
    enabled: !!orderId,
    retry: false,
  });
  const [form, setFormState] = useState<FormState | null>(null);
  const setForm = useCallback((p: Partial<FormState>) => setFormState((f) => (f ? { ...f, ...p } : f)), []);

  // nạp form từ bản xem trước (một lần)
  useEffect(() => {
    if (preview.data && !form) {
      const p = preview.data;
      setFormState({ buyer: p.buyer ?? {}, lines: toEditableLines(p.lines), note: '', paymentMethod: p.paymentMethod ?? '', invoiceDate: toDay(null), templateCode: p.templateCode ?? '', serial: p.serial ?? '' });
    }
  }, [preview.data, form]);

  const create = useMutation({
    mutationFn: (issueNow: boolean) => api.post<EInvoiceDetail>('/admin/einvoices', { orderId, ...formToPayload(form!), issueNow: issueNow || undefined }),
    onSuccess: (inv, issueNow) => {
      toast.success(issueNow ? (inv.status === 'ISSUED' ? 'Đã phát hành hoá đơn' : 'Đã gửi yêu cầu phát hành') : 'Đã lưu hoá đơn nháp');
      void qc.invalidateQueries({ queryKey: ['einvoices'] });
      void qc.invalidateQueries({ queryKey: ['einvoice-stats'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      void qc.invalidateQueries({ queryKey: ['order', orderId] });
      router.replace(`/orders/einvoices/${inv.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const currency = 'VND';
  const totals = useMemo(() => (form ? summarizeLines(form.lines, currency === 'VND' ? 0 : 2) : null), [form]);
  const valid = !!form && form.lines.length > 0 && form.lines.every((l) => l.name.trim() && l.quantity > 0);
  const noProvider = providers.data && (!providers.data.active || providers.data.active === 'none');

  if (!orderId) {
    return (
      <>
        <PageHeader title="Lập hoá đơn điện tử" breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Hoá đơn điện tử', href: '/orders/einvoices' }, { label: 'Lập hoá đơn' }]} />
        <PageBody>
          <EmptyState
            icon={ShoppingCart}
            title="Chưa chọn đơn hàng"
            description="Hoá đơn điện tử được lập từ một đơn hàng. Hãy quay lại danh sách và bấm “Lập hoá đơn” để chọn đơn."
            action={
              <Button asChild size="sm">
                <Link href="/orders/einvoices">Về danh sách hoá đơn</Link>
              </Button>
            }
          />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Lập hoá đơn điện tử"
        description="Kiểm tra thông tin người mua và dòng hàng trước khi phát hành"
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Hoá đơn điện tử', href: '/orders/einvoices' }, { label: 'Lập hoá đơn' }]}
        actions={
          form && (
            <>
              <Button variant="outline" size="sm" disabled={!valid || create.isPending} onClick={() => create.mutate(false)}>
                {create.isPending && create.variables === false ? <Loader2 className="animate-spin" /> : <Save />} Lưu nháp
              </Button>
              <Button size="sm" disabled={!valid || create.isPending || !!noProvider} title={noProvider ? 'Chưa chọn nhà cung cấp' : undefined} onClick={() => create.mutate(true)}>
                {create.isPending && create.variables === true ? <Loader2 className="animate-spin" /> : <Send />} Lập & phát hành ngay
              </Button>
            </>
          )
        }
      />
      <PageBody>
        {preview.isLoading || (preview.data && !form) ? (
          <div className="space-y-4">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : preview.error ? (
          <EmptyState
            icon={XCircle}
            title="Không thể xem trước hoá đơn"
            description={errorMessage(preview.error)}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={`/orders/${orderId}`}>Mở đơn hàng</Link>
              </Button>
            }
          />
        ) : form && preview.data && totals ? (
          <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
            <div className="min-w-0 space-y-6">
              <Warnings items={preview.data.warnings ?? []} />
              <Section title="Thông tin hoá đơn" description={`Nhà cung cấp: ${providerLabel(preview.data.provider, providers.data?.providers)}`}>
                <InvoiceMetaFields form={form} setForm={setForm} />
              </Section>
              <Section title="Người mua" description="Lấy từ yêu cầu xuất hoá đơn của khách hoặc thông tin đơn hàng — sửa nếu cần">
                <BuyerForm buyer={form.buyer} onChange={(buyer) => setForm({ buyer })} />
              </Section>
              <Section title="Hàng hoá, dịch vụ" description="Đơn giá chưa gồm VAT; thành tiền và tiền thuế tự tính">
                <LineItemsTable lines={form.lines} onChange={(lines) => setForm({ lines })} editable vatRates={providers.data?.vatRates} currency={currency} defaultUnit={settings.data?.defaultUnit ?? 'Cái'} defaultVatRate={settings.data?.defaultVatRate ?? 10} />
                <div className="border-t pt-4">
                  <InvoiceTotalsView totals={totals} currency={currency} vatRates={providers.data?.vatRates} />
                </div>
              </Section>
            </div>
            <div className="space-y-6">
              <Section title="Người bán">
                <SellerView seller={preview.data.seller} />
              </Section>
              <Section title="Đơn hàng">
                <Button variant="outline" size="sm" asChild className="w-full">
                  <Link href={`/orders/${orderId}`}>
                    <ShoppingCart /> Mở đơn hàng
                  </Link>
                </Button>
              </Section>
            </div>
          </div>
        ) : null}
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------
// Nhật ký gọi nhà cung cấp
// ---------------------------------------------------------------------------

const LOG_ACTION_LABEL: Record<string, string> = {
  create: 'Tạo hoá đơn',
  update: 'Sửa hoá đơn',
  issue: 'Phát hành',
  cancel: 'Huỷ',
  replace: 'Lập thay thế',
  adjust: 'Lập điều chỉnh',
  sync: 'Đồng bộ',
  email: 'Gửi email',
  manual: 'Nhập tay kết quả',
  delete: 'Xoá',
  download: 'Tải file',
  test: 'Kiểm tra kết nối',
};

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Đã sao chép'))}>
          <Copy className="size-3" /> Sao chép
        </button>
      </div>
      <pre className="max-h-64 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">{text}</pre>
    </div>
  );
}

function LogsTimeline({ logs }: { logs: EInvoiceLog[] }) {
  if (!logs.length) return <p className="text-sm text-muted-foreground">Chưa có hoạt động nào.</p>;
  return (
    <ol className="relative space-y-3 border-l pl-5">
      {logs.map((l) => {
        const ok = l.status === 'ok';
        const hasDetail = l.request != null || l.response != null;
        return (
          <li key={l.id} className="relative">
            <span className={cn('absolute -left-[27px] top-1 flex size-4 items-center justify-center rounded-full border-2 border-background', ok ? 'bg-emerald-500' : 'bg-red-500')}>
              {ok ? <CheckCircle2 className="size-3 text-white" /> : <XCircle className="size-3 text-white" />}
            </span>
            <Collapsible>
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{LOG_ACTION_LABEL[l.action] ?? l.action}</span>
                <span className={cn('text-xs', ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{ok ? 'Thành công' : 'Lỗi'}</span>
                <span className="ml-auto text-xs text-muted-foreground" title={formatDate(l.createdAt, 'dd/MM/yyyy HH:mm:ss')}>
                  {timeAgo(l.createdAt)}
                </span>
              </div>
              {l.message && <p className={cn('mt-0.5 text-xs', ok ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400')}>{l.message}</p>}
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{l.actorName ?? 'Hệ thống'}</span>
                {hasDetail && (
                  <CollapsibleTrigger className="inline-flex items-center gap-0.5 hover:text-foreground [&[data-state=open]>svg]:rotate-180">
                    Chi tiết <ChevronDown className="size-3 transition" />
                  </CollapsibleTrigger>
                )}
              </div>
              {hasDetail && (
                <CollapsibleContent className="mt-2 space-y-2">
                  <JsonBlock label="Request" value={l.request} />
                  <JsonBlock label="Response" value={l.response} />
                </CollapsibleContent>
              )}
            </Collapsible>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Trang chi tiết
// ---------------------------------------------------------------------------

function InvoiceDetail({ id }: { id: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canWrite = can('einvoice.write');
  const canCancel = can('einvoice.cancel');
  const providers = useEInvoiceProviders();
  const settings = useSettingGroup<{ defaultUnit?: string; defaultVatRate?: number }>('einvoice', canWrite && can('settings.manage'));
  const query = useQuery({ queryKey: ['einvoice', id], queryFn: () => api.get<EInvoiceDetail>(`/admin/einvoices/${id}`) });
  const inv = query.data;
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [editing, setEditing] = useState(false);
  const [form, setFormState] = useState<FormState | null>(null);
  const setForm = useCallback((p: Partial<FormState>) => setFormState((f) => (f ? { ...f, ...p } : f)), []);

  const editable = !!inv && canWrite && EDITABLE_STATUSES.includes(inv.status);
  const vatRates: VatRateOption[] | undefined = providers.data?.vatRates;

  /** Form từ dữ liệu hoá đơn */
  const fromInvoice = useCallback(
    (i: EInvoiceDetail): FormState => ({
      buyer: i.buyer ?? {},
      lines: toEditableLines(i.items),
      note: i.note ?? '',
      paymentMethod: i.paymentMethod ?? '',
      invoiceDate: toDay(i.invoiceDate),
      templateCode: i.templateCode ?? '',
      serial: i.serial ?? '',
    }),
    [],
  );

  // đang sửa thì nạp form; tắt sửa khi hoá đơn không còn sửa được
  useEffect(() => {
    if (inv && editing && !form) setFormState(fromInvoice(inv));
    if (inv && !EDITABLE_STATUSES.includes(inv.status) && editing) {
      setEditing(false);
      setFormState(null);
    }
  }, [inv, editing, form, fromInvoice]);

  const dirty = useMemo(() => !!(inv && form && editing && JSON.stringify(formToPayload(form)) !== JSON.stringify(formToPayload(fromInvoice(inv)))), [inv, form, editing, fromInvoice]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['einvoice', id] });
    void qc.invalidateQueries({ queryKey: ['einvoices'] });
    void qc.invalidateQueries({ queryKey: ['einvoice-stats'] });
    void qc.invalidateQueries({ queryKey: ['admin-badges'] });
    if (inv?.orderId) void qc.invalidateQueries({ queryKey: ['order', inv.orderId] });
  };

  const save = useMutation({
    mutationFn: () => api.put<EInvoiceDetail>(`/admin/einvoices/${id}`, formToPayload(form!)),
    onSuccess: (data) => {
      toast.success('Đã lưu hoá đơn nháp');
      qc.setQueryData(['einvoice', id], data);
      setEditing(false);
      setFormState(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const issue = useMutation({
    mutationFn: async () => {
      // còn thay đổi chưa lưu -> lưu trước rồi phát hành
      if (dirty) await api.put(`/admin/einvoices/${id}`, formToPayload(form!));
      return api.post<EInvoiceDetail>(`/admin/einvoices/${id}/issue`);
    },
    onSuccess: (data) => {
      toast.success(data.status === 'ISSUED' ? 'Đã phát hành hoá đơn' : 'Đã gửi yêu cầu phát hành, đang chờ nhà cung cấp');
      setEditing(false);
      setFormState(null);
      refresh();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refresh();
    },
  });

  const sync = useMutation({
    mutationFn: () => api.post(`/admin/einvoices/${id}/sync`),
    onSuccess: () => {
      toast.success('Đã đồng bộ với nhà cung cấp');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/einvoices/${id}`),
    onSuccess: () => {
      toast.success('Đã xoá hoá đơn nháp');
      void qc.invalidateQueries({ queryKey: ['einvoices'] });
      void qc.invalidateQueries({ queryKey: ['einvoice-stats'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      if (inv?.orderId) void qc.invalidateQueries({ queryKey: ['order', inv.orderId] });
      router.replace('/orders/einvoices');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (dirty && !save.isPending) save.mutate();
  }, [dirty, save]);
  useUnsavedGuard(dirty, doSave);

  if (query.isLoading) {
    return (
      <>
        <PageHeader title="Hoá đơn điện tử" breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Hoá đơn điện tử', href: '/orders/einvoices' }]} />
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
  if (!inv) {
    return (
      <>
        <PageHeader title="Hoá đơn điện tử" breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Hoá đơn điện tử', href: '/orders/einvoices' }]} />
        <PageBody>
          <EmptyState
            icon={FileText}
            title="Không tìm thấy hoá đơn"
            description={query.error ? errorMessage(query.error) : undefined}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/orders/einvoices">Về danh sách</Link>
              </Button>
            }
          />
        </PageBody>
      </>
    );
  }

  const cap = inv.capabilities;
  const isManual = inv.provider === 'manual';
  const issued = ['ISSUED', 'ADJUSTED'].includes(inv.status);
  const hasFile = ['ISSUED', 'ADJUSTED', 'REPLACED', 'CANCELLED'].includes(inv.status);
  const canPdf = hasFile && (!!inv.pdfPath || (!isManual && (cap?.pdf ?? false)));
  const canXml = hasFile && (!!inv.xmlPath || (!isManual && (cap?.xml ?? false)));
  const canIssue = canWrite && ['DRAFT', 'FAILED', 'QUEUED'].includes(inv.status);
  const canManual = canWrite && ['DRAFT', 'FAILED', 'QUEUED', 'ISSUING'].includes(inv.status) && (isManual || inv.status === 'FAILED' || inv.status === 'ISSUING');
  const canSync = ['ISSUING', 'ISSUED', 'ADJUSTED', 'QUEUED'].includes(inv.status) && !!cap?.sync;
  const canDoCancel = canCancel && issued;
  const canReplace = canCancel && issued && (cap?.replace ?? isManual);
  const canAdjust = canCancel && inv.status === 'ISSUED' && (cap?.adjust ?? isManual);
  const canEmail = canWrite && issued;
  const canDelete = canWrite && EDITABLE_STATUSES.includes(inv.status);
  const no = invoiceNumber(inv);
  const currency = inv.currency || 'VND';
  const decimals = currency === 'VND' ? 0 : 2;
  const liveTotals = editing && form ? summarizeLines(form.lines, decimals) : null;
  const storedTotals = summarizeLines(inv.items ?? [], decimals);
  const valid = !form || (form.lines.length > 0 && form.lines.every((l) => l.name.trim() && l.quantity > 0));
  const Spinner = <Loader2 className="animate-spin" />;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {no ? <span className="font-mono">{no}</span> : `Hoá đơn ${EINVOICE_KIND_LABEL[inv.kind]?.toLowerCase() ?? ''} (chưa có số)`}
            <EInvoiceStatusBadge status={inv.status} />
            <EInvoiceKindBadge kind={inv.kind} />
          </span>
        }
        description={`${inv.providerName} · Tạo ${formatDate(inv.createdAt)}${inv.issuedAt ? ` · Phát hành ${formatDate(inv.issuedAt)}` : ''}`}
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Hoá đơn điện tử', href: '/orders/einvoices' }, { label: no ?? 'Chi tiết' }]}
        actions={
          <>
            {editing ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setFormState(null);
                  }}
                >
                  Huỷ sửa
                </Button>
                <Button variant="outline" size="sm" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? Spinner : <Save />} Lưu nháp
                </Button>
              </>
            ) : (
              editable && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil /> Sửa nội dung
                </Button>
              )
            )}
            {canIssue && (
              <Button size="sm" disabled={issue.isPending || !valid} onClick={() => issue.mutate()}>
                {issue.isPending ? Spinner : <Send />} Phát hành ngay
              </Button>
            )}
            {canPdf && (
              <Button variant="outline" size="sm" onClick={() => void openEInvoicePdf(inv.id)}>
                <FileDown /> Xem PDF
              </Button>
            )}
            {/* Bản thể hiện HTML để in / lưu PDF — luôn có, kể cả khi NCC chưa trả file */}
            <Button variant="outline" size="sm" onClick={() => void openEInvoicePrint(inv.id)}>
              <Printer /> In bản thể hiện
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          {/* Cột trái */}
          <div className="min-w-0 space-y-6">
            {inv.status === 'FAILED' && inv.errorMessage && (
              <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium">Phát hành thất bại{inv.attempts > 1 ? ` (đã thử ${inv.attempts} lần)` : ''}</p>
                  <p className="break-words">{inv.errorMessage}</p>
                  <p className="mt-1 text-xs opacity-80">Sửa lại nội dung (nếu lỗi dữ liệu) rồi bấm “Phát hành ngay”, hoặc “Nhập tay kết quả” nếu đã phát hành trên cổng nhà cung cấp.</p>
                </div>
              </div>
            )}
            {inv.status === 'ISSUING' && (
              <div className="flex gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300">
                <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
                <p>Nhà cung cấp đã nhận hoá đơn, đang chờ ký số / cấp mã cơ quan thuế. Bấm “Đồng bộ” để cập nhật kết quả.</p>
              </div>
            )}
            {(inv.status === 'CANCELLED' || inv.status === 'REPLACED') && (inv.cancelReason || inv.reason) && (
              <div className="rounded-xl border bg-muted/40 p-4 text-sm">
                <span className="text-muted-foreground">{inv.status === 'CANCELLED' ? 'Lý do huỷ: ' : 'Lý do thay thế: '}</span>
                {inv.cancelReason || inv.reason}
                {inv.cancelledAt && <span className="text-xs text-muted-foreground"> · {formatDate(inv.cancelledAt)}</span>}
              </div>
            )}
            {inv.kind !== 'ORIGINAL' && inv.reason && inv.status !== 'CANCELLED' && (
              <div className="rounded-xl border bg-muted/40 p-4 text-sm">
                <span className="text-muted-foreground">Lý do {EINVOICE_KIND_LABEL[inv.kind]?.toLowerCase()}: </span>
                {inv.reason}
              </div>
            )}

            <Section title="Thông tin hoá đơn">
              {editing && form ? (
                <InvoiceMetaFields form={form} setForm={setForm} />
              ) : (
                <div className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
                  <Dl
                    rows={[
                      { label: 'Mẫu số', value: inv.templateCode, mono: true },
                      { label: 'Ký hiệu', value: inv.serial, mono: true },
                      { label: 'Số hoá đơn', value: inv.invoiceNo ? <span className="font-semibold">{inv.invoiceNo}</span> : <span className="text-muted-foreground">Chưa cấp</span>, mono: true },
                      {
                        label: 'Mã CQT',
                        value: inv.taxAuthorityCode ? (
                          <span className="inline-flex items-center gap-1 break-all">
                            {inv.taxAuthorityCode} <CopyBtn text={inv.taxAuthorityCode} />
                          </span>
                        ) : undefined,
                        mono: true,
                      },
                      {
                        label: 'Mã tra cứu',
                        value: inv.lookupCode ? (
                          <span className="inline-flex items-center gap-1">
                            {inv.lookupCode} <CopyBtn text={inv.lookupCode} />
                            {inv.lookupUrl && (
                              <a href={inv.lookupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                                Tra cứu <ExternalLink className="size-3" />
                              </a>
                            )}
                          </span>
                        ) : inv.lookupUrl ? (
                          <a href={inv.lookupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                            Trang tra cứu <ExternalLink className="size-3" />
                          </a>
                        ) : undefined,
                        mono: true,
                      },
                    ]}
                  />
                  <Dl
                    rows={[
                      { label: 'Nhà cung cấp', value: inv.providerName },
                      { label: 'Ngày lập', value: formatDate(inv.invoiceDate, 'dd/MM/yyyy') },
                      { label: 'Phát hành', value: inv.issuedAt ? formatDate(inv.issuedAt) : undefined },
                      { label: 'Thanh toán', value: inv.paymentMethod },
                      { label: 'Email đã gửi', value: inv.emailSentAt ? formatDate(inv.emailSentAt) : undefined },
                      { label: 'Ghi chú', value: inv.note },
                      { label: 'Mã tham chiếu NCC', value: inv.providerRef, mono: true },
                    ]}
                  />
                </div>
              )}
            </Section>

            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Người bán">
                <SellerView seller={inv.seller} />
              </Section>
              <Section
                title="Người mua"
                description={inv.order?.invoiceRequest?.requested ? 'Khách có yêu cầu xuất hoá đơn khi đặt hàng' : undefined}
                className={editing ? 'lg:col-span-2' : undefined}
              >
                {editing && form ? <BuyerForm buyer={form.buyer} onChange={(buyer) => setForm({ buyer })} /> : <BuyerView buyer={inv.buyer} />}
              </Section>
            </div>

            <Section title="Hàng hoá, dịch vụ" description={editing ? 'Đơn giá chưa gồm VAT; thành tiền và tiền thuế tự tính' : undefined}>
              {editing && form ? (
                <LineItemsTable lines={form.lines} onChange={(lines) => setForm({ lines })} editable adjustment={inv.kind === 'ADJUSTMENT'} vatRates={vatRates} currency={currency} defaultUnit={settings.data?.defaultUnit ?? 'Cái'} defaultVatRate={settings.data?.defaultVatRate ?? 10} />
              ) : (
                <LineItemsTable lines={toEditableLines(inv.items)} adjustment={inv.kind === 'ADJUSTMENT'} vatRates={vatRates} currency={currency} />
              )}
              <div className="border-t pt-4">
                <InvoiceTotalsView totals={liveTotals ?? { ...storedTotals, subtotal: toNum(inv.subtotal) || storedTotals.subtotal, vatTotal: toNum(inv.vatTotal) || storedTotals.vatTotal, total: toNum(inv.total) || storedTotals.total }} currency={currency} vatRates={vatRates} />
              </div>
            </Section>

            <Section title="Nhật ký" description="Các lần gọi nhà cung cấp và thao tác của quản trị viên">
              <LogsTimeline logs={inv.logs ?? []} />
            </Section>
          </div>

          {/* Cột phải */}
          <div className="space-y-6">
            {(canIssue || canManual || canSync || canDoCancel || canReplace || canAdjust || canEmail || canPdf || canXml || canDelete) && (
              <Section title="Thao tác">
                <div className="grid gap-2">
                  {canIssue && (
                    <Button className="w-full" disabled={issue.isPending || !valid} onClick={() => issue.mutate()}>
                      {issue.isPending ? Spinner : <Send />} Phát hành ngay
                    </Button>
                  )}
                  {canManual && (
                    <Button variant="outline" className="w-full" onClick={() => setDialog('manual')}>
                      <ClipboardEdit /> Nhập tay kết quả
                    </Button>
                  )}
                  {canSync && (
                    <Button variant="outline" className="w-full" disabled={sync.isPending} onClick={() => sync.mutate()}>
                      {sync.isPending ? Spinner : <RefreshCw />} Đồng bộ với NCC
                    </Button>
                  )}
                  {canEmail && (
                    <Button variant="outline" className="w-full" onClick={() => setDialog('email')}>
                      <Mail /> Gửi email người mua
                    </Button>
                  )}
                  {(canPdf || canXml) && (
                    <div className="grid grid-cols-2 gap-2">
                      {canPdf && (
                        <Button variant="outline" onClick={() => void downloadEInvoiceFile(inv, 'pdf')}>
                          <FileDown /> Tải PDF
                        </Button>
                      )}
                      {canXml && (
                        <Button variant="outline" onClick={() => void downloadEInvoiceFile(inv, 'xml')}>
                          <FileCode2 /> Tải XML
                        </Button>
                      )}
                    </div>
                  )}
                  {(canReplace || canAdjust) && (
                    <div className="grid grid-cols-2 gap-2 border-t pt-2">
                      {canReplace && (
                        <Button variant="outline" onClick={() => setDialog('replace')}>
                          <ArrowLeftRight /> Thay thế
                        </Button>
                      )}
                      {canAdjust && (
                        <Button variant="outline" onClick={() => setDialog('adjust')}>
                          <Pencil /> Điều chỉnh
                        </Button>
                      )}
                    </div>
                  )}
                  {canDoCancel && (
                    <Button variant="destructive" className="w-full" onClick={() => setDialog('cancel')}>
                      <Ban /> Huỷ hoá đơn
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="ghost"
                      className="w-full text-destructive hover:text-destructive"
                      disabled={remove.isPending}
                      onClick={async () => {
                        if (await confirm({ title: 'Xoá hoá đơn nháp?', description: 'Hoá đơn chưa phát hành sẽ bị xoá khỏi hệ thống. Không thể khôi phục.', confirmText: 'Xoá', destructive: true })) remove.mutate();
                      }}
                    >
                      {remove.isPending ? Spinner : <Trash2 />} Xoá nháp
                    </Button>
                  )}
                </div>
              </Section>
            )}

            {inv.order && (
              <Section title="Đơn hàng">
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/orders/${inv.order.id}`} className="font-mono font-semibold hover:text-primary">
                      #{inv.order.code}
                    </Link>
                    <span className="font-semibold tabular-nums">{formatMoney(toNum(inv.order.total), currency)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={inv.order.status} />
                    <StatusBadge status={inv.order.paymentStatus} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {inv.order.customerName}
                    {inv.order.customerPhone && ` · ${inv.order.customerPhone}`}
                    {inv.order.customerEmail && ` · ${inv.order.customerEmail}`}
                  </div>
                  {inv.order.invoiceRequest?.requested && (
                    <div className="rounded-lg border bg-muted/40 p-2.5 text-xs">
                      <p className="mb-1 font-medium">Yêu cầu xuất HĐ của khách</p>
                      <Dl
                        rows={[
                          { label: 'Loại', value: inv.order.invoiceRequest.type === 'company' ? 'Công ty' : 'Cá nhân' },
                          { label: 'Tên', value: inv.order.invoiceRequest.name },
                          { label: 'MST', value: inv.order.invoiceRequest.taxCode, mono: true },
                          { label: 'CCCD', value: inv.order.invoiceRequest.idNumber, mono: true },
                          { label: 'Địa chỉ', value: inv.order.invoiceRequest.address },
                          { label: 'Email', value: inv.order.invoiceRequest.email },
                        ]}
                      />
                    </div>
                  )}
                  <Button variant="outline" size="sm" asChild className="w-full">
                    <Link href={`/orders/${inv.order.id}`}>
                      <ShoppingCart /> Mở đơn hàng
                    </Link>
                  </Button>
                </div>
              </Section>
            )}

            {(inv.original || inv.derived?.length > 0) && (
              <Section title="Hoá đơn liên quan">
                <div className="space-y-2 text-sm">
                  {inv.original && (
                    <Link href={`/orders/einvoices/${inv.original.id}`} className="flex items-center justify-between gap-2 rounded-lg border p-2.5 transition hover:bg-muted/50">
                      <div className="min-w-0">
                        <div className="text-xs text-muted-foreground">Hoá đơn gốc</div>
                        <div className="truncate font-mono font-medium">{invoiceNumber(inv.original) ?? 'Chưa có số'}</div>
                      </div>
                      <EInvoiceStatusBadge status={inv.original.status} />
                    </Link>
                  )}
                  {inv.derived?.map((d) => (
                    <Link key={d.id} href={`/orders/einvoices/${d.id}`} className="flex items-center justify-between gap-2 rounded-lg border p-2.5 transition hover:bg-muted/50">
                      <div className="min-w-0">
                        <div className="text-xs text-muted-foreground">
                          HĐ {EINVOICE_KIND_LABEL[d.kind]?.toLowerCase()} · {formatMoney(toNum(d.total), currency)}
                        </div>
                        <div className="truncate font-mono font-medium">{invoiceNumber(d) ?? 'Chưa có số'}</div>
                        {d.reason && <div className="truncate text-xs text-muted-foreground">{d.reason}</div>}
                      </div>
                      <EInvoiceStatusBadge status={d.status} />
                    </Link>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Thông tin khác">
              <Dl
                rows={[
                  { label: 'Loại', value: EINVOICE_KIND_LABEL[inv.kind] },
                  { label: 'Tiền tệ', value: currency },
                  { label: 'Số lần thử', value: inv.attempts > 0 ? String(inv.attempts) : undefined },
                  { label: 'Tạo lúc', value: formatDate(inv.createdAt) },
                  { label: 'Trạng thái', value: ACTIVE_STATUSES.includes(inv.status) ? 'Còn hiệu lực' : 'Không còn hiệu lực' },
                ]}
              />
            </Section>
          </div>
        </div>
      </PageBody>

      {dialog === 'cancel' && <CancelInvoiceDialog inv={inv} onClose={() => setDialog(null)} />}
      {dialog === 'replace' && <ReplaceInvoiceDialog inv={inv} onClose={() => setDialog(null)} />}
      {dialog === 'adjust' && <AdjustInvoiceDialog inv={inv} onClose={() => setDialog(null)} vatRates={vatRates} defaultUnit={settings.data?.defaultUnit} />}
      {dialog === 'manual' && <ManualResultDialog inv={inv} onClose={() => setDialog(null)} />}
      {dialog === 'email' && <SendInvoiceEmailDialog inv={inv} onClose={() => setDialog(null)} />}
    </>
  );
}

export default function EInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense>{id === 'new' ? <NewInvoice /> : <InvoiceDetail id={id} />}</Suspense>;
}
