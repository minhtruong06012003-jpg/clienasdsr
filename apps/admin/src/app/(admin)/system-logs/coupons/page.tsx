'use client';

/**
 * Tab Nhật ký sử dụng mã giảm giá: mỗi lượt mã được áp vào đơn hàng (ai dùng, đơn nào, giảm bao nhiêu),
 * lọc theo khoảng ngày, kèm tổng tiền đã giảm theo bộ lọc.
 */
import Link from 'next/link';
import { Suspense } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { PageBody } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { StatusBadge } from '@/components/common/status-badge';
import { SystemLogsHeader } from '@/components/system-logs/system-logs-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';

interface CouponUsageRow {
  id: string;
  email: string | null;
  userId: string | null;
  createdAt: string;
  coupon: { id: string; code: string; type: 'PERCENT' | 'FIXED' | 'FREE_SHIPPING'; value: string };
  order: { id: string; code: string; customerName: string; customerEmail: string | null; discountTotal: string; total: string; status: string; paymentStatus: string; userId: string | null };
}

type CouponUsageList = Paginated<CouponUsageRow> & { summary: { discount: number } };

const DEFAULTS = { search: '', from: '', to: '' };

/** Mô tả ngắn giá trị mã: "10%", "50.000 ₫", "Miễn phí ship" */
function couponValue(c: CouponUsageRow['coupon']) {
  if (c.type === 'PERCENT') return `${Number(c.value)}%`;
  if (c.type === 'FREE_SHIPPING') return 'Miễn phí ship';
  return formatMoney(c.value);
}

function CouponLogs() {
  const { params, set, page, limit } = useListParams(DEFAULTS);
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['system-logs', 'coupon-usages', params],
    queryFn: () => api.get<CouponUsageList>('/admin/system-logs/coupon-usages', { ...params, page, limit }),
  });
  const hasFilter = !!(params.search || params.from || params.to);

  const columns: Column<CouponUsageRow>[] = [
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
      key: 'coupon',
      header: 'Mã giảm giá',
      mobile: 'primary',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono font-semibold">
            {r.coupon.code}
          </Badge>
          <span className="text-xs text-muted-foreground">{couponValue(r.coupon)}</span>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Khách hàng',
      cell: (r) => {
        const email = r.email ?? r.order.customerEmail;
        const uid = r.userId ?? r.order.userId;
        const body = (
          <>
            <div className="truncate font-medium">{r.order.customerName}</div>
            {email && <div className="truncate text-xs text-muted-foreground">{email}</div>}
          </>
        );
        // khách có tài khoản -> bấm sang trang thành viên; khách vãng lai chỉ hiện tên/email
        return uid ? (
          <Link href={`/users/${uid}`} className="block min-w-0 hover:text-primary">
            {body}
          </Link>
        ) : (
          <div className="min-w-0">{body}</div>
        );
      },
    },
    {
      key: 'order',
      header: 'Đơn hàng',
      cell: (r) => (
        <Link href={`/orders/${r.order.id}`} className="font-mono font-semibold hover:text-primary">
          #{r.order.code}
        </Link>
      ),
    },
    { key: 'discount', header: 'Đã giảm', headClassName: 'text-right', className: 'text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400', cell: (r) => formatMoney(r.order.discountTotal) },
    { key: 'total', header: 'Tổng đơn', headClassName: 'text-right', className: 'text-right tabular-nums', cell: (r) => formatMoney(r.order.total) },
    {
      key: 'status',
      header: 'Trạng thái đơn',
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={r.order.status} />
          <StatusBadge status={r.order.paymentStatus} />
        </div>
      ),
    },
  ];

  return (
    <>
      <SystemLogsHeader tab="coupons" />
      <PageBody>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Số lượt dùng (theo bộ lọc)</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{list.data ? list.data.meta.total.toLocaleString('vi-VN') : '—'}</div>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Tổng tiền đã giảm (theo bộ lọc)</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{list.data ? formatMoney(list.data.summary.discount) : '—'}</div>
          </div>
        </div>
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm mã giảm giá, email, tên khách, mã đơn..."
          filters={
            <>
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
          emptyTitle="Chưa có lượt dùng mã giảm giá nào"
        />
      </PageBody>
    </>
  );
}

export default function CouponLogsPage() {
  return (
    <Suspense>
      <CouponLogs />
    </Suspense>
  );
}
