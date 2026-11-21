'use client';

/**
 * Tab Yêu cầu rút tiền: GET /admin/affiliate/payouts (lọc trạng thái / cách nhận / tìm kiếm),
 * duyệt (POST .../approve — rút vào ví thì cộng số dư ví ngay) hoặc từ chối (POST .../reject — trả lại ví hoa hồng).
 */
import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { ToneBadge, type PaginatedWithCounts } from '@/components/ai/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';
import { PAYOUT_METHOD, PAYOUT_STATUS, PAYOUT_STATUSES, UserCell, type AffiliatePayout } from './shared';

/** Sao chép nhanh số tài khoản / tên chủ tài khoản để chuyển khoản */
function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success('Đã sao chép'));
}

export function PayoutsTab() {
  const qc = useQueryClient();
  const { params, set, page, limit } = useListParams<Record<string, string>>({ tab: 'payouts', status: 'PENDING', method: '', search: '' });
  const [action, setAction] = useState<{ payout: AffiliatePayout; kind: 'approve' | 'reject' } | null>(null);
  // tab "Tất cả" dùng giá trị "all" trên URL vì mặc định là Chờ duyệt
  const status = params.status === 'all' ? '' : params.status;
  const list = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['affiliate-payouts', status, params.method, params.search, page, limit],
    queryFn: () => api.get<PaginatedWithCounts<AffiliatePayout>>('/admin/affiliate/payouts', { status, method: params.method, search: params.search, page, limit }),
  });
  const counts = list.data?.counts ?? {};

  const columns: Column<AffiliatePayout>[] = [
    {
      key: 'code',
      header: 'Mã',
      mobile: 'primary',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="font-mono font-semibold">#{r.code}</div>
          <div className="text-[11px] text-muted-foreground" title={formatDate(r.createdAt)}>
            {timeAgo(r.createdAt)}
          </div>
        </div>
      ),
    },
    { key: 'user', header: 'Khách', cell: (r) => <UserCell user={r.user} /> },
    {
      key: 'amount',
      header: 'Số tiền',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="font-semibold tabular-nums">{formatMoney(r.amount)}</div>
          <div className="text-[11px] text-muted-foreground">còn {formatMoney(r.user.affiliateBalance)} trong ví hoa hồng</div>
        </div>
      ),
    },
    {
      key: 'method',
      header: 'Nhận tiền',
      cell: (r) =>
        r.method === 'BANK' ? (
          <div className="min-w-0 max-w-60 space-y-0.5 text-sm">
            <div className="font-medium">{r.bankName}</div>
            <button type="button" onClick={() => copy(r.bankAccount ?? '')} className="flex items-center gap-1 font-mono text-xs hover:text-primary">
              {r.bankAccount} <Copy className="size-3" />
            </button>
            <button type="button" onClick={() => copy(r.bankHolder ?? '')} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
              {r.bankHolder} <Copy className="size-3" />
            </button>
          </div>
        ) : (
          <span className="text-sm">{PAYOUT_METHOD.WALLET}</span>
        ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="max-w-56 space-y-1">
          <ToneBadge map={PAYOUT_STATUS} value={r.status} />
          {r.note && <p className="line-clamp-2 text-xs text-muted-foreground" title={r.note}>Khách: {r.note}</p>}
          {r.adminNote && <p className="line-clamp-2 text-xs text-muted-foreground" title={r.adminNote}>Admin: {r.adminNote}</p>}
          {r.processedAt && (
            <p className="text-[11px] text-muted-foreground">
              {r.processedBy?.name ? `${r.processedBy.name} · ` : ''}
              {formatDate(r.processedAt, 'dd/MM HH:mm')}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-40 text-right',
      cell: (r) =>
        r.status === 'PENDING' ? (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setAction({ payout: r, kind: 'reject' })}>
              <X /> Từ chối
            </Button>
            <Button size="sm" onClick={() => setAction({ payout: r, kind: 'approve' })}>
              <Check /> Duyệt
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <StatusTabs
        value={params.status}
        onChange={(v) => set({ status: v })}
        options={[
          ...PAYOUT_STATUSES.map((s) => ({ value: s, label: PAYOUT_STATUS[s].label, count: counts[s] ?? 0, highlight: s === 'PENDING' })),
          { value: 'all', label: 'Tất cả' },
        ]}
      />
      <ListToolbar
        search={params.search}
        onSearchChange={(v) => set({ search: v })}
        placeholder="Tìm mã #, email, tên khách, số tài khoản..."
        filters={
          <Select value={params.method || 'all'} onValueChange={(v) => set({ method: v === 'all' ? '' : v })}>
            <SelectTrigger className="w-44" aria-label="Cách nhận tiền">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Mọi cách nhận</SelectItem>
              <SelectItem value="WALLET">{PAYOUT_METHOD.WALLET}</SelectItem>
              <SelectItem value="BANK">{PAYOUT_METHOD.BANK}</SelectItem>
            </SelectContent>
          </Select>
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
        emptyTitle={status === 'PENDING' ? 'Không có yêu cầu nào chờ duyệt' : 'Chưa có yêu cầu rút'}
        emptyDescription="Khách gửi yêu cầu rút hoa hồng ở trang Giới thiệu bạn bè."
      />
      <p className="text-xs text-muted-foreground">
        Khi khách gửi yêu cầu, số tiền đã được trừ khỏi ví hoa hồng. Duyệt rút vào ví sẽ cộng ngay vào số dư ví của khách; rút ngân hàng thì chuyển khoản xong mới bấm duyệt. Từ chối sẽ trả tiền về ví hoa hồng.
      </p>
      {action && (
        <ProcessDialog
          {...action}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            void qc.invalidateQueries({ queryKey: ['affiliate-payouts'] });
            void qc.invalidateQueries({ queryKey: ['affiliate-stats'] });
            void qc.invalidateQueries({ queryKey: ['affiliate-txns'] });
            void qc.invalidateQueries({ queryKey: ['admin-badges'] });
          }}
        />
      )}
    </div>
  );
}

/** Xác nhận duyệt / từ chối kèm ghi chú khách nhìn thấy (mã giao dịch ngân hàng, lý do từ chối) */
function ProcessDialog({ payout, kind, onClose, onDone }: { payout: AffiliatePayout; kind: 'approve' | 'reject'; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const approve = kind === 'approve';
  const run = useMutation({
    mutationFn: () => api.post(`/admin/affiliate/payouts/${payout.id}/${kind}`, { adminNote: note.trim() || undefined }),
    onSuccess: () => {
      toast.success(approve ? `Đã duyệt yêu cầu #${payout.code}` : `Đã từ chối yêu cầu #${payout.code}, tiền đã trả về ví hoa hồng`);
      onDone();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {approve ? 'Duyệt' : 'Từ chối'} yêu cầu #{payout.code} · {formatMoney(payout.amount)}
          </DialogTitle>
          <DialogDescription>
            {approve
              ? payout.method === 'WALLET'
                ? `Cộng ${formatMoney(payout.amount)} vào số dư ví của ${payout.user.name}.`
                : `Xác nhận bạn đã chuyển khoản ${formatMoney(payout.amount)} tới ${payout.bankHolder} · ${payout.bankAccount} (${payout.bankName}).`
              : `Trả ${formatMoney(payout.amount)} về ví hoa hồng của ${payout.user.name}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="payout-note">{approve ? 'Ghi chú (tuỳ chọn)' : 'Lý do từ chối'}</Label>
          <Textarea id="payout-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={approve ? 'vd. Mã giao dịch FT2410...' : 'vd. Sai số tài khoản, vui lòng gửi lại'} />
          <p className="text-xs text-muted-foreground">Khách nhìn thấy ghi chú này.</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="button" variant={approve ? 'default' : 'destructive'} disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending && <Loader2 className="animate-spin" />}
            {approve ? 'Duyệt' : 'Từ chối'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
