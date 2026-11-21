'use client';

import { Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, Download, Loader2, Lock, Package, ShoppingCart, UserPlus, Wallet, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, ApiError, errorMessage, qs } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { DateRangePicker, useReportRange } from '@/components/reports/date-range';
import { KpiCard } from '@/components/reports/kpi-card';
import { SERIES_COLORS, TimeSeriesChart, VizRoot, type ChartKind } from '@/components/reports/charts';
import { CategoriesTab, CouponsTab, CustomersTab, PaymentShippingTab, ProductsTab, StockTab } from '@/components/reports/report-tabs';
import type { OverviewReport, RevenueReport } from '@/components/reports/types';

const TABS = [
  { key: 'products', label: 'Sản phẩm', export: 'products' },
  { key: 'categories', label: 'Danh mục', export: 'revenue' },
  { key: 'customers', label: 'Khách hàng', export: 'customers' },
  { key: 'payment', label: 'Thanh toán & Vận chuyển', export: 'revenue' },
  { key: 'coupons', label: 'Mã giảm giá', export: 'coupons' },
  { key: 'stock', label: 'Tồn kho', export: null },
] as const;

const METRICS = [
  { key: 'revenue', label: 'Doanh thu', money: true, color: SERIES_COLORS[0] },
  { key: 'orders', label: 'Đơn hàng', money: false, color: SERIES_COLORS[1] },
  { key: 'items', label: 'Sản phẩm bán', money: false, color: SERIES_COLORS[3] },
  { key: 'refunds', label: 'Hoàn tiền', money: true, color: SERIES_COLORS[4] },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

function ReportsContent() {
  const range = useReportRange();
  const { from, to, interval, tab, set } = range;
  const [metric, setMetric] = useState<MetricKey>('revenue');
  const [kind, setKind] = useState<ChartKind>('area');
  const [exporting, setExporting] = useState(false);

  const overview = useQuery({ queryKey: ['reports', 'overview', from, to], queryFn: () => api.get<OverviewReport>('/admin/reports/overview', { from, to, compare: 1 }) });
  const revenue = useQuery({ queryKey: ['reports', 'revenue', from, to, interval], queryFn: () => api.get<RevenueReport>('/admin/reports/revenue', { from, to, interval }) });

  const cur = overview.data?.current;
  const chg = overview.data?.change;
  const m = METRICS.find((x) => x.key === metric) ?? METRICS[0];
  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];

  const exportCsv = async () => {
    if (!activeTab.export) return;
    setExporting(true);
    try {
      await api.download(`/admin/reports/export.csv${qs({ report: activeTab.export, from, to, interval })}`, `bao-cao-${activeTab.export}-${from}_${to}.csv`);
      toast.success('Đã xuất file CSV');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  if (overview.error) {
    const forbidden = overview.error instanceof ApiError && overview.error.status === 403;
    return (
      <PageBody>
        <EmptyState icon={forbidden ? Lock : AlertTriangle} title={forbidden ? 'Bạn không có quyền xem báo cáo' : 'Không tải được báo cáo'} description={forbidden ? 'Cần quyền “orders.read”.' : errorMessage(overview.error)} />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <DateRangePicker range={range} />

      {/* KPI */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <KpiCard title="Doanh thu thuần" value={cur ? formatMoney(cur.revenue) : '—'} change={chg?.revenue} hint={cur ? `hoàn ${formatMoney(cur.refunds)}` : undefined} icon={Wallet} loading={overview.isLoading} />
        <KpiCard title="Đơn hàng" value={cur ? cur.orders.toLocaleString('vi-VN') : '—'} change={chg?.orders} hint={cur ? `${cur.allOrders.toLocaleString('vi-VN')} đơn kể cả huỷ` : undefined} icon={ShoppingCart} loading={overview.isLoading} />
        <KpiCard title="Giá trị đơn trung bình" value={cur ? formatMoney(cur.aov) : '—'} change={chg?.aov} icon={BarChart3} loading={overview.isLoading} />
        <KpiCard title="Sản phẩm đã bán" value={cur ? cur.items.toLocaleString('vi-VN') : '—'} change={chg?.items} icon={Package} loading={overview.isLoading} />
        <KpiCard title="Khách mới" value={cur ? cur.newCustomers.toLocaleString('vi-VN') : '—'} change={chg?.newCustomers} hint={cur ? `${cur.customers.toLocaleString('vi-VN')} khách mua` : undefined} icon={UserPlus} loading={overview.isLoading} />
        <KpiCard title="Tỉ lệ huỷ" value={cur ? `${cur.cancelRate.toLocaleString('vi-VN')}%` : '—'} change={chg?.cancelRate} invert hint={cur ? `${cur.cancelled.toLocaleString('vi-VN')} đơn huỷ` : undefined} icon={XCircle} loading={overview.isLoading} />
      </div>

      {/* Biểu đồ doanh thu / đơn */}
      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="text-base">{m.label} theo {interval === 'day' ? 'ngày' : interval === 'week' ? 'tuần' : 'tháng'}</CardTitle>
            <CardDescription>Đơn đã huỷ / hoàn toàn bộ không tính; doanh thu thuần đã trừ hoàn một phần.</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup type="single" size="sm" variant="outline" value={metric} onValueChange={(v) => v && setMetric(v as MetricKey)} aria-label="Chỉ số">
              {METRICS.map((x) => (
                <ToggleGroupItem key={x.key} value={x.key}>
                  <span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: x.color }} aria-hidden />
                  {x.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup type="single" size="sm" variant="outline" value={interval} onValueChange={(v) => v && set({ interval: v })} aria-label="Nhóm theo">
              <ToggleGroupItem value="day">Ngày</ToggleGroupItem>
              <ToggleGroupItem value="week">Tuần</ToggleGroupItem>
              <ToggleGroupItem value="month">Tháng</ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup type="single" size="sm" variant="outline" value={kind} onValueChange={(v) => v && setKind(v as ChartKind)} aria-label="Kiểu biểu đồ">
              <ToggleGroupItem value="area">Vùng</ToggleGroupItem>
              <ToggleGroupItem value="bar">Cột</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardHeader>
        <CardContent>
          {revenue.isLoading || !revenue.data ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <VizRoot>
              <TimeSeriesChart data={revenue.data.data} xKey="period" yKey={m.key} name={m.label} color={m.color} kind={kind} money={m.money} interval={revenue.data.interval} />
            </VizRoot>
          )}
        </CardContent>
      </Card>

      {/* Tab chi tiết */}
      <Tabs value={activeTab.key} onValueChange={(v) => set({ tab: v })}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="max-w-full overflow-x-auto">
            <TabsList>
              {TABS.map((t) => (
                <TabsTrigger key={t.key} value={t.key}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {activeTab.export && (
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />} Xuất CSV
            </Button>
          )}
        </div>
        <VizRoot className="mt-2">
          <TabsContent value="products">
            <ProductsTab from={from} to={to} interval={interval} />
          </TabsContent>
          <TabsContent value="categories">
            <CategoriesTab from={from} to={to} interval={interval} />
          </TabsContent>
          <TabsContent value="customers">
            <CustomersTab from={from} to={to} interval={interval} />
          </TabsContent>
          <TabsContent value="payment">
            <PaymentShippingTab from={from} to={to} interval={interval} />
          </TabsContent>
          <TabsContent value="coupons">
            <CouponsTab from={from} to={to} interval={interval} />
          </TabsContent>
          <TabsContent value="stock">
            <StockTab />
          </TabsContent>
        </VizRoot>
      </Tabs>
    </PageBody>
  );
}

/** Báo cáo bán hàng (kiểu WooCommerce › Analytics) — đường dẫn /reports/sales (/orders/reports chuyển hướng về đây) */
export default function ReportsPage() {
  const { user, can } = useAuth();
  const allowed = can('orders.read');
  return (
    <>
      <PageHeader title="Báo cáo bán hàng" description="Doanh thu, sản phẩm, khách hàng, thanh toán, mã giảm giá và tồn kho" breadcrumbs={[{ label: 'Báo cáo', href: '/reports' }, { label: 'Bán hàng' }]} />
      {user && !allowed ? (
        <PageBody>
          <EmptyState icon={Lock} title="Bạn không có quyền xem báo cáo" description="Tài khoản chưa được cấp quyền “orders.read”." />
        </PageBody>
      ) : (
        <Suspense
          fallback={
            <PageBody>
              <Skeleton className="h-8 w-80" />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-80 rounded-xl" />
            </PageBody>
          }
        >
          <ReportsContent />
        </Suspense>
      )}
    </>
  );
}
