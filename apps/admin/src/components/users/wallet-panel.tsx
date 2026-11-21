'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, RotateCcw, ShoppingCart, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Section } from '@/components/common/field';
import { DataTable, type Column } from '@/components/common/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
// uuid(): an toàn cả khi admin chạy qua http (không có crypto.randomUUID)
import { uuid } from '@/lib/uuid';
import { cn } from '@/lib/utils';

export type TxnType = 'DEPOSIT' | 'WITHDRAW' | 'PAYMENT' | 'REFUND';

interface WalletSummary {
  balance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalSpent: number;
  totalRefunded: number;
  transactionCount: number;
}

interface WalletTxn {
  id: string;
  type: TxnType;
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
  order: { id: string; code: string } | null;
  createdBy: { id: string; name: string } | null;
}

/** Nhãn + icon + màu theo loại giao dịch (màu cứng kèm biến thể dark theo quy ước dự án) */
export const TXN_TYPES: Record<TxnType, { label: string; icon: typeof Wallet; className: string }> = {
  DEPOSIT: { label: 'Nạp tiền', icon: ArrowDownToLine, className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  WITHDRAW: { label: 'Trừ tiền', icon: ArrowUpFromLine, className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  PAYMENT: { label: 'Thanh toán', icon: ShoppingCart, className: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  REFUND: { label: 'Hoàn tiền', icon: RotateCcw, className: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' },
};

/** Số tiền nhập dạng "1.000.000" hoặc "1000000" -> number */
const parseAmount = (s: string) => Number(s.replace(/[^\d]/g, ''));

/**
 * Khối "Ví" trên trang chi tiết thành viên: số dư, thống kê, nạp / trừ tiền (quyền users.wallet)
 * và lịch sử giao dịch (phân trang phía server).
 */
export function WalletPanel({ userId }: { userId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [type, setType] = useState<TxnType | 'all'>('all');
  const [dialog, setDialog] = useState<'deposit' | 'withdraw' | null>(null);

  const summary = useQuery({ queryKey: ['user-wallet', userId], queryFn: () => api.get<WalletSummary>(`/admin/users/${userId}/wallet`) });
  const txns = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['user-wallet-txns', userId, page, type],
    queryFn: () => api.get<Paginated<WalletTxn>>(`/admin/users/${userId}/wallet/transactions`, { page, limit: 10, ...(type !== 'all' ? { type } : {}) }),
  });

  const money = (v: number, signed = false) => (signed && v > 0 ? '+' : '') + formatMoney(v);

  const columns: Column<WalletTxn>[] = [
    {
      key: 'type',
      header: 'Loại',
      cell: (r) => {
        const m = TXN_TYPES[r.type];
        return (
          <span className="flex items-center gap-2">
            <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', m.className)}>
              <m.icon className="size-3.5" />
            </span>
            <span className="text-sm font-medium">{m.label}</span>
          </span>
        );
      },
    },
    {
      key: 'note',
      header: 'Nội dung',
      cell: (r) => (
        <div className="min-w-0 max-w-md">
          <div className="truncate text-sm">{r.note || <span className="text-muted-foreground">—</span>}</div>
          <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            {r.order && (
              <Link href={`/orders/${r.order.id}`} className="font-mono hover:text-primary">
                #{r.order.code}
              </Link>
            )}
            {r.createdBy && <span>bởi {r.createdBy.name}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Số tiền',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => <span className={cn('font-semibold tabular-nums', r.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{money(r.amount, true)}</span>,
    },
    { key: 'balanceAfter', header: 'Số dư sau', headClassName: 'text-right', className: 'text-right', cell: (r) => <span className="tabular-nums text-muted-foreground">{formatMoney(r.balanceAfter)}</span> },
    { key: 'createdAt', header: 'Thời gian', cell: (r) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(r.createdAt)}</span> },
  ];

  const s = summary.data;
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" /> Ví
        </span>
      }
      description="Số dư dùng để thanh toán đơn hàng trên website"
      actions={
        can('users.wallet') && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialog('withdraw')}>
              <ArrowUpFromLine /> Trừ tiền
            </Button>
            <Button size="sm" onClick={() => setDialog('deposit')}>
              <ArrowDownToLine /> Nạp tiền
            </Button>
          </div>
        )
      }
    >
      {/* số dư + thống kê */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-primary/5 p-3 dark:bg-primary/10 sm:col-span-1">
          <div className="text-xs text-muted-foreground">Số dư hiện tại</div>
          <div className="text-2xl font-bold tabular-nums text-primary">{s ? formatMoney(s.balance) : '…'}</div>
        </div>
        <Stat label="Đã nạp" value={s?.totalDeposited} />
        <Stat label="Đã chi tiêu" value={s?.totalSpent} />
        <Stat label="Đã hoàn vào ví" value={s?.totalRefunded} />
      </div>

      {/* lịch sử */}
      <div className="mt-4 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Lịch sử giao dịch</h4>
        <Select
          value={type}
          onValueChange={(v) => {
            setType(v as TxnType | 'all');
            setPage(1);
          }}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả loại</SelectItem>
            {(Object.keys(TXN_TYPES) as TxnType[]).map((k) => (
              <SelectItem key={k} value={k}>
                {TXN_TYPES[k].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="mt-2">
        <DataTable columns={columns} data={txns.data?.data ?? []} loading={txns.isLoading} error={txns.error} onRetry={() => void txns.refetch()} meta={txns.data?.meta} onPageChange={setPage} emptyTitle="Chưa có giao dịch nào" emptyDescription="Nạp tiền để thành viên có thể thanh toán bằng ví." />
      </div>

      {dialog && (
        <AdjustDialog
          userId={userId}
          type={dialog}
          balance={s?.balance ?? 0}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: ['user-wallet', userId] });
            void qc.invalidateQueries({ queryKey: ['user-wallet-txns', userId] });
            void qc.invalidateQueries({ queryKey: ['user', userId] });
            void qc.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}
    </Section>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-lg bg-muted/60 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value == null ? '…' : formatMoney(value)}</div>
    </div>
  );
}

/** Hộp thoại nạp / trừ tiền: nhập số tiền + ghi chú; trừ tiền không được vượt số dư */
function AdjustDialog({ userId, type, balance, onClose, onDone }: { userId: string; type: 'deposit' | 'withdraw'; balance: number; onClose: () => void; onDone: () => void }) {
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  // khoá chống trùng sinh MỘT lần mỗi lần mở dialog: bấm 2 lần / gửi lại request thì API trả lại giao dịch cũ, không cộng 2 lần
  const [idempotencyKey] = useState(() => uuid());
  const amount = parseAmount(amountText);
  const isDeposit = type === 'deposit';
  const tooMuch = !isDeposit && amount > balance;

  const save = useMutation({
    mutationFn: () => api.post<{ balance: number; duplicate?: boolean }>(`/admin/users/${userId}/wallet/adjust`, { type, amount, note: note.trim() || undefined, idempotencyKey }),
    onSuccess: (res) => {
      // request trùng khoá: giao dịch đã ghi từ lần bấm trước, số dư không đổi thêm
      if (res.duplicate) toast.info(`Giao dịch đã được ghi trước đó · số dư ${formatMoney(res.balance)}`);
      else toast.success(`${isDeposit ? 'Đã nạp' : 'Đã trừ'} ${formatMoney(amount)} · số dư mới ${formatMoney(res.balance)}`);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const after = isDeposit ? balance + amount : balance - amount;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isDeposit ? 'Nạp tiền vào ví' : 'Trừ tiền khỏi ví'}</DialogTitle>
          <DialogDescription>Số dư hiện tại {formatMoney(balance)}. Giao dịch được ghi vào lịch sử và thành viên nhìn thấy ghi chú.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (amount > 0 && !tooMuch) save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="wallet-amount">Số tiền (đ)</Label>
            <Input
              id="wallet-amount"
              inputMode="numeric"
              autoFocus
              placeholder="vd. 500.000"
              value={amountText}
              onChange={(e) => setAmountText(parseAmount(e.target.value) ? parseAmount(e.target.value).toLocaleString('vi-VN') : '')}
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[100000, 200000, 500000, 1000000].map((v) => (
                <Button key={v} type="button" size="xs" variant="outline" onClick={() => setAmountText(v.toLocaleString('vi-VN'))}>
                  {formatMoney(v)}
                </Button>
              ))}
            </div>
            {tooMuch && <p className="text-xs text-destructive">Số tiền trừ vượt quá số dư hiện có.</p>}
            {amount > 0 && !tooMuch && <p className="text-xs text-muted-foreground">Số dư sau giao dịch: <b className="tabular-nums">{formatMoney(after)}</b></p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wallet-note">Ghi chú</Label>
            <Textarea id="wallet-note" rows={2} placeholder={isDeposit ? 'vd. Nạp qua chuyển khoản ngày 03/10' : 'vd. Thu hồi khuyến mãi sai'} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={amount <= 0 || tooMuch || save.isPending} variant={isDeposit ? 'default' : 'destructive'}>
              {save.isPending ? <Loader2 className="animate-spin" /> : isDeposit ? <ArrowDownToLine /> : <ArrowUpFromLine />}
              {isDeposit ? 'Nạp tiền' : 'Trừ tiền'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Badge nhỏ hiển thị số dư (dùng ở danh sách thành viên) */
export function WalletBadge({ balance }: { balance: number | string | null | undefined }) {
  const n = Number(balance ?? 0);
  return <Badge variant={n > 0 ? 'secondary' : 'outline'} className={cn('tabular-nums font-medium', n > 0 && 'text-emerald-700 dark:text-emerald-300')}>{formatMoney(n)}</Badge>;
}
