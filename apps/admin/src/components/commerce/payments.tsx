'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { formatMoney, i18n } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ONLINE_PAYMENT_LABELS, toNum } from './utils';

/** Cổng thanh toán tích hợp sẵn (GET /admin/payments/providers): web2m (PayOS / SePay / Pay2S đã ẩn) */
export interface PaymentProviderInfo {
  key: string;
  label: Record<string, string> | string;
  /** đang bật trong Cài đặt › Cổng thanh toán */
  enabled: boolean;
  /** đã nhập đủ thông tin bắt buộc (khoá API, tài khoản...) */
  configured: boolean;
  /** URL đầy đủ để khai báo webhook / IPN ở trang quản lý của cổng */
  webhookUrl: string;
}

export interface PaymentTransactionRow {
  id: string;
  /** null khi là giao dịch nạp ví (purpose = 'wallet') */
  orderId: string | null;
  /** order = thanh toán đơn hàng | wallet = khách nạp tiền vào ví qua cổng */
  purpose?: 'order' | 'wallet' | string;
  /** chủ ví được cộng tiền (giao dịch nạp ví) */
  userId?: string | null;
  user?: { id: string; email: string; name: string } | null;
  provider: string;
  amount: unknown;
  currency: string;
  usdtAmount?: number | null;
  usdtRate?: number | null;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  providerOrderCode: string;
  reference: string | null;
  transferContent: string | null;
  checkoutUrl: string | null;
  qrData: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  /** tiền đã vào nhưng đơn đã huỷ / đã thanh toán bằng giao dịch khác -> cần hoàn tiền cho khách */
  needsRefund?: boolean;
  /** ghi chú hệ thống (nhận thiếu tiền, lý do hết hạn / huỷ, cần hoàn tiền...) */
  note?: string | null;
  order: { id: string; code: string; customerName: string; status: string; paymentStatus: string } | null;
}

export const TX_STATUSES: { value: PaymentTransactionRow['status']; label: string; className: string }[] = [
  { value: 'PENDING', label: 'Chờ thanh toán', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  { value: 'PAID', label: 'Đã thanh toán', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  { value: 'FAILED', label: 'Thất bại', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  { value: 'CANCELLED', label: 'Đã huỷ', className: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  { value: 'EXPIRED', label: 'Hết hạn', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
];

/** Giao dịch còn có thể xác nhận thủ công (khách đã chuyển tiền nhưng cổng không báo về / sai nội dung) */
export const CONFIRMABLE = ['PENDING', 'EXPIRED'];

/** Đơn đã đóng: không nhận tiền nữa (API trả 400 khi xác nhận) */
const CLOSED_ORDER = ['CANCELLED', 'REFUNDED'];

/**
 * Có hiện nút "Xác nhận đã nhận tiền" không: giao dịch còn chờ / hết hạn VÀ đơn chưa thanh toán, chưa huỷ / hoàn tiền.
 * Không biết trạng thái đơn -> ẩn (API cũng chặn).
 */
export function canConfirmPayment(tx: Pick<PaymentTransactionRow, 'status' | 'purpose' | 'orderId'>, order: { status: string; paymentStatus: string } | null | undefined) {
  if (!CONFIRMABLE.includes(tx.status)) return false;
  // nạp ví: không có đơn — chỉ cần giao dịch còn chờ / hết hạn (API kiểm quyền users.wallet)
  if (isWalletTopup(tx)) return true;
  return !!order && order.paymentStatus !== 'PAID' && !CLOSED_ORDER.includes(order.status);
}

/** Giao dịch nạp ví (không gắn đơn hàng) */
export function isWalletTopup(tx: Pick<PaymentTransactionRow, 'purpose' | 'orderId'>) {
  return tx.purpose === 'wallet' || (!tx.orderId && tx.purpose !== 'order');
}

/** Badge đỏ "Cần hoàn tiền" (tiền vào sau khi đơn huỷ / khách trả trùng) */
export function NeedsRefundBadge({ className }: { className?: string }) {
  return (
    <Badge className={cn('border-transparent bg-red-100 font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300', className)}>
      <TriangleAlert /> Cần hoàn tiền
    </Badge>
  );
}

export function TxStatusBadge({ status, className }: { status: string; className?: string }) {
  const m = TX_STATUSES.find((s) => s.value === status) ?? { label: status, className: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300' };
  return <Badge className={cn('border-transparent font-medium', m.className, className)}>{m.label}</Badge>;
}

/** Danh sách cổng thanh toán đã đăng ký (dùng cho bộ lọc / tên hiển thị) */
export function usePaymentProviders(enabled = true) {
  return useQuery({ queryKey: ['payment-providers'], queryFn: () => api.get<PaymentProviderInfo[]>('/admin/payments/providers'), enabled, staleTime: 5 * 60_000 });
}

/** Tên ngắn của cổng (PayOS, SePay...) — dùng trong bảng / badge */
export function providerName(key: string, providers?: PaymentProviderInfo[]) {
  if (ONLINE_PAYMENT_LABELS[key]) return ONLINE_PAYMENT_LABELS[key];
  // nhật ký callback nạp thẻ cào ghi provider dạng card_<nhà cung cấp>
  if (key.startsWith('card_')) return `Thẻ cào · ${key.slice(5)}`;
  const p = providers?.find((x) => x.key === key);
  return (p && i18n(p.label)) || key.toUpperCase();
}

/** Tên đầy đủ khách nhìn thấy ở trang thanh toán */
export function providerLabel(key: string, providers?: PaymentProviderInfo[]) {
  const p = providers?.find((x) => x.key === key);
  return (p && i18n(p.label)) || providerName(key, providers);
}

/** Nút + hộp thoại "Xác nhận đã nhận tiền" cho một giao dịch (cần quyền orders.write) */
export function ConfirmPaymentButton({ tx, providerLabel, size = 'sm', className }: { tx: PaymentTransactionRow; providerLabel?: string; size?: 'sm' | 'xs'; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size={size}
        variant="outline"
        className={cn('border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 hover:text-emerald-800 dark:hover:text-emerald-300 dark:border-emerald-800 dark:text-emerald-400', className)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <BadgeCheck /> Xác nhận đã nhận tiền
      </Button>
      {open && <ConfirmPaymentDialog tx={tx} providerLabel={providerLabel} onClose={() => setOpen(false)} />}
    </>
  );
}

function ConfirmPaymentDialog({ tx, providerLabel, onClose }: { tx: PaymentTransactionRow; providerLabel?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [reference, setReference] = useState('');
  // mã giao dịch trên sao kê ngân hàng (tuỳ chọn): API ghi lại để webhook tới sau không ghi nhận trùng; mã đã dùng -> 400
  const [bankTxnId, setBankTxnId] = useState('');
  const wallet = isWalletTopup(tx);
  // nạp ví: cho sửa số tiền thực nhận sẽ cộng vào ví (mặc định = số tiền giao dịch)
  const [credit, setCredit] = useState(String(toNum(tx.amount)));
  const creditNum = Math.round(Number(credit) || 0);
  const amount = formatMoney(wallet ? creditNum : toNum(tx.amount), tx.currency);
  const code = tx.order?.code;

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ note?: string }>(`/admin/payments/transactions/${tx.id}/confirm`, {
        reference: reference.trim() || undefined,
        amount: wallet ? creditNum : undefined,
        bankTxnId: bankTxnId.trim() || undefined,
      }),
    onSuccess: (r) => {
      toast.success(r?.note ?? (wallet ? 'Đã cộng tiền vào ví' : 'Đã ghi nhận thanh toán'));
      void qc.invalidateQueries({ queryKey: ['payment-transactions'] });
      if (tx.orderId) void qc.invalidateQueries({ queryKey: ['order', tx.orderId] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      // nạp ví: làm mới số dư / lịch sử ví của thành viên
      if (tx.userId) {
        void qc.invalidateQueries({ queryKey: ['user', tx.userId] });
        void qc.invalidateQueries({ queryKey: ['user-wallet', tx.userId] });
        void qc.invalidateQueries({ queryKey: ['user-wallet-txns', tx.userId] });
      }
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = async () => {
    if (wallet && creditNum <= 0) {
      toast.error('Số tiền cộng vào ví phải lớn hơn 0');
      return;
    }
    const ok = await confirm({
      title: `Xác nhận đã nhận ${amount}?`,
      description: wallet
        ? `Giao dịch nạp ví ${providerLabel ?? tx.provider.toUpperCase()}${tx.user ? ` của ${tx.user.email}` : ''} sẽ chuyển sang “Đã thanh toán” và ${amount} được cộng vào ví. Chỉ xác nhận khi bạn đã kiểm tra tiền thực sự về tài khoản.`
        : `Giao dịch ${providerLabel ?? tx.provider.toUpperCase()}${code ? ` của đơn #${code}` : ''} sẽ chuyển sang “Đã thanh toán” và đơn hàng được đánh dấu đã thanh toán. Chỉ xác nhận khi bạn đã kiểm tra tiền thực sự về tài khoản.`,
      confirmText: 'Xác nhận đã nhận tiền',
    });
    if (ok) mutation.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Xác nhận thủ công đã nhận tiền</DialogTitle>
          <DialogDescription>Dùng khi khách đã chuyển tiền nhưng cổng thanh toán không gửi thông báo về (vd chuyển sai nội dung, webhook lỗi).</DialogDescription>
        </DialogHeader>
        <form
          id="confirm-payment"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
            {code && (
              <>
                <dt className="text-muted-foreground">Đơn hàng</dt>
                <dd className="text-right font-mono font-medium">#{code}</dd>
              </>
            )}
            {wallet && (
              <>
                <dt className="text-muted-foreground">Nạp ví</dt>
                <dd className="truncate text-right">{tx.user ? `${tx.user.name || tx.user.email} (${tx.user.email})` : '—'}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Cổng</dt>
            <dd className="text-right">{providerLabel ?? tx.provider.toUpperCase()}</dd>
            <dt className="text-muted-foreground">Mã GD cổng</dt>
            <dd className="truncate text-right font-mono text-xs">{tx.providerOrderCode}</dd>
            <dt className="text-muted-foreground">Số tiền</dt>
            <dd className="text-right text-base font-semibold tabular-nums">{formatMoney(toNum(tx.amount), tx.currency)}</dd>
          </dl>
          {wallet && (
            <Field label="Số tiền cộng vào ví" help="Mặc định bằng số tiền giao dịch; sửa nếu khách chuyển thiếu / thừa.">
              <Input type="number" min={1} value={credit} onChange={(e) => setCredit(e.target.value)} className="tabular-nums" />
            </Field>
          )}
          <Field label="Mã giao dịch ngân hàng" help="Không bắt buộc. Mã GD trên sao kê ngân hàng — giúp chống ghi nhận trùng khi webhook của cổng tới sau.">
            <Input value={bankTxnId} onChange={(e) => setBankTxnId(e.target.value)} maxLength={190} placeholder="Vd: FT26276123456789" className="font-mono" autoFocus />
          </Field>
          <Field label="Mã tham chiếu / ghi chú đối soát" help="Không bắt buộc. Lưu lại để đối soát sau này.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="Vd: KH báo qua Zalo 07/10" />
          </Field>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="submit" form="confirm-payment" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" /> : <BadgeCheck />} Xác nhận
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
