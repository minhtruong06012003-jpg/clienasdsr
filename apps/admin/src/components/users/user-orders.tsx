'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, ShoppingCart } from 'lucide-react';
import { Section } from '@/components/common/field';
import { DataTable, type Column } from '@/components/common/data-table';
import { StatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { api, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';

interface OrderRow {
  id: string;
  code: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  currency: string;
  total: unknown;
  refundedTotal?: unknown;
  createdAt: string;
  _count: { items: number };
}

const toNum = (v: unknown) => Number(v ?? 0);

/**
 * Tab "Đơn hàng" trên trang chi tiết thành viên: bảng đơn của riêng thành viên này
 * (lọc server-side theo userId), có phân trang và link sang danh sách đơn đầy đủ.
 */
export function UserOrdersPanel({ userId, email }: { userId: string; email: string }) {
  const [page, setPage] = useState(1);
  const orders = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['user-orders', userId, page],
    queryFn: () => api.get<Paginated<OrderRow>>('/admin/orders', { userId, page, limit: 10, sort: 'createdAt', order: 'desc' }),
  });

  const columns: Column<OrderRow>[] = [
    {
      key: 'code',
      header: 'Mã đơn',
      cell: (r) => (
        <div>
          <Link href={`/orders/${r.id}`} className="font-mono font-semibold hover:text-primary">
            #{r.code}
          </Link>
          <div className="text-xs text-muted-foreground">{r._count.items} sản phẩm</div>
        </div>
      ),
    },
    {
      key: 'total',
      header: 'Tổng tiền',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <span className="font-semibold tabular-nums">{formatMoney(toNum(r.total), r.currency)}</span>
          {toNum(r.refundedTotal) > 0 && <div className="text-xs tabular-nums text-muted-foreground">đã hoàn {formatMoney(toNum(r.refundedTotal), r.currency)}</div>}
        </div>
      ),
    },
    { key: 'payment', header: 'Thanh toán', cell: (r) => <StatusBadge status={r.paymentStatus} /> },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'createdAt',
      header: 'Ngày đặt',
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div>{formatDate(r.createdAt)}</div>
          <div className="text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
  ];

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <ShoppingCart className="size-4 text-muted-foreground" /> Đơn hàng
        </span>
      }
      description="Các đơn thành viên đã đặt khi đăng nhập. Đơn đặt bằng email này khi chưa đăng nhập xem ở danh sách đơn hàng."
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link href={`/orders?search=${encodeURIComponent(email)}`}>
            <ExternalLink /> Tìm theo email
          </Link>
        </Button>
      }
    >
      <DataTable columns={columns} data={orders.data?.data ?? []} loading={orders.isLoading} error={orders.error} onRetry={() => void orders.refetch()} meta={orders.data?.meta} onPageChange={setPage} emptyTitle="Chưa có đơn hàng nào" emptyDescription="Thành viên này chưa đặt đơn nào khi đăng nhập." />
    </Section>
  );
}
