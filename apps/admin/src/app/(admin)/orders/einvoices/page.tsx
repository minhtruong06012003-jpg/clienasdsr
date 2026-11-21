'use client';

/**
 * Danh sách hoá đơn điện tử: thống kê tháng, tab trạng thái, tìm kiếm, lọc NCC/loại/ngày,
 * chọn nhiều để phát hành lại, nút "Lập hoá đơn" chọn đơn hàng.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, FileDown, FileSpreadsheet, FileText, Loader2, Plus, Receipt, RefreshCw, Search, Send, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { StatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toNum } from '@/components/commerce/utils';
import { EINVOICE_KINDS, EInvoiceKindBadge, EInvoiceStatusBadge, invoiceNumber, openEInvoicePdf, providerLabel, useEInvoiceProviders, type EInvoiceRow } from '@/components/commerce/einvoice';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useDebounce } from '@/hooks/use-debounce';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';

interface Stats {
  counts: Partial<Record<string, number>>;
  needsAction: number;
  month: { count: number; total: number; vat: number };
}

interface OrderRow {
  id: string;
  code: string;
  customerName: string;
  total: unknown;
  currency: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
}

/** Thẻ số liệu nhỏ */
function StatCard({ label, value, hint, className, icon: Icon }: { label: string; value: string | number; hint?: string; className?: string; icon: typeof Receipt }) {
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

/** Dialog chọn đơn hàng để lập hoá đơn (tìm theo mã đơn / tên khách) */
function PickOrderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 350);
  const orders = useQuery({
    queryKey: ['einvoice-pick-order', q],
    queryFn: () => api.get<Paginated<OrderRow>>('/admin/orders', { search: q, limit: 10 }),
    enabled: open,
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Lập hoá đơn từ đơn hàng</DialogTitle>
          <DialogDescription>Chọn đơn hàng cần xuất hoá đơn điện tử. Bạn có thể sửa thông tin người mua và dòng hàng trước khi phát hành.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mã đơn, tên khách, số điện thoại..." className="pl-8" />
        </div>
        <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {orders.isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !orders.data?.data.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Không tìm thấy đơn hàng</p>
          ) : (
            orders.data.data.map((o) => (
              <button
                key={o.id}
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-muted/60"
                onClick={() => {
                  onClose();
                  router.push(`/orders/einvoices/new?orderId=${o.id}`);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">#{o.code}</span>
                    <StatusBadge status={o.status} className="text-[10px]" />
                    <StatusBadge status={o.paymentStatus} className="text-[10px]" />
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {o.customerName} · {timeAgo(o.createdAt)}
                  </div>
                </div>
                <span className="whitespace-nowrap font-semibold tabular-nums">{formatMoney(toNum(o.total), o.currency)}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EInvoicesContent() {
  const { can } = useAuth();
  const canWrite = can('einvoice.write');
  const canSettings = can('settings.manage');
  const qc = useQueryClient();
  const { params, set, page, limit } = useListParams<Record<string, string>>({ status: '', search: '', provider: '', kind: '', from: '', to: '' });
  const [selected, setSelected] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);

  const providers = useEInvoiceProviders();
  const stats = useQuery({ queryKey: ['einvoice-stats'], queryFn: () => api.get<Stats>('/admin/einvoices/stats'), refetchInterval: 60_000 });
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['einvoices', params.status, params.search, params.provider, params.kind, params.from, params.to, page, limit],
    queryFn: () =>
      api.get<Paginated<EInvoiceRow>>('/admin/einvoices', {
        status: params.status || undefined,
        search: params.search,
        provider: params.provider,
        kind: params.kind,
        from: params.from ? new Date(`${params.from}T00:00:00`).toISOString() : undefined,
        to: params.to ? new Date(`${params.to}T23:59:59.999`).toISOString() : undefined,
        page,
        limit,
      }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['einvoices'] });
    void qc.invalidateQueries({ queryKey: ['einvoice-stats'] });
    void qc.invalidateQueries({ queryKey: ['admin-badges'] });
  };

  /** Xuất bảng kê CSV theo bộ lọc hiện tại (status, provider, kind, from, to, search) */
  const exportCsv = async () => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: params.status, provider: params.provider, kind: params.kind, from: params.from, to: params.to, search: params.search })) if (v) q.set(k, String(v));
    await toast.promise(api.download(`/admin/einvoices/export.csv${q.toString() ? `?${q}` : ''}`, `bang-ke-hoa-don-${stamp}.csv`), { loading: 'Đang xuất bảng kê...', success: 'Đã tải bảng kê CSV', error: (e) => errorMessage(e) });
  };

  /** Phát hành lại hàng loạt (xếp hàng job) các hoá đơn nháp / lỗi đã chọn */
  const bulkRetry = useMutation({
    mutationFn: (ids: string[]) => api.post<{ queued: number }>('/admin/einvoices/bulk-retry', { ids }),
    onSuccess: (r) => {
      toast.success(`Đã xếp hàng phát hành ${r.queued} hoá đơn`);
      setSelected([]);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  /** Phát hành ngay một hoá đơn từ danh sách */
  const issueOne = useMutation({
    mutationFn: (id: string) => api.post(`/admin/einvoices/${id}/issue`),
    onSuccess: () => {
      toast.success('Đã phát hành hoá đơn');
      refresh();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refresh();
    },
  });

  const noProvider = providers.data && (!providers.data.active || providers.data.active === 'none');
  const counts = stats.data?.counts ?? {};
  const rows = list.data?.data;
  // chỉ cho chọn các hoá đơn có thể phát hành lại (nháp/lỗi)
  const retryable = selected.filter((id) => rows?.some((r) => r.id === id && (r.status === 'DRAFT' || r.status === 'FAILED')));

  const columns: Column<EInvoiceRow>[] = [
    {
      key: 'invoiceNo',
      header: 'Số hoá đơn',
      cell: (r) => {
        const no = invoiceNumber(r);
        return (
          <div className="min-w-0">
            <Link href={`/orders/einvoices/${r.id}`} className={cn('font-mono font-semibold hover:text-primary', !no && 'font-sans font-normal text-muted-foreground')}>
              {no ?? 'Chưa có số'}
            </Link>
            <div className="text-xs text-muted-foreground">
              {r.taxAuthorityCode ? (
                <span className="font-mono" title="Mã cơ quan thuế">
                  CQT {r.taxAuthorityCode.slice(0, 12)}
                  {r.taxAuthorityCode.length > 12 && '…'}
                </span>
              ) : (
                <span>{providerLabel(r.provider, providers.data?.providers)}</span>
              )}
            </div>
          </div>
        );
      },
    },
    { key: 'kind', header: 'Loại', cell: (r) => <EInvoiceKindBadge kind={r.kind} /> },
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
      key: 'buyer',
      header: 'Người mua',
      cell: (r) => (
        <div className="max-w-56 min-w-0">
          <div className="truncate font-medium">{r.buyer?.legalName || r.buyer?.name || r.order?.customerName || '—'}</div>
          <div className="truncate text-xs text-muted-foreground">{r.buyer?.taxCode ? <span className="font-mono">MST {r.buyer.taxCode}</span> : r.buyer?.anonymous ? 'Không lấy hoá đơn' : 'Không có MST'}</div>
        </div>
      ),
    },
    {
      key: 'total',
      header: 'Tổng tiền',
      headClassName: 'text-right',
      className: 'text-right',
      cell: (r) => (
        <div className="whitespace-nowrap tabular-nums">
          <div className="font-semibold">{formatMoney(toNum(r.total), r.currency)}</div>
          <div className="text-xs text-muted-foreground">VAT {formatMoney(toNum(r.vatTotal), r.currency)}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (r) => (
        <div className="max-w-56 space-y-1">
          <EInvoiceStatusBadge status={r.status} />
          {r.status === 'FAILED' && r.errorMessage && (
            <p className="line-clamp-2 text-xs text-red-600 dark:text-red-400" title={r.errorMessage}>
              {r.errorMessage}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'issuedAt',
      header: 'Ngày phát hành',
      cell: (r) =>
        r.issuedAt ? (
          <div className="whitespace-nowrap text-xs">
            <div>{formatDate(r.issuedAt)}</div>
            <div className="text-muted-foreground">{timeAgo(r.issuedAt)}</div>
          </div>
        ) : (
          <div className="whitespace-nowrap text-xs text-muted-foreground" title="Ngày tạo">
            Tạo {formatDate(r.createdAt, 'dd/MM/yyyy')}
          </div>
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10 text-right',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon-xs" asChild title="Xem chi tiết">
            <Link href={`/orders/einvoices/${r.id}`}>
              <Eye />
            </Link>
          </Button>
          {canWrite && (r.status === 'DRAFT' || r.status === 'FAILED' || r.status === 'QUEUED') && (
            <Button
              variant="ghost"
              size="icon-xs"
              title="Phát hành ngay"
              className="text-primary"
              disabled={issueOne.isPending}
              onClick={(e) => {
                e.stopPropagation();
                issueOne.mutate(r.id);
              }}
            >
              {issueOne.isPending && issueOne.variables === r.id ? <Loader2 className="animate-spin" /> : <Send />}
            </Button>
          )}
          {['ISSUED', 'ADJUSTED', 'REPLACED', 'CANCELLED'].includes(r.status) && r.provider !== 'manual' && (
            <Button
              variant="ghost"
              size="icon-xs"
              title="Xem PDF"
              onClick={(e) => {
                e.stopPropagation();
                void openEInvoicePdf(r.id);
              }}
            >
              <FileDown />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Hoá đơn điện tử"
        description="Lập, phát hành và theo dõi hoá đơn điện tử theo đơn hàng"
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Hoá đơn điện tử' }]}
        actions={
          <>
            {/* Bảng kê hoá đơn CSV theo bộ lọc hiện tại (kế toán kê khai thuế) */}
            <Button variant="outline" size="sm" onClick={() => void exportCsv()}>
              <FileSpreadsheet /> Xuất bảng kê
            </Button>
            {canSettings && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings?tab=einvoice">
                  <Settings2 /> Cài đặt
                </Link>
              </Button>
            )}
            {canWrite && (
              <Button size="sm" onClick={() => setPicking(true)}>
                <Plus /> Lập hoá đơn
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        {noProvider && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <AlertTriangle className="size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Chưa chọn nhà cung cấp hoá đơn điện tử</p>
              <p className="text-xs opacity-90">Bạn vẫn có thể lập hoá đơn nháp, nhưng cần chọn và cấu hình nhà cung cấp để phát hành.</p>
            </div>
            {canSettings && (
              <Button size="sm" variant="outline" asChild className="border-amber-300 dark:border-amber-800">
                <Link href="/settings?tab=einvoice">Mở cài đặt</Link>
              </Button>
            )}
          </div>
        )}

        {/* Thống kê nhanh */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {stats.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[76px] rounded-xl" />)
          ) : (
            <>
              <StatCard icon={Receipt} label="Hoá đơn tháng này" value={stats.data?.month.count ?? 0} hint="Đã phát hành" />
              <StatCard icon={FileText} label="Doanh thu đã xuất HĐ" value={formatMoney(stats.data?.month.total ?? 0)} hint="Tháng này" />
              <StatCard icon={FileText} label="Thuế GTGT" value={formatMoney(stats.data?.month.vat ?? 0)} hint="Tháng này" />
              <StatCard
                icon={AlertTriangle}
                label="Cần xử lý"
                value={stats.data?.needsAction ?? 0}
                hint="Nháp + lỗi"
                className={cn((stats.data?.needsAction ?? 0) > 0 && 'border-amber-300 dark:border-amber-800')}
              />
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
            { value: 'needsAction', label: 'Cần xử lý', count: stats.data?.needsAction, highlight: true },
            { value: 'DRAFT', label: 'Nháp', count: counts.DRAFT },
            { value: 'QUEUED', label: 'Chờ phát hành', count: counts.QUEUED },
            { value: 'ISSUING', label: 'Đang phát hành', count: counts.ISSUING },
            { value: 'ISSUED', label: 'Đã phát hành', count: counts.ISSUED },
            { value: 'CANCELLED', label: 'Đã huỷ', count: counts.CANCELLED },
            { value: 'FAILED', label: 'Lỗi', count: counts.FAILED, highlight: true },
          ]}
        />

        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Số HĐ, mã CQT, mã tra cứu, MST, mã đơn..."
          selectedCount={retryable.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            canWrite && (
              <Button size="xs" onClick={() => bulkRetry.mutate(retryable)} disabled={bulkRetry.isPending}>
                {bulkRetry.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Phát hành lại
              </Button>
            )
          }
          filters={
            <>
              <Select value={params.provider || 'all'} onValueChange={(v) => set({ provider: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Nhà cung cấp" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả NCC</SelectItem>
                  {providers.data?.providers.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={params.kind || 'all'} onValueChange={(v) => set({ kind: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Loại" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Mọi loại</SelectItem>
                  {EINVOICE_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
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
          selectable={canWrite}
          selected={selected}
          onSelectedChange={setSelected}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          emptyTitle={params.status === 'needsAction' ? 'Không có hoá đơn cần xử lý' : 'Chưa có hoá đơn điện tử'}
          emptyDescription={params.status ? 'Không có hoá đơn nào ở trạng thái này.' : 'Lập hoá đơn từ đơn hàng hoặc bật tự động xuất hoá đơn trong Cài đặt.'}
          emptyAction={
            canWrite && !params.status ? (
              <Button size="sm" onClick={() => setPicking(true)}>
                <Plus /> Lập hoá đơn
              </Button>
            ) : undefined
          }
        />
      </PageBody>
      <PickOrderDialog open={picking} onClose={() => setPicking(false)} />
    </>
  );
}

export default function EInvoicesPage() {
  return (
    <Suspense>
      <EInvoicesContent />
    </Suspense>
  );
}
