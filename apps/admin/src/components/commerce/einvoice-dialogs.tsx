'use client';

/**
 * Các hộp thoại hành động trên hoá đơn điện tử:
 * huỷ, lập hoá đơn thay thế, lập hoá đơn điều chỉnh, nhập tay kết quả phát hành, gửi email cho người mua.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { invoiceNumber, LineItemsTable, linesToPayload, summarizeLines, toEditableLines, type EditableLine, type EInvoiceDetail, type VatRateOption } from './einvoice';

type Props = { inv: EInvoiceDetail; onClose: () => void };

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

/** Mutation chung: báo toast, làm mới cache hoá đơn + danh sách + badge */
function useInvoiceMutation<TBody>(inv: EInvoiceDetail, fn: (body: TBody) => Promise<unknown>, successMsg: string, onDone: (res: unknown) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      toast.success(successMsg);
      void qc.invalidateQueries({ queryKey: ['einvoice', inv.id] });
      void qc.invalidateQueries({ queryKey: ['einvoices'] });
      void qc.invalidateQueries({ queryKey: ['einvoice-stats'] });
      void qc.invalidateQueries({ queryKey: ['admin-badges'] });
      if (inv.orderId) void qc.invalidateQueries({ queryKey: ['order', inv.orderId] });
      onDone(res);
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      // lỗi từ NCC vẫn ghi log / đổi trạng thái -> tải lại
      void qc.invalidateQueries({ queryKey: ['einvoice', inv.id] });
    },
  });
}

// ---------------- huỷ hoá đơn ----------------

export function CancelInvoiceDialog({ inv, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [localOnly, setLocalOnly] = useState(inv.provider === 'manual');
  const m = useInvoiceMutation(inv, (body: { reason: string; localOnly?: boolean }) => api.post(`/admin/einvoices/${inv.id}/cancel`, body), 'Đã huỷ hoá đơn', onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Huỷ hoá đơn {invoiceNumber(inv) ?? ''}</DialogTitle>
          <DialogDescription>Hoá đơn đã phát hành chỉ được huỷ khi có sai sót và chưa kê khai thuế, hoặc đã huỷ đơn hàng. Lý do sẽ được gửi tới nhà cung cấp và cơ quan thuế.</DialogDescription>
        </DialogHeader>
        <Field label="Lý do huỷ" required>
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Vd: Khách huỷ đơn hàng / Sai thông tin người mua" maxLength={500} />
        </Field>
        <CheckRow checked={localOnly} onChange={setLocalOnly} label="Chỉ đánh dấu huỷ trong hệ thống" description="Không gọi nhà cung cấp — dùng khi bạn đã huỷ tay trên cổng của nhà cung cấp hoặc dùng nhà cung cấp nhập tay." />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button variant="destructive" disabled={!reason.trim() || m.isPending} onClick={() => m.mutate({ reason: reason.trim(), localOnly: localOnly || undefined })}>
            {m.isPending && <Loader2 className="animate-spin" />} Huỷ hoá đơn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- lập hoá đơn thay thế ----------------

export function ReplaceInvoiceDialog({ inv, onClose }: Props) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [issueNow, setIssueNow] = useState(false);
  const m = useInvoiceMutation(inv, (body: { reason: string; issueNow?: boolean }) => api.post<{ id: string }>(`/admin/einvoices/${inv.id}/replace`, body), issueNow ? 'Đã lập và phát hành hoá đơn thay thế' : 'Đã lập hoá đơn thay thế (nháp)', (res) => {
    onClose();
    const id = (res as { id?: string } | null)?.id;
    if (id) router.push(`/orders/einvoices/${id}`);
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Lập hoá đơn thay thế</DialogTitle>
          <DialogDescription>
            Hoá đơn mới sao chép toàn bộ nội dung của hoá đơn {invoiceNumber(inv) ?? 'gốc'}; hoá đơn gốc chuyển sang “Đã bị thay thế”. Bạn có thể sửa nội dung ở hoá đơn nháp trước khi phát hành.
          </DialogDescription>
        </DialogHeader>
        <Field label="Lý do thay thế" required>
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Vd: Sai tên / địa chỉ người mua" maxLength={500} />
        </Field>
        <CheckRow checked={issueNow} onChange={setIssueNow} label="Phát hành ngay" description="Bỏ chọn để tạo hoá đơn nháp, sửa nội dung rồi phát hành sau." />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button disabled={!reason.trim() || m.isPending} onClick={() => m.mutate({ reason: reason.trim(), issueNow: issueNow || undefined })}>
            {m.isPending && <Loader2 className="animate-spin" />} {issueNow ? 'Lập & phát hành' : 'Lập hoá đơn nháp'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- lập hoá đơn điều chỉnh ----------------

export function AdjustInvoiceDialog({ inv, onClose, vatRates, defaultUnit }: Props & { vatRates?: VatRateOption[]; defaultUnit?: string }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [issueNow, setIssueNow] = useState(false);
  // mặc định: 1 dòng điều chỉnh trống
  const [lines, setLines] = useState<EditableLine[]>(() => toEditableLines([{ name: '', unit: defaultUnit ?? 'Cái', quantity: 1, unitPrice: 0, vatRate: inv.items[0]?.vatRate ?? 10, kind: 'product', adjustment: 'increase' }]));
  const decimals = inv.currency === 'VND' ? 0 : 2;
  const totals = summarizeLines(lines, decimals);
  const m = useInvoiceMutation(inv, (body: unknown) => api.post<{ id: string }>(`/admin/einvoices/${inv.id}/adjust`, body), issueNow ? 'Đã lập và phát hành hoá đơn điều chỉnh' : 'Đã lập hoá đơn điều chỉnh (nháp)', (res) => {
    onClose();
    const id = (res as { id?: string } | null)?.id;
    if (id) router.push(`/orders/einvoices/${id}`);
  });
  const valid = reason.trim() && lines.length > 0 && lines.every((l) => l.name.trim() && l.quantity > 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Lập hoá đơn điều chỉnh</DialogTitle>
          <DialogDescription>Chỉ ghi phần chênh lệch so với hoá đơn {invoiceNumber(inv) ?? 'gốc'}: dòng “Tăng” cộng thêm, dòng “Giảm” trừ đi (số lượng, đơn giá nhập số dương).</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <Field label="Lý do điều chỉnh" required>
            <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Vd: Điều chỉnh giảm đơn giá do nhập sai" maxLength={500} />
          </Field>
          <LineItemsTable lines={lines} onChange={setLines} editable adjustment vatRates={vatRates} currency={inv.currency} defaultUnit={defaultUnit} defaultVatRate={inv.items[0]?.vatRate ?? 10} />
          <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              Chênh lệch tiền hàng: <span className="font-medium text-foreground tabular-nums">{formatMoney(totals.subtotal, inv.currency)}</span>
            </span>
            <span className="text-muted-foreground">
              Chênh lệch VAT: <span className="font-medium text-foreground tabular-nums">{formatMoney(totals.vatTotal, inv.currency)}</span>
            </span>
            <span className="font-semibold tabular-nums">Tổng điều chỉnh: {formatMoney(totals.total, inv.currency)}</span>
          </div>
          <Field label="Ghi chú trên hoá đơn">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Tuỳ chọn" />
          </Field>
          <CheckRow checked={issueNow} onChange={setIssueNow} label="Phát hành ngay" description="Bỏ chọn để tạo hoá đơn nháp và kiểm tra lại trước khi phát hành." />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button disabled={!valid || m.isPending} onClick={() => m.mutate({ reason: reason.trim(), items: linesToPayload(lines), note: note.trim() || undefined, issueNow: issueNow || undefined })}>
            {m.isPending && <Loader2 className="animate-spin" />} {issueNow ? 'Lập & phát hành' : 'Lập hoá đơn nháp'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- nhập tay kết quả phát hành ----------------

export function ManualResultDialog({ inv, onClose }: Props) {
  const [form, setForm] = useState({
    invoiceNo: inv.invoiceNo ?? '',
    serial: inv.serial ?? '',
    templateCode: inv.templateCode ?? '',
    taxAuthorityCode: inv.taxAuthorityCode ?? '',
    lookupCode: inv.lookupCode ?? '',
    lookupUrl: inv.lookupUrl ?? '',
    issuedAt: (inv.issuedAt ?? new Date().toISOString()).slice(0, 16),
  });
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const m = useInvoiceMutation(inv, (body: unknown) => api.put(`/admin/einvoices/${inv.id}/manual`, body), 'Đã ghi nhận kết quả phát hành', onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nhập tay kết quả phát hành</DialogTitle>
          <DialogDescription>Dùng khi bạn đã phát hành hoá đơn trên cổng của nhà cung cấp và cần ghi lại số hoá đơn vào hệ thống. Hoá đơn sẽ chuyển sang “Đã phát hành”.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Mẫu số">
            <Input value={form.templateCode} onChange={(e) => set({ templateCode: e.target.value })} placeholder="1" className="font-mono" maxLength={20} />
          </Field>
          <Field label="Ký hiệu">
            <Input value={form.serial} onChange={(e) => set({ serial: e.target.value.toUpperCase() })} placeholder="C25TAA" className="font-mono" maxLength={20} />
          </Field>
          <Field label="Số hoá đơn" required>
            <Input autoFocus value={form.invoiceNo} onChange={(e) => set({ invoiceNo: e.target.value })} placeholder="00000123" className="font-mono" maxLength={20} />
          </Field>
        </div>
        <Field label="Mã cơ quan thuế" help="Chuỗi 34 ký tự trên hoá đơn có mã của CQT (bỏ trống nếu hoá đơn không mã)">
          <Input value={form.taxAuthorityCode} onChange={(e) => set({ taxAuthorityCode: e.target.value.trim() })} className="font-mono text-sm" maxLength={100} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mã tra cứu">
            <Input value={form.lookupCode} onChange={(e) => set({ lookupCode: e.target.value.trim() })} className="font-mono text-sm" maxLength={100} />
          </Field>
          <Field label="Ngày phát hành">
            <Input type="datetime-local" value={form.issuedAt} onChange={(e) => set({ issuedAt: e.target.value })} />
          </Field>
        </div>
        <Field label="Link tra cứu">
          <Input type="url" value={form.lookupUrl} onChange={(e) => set({ lookupUrl: e.target.value.trim() })} placeholder="https://..." maxLength={500} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button
            disabled={!form.invoiceNo.trim() || m.isPending}
            onClick={() =>
              m.mutate({
                invoiceNo: form.invoiceNo.trim(),
                serial: form.serial.trim() || undefined,
                templateCode: form.templateCode.trim() || undefined,
                taxAuthorityCode: form.taxAuthorityCode || undefined,
                lookupCode: form.lookupCode || undefined,
                lookupUrl: form.lookupUrl || undefined,
                issuedAt: form.issuedAt ? new Date(form.issuedAt).toISOString() : undefined,
              })
            }
          >
            {m.isPending && <Loader2 className="animate-spin" />} Ghi nhận
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- gửi email hoá đơn ----------------

export function SendInvoiceEmailDialog({ inv, onClose }: Props) {
  const [to, setTo] = useState(inv.buyer?.email || inv.order?.customerEmail || '');
  const canPdf = inv.provider !== 'manual' && (inv.capabilities?.pdf ?? true);
  const [attachPdf, setAttachPdf] = useState(canPdf);
  const m = useInvoiceMutation(inv, (body: { to?: string; attachPdf?: boolean }) => api.post(`/admin/einvoices/${inv.id}/send-email`, body), 'Đã gửi email hoá đơn', onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Gửi hoá đơn cho người mua</DialogTitle>
          <DialogDescription>Email gồm số hoá đơn, mã tra cứu và link tra cứu (nếu có). Cần cấu hình SMTP trong Cài đặt.</DialogDescription>
        </DialogHeader>
        <Field label="Gửi tới" required>
          <Input type="email" autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="email@khachhang.vn" />
        </Field>
        {canPdf && <CheckRow checked={attachPdf} onChange={setAttachPdf} label="Đính kèm file PDF" description="Tải PDF từ nhà cung cấp và đính kèm vào email." />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
          <Button disabled={!to.trim() || m.isPending} onClick={() => m.mutate({ to: to.trim(), attachPdf: canPdf ? attachPdf : false })}>
            {m.isPending && <Loader2 className="animate-spin" />} Gửi email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
