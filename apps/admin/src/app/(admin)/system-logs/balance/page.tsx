'use client';

/**
 * Tab Nhật ký số dư: mọi biến động ví thành viên trên toàn hệ thống (nạp, trừ, thanh toán, hoàn tiền),
 * lọc theo loại / chiều tiền / khoảng ngày, kèm tổng cộng – tổng trừ theo bộ lọc để đối soát.
 */
import Link from 'next/link';
import { Suspense } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { PageBody } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { TXN_TYPES, type TxnType } from '@/components/users/wallet-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

interface WalletLogRow {
  id: string;
  type: TxnType;
  amount: string;
  balanceAfter: string;
  note: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
  order: { id: string; code: string } | null;
  createdBy: { id: string; name: string } | null;
}

type WalletLogList = Paginated<WalletLogRow> & { summary: { credit: number; debit: number } };

const DEFAULTS = { search: '', type: '', direction: '', from: '', to: '' };

/** Ô thống kê nhỏ phía trên bảng */
function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', className)}>{value}</div>
    </div>
  );
}

function BalanceLogs() {
  const { params, set, page, limit } = useListParams(DEFAULTS);
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['system-logs', 'wallet', params],
    queryFn: () => api.get<WalletLogList>('/admin/system-logs/wallet', { ...params, page, limit }),
  });
  const hasFilter = !!(params.search || params.type || params.direction || params.from || params.to);
  const summary = list.data?.summary;

  const columns: Column<WalletLogRow>[] = [
    {
      key: 'createdAt',
      header: 'Thời gian',
      className: 'w-40',
      cell: (r) => (
        <div className="text-sm">
          <div>{formatDate(r.createdAt)}</div>
          <div className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'user',
      header: 'Thành viên',
      mobile: 'primary',
      cell: (r) => (
        <Link href={`/users/${r.user.id}`} className="block min-w-0 hover:text-primary">
          <div className="truncate font-medium">{r.user.name}</div>
          <div className="truncate text-xs text-muted-foreground">{r.user.email}</div>
        </Link>
      ),
    },
    {
      key: 'type',
      header: 'Loại',
      cell: (r) => {
        const t = TXN_TYPES[r.type];
        return (
          <Badge className={cn('border-transparent font-medium', t?.className)}>
            {t && <t.icon />} {t?.label ?? r.type}
          </Badge>
        );
      },
    },
    {
      key: 'amount',
      header: 'Số tiền',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => {
        const n = Number(r.amount);
        return <span className={cn('font-semibold tabular-nums', n >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>{(n >= 0 ? '+' : '−') + formatMoney(Math.abs(n))}</span>;
      },
    },
    { key: 'balanceAfter', header: 'Số dư sau', headClassName: 'text-right', className: 'text-right tabular-nums', cell: (r) => formatMoney(r.balanceAfter) },
    {
      key: 'note',
      header: 'Nội dung',
      cell: (r) => (
        <div className="max-w-xs text-sm">
          {r.order && (
            <Link href={`/orders/${r.order.id}`} className="font-mono font-semibold hover:text-primary">
              #{r.order.code}
            </Link>
          )}
          {r.note && <div className="line-clamp-2 text-muted-foreground">{r.note}</div>}
          {!r.order && !r.note && <span className="text-muted-foreground">—</span>}
        </div>
      ),
    },
    // null = hệ thống hoặc khách tự thanh toán bằng ví
    { key: 'createdBy', header: 'Người thực hiện', cell: (r) => (r.createdBy ? <span className="text-sm">{r.createdBy.name}</span> : <span className="text-xs text-muted-foreground">Hệ thống</span>) },
  ];

  return (
    <>
      <SystemLogsHeader tab="balance" />
      <PageBody>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Tổng cộng vào ví (theo bộ lọc)" value={summary ? `+${formatMoney(summary.credit)}` : '—'} className="text-emerald-600 dark:text-emerald-400" />
          <Stat label="Tổng trừ khỏi ví (theo bộ lọc)" value={summary ? `−${formatMoney(summary.debit)}` : '—'} className="text-rose-600 dark:text-rose-400" />
          <Stat label="Số giao dịch" value={list.data ? list.data.meta.total.toLocaleString('vi-VN') : '—'} />
        </div>
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm tên, email thành viên, mã đơn, ghi chú..."
          filters={
            <>
              <Select value={params.type || 'all'} onValueChange={(v) => set({ type: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-40">
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
              <Select value={params.direction || 'all'} onValueChange={(v) => set({ direction: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Cộng & trừ</SelectItem>
                  <SelectItem value="in">Chỉ cộng tiền</SelectItem>
                  <SelectItem value="out">Chỉ trừ tiền</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Input type="date" value={params.from} onChange={(e) => set({ from: e.target.value })} className="w-36" aria-label="Từ ngày" />
                <span>→</span>
                <Input type="date" value={params.to} onChange={(e) => set({ to: e.target.value })} className="w-36" aria-label="Đến ngày" />
              </div>
              {hasFilter && (
                <Button variant="ghost" size="sm" onClick={() => set(DEFAULTS)}>
                  <X /> Bỏ lọc
                </Button>
              )}
            </>
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          emptyTitle="Chưa có biến động số dư nào"
        />
      </PageBody>
    </>
  );
}

export default function BalanceLogsPage() {
  return (
    <Suspense>
      <BalanceLogs />
    </Suspense>
  );
}
