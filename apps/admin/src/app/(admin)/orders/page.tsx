'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Eye, MoreHorizontal, Plus, Printer, TicketPercent, Trash2, Truck, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { StatusBadge, STATUS_LABELS } from '@/components/common/status-badge';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, qs, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { ONLINE_PAYMENT_LABELS, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, toNum } from '@/components/commerce/utils';
import { openInvoice, SOURCE_LABELS } from '@/components/commerce/order-dialogs';
import { OrderCodeStatusBadge } from '@/components/digital-codes/shared';

interface OrderRow {
  id: string;
  code: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  currency: string;
  total: unknown;
  refundedTotal?: unknown;
  couponCode: string | null;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string;
  source: string;
  shippingMethodName: string | null;
  /** trạng thái giao mã (null = đơn không có sản phẩm kho mã) */
  codeStatus?: string | null;
  createdAt: string;
  _count: { items: number };
}

type OrderList = Paginated<OrderRow> & { statusCounts: Record<string, number> };
interface BulkResult {
  affected: number;
  /** đơn bị bỏ qua; với xoá, `error` đã có dạng "Đơn X: lý do" */
  failed: { id: string; code?: string; error: string }[];
  /** tóm tắt từ API (vd "Đã bỏ qua 2 đơn không được xoá: DH..., DH...") */
  message?: string;
}

const SOURCE_OPTIONS = [
  { value: 'web', label: 'Website' },
  { value: 'admin', label: 'Admin' },
  { value: 'pos', label: 'POS' },
];

function SourceBadge({ source }: { source: string }) {
  const cls = source === 'admin' ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' : source === 'pos' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300';
  return <Badge className={`border-transparent font-medium ${cls}`}>{SOURCE_LABELS[source] ?? source}</Badge>;
}

function OrdersList() {
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canWrite = can('orders.write');
  const { params, set, page, limit } = useListParams({ status: '', paymentStatus: '', source: '', search: '', from: '', to: '', sort: 'createdAt', order: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkPayment, setBulkPayment] = useState('');

  const filterQuery = {
    status: params.status,
    paymentStatus: params.paymentStatus,
    source: params.source,
    search: params.search,
    sort: params.sort,
    order: params.order,
    from: params.from ? new Date(`${params.from}T00:00:00`).toISOString() : undefined,
    to: params.to ? new Date(`${params.to}T23:59:59.999`).toISOString() : undefined,
  };
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['orders', params],
    queryFn: () => api.get<OrderList>('/admin/orders', { ...filterQuery, page, limit }),
  });

  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: string }) => api.post<BulkResult>('/admin/orders/bulk', { ids, action }),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      // giữ lại các đơn bị bỏ qua trong vùng chọn để admin thấy rõ đơn nào chưa xử lý
      setSelected(r.failed.map((f) => f.id).filter((id) => v.ids.includes(id)));
      setBulkStatus('');
      setBulkPayment('');
      if (r.failed.length) {
        // liệt kê từng đơn bị bỏ qua + lý do (mỗi dòng một đơn), toast để lâu hơn cho kịp đọc
        const lines = r.failed.map((f) => (v.action === 'delete' || !f.code ? f.error : `#${f.code}: ${f.error}`));
        toast.warning(`${v.action === 'delete' ? 'Đã xoá' : 'Đã cập nhật'} ${r.affected} đơn · bỏ qua ${r.failed.length} đơn`, {
          description: (
            <div className="space-y-0.5">
              {r.message && <p className="font-medium">{r.message}</p>}
              <ul className="max-h-48 list-disc overflow-y-auto pl-4">
                {lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ),
          duration: 15_000,
        });
      } else toast.success(`${v.action === 'delete' ? 'Đã xoá' : 'Đã cập nhật'} ${r.affected} đơn hàng`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runBulk = async (ids: string[], action: string) => {
    if (!ids.length) return;
    if (action === 'delete') {
      const ok = await confirm({ title: `Xoá ${ids.length} đơn hàng?`, description: 'Chỉ đơn đã huỷ mới bị xoá vĩnh viễn (kho đã được hoàn khi huỷ). Đơn ở trạng thái khác sẽ được bỏ qua.', destructive: true, confirmText: 'Xoá' });
      if (!ok) return;
    } else if (action.startsWith('status:')) {
      const target = action.slice(7);
      if (['CANCELLED', 'REFUNDED'].includes(target)) {
        const ok = await confirm({ title: `Chuyển ${ids.length} đơn sang "${STATUS_LABELS[target]}"?`, description: 'Số lượng sản phẩm trong các đơn này sẽ được hoàn lại kho và không thể mở lại.', destructive: true, confirmText: 'Xác nhận' });
        if (!ok) return;
      }
    }
    bulk.mutate({ ids, action });
  };

  const exportCsv = (detail: boolean) => {
    const stamp = new Date().toISOString().slice(0, 10);
    toast.promise(api.download(`/admin/orders/export.csv${qs({ ...filterQuery, detail: detail ? '1' : undefined })}`, `don-hang-${detail ? 'chi-tiet-' : ''}${stamp}.csv`), {
      loading: 'Đang xuất CSV...',
      success: 'Đã tải file CSV',
      error: (e) => errorMessage(e),
    });
  };

  const counts = list.data?.statusCounts ?? {};
  const totalCount = Object.values(counts).reduce((s, n) => s + n, 0);

  const columns: Column<OrderRow>[] = [
    {
      key: 'code',
      header: 'Mã đơn',
      cell: (r) => (
        <div>
          <Link href={`/orders/${r.id}`} className="font-mono font-semibold hover:text-primary" onClick={(e) => e.stopPropagation()}>
            #{r.code}
          </Link>
          <div className="text-xs text-muted-foreground">{r._count.items} sản phẩm</div>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Khách hàng',
      cell: (r) => (
        <div className="min-w-0">
          <div className="line-clamp-1 font-medium">{r.customerName}</div>
          <div className="line-clamp-1 text-xs text-muted-foreground">{r.customerPhone}{r.customerEmail ? ` · ${r.customerEmail}` : ''}</div>
        </div>
      ),
    },
    {
      key: 'total',
      header: 'Tổng tiền',
      headClassName: 'text-right',
      className: 'text-right',
      sortable: true,
      cell: (r) => (
        <div className="whitespace-nowrap">
          <span className="font-semibold tabular-nums">{formatMoney(toNum(r.total), r.currency)}</span>
          {toNum(r.refundedTotal) > 0 && <div className="text-xs tabular-nums text-muted-foreground">đã hoàn {formatMoney(toNum(r.refundedTotal), r.currency)}</div>}
          {r.couponCode && (
            <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
              <TicketPercent className="size-3" />
              {r.couponCode}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'payment',
      header: 'Thanh toán',
      cell: (r) => (
        <div className="space-y-0.5">
          <StatusBadge status={r.paymentStatus} />
          <div className="text-xs text-muted-foreground">{r.paymentMethod === 'cod' ? 'COD' : (PAYMENT_METHODS[r.paymentMethod] ?? ONLINE_PAYMENT_LABELS[r.paymentMethod] ?? r.paymentMethod)}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={r.status} />
          {/* đơn có sản phẩm kho mã: chờ / thiếu mã tô cam */}
          <OrderCodeStatusBadge status={r.codeStatus} className="text-[10px]" />
        </div>
      ),
    },
    {
      key: 'source',
      header: 'Nguồn',
      cell: (r) => (
        <div className="space-y-0.5">
          <SourceBadge source={r.source} />
          {r.shippingMethodName && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Truck className="size-3" />
              <span className="line-clamp-1">{r.shippingMethodName}</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: 'Ngày đặt',
      sortable: true,
      cell: (r) => (
        <div className="whitespace-nowrap text-xs">
          <div>{formatDate(r.createdAt)}</div>
          <div className="text-muted-foreground">{timeAgo(r.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (r) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem asChild>
              <Link href={`/orders/${r.id}`}>
                <Eye /> Xem chi tiết
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openInvoice(r.id, true)}>
              <Printer /> In hoá đơn
            </DropdownMenuItem>
            {canWrite && r.status === 'CANCELLED' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => runBulk([r.id], 'delete')}>
                  <Trash2 /> Xoá đơn
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const hasFilter = params.search || params.paymentStatus || params.source || params.from || params.to;

  return (
    <>
      <PageHeader
        title="Đơn hàng"
        description="Theo dõi và xử lý đơn đặt hàng"
        actions={
          <>
            {can('coupons.manage') && (
              <Button variant="outline" asChild>
                <Link href="/orders/coupons">
                  <TicketPercent /> Mã giảm giá
                </Link>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Download /> Xuất CSV
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Theo bộ lọc hiện tại</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => exportCsv(false)}>Mỗi đơn một dòng (sản phẩm gộp)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportCsv(true)}>Mỗi sản phẩm một dòng (chi tiết)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {canWrite && (
              <Button asChild>
                <Link href="/orders/new">
                  <Plus /> Tạo đơn
                </Link>
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        <StatusTabs
          value={params.status}
          onChange={(v) => set({ status: v })}
          options={[{ value: '', label: 'Tất cả', count: totalCount }, ...ORDER_STATUSES.map((s) => ({ value: s.value, label: s.label, count: counts[s.value] ?? 0 }))]}
        />
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Mã đơn, tên, SĐT, email..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            canWrite && (
              <>
                <Select value={bulkStatus || 'none'} onValueChange={(v) => setBulkStatus(v === 'none' ? '' : v)}>
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue placeholder="Đổi trạng thái" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Đổi trạng thái…</SelectItem>
                    {ORDER_STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={bulkPayment || 'none'} onValueChange={(v) => setBulkPayment(v === 'none' ? '' : v)}>
                  <SelectTrigger size="sm" className="w-44">
                    <SelectValue placeholder="Đổi thanh toán" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Đổi thanh toán…</SelectItem>
                    {PAYMENT_STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" disabled={(!bulkStatus && !bulkPayment) || bulk.isPending} onClick={() => runBulk(selected, bulkStatus ? `status:${bulkStatus}` : `paymentStatus:${bulkPayment}`)}>
                  Áp dụng
                </Button>
                <Button size="sm" variant="destructive" disabled={bulk.isPending} onClick={() => runBulk(selected, 'delete')}>
                  <Trash2 /> Xoá đơn đã huỷ
                </Button>
              </>
            )
          }
          filters={
            <>
              <Select value={params.paymentStatus || 'all'} onValueChange={(v) => set({ paymentStatus: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Thanh toán" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Mọi trạng thái thanh toán</SelectItem>
                  {PAYMENT_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={params.source || 'all'} onValueChange={(v) => set({ source: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Nguồn" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Mọi nguồn</SelectItem>
                  {SOURCE_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5">
                <Input type="date" value={params.from} max={params.to || undefined} onChange={(e) => set({ from: e.target.value })} className="w-38" aria-label="Từ ngày" />
                <span className="text-muted-foreground">–</span>
                <Input type="date" value={params.to} min={params.from || undefined} onChange={(e) => set({ to: e.target.value })} className="w-38" aria-label="Đến ngày" />
              </div>
              {hasFilter && (
                <Button variant="ghost" size="sm" onClick={() => set({ search: '', paymentStatus: '', source: '', from: '', to: '' })}>
                  <X /> Xoá lọc
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
          selectable={canWrite}
          selected={selected}
          onSelectedChange={setSelected}
          onRowClick={(r) => router.push(`/orders/${r.id}`)}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          sort={{ key: params.sort, order: params.order as 'asc' | 'desc' }}
          onSortChange={(s) => set({ sort: s.key, order: s.order })}
          emptyTitle={hasFilter || params.status ? 'Không có đơn hàng phù hợp' : 'Chưa có đơn hàng'}
          emptyDescription={hasFilter ? 'Thử thay đổi bộ lọc hoặc từ khoá tìm kiếm.' : 'Đơn hàng từ website sẽ xuất hiện tại đây, hoặc bấm "Tạo đơn" để tạo thủ công.'}
          emptyAction={
            canWrite && !hasFilter && !params.status ? (
              <Button asChild>
                <Link href="/orders/new">
                  <Plus /> Tạo đơn
                </Link>
              </Button>
            ) : undefined
          }
        />
      </PageBody>
    </>
  );
}

export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersList />
    </Suspense>
  );
}
