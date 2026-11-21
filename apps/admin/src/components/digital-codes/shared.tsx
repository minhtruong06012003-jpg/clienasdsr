'use client';

/**
 * Thành phần dùng chung của module "Kho mã số" (admin):
 * - khoá cache React Query + hàm làm mới toàn bộ dữ liệu kho
 * - badge trạng thái mã / trạng thái giao mã của đơn / trạng thái báo lỗi
 * - dialog Xem nội dung (reveal), Đổi mã (replace), Thu hồi (revoke), Giao tay (manual)
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CODE_REPORT_STATUS_LABELS,
  DIGITAL_CODE_STATUS_LABELS,
  ORDER_CODE_STATUS_LABELS,
  type AdminDigitalCode,
  type AdminOrderCodes,
  type CodeReportStatus,
  type DigitalCodeStatus,
  type OrderCodeStatus,
} from '@cmsnt/shared';
import { Field } from '@/components/common/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Gốc khoá cache của mọi truy vấn kho mã — invalidate gốc này là làm mới toàn bộ */
export const DIGITAL_QK = 'digital-codes';

/** Sản phẩm có thể gắn kho mã (GET admin/digital-codes/products) */
export interface DigitalProductOption {
  id: string;
  name: string;
  sku: string | null;
  type: string;
  codeDelivery: boolean;
  variants: { id: string; label: string; sku: string | null }[];
}

/** Một lô nhập (GET admin/digital-codes/batches) */
export interface DigitalBatch {
  batch: string;
  count: number;
  createdAt: string;
}

/** Làm mới mọi dữ liệu kho mã + badge menu + (tuỳ chọn) chi tiết đơn */
export function invalidateDigital(qc: QueryClient, orderId?: string | null) {
  void qc.invalidateQueries({ queryKey: [DIGITAL_QK] });
  void qc.invalidateQueries({ queryKey: ['admin-badges'] });
  if (orderId) {
    void qc.invalidateQueries({ queryKey: ['order', orderId] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  }
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const CODE_STATUS_CLASS: Record<DigitalCodeStatus, string> = {
  AVAILABLE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  RESERVED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  SOLD: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  DISABLED: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  REVOKED: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

/** Badge trạng thái một mã (Còn trong kho / Đang giữ / Đã giao / Tạm khoá / Thu hồi) */
export function CodeStatusBadge({ status, className }: { status: DigitalCodeStatus; className?: string }) {
  return <Badge className={cn('border-transparent font-medium', CODE_STATUS_CLASS[status], className)}>{DIGITAL_CODE_STATUS_LABELS[status] ?? status}</Badge>;
}

const ORDER_CODE_CLASS: Record<OrderCodeStatus, string> = {
  pending: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  partial: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  delivered: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
};

/** Badge trạng thái giao mã của đơn (Chờ giao mã / Giao thiếu / Đã giao) — null thì không vẽ gì */
export function OrderCodeStatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return null;
  const s = status as OrderCodeStatus;
  return <Badge className={cn('border-transparent font-medium', ORDER_CODE_CLASS[s] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', className)}>{ORDER_CODE_STATUS_LABELS[s] ?? status}</Badge>;
}

const REPORT_CLASS: Record<CodeReportStatus, string> = {
  OPEN: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  RESOLVED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  REJECTED: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

/** Badge trạng thái báo lỗi của khách */
export function ReportStatusBadge({ status, className }: { status: CodeReportStatus | null | undefined; className?: string }) {
  if (!status) return null;
  return <Badge className={cn('border-transparent font-medium', REPORT_CLASS[status], className)}>Báo lỗi: {CODE_REPORT_STATUS_LABELS[status] ?? status}</Badge>;
}

/** Thẻ số liệu nhỏ ở đầu trang */
export function StatTile({ label, value, hint, tone, onClick }: { label: string; value: number; hint?: string; tone?: 'warn' | 'danger'; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'rounded-xl border bg-card p-3 text-left',
        onClick && 'transition hover:bg-muted/50',
        tone === 'warn' && value > 0 && 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20',
        tone === 'danger' && value > 0 && 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20',
      )}
    >
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value.toLocaleString('vi-VN')}</p>
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </Comp>
  );
}

// ---------------------------------------------------------------------------
// Xem nội dung mã
// ---------------------------------------------------------------------------

/** Số giây tự ẩn nội dung sau khi hiện */
const REVEAL_SECONDS = 30;

/**
 * Dialog xem nội dung thật của mã: bấm "Hiện nội dung" mới gọi API reveal (có ghi nhật ký),
 * có nút sao chép, tự ẩn sau 30 giây và xoá nội dung khỏi bộ nhớ khi đóng.
 */
export function RevealCodeDialog({ code, onClose }: { code: Pick<AdminDigitalCode, 'id' | 'preview' | 'productName' | 'variantLabel'> | null; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  // id mã đang mở — phản hồi reveal về trễ của mã khác (đã đóng / đổi mã) sẽ bị bỏ qua
  const openId = useRef<string | null>(null);
  // đồng bộ id mã đang mở vào ref sau mỗi lần đổi mã (không gán ref trong lúc render)
  useEffect(() => {
    openId.current = code?.id ?? null;
  }, [code?.id]);

  const reveal = useMutation({
    mutationFn: (id: string) => api.post<{ content: string }>(`/admin/digital-codes/${id}/reveal`),
    onSuccess: (r, id) => {
      if (id !== openId.current) return;
      setContent(r.content);
      setLeft(REVEAL_SECONDS);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // đổi mã khác / đóng dialog -> xoá nội dung đã hiện
  useEffect(() => {
    setContent(null);
    setLeft(0);
    setCopied(false);
  }, [code?.id]);

  // đếm ngược rồi tự ẩn
  useEffect(() => {
    if (content == null) return;
    if (left <= 0) {
      setContent(null);
      return;
    }
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [content, left]);

  const copy = async () => {
    if (content == null) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Trình duyệt không cho phép sao chép');
    }
  };

  return (
    <Dialog open={!!code} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nội dung mã</DialogTitle>
          <DialogDescription>
            {code?.productName}
            {code?.variantLabel ? ` · ${code.variantLabel}` : ''}. Mỗi lần xem đều được ghi vào nhật ký hoạt động.
          </DialogDescription>
        </DialogHeader>
        {content == null ? (
          <div className="space-y-3">
            <div className="rounded-lg border bg-muted/40 p-3 font-mono text-sm break-all">{code?.preview || '••••'}</div>
            <Button className="w-full" onClick={() => code && reveal.mutate(code.id)} disabled={reveal.isPending}>
              {reveal.isPending ? <Loader2 className="animate-spin" /> : <Eye />} Hiện nội dung
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-sm whitespace-pre-wrap break-all">{content}</pre>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Tự ẩn sau {left} giây</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setContent(null)}>
                  <EyeOff /> Ẩn
                </Button>
                <Button size="sm" onClick={() => void copy()}>
                  {copied ? <Check /> : <Copy />} {copied ? 'Đã chép' : 'Sao chép'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Đổi mã / thu hồi / giao tay
// ---------------------------------------------------------------------------

/**
 * Dialog đổi mã (mã cũ -> REVOKED, cấp mã mới từ kho hoặc nội dung nhập tay, gửi email cho khách).
 * Dùng cho cả "Đổi mã" ở danh sách, tab Báo lỗi và thẻ mã trong chi tiết đơn.
 */
export function ReplaceCodeDialog({ code, onClose, onDone }: { code: Pick<AdminDigitalCode, 'id' | 'preview' | 'productName' | 'orderId' | 'orderCode' | 'reportNote'> | null; onClose: () => void; onDone?: (c: AdminDigitalCode) => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [manual, setManual] = useState(false);
  const [content, setContent] = useState('');
  const [notify, setNotify] = useState(true);

  // mở dialog cho mã khác -> đặt lại form (lý do mặc định lấy nội dung khách báo lỗi)
  useEffect(() => {
    setReason(code?.reportNote ? `Khách báo lỗi: ${code.reportNote}`.slice(0, 500) : '');
    setManual(false);
    setContent('');
    setNotify(true);
  }, [code?.id, code?.reportNote]);

  const replace = useMutation({
    mutationFn: () => api.post<AdminDigitalCode>(`/admin/digital-codes/${code!.id}/replace`, { reason: reason.trim() || undefined, content: manual ? content.trim() : undefined, notify }),
    onSuccess: (c) => {
      toast.success('Đã đổi mã mới cho khách');
      invalidateDigital(qc, code?.orderId);
      onDone?.(c);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!code} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual && !content.trim()) return toast.error('Vui lòng nhập nội dung mã mới');
            replace.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Đổi mã mới</DialogTitle>
            <DialogDescription>
              Mã cũ <span className="font-mono">{code?.preview}</span>
              {code?.orderCode ? ` của đơn #${code.orderCode}` : ''} sẽ bị thu hồi, khách nhận mã thay thế.
            </DialogDescription>
          </DialogHeader>
          <Field label="Lý do" help="Ghi vào lịch sử và gửi kèm email cho khách">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="Vd: Mã đã bị sử dụng, tài khoản sai mật khẩu..." />
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <span>
              <span className="font-medium">Nhập tay nội dung mã mới</span>
              <span className="block text-xs text-muted-foreground">Tắt: tự lấy một mã còn trong kho của cùng sản phẩm / biến thể</span>
            </span>
            <Switch checked={manual} onCheckedChange={setManual} />
          </label>
          {manual && (
            <Field label="Nội dung mã mới" required help='Nhiều phần cách nhau bằng "|", vd: tài khoản|mật khẩu|ghi chú'>
              <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} maxLength={2000} className="font-mono" autoFocus />
            </Field>
          )}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Gửi email mã mới cho khách</span>
            <Switch checked={notify} onCheckedChange={setNotify} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={replace.isPending}>
              {replace.isPending && <Loader2 className="animate-spin" />} Đổi mã
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dialog thu hồi mã: nhập lý do; mã đang giữ cho đơn (RESERVED, chưa giao) có thể "trả về kho" (restock -> AVAILABLE).
 * Mã đã giao (SOLD) luôn thành REVOKED.
 */
export function RevokeCodeDialog({ code, onClose }: { code: Pick<AdminDigitalCode, 'id' | 'preview' | 'status' | 'viewedAt' | 'orderId'> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(false);
  useEffect(() => {
    setReason('');
    setRestock(false);
  }, [code?.id]);
  // chỉ trả về kho được khi mã đang giữ cho đơn, chưa giao cho khách
  const canRestock = !!code && code.status === 'RESERVED';

  const revoke = useMutation({
    mutationFn: () => api.post<AdminDigitalCode>(`/admin/digital-codes/${code!.id}/revoke`, { reason: reason.trim() || undefined, restock: canRestock && restock }),
    onSuccess: (c) => {
      toast.success(c.status === 'AVAILABLE' ? 'Đã thu hồi và trả mã về kho' : 'Đã thu hồi mã');
      invalidateDigital(qc, code?.orderId);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!code} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            revoke.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Thu hồi mã</DialogTitle>
            <DialogDescription>
              Mã <span className="font-mono">{code?.preview}</span> sẽ không còn hiển thị cho khách. Hành động này không tự cấp mã thay thế.
            </DialogDescription>
          </DialogHeader>
          <Field label="Lý do">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="Vd: Đơn hoàn tiền, khách không dùng..." />
          </Field>
          {canRestock && (
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <span>
                <span className="font-medium">Trả mã về kho</span>
                <span className="block text-xs text-muted-foreground">Mã đang giữ, chưa giao cho khách nên có thể bán lại</span>
              </span>
              <Switch checked={restock} onCheckedChange={setRestock} />
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" variant="destructive" disabled={revoke.isPending}>
              {revoke.isPending && <Loader2 className="animate-spin" />} Thu hồi
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog từ chối báo lỗi của khách (REJECTED + phản hồi) */
export function RejectReportDialog({ code, onClose }: { code: Pick<AdminDigitalCode, 'id' | 'preview' | 'reportNote' | 'orderId'> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  useEffect(() => setReply(''), [code?.id]);
  const reject = useMutation({
    mutationFn: () => api.post<AdminDigitalCode>(`/admin/digital-codes/${code!.id}/resolve-report`, { status: 'REJECTED', reply: reply.trim() || undefined }),
    onSuccess: () => {
      toast.success('Đã từ chối báo lỗi');
      invalidateDigital(qc, code?.orderId);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={!!code} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            reject.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Từ chối báo lỗi</DialogTitle>
            <DialogDescription>Khách báo: {code?.reportNote || '(không có nội dung)'}</DialogDescription>
          </DialogHeader>
          <Field label="Phản hồi cho khách" help="Khách xem được phản hồi này ở trang mã đã mua">
            <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={1000} placeholder="Vd: Mã đã được kiểm tra và vẫn hoạt động bình thường, vui lòng làm theo hướng dẫn..." autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" variant="destructive" disabled={reject.isPending}>
              {reject.isPending && <Loader2 className="animate-spin" />} Từ chối
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Dialog giao tay: nhập nội dung giao cho một dòng hàng (dịch vụ nâng cấp, nạp game...) */
export function ManualDeliverDialog({ orderId, item, onClose, onDone }: { orderId: string; item: { orderItemId: string; productName: string; variantLabel: string | null } | null; onClose: () => void; onDone?: (r: AdminOrderCodes) => void }) {
  const qc = useQueryClient();
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  useEffect(() => {
    setContent('');
    setNote('');
    setNotify(true);
  }, [item?.orderItemId]);
  const send = useMutation({
    mutationFn: () => api.post<AdminOrderCodes>(`/admin/digital-codes/by-order/${orderId}/manual`, { orderItemId: item!.orderItemId, content: content.trim(), note: note.trim() || undefined, notify }),
    onSuccess: (r) => {
      toast.success('Đã giao nội dung cho khách');
      qc.setQueryData([DIGITAL_QK, 'order', orderId], r);
      invalidateDigital(qc, orderId);
      onDone?.(r);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!content.trim()) return toast.error('Vui lòng nhập nội dung giao cho khách');
            send.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Giao tay</DialogTitle>
            <DialogDescription>
              {item?.productName}
              {item?.variantLabel ? ` · ${item.variantLabel}` : ''} — nội dung được mã hoá và hiện cho khách như một mã đã giao.
            </DialogDescription>
          </DialogHeader>
          <Field label="Nội dung" required help='Vd: "Đã nạp 500 kim cương vào ID 123456" hoặc "tài khoản|mật khẩu"'>
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} maxLength={2000} className="font-mono" autoFocus />
          </Field>
          <Field label="Ghi chú nội bộ">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Gửi email thông báo cho khách</span>
            <Switch checked={notify} onCheckedChange={setNotify} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={send.isPending}>
              {send.isPending && <Loader2 className="animate-spin" />} Giao cho khách
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
