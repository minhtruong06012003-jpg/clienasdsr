'use client';

/**
 * Tab Lịch sử hoa hồng: sổ cái ví hoa hồng của mọi khách (GET /admin/affiliate/transactions),
 * lọc theo loại / khách (?userId= từ Top người giới thiệu) / tìm kiếm; admin cộng / trừ tay ví hoa hồng của một khách.
 */
import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, SlidersHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { ToneBadge, type PaginatedWithCounts } from '@/components/ai/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';
import { uuid } from '@/lib/uuid';
import { TXN_TYPE, TXN_TYPES, UserCell, type AffiliateTxn, type UserRef } from './shared';

export function TransactionsTab() {
  const qc = useQueryClient();
  const { params, set, page, limit } = useListParams<Record<string, string>>({ tab: 'transactions', type: '', userId: '', search: '' });
  const [adjustFor, setAdjustFor] = useState<UserRef | null>(null);
  const list = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['affiliate-txns', params.type, params.userId, params.search, page, limit],
    queryFn: () => api.get<PaginatedWithCounts<AffiliateTxn>>('/admin/affiliate/transactions', { type: params.type, userId: params.userId, search: params.search, page, limit }),
  });
  // đang lọc theo một khách: lấy tên từ dòng đầu để hiện nhãn + nút điều chỉnh
  const filteredUser = params.userId ? list.data?.data.find((r) => r.user.id === params.userId)?.user : undefined;

  const columns: Column<AffiliateTxn>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
      mobile: 'primary',
      cell: (r) => <div className="whitespace-nowrap text-xs">{formatDate(r.createdAt, 'dd/MM/yyyy HH:mm')}</div>,
    },
    {
      key: 'user',
      header: 'Chủ ví hoa hồng',
      cell: (r) => (
        <div className="flex items-start gap-1">
          <UserCell user={r.user} />
          {!params.userId && (
            <button type="button" title="Chỉ xem khách này" onClick={() => set({ userId: r.user.id })} className="mt-0.5 text-muted-foreground hover:text-primary">
              <SlidersHorizontal className="size-3.5" />
            </button>
          )}
        </div>
      ),
    },
    { key: 'type', header: 'Loại', cell: (r) => <ToneBadge map={TXN_TYPE} value={r.type} /> },
    {
      key: 'note',
      header: 'Nội dung',
      cell: (r) => (
        <div className="min-w-0 max-w-80 space-y-0.5 text-sm">
          <div className="line-clamp-2" title={r.note ?? ''}>
            {r.note || '—'}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {r.fromUser && (
              <>
                từ{' '}
                <Link href={`/users/${r.fromUser.id}`} className="hover:text-primary">
                  {r.fromUser.name}
                </Link>
              </>
            )}
            {r.payout && (
              <Link href={`?tab=payouts&status=all&search=${r.payout.code}`} className="ml-1 hover:text-primary">
                yêu cầu #{r.payout.code}
              </Link>
            )}
            {r.createdBy && <span className="ml-1">· {r.createdBy.name}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Số tiền',
      className: 'text-right',
      cell: (r) => (
        <div className="whitespace-nowrap text-right">
          <div className={cn('font-semibold tabular-nums', Number(r.amount) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
            {Number(r.amount) >= 0 ? '+' : ''}
            {formatMoney(r.amount)}
          </div>
          <div className="text-[11px] text-muted-foreground">số dư {formatMoney(r.balanceAfter)}</div>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <ListToolbar
        search={params.search}
        onSearchChange={(v) => set({ search: v })}
        placeholder="Tìm theo tên, email chủ ví..."
        filters={
          <>
            <Select value={params.type || 'all'} onValueChange={(v) => set({ type: v === 'all' ? '' : v })}>
              <SelectTrigger className="w-44" aria-label="Loại giao dịch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Mọi loại</SelectItem>
                {TXN_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TXN_TYPE[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {params.userId && (
              <Button size="sm" variant="secondary" onClick={() => set({ userId: '' })}>
                {filteredUser?.name ?? 'Một khách'} <X />
              </Button>
            )}
            {filteredUser && (
              <Button size="sm" variant="outline" onClick={() => setAdjustFor(filteredUser)}>
                Cộng / trừ hoa hồng
              </Button>
            )}
          </>
        }
      />
      <DataTable
        columns={columns}
        data={list.data?.data}
        meta={list.data?.meta}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onPageChange={(p) => set({ page: p })}
        onLimitChange={(l) => set({ limit: l })}
        emptyTitle="Chưa có giao dịch hoa hồng"
        emptyDescription="Hoa hồng được cộng khi người được giới thiệu nạp tiền qua cổng thanh toán hoặc thẻ cào."
      />
      <p className="text-xs text-muted-foreground">
        Hoa hồng phát sinh trước khi có ví hoa hồng riêng đã nằm trong số dư ví chính của khách (loại “Hoa hồng giới thiệu” ở lịch sử ví), không hiện ở đây nhưng vẫn được tính vào thống kê. Bấm biểu tượng lọc cạnh tên khách để xem riêng và cộng / trừ tay ví hoa hồng của khách đó.
      </p>
      {adjustFor && (
        <AdjustDialog
          user={adjustFor}
          onClose={() => setAdjustFor(null)}
          onDone={() => {
            setAdjustFor(null);
            void qc.invalidateQueries({ queryKey: ['affiliate-txns'] });
            void qc.invalidateQueries({ queryKey: ['affiliate-stats'] });
          }}
        />
      )}
    </div>
  );
}

/** Cộng (+) / trừ (−) tay ví hoa hồng — khoá chống bấm trùng sinh một lần mỗi lần mở dialog */
function AdjustDialog({ user, onClose, onDone }: { user: UserRef; onClose: () => void; onDone: () => void }) {
  const [sign, setSign] = useState<'+' | '-'>('+');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [idempotencyKey] = useState(() => uuid());
  const amount = Number(amountText.replace(/[^\d]/g, ''));
  const run = useMutation({
    mutationFn: () => api.post<{ balance: number }>(`/admin/affiliate/users/${user.id}/adjust`, { amount: sign === '+' ? amount : -amount, note: note.trim(), idempotencyKey }),
    onSuccess: (res) => {
      toast.success(`Đã ${sign === '+' ? 'cộng' : 'trừ'} ${formatMoney(amount)} · số dư hoa hồng ${formatMoney(res.balance)}`);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Điều chỉnh ví hoa hồng</DialogTitle>
          <DialogDescription>
            {user.name} · {user.email}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (amount > 0 && note.trim()) run.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="aff-amount">Số tiền (đ)</Label>
            <div className="flex gap-2">
              <Select value={sign} onValueChange={(v) => setSign(v as '+' | '-')}>
                <SelectTrigger className="w-24" aria-label="Cộng hay trừ">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="+">Cộng</SelectItem>
                  <SelectItem value="-">Trừ</SelectItem>
                </SelectContent>
              </Select>
              <Input id="aff-amount" inputMode="numeric" autoFocus placeholder="vd. 50.000" value={amountText} onChange={(e) => setAmountText(Number(e.target.value.replace(/[^\d]/g, '')) ? Number(e.target.value.replace(/[^\d]/g, '')).toLocaleString('vi-VN') : '')} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="aff-note">Lý do (khách nhìn thấy)</Label>
            <Textarea id="aff-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="vd. Thưởng top giới thiệu tháng 10" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={amount <= 0 || !note.trim() || run.isPending} variant={sign === '+' ? 'default' : 'destructive'}>
              {run.isPending && <Loader2 className="animate-spin" />}
              {sign === '+' ? 'Cộng' : 'Trừ'} {amount > 0 ? formatMoney(amount) : ''}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
