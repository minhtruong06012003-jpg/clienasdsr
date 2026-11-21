'use client';

/**
 * Lịch sử nạp thẻ cào vào ví (modules/card-topup). Admin theo dõi thẻ chờ / thành công / lỗi,
 * hỏi lại nhà cung cấp, hoặc duyệt / từ chối tay các thẻ treo lâu không có callback.
 * Dùng chung cho Đơn hàng › Nạp thẻ cào và Nhật ký hệ thống › Nạp thẻ cào (trang tự dựng header).
 */
import Link from 'next/link';
import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { Field } from '@/components/common/field';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

type CardStatus = 'PENDING' | 'SUCCESS' | 'WRONG_VALUE' | 'FAILED';

interface CardTopupRow {
  id: string;
  code: string;
  provider: string;
  telco: string;
  serial: string;
  pin: string;
  declaredValue: number;
  realValue: number | null;
  providerAmount: string | number | null;
  credited: string | number;
  discount: string | number;
  status: CardStatus;
  message: string | null;
  /** Lỗi phía hệ thống / nhà cung cấp — không tính vào giới hạn thẻ lỗi của khách */
  systemError: boolean;
  providerRef: string | null;
  createdAt: string;
  completedAt: string | null;
  user: { id: string; name: string; email: string };
  reviewedBy: { id: string; name: string } | null;
}

interface CardStats {
  pending: number;
  success: number;
  wrongValue: number;
  failed: number;
  today: { cards: number; declared: number; credited: number };
}

const STATUS: Record<CardStatus, { label: string; className: string }> = {
  PENDING: { label: 'Chờ xử lý', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  SUCCESS: { label: 'Thành công', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  WRONG_VALUE: { label: 'Sai mệnh giá', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' },
  FAILED: { label: 'Thẻ lỗi', className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
};

/** Nút sao chép nhỏ trong ô bảng */
function CopyIcon({ text }: { text: string }) {
  return (
    <button
      type="button"
      title="Sao chép"
      className="text-muted-foreground hover:text-foreground"
      onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Đã sao chép'))}
    >
      <Copy className="size-3" />
    </button>
  );
}

/** Hộp thoại duyệt tay: nhập mệnh giá thật + số tiền cộng ví (để trống = tính theo chiết khấu) */
function ApproveDialog({ row, onClose }: { row: CardTopupRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [realValue, setRealValue] = useState('');
  const [credited, setCredited] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post(`/admin/card-topup/${row!.id}/approve`, {
        realValue: realValue ? Number(realValue) : undefined,
        credited: credited ? Number(credited) : undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Đã duyệt thẻ và cộng ví');
      void qc.invalidateQueries({ queryKey: ['card-topups'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const real = Number(realValue || row?.declaredValue || 0);
  const suggested = row ? Math.floor(real * (1 - Number(row.discount) / 100)) : 0;
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Duyệt thẻ thủ công</DialogTitle>
          <DialogDescription>
            {row?.telco} {formatMoney(row?.declaredValue)} · serial <span className="font-mono">{row?.serial}</span>. Chỉ duyệt khi đã kiểm tra thẻ đúng ở nhà cung cấp.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Mệnh giá thật">
            <Input type="number" min={0} value={realValue} onChange={(e) => setRealValue(e.target.value)} placeholder={String(row?.declaredValue ?? '')} />
          </Field>
          <Field label="Cộng vào ví" help={`Mặc định ${formatMoney(suggested)} (CK ${Number(row?.discount ?? 0)}%)`}>
            <Input type="number" min={0} value={credited} onChange={(e) => setCredited(e.target.value)} placeholder={String(suggested)} />
          </Field>
        </div>
        <Field label="Ghi chú">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Admin duyệt thủ công" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            <Check /> Duyệt & cộng ví
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Hộp thoại từ chối thẻ (không cộng ví) */
function RejectDialog({ row, onClose }: { row: CardTopupRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/admin/card-topup/${row!.id}/reject`, { reason: reason.trim() || undefined }),
    onSuccess: () => {
      toast.success('Đã đánh dấu thẻ lỗi');
      void qc.invalidateQueries({ queryKey: ['card-topups'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Từ chối thẻ</DialogTitle>
          <DialogDescription>Thẻ sẽ chuyển sang “Thẻ lỗi”, không cộng tiền vào ví khách.</DialogDescription>
        </DialogHeader>
        <Field label="Lý do (khách nhìn thấy)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Thẻ không hợp lệ hoặc đã được sử dụng" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button variant="destructive" onClick={() => m.mutate()} disabled={m.isPending}>
            <X /> Từ chối
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Thống kê nhanh (cùng queryKey với bảng nên không gọi API hai lần) */
export function useCardTopupStats() {
  return useQuery({ queryKey: ['card-topups', 'stats'], queryFn: () => api.get<CardStats>('/admin/card-topup/stats') });
}

/** Câu tóm tắt hôm nay cho mô tả header trang */
export function cardTopupTodaySummary(s: CardStats | undefined) {
  return s ? `Hôm nay: ${s.today.cards} thẻ thành công · mệnh giá ${formatMoney(s.today.declared)} · đã cộng ví ${formatMoney(s.today.credited)}` : 'Thẻ cào thành viên nạp vào ví';
}

/** Thân trang: tab trạng thái + tìm kiếm + bảng thẻ + hộp thoại duyệt/từ chối (cần bọc Suspense ở trang) */
export function CardTopupLogsView() {
  const { can } = useAuth();
  const canManage = can('users.wallet');
  const qc = useQueryClient();
  const { params, set, page, limit } = useListParams<Record<string, string>>({ status: '', search: '' });
  const [approving, setApproving] = useState<CardTopupRow | null>(null);
  const [rejecting, setRejecting] = useState<CardTopupRow | null>(null);

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['card-topups', params.status, params.search, page, limit],
    queryFn: () => api.get<Paginated<CardTopupRow>>('/admin/card-topup', { status: params.status, search: params.search, page, limit }),
  });
  const stats = useCardTopupStats();

  const recheck = useMutation({
    mutationFn: (id: string) => api.post<{ status: CardStatus; message: string | null }>(`/admin/card-topup/${id}/recheck`),
    onSuccess: (r) => {
      toast.message(`Nhà cung cấp trả về: ${STATUS[r.status]?.label ?? r.status}${r.message ? ` — ${r.message}` : ''}`);
      void qc.invalidateQueries({ queryKey: ['card-topups'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns: Column<CardTopupRow>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div>{formatDate(r.createdAt)}</div>
          <div className="text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'user',
      header: 'Thành viên',
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/users/${r.user.id}`} className="line-clamp-1 font-medium hover:text-primary">
            {r.user.name}
          </Link>
          <div className="line-clamp-1 text-xs text-muted-foreground">{r.user.email}</div>
        </div>
      ),
    },
    {
      key: 'card',
      header: 'Thẻ',
      cell: (r) => (
        <div className="space-y-0.5 text-xs">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="font-medium">
              {r.telco}
            </Badge>
            <span className="font-semibold tabular-nums">{formatMoney(r.declaredValue)}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Serial</span> <span className="font-mono">{r.serial}</span>
            <CopyIcon text={r.serial} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Mã</span> <span className="font-mono">{r.pin}</span>
            <CopyIcon text={r.pin} />
          </div>
        </div>
      ),
    },
    {
      key: 'credited',
      header: 'Cộng ví',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div className={cn('text-sm font-semibold tabular-nums', Number(r.credited) > 0 && 'text-emerald-700 dark:text-emerald-400')}>{Number(r.credited) > 0 ? `+${formatMoney(r.credited)}` : '—'}</div>
          {r.realValue != null && r.realValue !== r.declaredValue && <div className="text-orange-600 dark:text-orange-400">Thật: {formatMoney(r.realValue)}</div>}
          {r.providerAmount != null && <div className="text-muted-foreground">NCC trả: {formatMoney(r.providerAmount)}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="max-w-56 space-y-1">
          <div className="flex flex-wrap items-center gap-1">
            <Badge className={cn('border-transparent', STATUS[r.status].className)}>{STATUS[r.status].label}</Badge>
            {r.systemError && (
              <Badge variant="outline" className="text-[10px]" title="Nhà cung cấp chưa nhận thẻ — không tính vào giới hạn thẻ lỗi của khách">
                Lỗi hệ thống
              </Badge>
            )}
          </div>
          {r.message && (
            <p className="line-clamp-2 text-xs text-muted-foreground" title={r.message}>
              {r.message}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            <span className="font-mono">{r.code}</span> · {r.provider}
            {r.reviewedBy && <> · duyệt bởi {r.reviewedBy.name}</>}
          </p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10 text-right',
      cell: (r) =>
        canManage && r.status === 'PENDING' ? (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="icon-xs" title="Hỏi lại nhà cung cấp" disabled={recheck.isPending} onClick={() => recheck.mutate(r.id)}>
              <RefreshCw className={cn(recheck.isPending && recheck.variables === r.id && 'animate-spin')} />
            </Button>
            <Button variant="ghost" size="icon-xs" title="Duyệt tay & cộng ví" onClick={() => setApproving(r)}>
              <Check className="text-emerald-600" />
            </Button>
            <Button variant="ghost" size="icon-xs" title="Từ chối" onClick={() => setRejecting(r)}>
              <X className="text-red-600" />
            </Button>
          </div>
        ) : null,
    },
  ];

  const s = stats.data;
  return (
    <>
      <div className="space-y-4">
        <StatusTabs
          value={params.status}
          onChange={(v) => set({ status: v })}
          options={[
            { value: '', label: 'Tất cả' },
            { value: 'PENDING', label: 'Chờ xử lý', count: s?.pending, highlight: true },
            { value: 'SUCCESS', label: 'Thành công', count: s?.success },
            { value: 'WRONG_VALUE', label: 'Sai mệnh giá', count: s?.wrongValue },
            { value: 'FAILED', label: 'Thẻ lỗi', count: s?.failed },
          ]}
        />
        <ListToolbar search={params.search} onSearchChange={(v) => set({ search: v })} placeholder="Serial, mã thẻ, mã yêu cầu, email thành viên..." />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          emptyTitle="Chưa có thẻ nào"
          emptyDescription="Thẻ được tạo khi thành viên nạp thẻ cào trên website (bật ở Cài đặt › Cổng thanh toán › Nạp thẻ cào)."
        />
        <p className="text-xs text-muted-foreground">Thẻ chờ quá 3 phút được tự hỏi lại nhà cung cấp mỗi 5 phút (trong 48 giờ). Sau đó cần duyệt / từ chối tay.</p>
      </div>
      <ApproveDialog key={approving?.id ?? 'a'} row={approving} onClose={() => setApproving(null)} />
      <RejectDialog key={rejecting?.id ?? 'r'} row={rejecting} onClose={() => setRejecting(null)} />
    </>
  );
}
