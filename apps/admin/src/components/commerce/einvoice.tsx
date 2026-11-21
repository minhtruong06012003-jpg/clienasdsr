'use client';

/**
 * Thành phần dùng chung cho module Hoá đơn điện tử (HĐĐT):
 * kiểu dữ liệu, nhãn trạng thái/loại, badge, tải PDF/XML kèm token,
 * tính toán dòng hàng và bảng sửa dòng hàng (dùng ở trang chi tiết, trang tạo và dialog điều chỉnh).
 */

import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu (khớp API /admin/einvoices)
// ---------------------------------------------------------------------------

export type EInvoiceStatus = 'DRAFT' | 'QUEUED' | 'ISSUING' | 'ISSUED' | 'CANCELLED' | 'REPLACED' | 'ADJUSTED' | 'FAILED';
export type EInvoiceKind = 'ORIGINAL' | 'REPLACEMENT' | 'ADJUSTMENT';
export type LineKind = 'product' | 'shipping' | 'discount' | 'note';
export type Adjustment = 'increase' | 'decrease';

export interface ProviderField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select' | 'boolean' | 'number' | 'textarea';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: unknown;
  env?: 'sandbox' | 'production';
}

export interface ProviderCapabilities {
  draft?: boolean;
  cancel: boolean;
  replace: boolean;
  adjust: boolean;
  pdf: boolean;
  xml: boolean;
  sync: boolean;
  testConnection: boolean;
  lookup: boolean;
}

export interface ProviderMeta {
  key: string;
  name: string;
  description: string;
  website?: string;
  docsUrl?: string;
  signing: 'hsm' | 'server' | 'usb' | 'none';
  fields: ProviderField[];
  capabilities: ProviderCapabilities;
  notes?: string[];
}

export interface VatRateOption {
  value: number;
  label: string;
  code: string;
}

export interface ProvidersResponse {
  active: string;
  environment: 'sandbox' | 'production';
  providers: ProviderMeta[];
  vatRates: VatRateOption[];
}

export interface InvoiceBuyer {
  name?: string;
  legalName?: string;
  taxCode?: string;
  address?: string;
  email?: string;
  phone?: string;
  idNumber?: string;
  bankAccount?: string;
  bankName?: string;
  budgetCode?: string;
  anonymous?: boolean;
}

export interface InvoiceSeller {
  name: string;
  taxCode: string;
  address: string;
  phone?: string;
  email?: string;
  bankAccount?: string;
  bankName?: string;
}

/** Dòng hàng trả về từ API (đã tính sẵn tiền) */
export interface InvoiceLine {
  index: number;
  kind: LineKind;
  name: string;
  sku?: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  adjustment?: Adjustment;
}

/** Dòng hàng admin nhập (gửi lên API) */
export interface LineInput {
  name: string;
  sku?: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  vatRate: number;
  kind?: LineKind;
  adjustment?: Adjustment;
}

export interface VatBreakdown {
  vatRate: number;
  amount: number;
  vatAmount: number;
}

export interface InvoiceTotals {
  subtotal: number;
  discountTotal: number;
  vatTotal: number;
  total: number;
  totalInWords?: string;
  breakdown: VatBreakdown[];
}

export interface InvoiceRequest {
  requested: boolean;
  type?: 'company' | 'personal';
  name?: string;
  taxCode?: string;
  address?: string;
  email?: string;
  idNumber?: string;
}

/** Một dòng trong danh sách hoá đơn */
export interface EInvoiceRow {
  id: string;
  orderId: string | null;
  provider: string;
  kind: EInvoiceKind;
  status: EInvoiceStatus;
  templateCode: string | null;
  serial: string | null;
  invoiceNo: string | null;
  taxAuthorityCode: string | null;
  lookupCode: string | null;
  lookupUrl: string | null;
  buyer: InvoiceBuyer | null;
  total: unknown;
  vatTotal: unknown;
  subtotal: unknown;
  currency: string;
  invoiceDate: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  errorMessage: string | null;
  emailSentAt: string | null;
  createdAt: string;
  order: { id: string; code: string; customerName: string; total: unknown; status: string; paymentStatus: string } | null;
}

export interface EInvoiceLog {
  id: string;
  action: string;
  status: 'ok' | 'error';
  message: string | null;
  request: unknown;
  response: unknown;
  actorName: string | null;
  createdAt: string;
}

/** Chi tiết hoá đơn (GET /admin/einvoices/:id) */
export interface EInvoiceDetail extends EInvoiceRow {
  seller: InvoiceSeller | null;
  items: InvoiceLine[];
  note: string | null;
  paymentMethod: string | null;
  reason: string | null;
  cancelReason: string | null;
  attempts: number;
  providerRef: string | null;
  providerName: string;
  capabilities: ProviderCapabilities | null;
  pdfPath?: string | null;
  xmlPath?: string | null;
  order: (EInvoiceRow['order'] & { customerEmail: string | null; customerPhone: string; paymentMethod: string; invoiceRequest: InvoiceRequest | null; createdAt: string }) | null;
  original: { id: string; invoiceNo: string | null; serial: string | null; templateCode: string | null; status: EInvoiceStatus; issuedAt: string | null } | null;
  derived: { id: string; kind: EInvoiceKind; invoiceNo: string | null; serial: string | null; status: EInvoiceStatus; issuedAt: string | null; total: unknown; reason: string | null }[];
  logs: EInvoiceLog[];
}

/** Kết quả xem trước (POST /admin/einvoices/preview) */
export interface EInvoicePreview {
  buyer: InvoiceBuyer;
  seller: InvoiceSeller;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  paymentMethod: string;
  templateCode: string;
  serial: string;
  provider: string;
  warnings: string[];
}

/** Hoá đơn gắn trong chi tiết đơn hàng (GET /admin/orders/:id → eInvoices) */
export interface OrderEInvoice {
  id: string;
  status: EInvoiceStatus;
  kind: EInvoiceKind;
  invoiceNo: string | null;
  serial: string | null;
  templateCode: string | null;
  taxAuthorityCode: string | null;
  lookupCode: string | null;
  lookupUrl: string | null;
  issuedAt: string | null;
  total: unknown;
  pdfPath: string | null;
  errorMessage: string | null;
  provider: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Nhãn & badge
// ---------------------------------------------------------------------------

export const EINVOICE_STATUSES: { value: EInvoiceStatus; label: string; className: string }[] = [
  { value: 'DRAFT', label: 'Nháp', className: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  { value: 'QUEUED', label: 'Chờ phát hành', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  { value: 'ISSUING', label: 'Đang phát hành', className: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  { value: 'ISSUED', label: 'Đã phát hành', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  { value: 'CANCELLED', label: 'Đã huỷ', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  { value: 'REPLACED', label: 'Đã bị thay thế', className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  { value: 'ADJUSTED', label: 'Đã điều chỉnh', className: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
  { value: 'FAILED', label: 'Lỗi', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
];

export const EINVOICE_STATUS_LABEL: Record<string, string> = Object.fromEntries(EINVOICE_STATUSES.map((s) => [s.value, s.label]));

export const EINVOICE_KINDS: { value: EInvoiceKind; label: string }[] = [
  { value: 'ORIGINAL', label: 'Gốc' },
  { value: 'REPLACEMENT', label: 'Thay thế' },
  { value: 'ADJUSTMENT', label: 'Điều chỉnh' },
];
export const EINVOICE_KIND_LABEL: Record<string, string> = Object.fromEntries(EINVOICE_KINDS.map((k) => [k.value, k.label]));

/** Trạng thái còn "sống" (không huỷ / không bị thay thế) — đơn đã có HĐ hợp lệ thì không lập thêm */
export const ACTIVE_STATUSES: EInvoiceStatus[] = ['DRAFT', 'QUEUED', 'ISSUING', 'ISSUED', 'ADJUSTED'];
/** Trạng thái cho phép sửa nội dung hoá đơn */
export const EDITABLE_STATUSES: EInvoiceStatus[] = ['DRAFT', 'FAILED'];

export function EInvoiceStatusBadge({ status, className }: { status: string; className?: string }) {
  const m = EINVOICE_STATUSES.find((s) => s.value === status);
  return <Badge className={cn('border-transparent font-medium', m?.className ?? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', className)}>{m?.label ?? status}</Badge>;
}

export function EInvoiceKindBadge({ kind }: { kind: string }) {
  if (kind === 'ORIGINAL') return <span className="text-xs text-muted-foreground">Gốc</span>;
  return (
    <Badge variant="outline" className={cn('font-medium', kind === 'ADJUSTMENT' ? 'border-violet-300 text-violet-700 dark:border-violet-800 dark:text-violet-300' : 'border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300')}>
      {EINVOICE_KIND_LABEL[kind] ?? kind}
    </Badge>
  );
}

/** Số hoá đơn hiển thị: "C25TAA · 00000123" hoặc "(chưa có số)" */
export function invoiceNumber(inv: { invoiceNo?: string | null; serial?: string | null; templateCode?: string | null }) {
  if (!inv.invoiceNo) return null;
  return [inv.templateCode, inv.serial].filter(Boolean).join('') ? `${[inv.templateCode, inv.serial].filter(Boolean).join('')} · ${inv.invoiceNo}` : inv.invoiceNo;
}

/** Nhãn thuế suất: 10 -> "10%", -1 -> "KCT" */
export function vatLabel(rate: number, rates?: VatRateOption[]) {
  const r = rates?.find((x) => x.value === rate);
  if (r) return rate >= 0 ? r.label : r.code;
  return rate >= 0 ? `${rate}%` : rate === -1 ? 'KCT' : rate === -2 ? 'KKKNT' : 'Khác';
}

export const LINE_KIND_LABEL: Record<LineKind, string> = { product: 'Hàng hoá', shipping: 'Vận chuyển', discount: 'Chiết khấu', note: 'Ghi chú' };

/** Meta nhà cung cấp + thuế suất (cache 5 phút) */
export function useEInvoiceProviders(enabled = true) {
  return useQuery({ queryKey: ['einvoice-providers'], queryFn: () => api.get<ProvidersResponse>('/admin/einvoices/providers'), staleTime: 5 * 60_000, enabled });
}

export function providerLabel(key: string | null | undefined, providers?: ProviderMeta[]) {
  if (!key || key === 'none') return 'Chưa chọn';
  return providers?.find((p) => p.key === key)?.name ?? key;
}

// ---------------------------------------------------------------------------
// Tải file PDF/XML (API cần token Bearer -> fetch blob rồi mở/tải)
// ---------------------------------------------------------------------------

/** Mở PDF ở tab mới (mở tab ngay trong sự kiện click để không bị chặn popup) */
export async function openEInvoicePdf(id: string) {
  const w = window.open('', '_blank');
  try {
    const res = await api.raw(`/admin/einvoices/${id}/pdf`, { inline: '1' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data as { message?: string } | null)?.message || 'Không tải được PDF');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (!w) throw new Error('Trình duyệt chặn mở tab mới');
    w.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    w?.close();
    toast.error(errorMessage(e));
  }
}

/** Mở bản thể hiện HTML (in / lưu PDF từ trình duyệt) trong tab mới */
export async function openEInvoicePrint(id: string) {
  const w = window.open('', '_blank');
  try {
    const res = await api.raw(`/admin/einvoices/${id}/print`);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data as { message?: string } | null)?.message || 'Không tạo được bản thể hiện');
    }
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

/** Tải PDF/XML về máy */
export async function downloadEInvoiceFile(inv: { id: string; invoiceNo?: string | null; serial?: string | null }, type: 'pdf' | 'xml') {
  const name = `HD-${inv.serial ?? ''}-${inv.invoiceNo ?? inv.id.slice(0, 8)}.${type}`.replace(/\s+/g, '');
  try {
    await api.download(`/admin/einvoices/${inv.id}/${type}`, name);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

// ---------------------------------------------------------------------------
// Tính toán dòng hàng (đồng bộ công thức với API: đơn giá chưa VAT)
// ---------------------------------------------------------------------------

/** Làm tròn theo số lẻ tiền tệ (VND = 0) */
export function roundMoney(v: number, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round((v + Number.EPSILON) * f) / f;
}

/** Dòng hàng đang soạn trên form (có key ổn định cho React) */
export interface EditableLine extends LineInput {
  key: string;
}

export const newLineKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));

/** Chuyển dòng API -> dòng soạn thảo */
export function toEditableLines(lines: InvoiceLine[] | LineInput[] | null | undefined): EditableLine[] {
  return (lines ?? []).map((l) => ({
    key: newLineKey(),
    name: l.name,
    sku: l.sku ?? undefined,
    unit: l.unit ?? undefined,
    quantity: Number(l.quantity) || 0,
    unitPrice: Number(l.unitPrice) || 0,
    discount: Number(l.discount) || 0,
    vatRate: Number(l.vatRate) || 0,
    kind: l.kind ?? 'product',
    adjustment: l.adjustment,
  }));
}

/** Dòng soạn thảo -> payload gửi API */
export function linesToPayload(lines: EditableLine[]): LineInput[] {
  return lines.map(({ key: _key, ...l }) => ({
    ...l,
    name: l.name.trim(),
    sku: l.sku?.trim() || undefined,
    unit: l.unit?.trim() || undefined,
    discount: l.discount || undefined,
  }));
}

/** Tính tiền một dòng: thành tiền (chưa VAT), VAT, tổng */
export function calcLine(l: LineInput, decimals = 0) {
  const amount = roundMoney(l.quantity * l.unitPrice - (l.discount ?? 0), decimals);
  const pct = l.vatRate > 0 ? l.vatRate : 0;
  const vatAmount = roundMoney((amount * pct) / 100, decimals);
  return { amount, vatAmount, total: roundMoney(amount + vatAmount, decimals) };
}

/** Tổng hợp các dòng: tổng chưa thuế, VAT, tổng thanh toán + theo từng thuế suất. Dòng điều chỉnh giảm tính âm. */
export function summarizeLines(lines: LineInput[], decimals = 0): InvoiceTotals {
  const byRate = new Map<number, VatBreakdown>();
  let subtotal = 0;
  let discountTotal = 0;
  let vatTotal = 0;
  for (const l of lines) {
    const sign = l.adjustment === 'decrease' ? -1 : 1;
    const c = calcLine(l, decimals);
    subtotal += sign * c.amount;
    discountTotal += sign * (l.discount ?? 0);
    vatTotal += sign * c.vatAmount;
    const b = byRate.get(l.vatRate) ?? { vatRate: l.vatRate, amount: 0, vatAmount: 0 };
    b.amount += sign * c.amount;
    b.vatAmount += sign * c.vatAmount;
    byRate.set(l.vatRate, b);
  }
  return {
    subtotal: roundMoney(subtotal, decimals),
    discountTotal: roundMoney(discountTotal, decimals),
    vatTotal: roundMoney(vatTotal, decimals),
    total: roundMoney(subtotal + vatTotal, decimals),
    breakdown: [...byRate.values()].map((b) => ({ ...b, amount: roundMoney(b.amount, decimals), vatAmount: roundMoney(b.vatAmount, decimals) })),
  };
}

// ---------------------------------------------------------------------------
// Bảng dòng hàng (xem / sửa)
// ---------------------------------------------------------------------------

/** Ô số: cho gõ tự do, chuyển sang number khi đổi */
function NumCell({ value, onChange, min = 0, step, className }: { value: number; onChange: (n: number) => void; min?: number; step?: number | 'any'; className?: string }) {
  return <Input type="number" min={min} step={step ?? 'any'} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(Number(e.target.value) || 0)} className={cn('h-8 text-right tabular-nums', className)} />;
}

/**
 * Bảng dòng hàng của hoá đơn.
 * - `editable`: thêm/xoá dòng, sửa tên, ĐVT, SL, đơn giá chưa VAT, chiết khấu, thuế suất; tự tính thành tiền/VAT/tổng.
 * - `adjustment`: thêm cột Tăng/Giảm (hoá đơn điều chỉnh).
 */
export function LineItemsTable({
  lines,
  onChange,
  editable = false,
  adjustment = false,
  vatRates,
  currency = 'VND',
  defaultUnit = 'Cái',
  defaultVatRate = 10,
}: {
  lines: EditableLine[];
  onChange?: (lines: EditableLine[]) => void;
  editable?: boolean;
  adjustment?: boolean;
  vatRates?: VatRateOption[];
  currency?: string;
  defaultUnit?: string;
  defaultVatRate?: number;
}) {
  const decimals = currency === 'VND' ? 0 : 2;
  const money = (v: number) => formatMoney(v, currency);
  const patch = (key: string, p: Partial<EditableLine>) => onChange?.(lines.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: string) => onChange?.(lines.filter((l) => l.key !== key));
  const add = () => onChange?.([...lines, { key: newLineKey(), name: '', unit: defaultUnit, quantity: 1, unitPrice: 0, discount: 0, vatRate: defaultVatRate, kind: 'product', adjustment: adjustment ? 'increase' : undefined }]);
  const rates = vatRates ?? [
    { value: 0, label: '0%', code: '0' },
    { value: 5, label: '5%', code: '5' },
    { value: 8, label: '8%', code: '8' },
    { value: 10, label: '10%', code: '10' },
    { value: -1, label: 'Không chịu thuế (KCT)', code: 'KCT' },
    { value: -2, label: 'Không kê khai, tính nộp thuế (KKKNT)', code: 'KKKNT' },
    { value: -3, label: 'Khác', code: 'KHAC' },
  ];

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2 text-left">#</th>
              {adjustment && <th className="px-2 py-2 text-left">Loại</th>}
              <th className="min-w-[220px] px-2 py-2 text-left">Tên hàng hoá, dịch vụ</th>
              <th className="w-20 px-2 py-2 text-left">ĐVT</th>
              <th className="w-20 px-2 py-2 text-right">SL</th>
              <th className="w-32 px-2 py-2 text-right">Đơn giá</th>
              {editable && <th className="w-28 px-2 py-2 text-right">CK</th>}
              <th className="w-32 px-2 py-2 text-right">Thành tiền</th>
              <th className="w-28 px-2 py-2 text-left">Thuế</th>
              <th className="w-28 px-2 py-2 text-right">Tiền thuế</th>
              <th className="w-32 px-2 py-2 text-right">Tổng</th>
              {editable && <th className="w-8 px-1 py-2" />}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-muted-foreground">
                  Chưa có dòng hàng nào
                </td>
              </tr>
            )}
            {lines.map((l, i) => {
              const c = calcLine(l, decimals);
              const dec = l.adjustment === 'decrease';
              return (
                <tr key={l.key} className={cn('border-t align-top', dec && 'bg-red-50/60 dark:bg-red-950/20')}>
                  <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                  {adjustment && (
                    <td className="px-2 py-1.5">
                      {editable ? (
                        <Select value={l.adjustment ?? 'increase'} onValueChange={(v) => patch(l.key, { adjustment: v as Adjustment })}>
                          <SelectTrigger size="sm" className="w-24">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="increase">Tăng</SelectItem>
                            <SelectItem value="decrease">Giảm</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className={dec ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}>
                          {dec ? 'Giảm' : 'Tăng'}
                        </Badge>
                      )}
                    </td>
                  )}
                  <td className="px-2 py-1.5">
                    {editable ? (
                      <div className="space-y-1">
                        <Input value={l.name} onChange={(e) => patch(l.key, { name: e.target.value })} placeholder="Tên hàng hoá / dịch vụ" className="h-8" />
                        <Input value={l.sku ?? ''} onChange={(e) => patch(l.key, { sku: e.target.value })} placeholder="Mã (SKU, tuỳ chọn)" className="h-7 font-mono text-xs" />
                      </div>
                    ) : (
                      <div>
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.sku && <span className="font-mono">{l.sku} · </span>}
                          {LINE_KIND_LABEL[l.kind ?? 'product']}
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">{editable ? <Input value={l.unit ?? ''} onChange={(e) => patch(l.key, { unit: e.target.value })} className="h-8" /> : l.unit || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{editable ? <NumCell value={l.quantity} onChange={(quantity) => patch(l.key, { quantity })} /> : l.quantity.toLocaleString('vi-VN')}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{editable ? <NumCell value={l.unitPrice} onChange={(unitPrice) => patch(l.key, { unitPrice })} /> : money(l.unitPrice)}</td>
                  {editable && (
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      <NumCell value={l.discount ?? 0} onChange={(discount) => patch(l.key, { discount })} />
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {money(c.amount)}
                    {!editable && (l.discount ?? 0) > 0 && <div className="text-xs text-muted-foreground">CK {money(l.discount ?? 0)}</div>}
                  </td>
                  <td className="px-2 py-1.5">
                    {editable ? (
                      <Select value={String(l.vatRate)} onValueChange={(v) => patch(l.key, { vatRate: Number(v) })}>
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {rates.map((r) => (
                            <SelectItem key={r.value} value={String(r.value)}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      vatLabel(l.vatRate, vatRates)
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{money(c.vatAmount)}</td>
                  <td className={cn('px-2 py-1.5 text-right font-semibold tabular-nums', dec && 'text-red-600 dark:text-red-400')}>
                    {dec ? '−' : ''}
                    {money(c.total)}
                  </td>
                  {editable && (
                    <td className="px-1 py-1.5">
                      <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-destructive" onClick={() => remove(l.key)} aria-label="Xoá dòng">
                        <Trash2 />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus /> Thêm dòng
        </Button>
      )}
    </div>
  );
}

/** Tổng hợp theo thuế suất + tổng cộng (bằng số và bằng chữ nếu có) */
export function InvoiceTotalsView({ totals, currency = 'VND', vatRates }: { totals: InvoiceTotals; currency?: string; vatRates?: VatRateOption[] }) {
  const money = (v: number) => formatMoney(v, currency);
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Theo thuế suất</p>
        <table className="w-full max-w-md text-sm">
          <tbody>
            {totals.breakdown.length === 0 && (
              <tr>
                <td className="py-1 text-muted-foreground">—</td>
              </tr>
            )}
            {totals.breakdown.map((b) => (
              <tr key={b.vatRate} className="border-t first:border-t-0">
                <td className="py-1 text-muted-foreground">{vatLabel(b.vatRate, vatRates)}</td>
                <td className="py-1 text-right tabular-nums">{money(b.amount)}</td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">VAT {money(b.vatAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm md:ml-auto">
        <dt className="text-muted-foreground">Tiền hàng (chưa thuế)</dt>
        <dd className="text-right tabular-nums">{money(totals.subtotal)}</dd>
        {totals.discountTotal > 0 && (
          <>
            <dt className="text-muted-foreground">Chiết khấu</dt>
            <dd className="text-right tabular-nums">−{money(totals.discountTotal)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Tiền thuế GTGT</dt>
        <dd className="text-right tabular-nums">{money(totals.vatTotal)}</dd>
        <dt className="border-t pt-1.5 font-semibold">Tổng thanh toán</dt>
        <dd className="border-t pt-1.5 text-right text-base font-bold tabular-nums">{money(totals.total)}</dd>
        {totals.totalInWords && <dd className="col-span-2 text-right text-xs italic text-muted-foreground">{totals.totalInWords}</dd>}
      </dl>
    </div>
  );
}
