'use client';

/**
 * Danh sách vận đơn: thống kê nhanh, tab trạng thái, tìm kiếm (mã vận đơn / mã đơn / tên, SĐT khách),
 * lọc hãng + khoảng ngày, chọn nhiều để đồng bộ trạng thái từ hãng.
 */

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Eye, Loader2, PackageCheck, Printer, RefreshCw, Settings2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toNum } from '@/components/commerce/utils';
import { canTrack, carrierServiceText, hasLabel, openShipmentLabel, ShipmentStatusBadge, useCarriers, type ShipmentRow, type ShipmentStats } from '@/components/commerce/shipments';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

/** Thẻ số liệu nhỏ */
function StatCard({ label, value, hint, className, icon: Icon }: { label: string; value: string | number; hint?: string; className?: string; icon: typeof Truck }) {
  return (
    <div className={cn('flex items-center gap-3 rounded-xl border bg-card p-4', className)}>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-semibold tabular-nums">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function ShipmentsContent() {
  const { can } = useAuth();
  const canSettings = can('settings.manage');
  const qc = useQueryClient();
  const { params, set, page, limit } = useListParams<Record<string, string>>({ status: '', search: '', carrier: '', from: '', to: '' });
  const [selected, setSelected] = useState<string[]>([]);

  // meta hãng chỉ đọc được khi có quyền cài đặt; không có thì dùng carrierName trong dữ liệu vận đơn
  const carriers = useCarriers(canSettings);
  const stats = useQuery({ queryKey: ['shipment-stats'], queryFn: () => api.get<ShipmentStats>('/admin/shipments/stats'), refetchInterval: 60_000 });
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['shipments', params.status, params.search, params.carrier, params.from, params.to, page, limit],
    queryFn: () =>
      api.get<Paginated<ShipmentRow>>('/admin/shipments', {
        status: params.status || undefined,
        search: params.search,
        carrier: params.carrier,
        from: params.from ? new Date(`${params.from}T00:00:00`).toISOString() : undefined,
        to: params.to ? new Date(`${params.to}T23:59:59.999`).toISOString() : undefined,
        page,
        limit,
      }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shipments'] });
    void qc.invalidateQueries({ queryKey: ['shipment-stats'] });
  };

  /** Đồng bộ hàng loạt (API bỏ qua vận đơn hãng không hỗ trợ tra cứu) */
  const bulkSync = useMutation({
    mutationFn: (ids: string[]) => api.post<{ results: { id: string; ok?: boolean; error?: string }[] }>('/admin/shipments/bulk-sync', { ids }),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.ok).length;
      const failed = r.results.filter((x) => x.error);
      if (failed.length) toast.warning(`Đã đồng bộ ${ok} vận đơn, ${failed.length} lỗi: ${failed[0].error}`);
      else toast.success(`Đã đồng bộ ${ok} vận đơn`);
      setSelected([]);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const syncOne = useMutation({
    mutationFn: (id: string) => api.post(`/admin/shipments/${id}/sync`),
    onSuccess: () => {
      toast.success('Đã đồng bộ trạng thái từ hãng');
      refresh();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refresh();
    },
  });

  const counts = stats.data?.counts ?? {};
  const rows = list.data?.data;
  const metaList = carriers.data?.carriers;
  const capsOf = (key: string) => metaList?.find((c) => c.key === key)?.capabilities ?? null;
  // chỉ đồng bộ được vận đơn chưa kết thúc của hãng có API tra cứu
  const syncable = selected.filter((id) => rows?.some((r) => r.id === id && canTrack(r, capsOf(r.carrier))));
  const noCarrier = carriers.data && !carriers.data.carriers.some((c) => c.enabled);
  // bộ lọc hãng: theo meta, hoặc gom từ dữ liệu đang hiện khi không đọc được meta
  const carrierOptions = metaList?.map((c) => ({ key: c.key, name: c.name })) ?? [...new Map((rows ?? []).map((r) => [r.carrier, { key: r.carrier, name: r.carrierName }])).values()];

  const columns: Column<ShipmentRow>[] = [
    {
      key: 'trackingCode',
      header: 'Mã vận đơn',
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/orders/shipments/${r.id}`} className={cn('font-mono font-semibold hover:text-primary', !r.trackingCode && 'font-sans font-normal text-muted-foreground')}>
            {r.trackingCode ?? 'Chưa có mã'}
          </Link>
          <div className="truncate text-xs text-muted-foreground">{carrierServiceText(r, metaList)}</div>
        </div>
      ),
    },
    {
      key: 'order',
      header: 'Đơn hàng',
      cell: (r) =>
        r.order ? (
          <Link href={`/orders/${r.order.id}`} className="font-mono text-sm font-medium hover:text-primary">
            #{r.order.code}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'recipient',
      header: 'Người nhận',
      cell: (r) => (
        <div className="max-w-56 min-w-0">
          <div className="truncate font-medium">{r.recipient?.name || r.order?.customerName || '—'}</div>
          <div className="truncate text-xs text-muted-foreground">{r.recipient?.phone || r.order?.customerPhone || ''}</div>
        </div>
      ),
    },
    {
      key: 'fee',
      header: 'Phí / COD',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => (
        <div className="whitespace-nowrap tabular-nums">
          <div className="font-semibold">{formatMoney(toNum(r.fee))}</div>
          <div className="text-xs text-muted-foreground">{toNum(r.codAmount) > 0 ? `COD ${formatMoney(toNum(r.codAmount))}` : 'Không COD'}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="max-w-56 space-y-1">
          <ShipmentStatusBadge status={r.status} />
          {r.status === 'FAILED' && r.errorMessage ? (
            <p className="line-clamp-2 text-xs text-red-600 dark:text-red-400" title={r.errorMessage}>
              {r.errorMessage}
            </p>
          ) : r.statusMessage ? (
            <p className="line-clamp-2 text-xs text-muted-foreground" title={r.statusMessage}>
              {r.statusMessage}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'expectedDeliveryAt',
      header: 'Dự kiến giao',
      cell: (r) =>
        r.deliveredAt ? (
          <div className="whitespace-nowrap text-xs">
            <div className="text-emerald-700 dark:text-emerald-400">Đã giao</div>
            <div className="text-muted-foreground">{formatDate(r.deliveredAt)}</div>
          </div>
        ) : r.expectedDeliveryAt ? (
          <div className="whitespace-nowrap text-xs">
            <div>{formatDate(r.expectedDeliveryAt, 'dd/MM/yyyy')}</div>
            <div className="text-muted-foreground">{timeAgo(r.expectedDeliveryAt)}</div>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'updated',
      header: 'Cập nhật',
      cell: (r) => {
        const at = r.lastSyncAt ?? r.updatedAt ?? r.createdAt;
        return (
          <div className="whitespace-nowrap text-xs" title={formatDate(at)}>
            <div>{timeAgo(at)}</div>
            <div className="text-muted-foreground">Tạo {formatDate(r.createdAt, 'dd/MM HH:mm')}</div>
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10 text-right',
      cell: (r) => {
        const caps = capsOf(r.carrier);
        return (
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="icon-xs" asChild title="Xem chi tiết">
              <Link href={`/orders/shipments/${r.id}`}>
                <Eye />
              </Link>
            </Button>
            {canTrack(r, caps) && (
              <Button
                variant="ghost"
                size="icon-xs"
                title="Đồng bộ trạng thái từ hãng"
                disabled={syncOne.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  syncOne.mutate(r.id);
                }}
              >
                {syncOne.isPending && syncOne.variables === r.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            )}
            {hasLabel(r, caps) && (
              <Button
                variant="ghost"
                size="icon-xs"
                title="In nhãn"
                onClick={(e) => {
                  e.stopPropagation();
                  void openShipmentLabel(r.id);
                }}
              >
                <Printer />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Vận đơn"
        description="Theo dõi vận đơn đã tạo qua các đơn vị vận chuyển"
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Vận đơn' }]}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={list.isFetching}>
              <RefreshCw className={cn(list.isFetching && 'animate-spin')} /> Tải lại
            </Button>
            {canSettings && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings?tab=shipping&section=carriers">
                  <Settings2 /> Đơn vị vận chuyển
                </Link>
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        {noCarrier && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <AlertTriangle className="size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Chưa bật đơn vị vận chuyển nào</p>
              <p className="text-xs opacity-90">Bật và cấu hình hãng (GHN, GHTK, Viettel Post...) để báo giá, tạo vận đơn và theo dõi hành trình tự động.</p>
            </div>
            {canSettings && (
              <Button size="sm" variant="outline" asChild className="border-amber-300 dark:border-amber-800">
                <Link href="/settings?tab=shipping&section=carriers">Mở cài đặt</Link>
              </Button>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {stats.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[76px] rounded-xl" />)
          ) : (
            <>
              <StatCard icon={Truck} label="Đang xử lý" value={stats.data?.active ?? 0} hint="Chờ lấy, đang lấy, đang giao, đang hoàn" />
              <StatCard icon={Clock} label="Chờ lấy hàng" value={counts.PENDING ?? 0} hint="Đã tạo, shipper chưa lấy" />
              <StatCard icon={PackageCheck} label="Đã giao" value={counts.DELIVERED ?? 0} hint="Tổng" />
              <StatCard icon={AlertTriangle} label="Lỗi / hoàn" value={(counts.FAILED ?? 0) + (counts.RETURNING ?? 0) + (counts.RETURNED ?? 0)} hint="Cần kiểm tra" className={cn((counts.FAILED ?? 0) > 0 && 'border-amber-300 dark:border-amber-800')} />
            </>
          )}
        </div>

        <StatusTabs
          value={params.status}
          onChange={(v) => {
            setSelected([]);
            set({ status: v });
          }}
          options={[
            { value: '', label: 'Tất cả' },
            { value: 'active', label: 'Đang xử lý', count: stats.data?.active },
            { value: 'PENDING', label: 'Chờ lấy hàng', count: counts.PENDING },
            { value: 'DELIVERING', label: 'Đang giao', count: counts.DELIVERING },
            { value: 'DELIVERED', label: 'Đã giao', count: counts.DELIVERED },
            { value: 'RETURNING', label: 'Đang hoàn', count: counts.RETURNING, highlight: true },
            { value: 'RETURNED', label: 'Đã hoàn', count: counts.RETURNED },
            { value: 'CANCELLED', label: 'Đã huỷ', count: counts.CANCELLED },
            { value: 'FAILED', label: 'Lỗi', count: counts.FAILED, highlight: true },
          ]}
        />

        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Mã vận đơn, mã đơn, tên / SĐT khách..."
          selectedCount={syncable.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            <Button size="xs" onClick={() => bulkSync.mutate(syncable)} disabled={bulkSync.isPending}>
              {bulkSync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Đồng bộ
            </Button>
          }
          filters={
            <>
              <Select value={params.carrier || 'all'} onValueChange={(v) => set({ carrier: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Hãng vận chuyển" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả hãng</SelectItem>
                  {carrierOptions.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Input type="date" value={params.from} onChange={(e) => set({ from: e.target.value })} className="w-36" aria-label="Từ ngày" />
                <span className="text-xs text-muted-foreground">–</span>
                <Input type="date" value={params.to} onChange={(e) => set({ to: e.target.value })} className="w-36" aria-label="Đến ngày" />
              </div>
            </>
          }
        />

        <DataTable
          columns={columns}
          data={rows}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          emptyTitle={params.status ? 'Không có vận đơn ở trạng thái này' : 'Chưa có vận đơn'}
          emptyDescription={params.status ? undefined : 'Tạo vận đơn từ trang chi tiết đơn hàng (mục Vận chuyển), hoặc bật tự tạo vận đơn trong Cài đặt.'}
          emptyAction={
            !params.status ? (
              <Button size="sm" variant="outline" asChild>
                <Link href="/orders">
                  <CheckCircle2 /> Mở danh sách đơn hàng
                </Link>
              </Button>
            ) : undefined
          }
        />
      </PageBody>
    </>
  );
}

export default function ShipmentsPage() {
  return (
    <Suspense>
      <ShipmentsContent />
    </Suspense>
  );
}
