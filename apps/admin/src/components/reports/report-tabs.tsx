'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Boxes, PackageX, Warehouse, AlertTriangle } from 'lucide-react';
import { DataTable, type Column } from '@/components/common/data-table';
import { StatusBadge } from '@/components/common/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { COUPON_TYPES, ONLINE_PAYMENT_LABELS, PAYMENT_METHODS } from '@/components/commerce/utils';
import { DonutChart, RankBarChart, SERIES_COLORS, formatCount, periodLabel, periodTick, tooltipCursor, tooltipStyle } from './charts';
import { KpiCard } from './kpi-card';
import type { CategoriesReport, CouponsReport, CustomerRow, CustomersReport, NewCustomersReport, PaymentMethodsReport, ProductRow, ProductsReport, ReportInterval, ShippingMethodsReport, StatusesReport, StockReport, StockRow } from './types';

export interface TabProps {
  from: string;
  to: string;
  interval: ReportInterval;
}

const share = (v: number, total: number) => (total ? `${Math.round((v / total) * 1000) / 10}%` : '—');
const num = (v: number) => v.toLocaleString('vi-VN');
const money = (v: number) => formatMoney(v);

function ChartSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn('h-64 w-full', className)} />;
}

// ------------------------------------------------------------------ Sản phẩm

export function ProductsTab({ from, to }: TabProps) {
  const [sort, setSort] = useState<'revenue' | 'quantity'>('revenue');
  const q = useQuery({ queryKey: ['reports', 'products', from, to, sort], queryFn: () => api.get<ProductsReport>('/admin/reports/products', { from, to, sort, limit: 20 }) });
  const rows = q.data?.data ?? [];
  const total = q.data?.totals;
  const columns: Column<ProductRow>[] = [
    { key: 'rank', header: '#', className: 'w-10 text-muted-foreground', cell: (r) => rows.indexOf(r) + 1 },
    {
      key: 'name',
      header: 'Sản phẩm',
      cell: (r) => (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {r.featuredImage ? <img src={r.featuredImage.urls?.thumb ?? r.featuredImage.url} alt="" className="size-9 shrink-0 rounded-md object-cover" /> : <div className="size-9 shrink-0 rounded-md bg-muted" />}
          <div className="min-w-0">
            {r.productId && !r.deleted ? (
              <Link href={`/products/${r.productId}`} className="line-clamp-1 font-medium hover:underline">
                {r.name}
              </Link>
            ) : (
              <span className="line-clamp-1 font-medium text-muted-foreground">{r.name}</span>
            )}
            <div className="text-xs text-muted-foreground">
              {r.sku ?? '—'}
              {r.deleted && ' · đã xoá'}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'quantity', header: 'Đã bán', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.quantity) },
    { key: 'orders', header: 'Số đơn', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.orders) },
    { key: 'revenue', header: 'Doanh thu', className: 'text-right font-medium tabular-nums', headClassName: 'text-right', cell: (r) => money(r.revenue) },
    { key: 'share', header: 'Tỉ trọng', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => share(r.revenue, total?.revenue ?? 0) },
  ];
  const chart = rows.slice(0, 10).map((r) => ({ name: r.name, value: sort === 'quantity' ? r.quantity : r.revenue }));
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <Card className="xl:col-span-2">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Top 10 sản phẩm</CardTitle>
            <CardDescription>Theo {sort === 'quantity' ? 'số lượng bán' : 'doanh thu'} trong kỳ</CardDescription>
          </div>
          <ToggleGroup type="single" size="sm" variant="outline" value={sort} onValueChange={(v) => v && setSort(v as 'revenue' | 'quantity')}>
            <ToggleGroupItem value="revenue">Doanh thu</ToggleGroupItem>
            <ToggleGroupItem value="quantity">Số lượng</ToggleGroupItem>
          </ToggleGroup>
        </CardHeader>
        <CardContent>
          {q.isLoading ? <ChartSkeleton /> : chart.length ? <RankBarChart data={chart} money={sort === 'revenue'} name={sort === 'quantity' ? 'Đã bán' : 'Doanh thu'} /> : <p className="py-10 text-center text-sm text-muted-foreground">Chưa có sản phẩm bán ra trong kỳ</p>}
        </CardContent>
      </Card>
      <div className="space-y-3 xl:col-span-3">
        {total && (
          <p className="text-sm text-muted-foreground">
            Tổng trong kỳ: <span className="font-medium text-foreground">{num(total.quantity)}</span> sản phẩm · <span className="font-medium text-foreground">{money(total.revenue)}</span> doanh thu dòng hàng
          </p>
        )}
        <DataTable columns={columns} data={rows} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle="Chưa có sản phẩm bán ra trong kỳ" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Danh mục

export function CategoriesTab({ from, to }: TabProps) {
  const q = useQuery({ queryKey: ['reports', 'categories', from, to], queryFn: () => api.get<CategoriesReport>('/admin/reports/categories', { from, to }) });
  const rows = q.data?.data ?? [];
  const columns: Column<CategoriesReport['data'][number]>[] = [
    { key: 'name', header: 'Danh mục', cell: (r) => (r.id === 'uncategorized' ? <span className="text-muted-foreground">{r.name}</span> : <Link href={`/products?categoryId=${r.id}`} className="font-medium hover:underline">{r.name}</Link>) },
    { key: 'revenue', header: 'Doanh thu', className: 'text-right font-medium tabular-nums', headClassName: 'text-right', cell: (r) => money(r.revenue) },
    { key: 'share', header: 'Tỉ trọng', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => `${r.share}%` },
    { key: 'quantity', header: 'Số lượng', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.quantity) },
    { key: 'orders', header: 'Số đơn', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.orders) },
    { key: 'products', header: 'Sản phẩm', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.products) },
  ];
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <Card className="xl:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Tỉ trọng doanh thu</CardTitle>
          <CardDescription>Dòng hàng thuộc nhiều danh mục được chia đều cho các danh mục đó.</CardDescription>
        </CardHeader>
        <CardContent>{q.isLoading ? <ChartSkeleton className="h-44" /> : <DonutChart data={rows.map((r) => ({ name: r.name, value: r.revenue }))} money centerLabel="doanh thu" />}</CardContent>
      </Card>
      <div className="xl:col-span-3">
        <DataTable columns={columns} data={rows} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle="Chưa có doanh thu trong kỳ" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Khách hàng

export function CustomersTab({ from, to, interval }: TabProps) {
  const top = useQuery({ queryKey: ['reports', 'customers', from, to], queryFn: () => api.get<CustomersReport>('/admin/reports/customers', { from, to, limit: 20 }) });
  const fresh = useQuery({ queryKey: ['reports', 'customers-new', from, to, interval], queryFn: () => api.get<NewCustomersReport>('/admin/reports/customers/new', { from, to, interval }) });
  const rows = top.data?.data ?? [];
  const totals = fresh.data?.data.reduce((s, x) => ({ n: s.n + x.newCustomers, r: s.r + x.returning }), { n: 0, r: 0 });
  const columns: Column<CustomerRow>[] = [
    { key: 'rank', header: '#', className: 'w-10 text-muted-foreground', cell: (r) => rows.indexOf(r) + 1 },
    {
      key: 'name',
      header: 'Khách hàng',
      cell: (r) => (
        <div className="min-w-0">
          {r.userId ? (
            <Link href={`/users/${r.userId}`} className="font-medium hover:underline">
              {r.name}
            </Link>
          ) : (
            <span className="font-medium">
              {r.name} <span className="text-xs font-normal text-muted-foreground">(khách vãng lai)</span>
            </span>
          )}
          <div className="truncate text-xs text-muted-foreground">{[r.email, r.phone].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    { key: 'orders', header: 'Số đơn', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.orders) },
    { key: 'items', header: 'Sản phẩm', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.items) },
    { key: 'spent', header: 'Tổng chi', className: 'text-right font-medium tabular-nums', headClassName: 'text-right', cell: (r) => money(r.spent) },
    { key: 'aov', header: 'Đơn TB', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => money(r.aov) },
    { key: 'last', header: 'Mua lần cuối', className: 'whitespace-nowrap text-muted-foreground', cell: (r) => formatDate(r.lastOrderAt, 'dd/MM/yyyy') },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Khách mới & khách quay lại</CardTitle>
            <CardDescription>
              Khách mới = có đơn đầu tiên trong kỳ.
              {totals && (
                <>
                  {' '}
                  Trong kỳ: <span className="font-medium text-foreground">{num(totals.n)}</span> khách mới · <span className="font-medium text-foreground">{num(totals.r)}</span> khách quay lại
                </>
              )}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {fresh.isLoading || !fresh.data ? (
            <ChartSkeleton className="h-56" />
          ) : (
            <ResponsiveContainer width="100%" height={224}>
              <BarChart data={fresh.data.data} margin={{ left: 0, right: 8, top: 8 }} barCategoryGap="25%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="period" tickFormatter={(v: string) => periodTick(v, interval)} tickLine={false} axisLine={false} minTickGap={24} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
                <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
                <Tooltip formatter={(v, n) => [formatCount(Number(v)), String(n)]} labelFormatter={(l) => periodLabel(String(l), interval)} contentStyle={tooltipStyle} cursor={tooltipCursor} />
                <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="newCustomers" name="Khách mới" stackId="c" fill={SERIES_COLORS[0]} maxBarSize={40} />
                <Bar dataKey="returning" name="Khách quay lại" stackId="c" fill={SERIES_COLORS[1]} radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Top 20 khách mua nhiều nhất</h3>
        <DataTable columns={columns} data={rows} loading={top.isLoading} error={top.error} onRetry={() => void top.refetch()} emptyTitle="Chưa có khách mua hàng trong kỳ" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Thanh toán & vận chuyển & trạng thái

const paymentLabel = (key: string) => (key === 'cod' ? 'COD' : (PAYMENT_METHODS[key] ?? ONLINE_PAYMENT_LABELS[key] ?? key));

/** Danh sách trạng thái: badge + số đơn + thanh tỉ lệ */
function StatusList({ rows }: { rows: StatusesReport['status'] }) {
  const max = Math.max(1, ...rows.map((r) => r.orders));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <StatusBadge status={r.status} />
          <span className="text-right text-sm tabular-nums">
            {num(r.orders)} <span className="text-xs text-muted-foreground">({r.share}%)</span>
          </span>
          <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/70" style={{ width: `${(r.orders / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PaymentShippingTab({ from, to }: TabProps) {
  const pay = useQuery({ queryKey: ['reports', 'payment-methods', from, to], queryFn: () => api.get<PaymentMethodsReport>('/admin/reports/payment-methods', { from, to }) });
  const ship = useQuery({ queryKey: ['reports', 'shipping-methods', from, to], queryFn: () => api.get<ShippingMethodsReport>('/admin/reports/shipping-methods', { from, to }) });
  const st = useQuery({ queryKey: ['reports', 'statuses', from, to], queryFn: () => api.get<StatusesReport>('/admin/reports/statuses', { from, to }) });
  const payRows = pay.data?.data ?? [];
  const shipRows = ship.data?.data ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Phương thức thanh toán</CardTitle>
          <CardDescription>Doanh thu thuần theo phương thức (đơn hợp lệ)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pay.isLoading ? <ChartSkeleton className="h-44" /> : <DonutChart data={payRows.map((r) => ({ name: paymentLabel(r.method), value: r.revenue }))} money centerLabel="doanh thu" />}
          {payRows.length > 0 && (
            <ul className="divide-y text-sm">
              {payRows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="truncate">{paymentLabel(r.method)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {num(r.orders)} đơn · {num(r.paid)} đã thanh toán
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Phương thức vận chuyển</CardTitle>
          <CardDescription>Số đơn theo phương thức giao hàng</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ship.isLoading ? <ChartSkeleton className="h-44" /> : <DonutChart data={shipRows.map((r) => ({ name: r.label, value: r.orders }))} centerLabel="đơn hàng" />}
          {shipRows.length > 0 && (
            <ul className="divide-y text-sm">
              {shipRows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="truncate">{r.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    phí ship {money(r.shipping)} · doanh thu {money(r.revenue)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trạng thái đơn hàng</CardTitle>
          <CardDescription>Mọi đơn tạo trong kỳ, kể cả đã huỷ</CardDescription>
        </CardHeader>
        <CardContent>{st.isLoading || !st.data ? <ChartSkeleton className="h-56" /> : <StatusList rows={st.data.status} />}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trạng thái thanh toán</CardTitle>
          <CardDescription>Mọi đơn tạo trong kỳ</CardDescription>
        </CardHeader>
        <CardContent>{st.isLoading || !st.data ? <ChartSkeleton className="h-56" /> : <StatusList rows={st.data.payment} />}</CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Mã giảm giá

export function CouponsTab({ from, to }: TabProps) {
  const q = useQuery({ queryKey: ['reports', 'coupons', from, to], queryFn: () => api.get<CouponsReport>('/admin/reports/coupons', { from, to }) });
  const rows = q.data?.data ?? [];
  const typeLabel = (t: string | null) => COUPON_TYPES.find((x) => x.value === t)?.label ?? t ?? '—';
  const columns: Column<CouponsReport['data'][number]>[] = [
    {
      key: 'code',
      header: 'Mã',
      cell: (r) => (
        <div>
          {r.couponId ? (
            <Link href={`/orders/coupons?search=${encodeURIComponent(r.code)}`} className="font-mono font-medium hover:underline">
              {r.code}
            </Link>
          ) : (
            <span className="font-mono font-medium text-muted-foreground">{r.code}</span>
          )}
          <div className="text-xs text-muted-foreground">
            {typeLabel(r.type)}
            {r.value != null && (r.type === 'PERCENT' ? ` · ${r.value}%` : r.type === 'FIXED' ? ` · ${money(r.value)}` : '')}
          </div>
        </div>
      ),
    },
    { key: 'uses', header: 'Lượt dùng trong kỳ', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.uses) },
    { key: 'discount', header: 'Tổng giảm', className: 'text-right font-medium tabular-nums', headClassName: 'text-right', cell: (r) => money(r.discount) },
    { key: 'revenue', header: 'Doanh thu đơn áp dụng', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => money(r.revenue) },
    {
      key: 'limit',
      header: 'Tổng lượt / giới hạn',
      className: 'text-right tabular-nums text-muted-foreground',
      headClassName: 'text-right',
      cell: (r) => (r.usedCount == null ? '—' : `${num(r.usedCount)} / ${r.usageLimit == null ? '∞' : num(r.usageLimit)}`),
    },
    { key: 'active', header: 'Trạng thái', cell: (r) => (r.isActive == null ? <Badge variant="outline">Đã xoá</Badge> : r.isActive ? <StatusBadge status="ACTIVE" /> : <StatusBadge status="INACTIVE" />) },
  ];
  const t = q.data?.totals;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard title="Lượt dùng mã" value={t ? num(t.uses) : '—'} loading={q.isLoading} />
        <KpiCard title="Tổng tiền giảm" value={t ? money(t.discount) : '—'} loading={q.isLoading} />
        <KpiCard title="Doanh thu đơn có mã" value={t ? money(t.revenue) : '—'} loading={q.isLoading} />
      </div>
      <DataTable columns={columns} data={rows} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle="Chưa có đơn dùng mã giảm giá trong kỳ" />
    </div>
  );
}

// ------------------------------------------------------------------ Tồn kho

export function StockTab() {
  const q = useQuery({ queryKey: ['reports', 'stock'], queryFn: () => api.get<StockReport>('/admin/reports/stock', { limit: 100 }) });
  const s = q.data?.summary;
  const rows = q.data?.data ?? [];
  const columns: Column<StockRow>[] = [
    {
      key: 'name',
      header: 'Sản phẩm',
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/products/${r.productId}`} className="line-clamp-1 font-medium hover:underline">
            {r.name || '(không tên)'}
          </Link>
          <div className="text-xs text-muted-foreground">{[r.variant, r.sku].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'price', header: 'Giá', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => money(r.price) },
    { key: 'stock', header: 'Tồn', className: 'text-right font-semibold tabular-nums', headClassName: 'text-right', cell: (r) => <span className={r.state === 'out' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}>{num(r.stockQuantity)}</span> },
    { key: 'threshold', header: 'Ngưỡng', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => num(r.threshold) },
    { key: 'state', header: 'Tình trạng', cell: (r) => (r.state === 'out' ? <StatusBadge status="OUT_OF_STOCK" /> : <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Sắp hết</Badge>) },
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard title="Giá trị tồn kho" value={s ? money(s.value) : '—'} hint={s ? `${num(s.units)} đơn vị` : undefined} icon={Warehouse} loading={q.isLoading} />
        <KpiCard title="Dòng hàng có quản lý kho" value={s ? num(s.tracked) : '—'} hint={s ? `${num(s.products)} sản phẩm` : undefined} icon={Boxes} loading={q.isLoading} />
        <KpiCard title="Sắp hết hàng" value={s ? num(s.lowStock) : '—'} hint={q.data ? `≤ ${q.data.threshold} (hoặc ngưỡng riêng)` : undefined} icon={AlertTriangle} loading={q.isLoading} />
        <KpiCard title="Hết hàng" value={s ? num(s.outOfStock) : '—'} icon={PackageX} loading={q.isLoading} />
      </div>
      <p className="text-xs text-muted-foreground">Giá trị tồn = giá bán gốc × số lượng tồn của sản phẩm có bật quản lý kho (sản phẩm có biến thể tính theo từng biến thể). Tồn kho là số liệu hiện tại, không phụ thuộc khoảng thời gian.</p>
      <DataTable columns={columns} data={rows} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle="Không có sản phẩm sắp hết hoặc hết hàng" />
    </div>
  );
}
