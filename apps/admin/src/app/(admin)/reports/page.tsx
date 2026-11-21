'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { Download, Loader2, Lock, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { DateRangePicker, useReportRange } from '@/components/reports/date-range';
import { VizRoot } from '@/components/reports/charts';
import type { SiteTabProps } from '@/components/reports/site-common';
import { OverviewTab, PagesTab, SourcesTab, TrafficTab } from '@/components/reports/site-tabs';
import { ContentTab, EmailsTab, EngagementTab, MembersTab } from '@/components/reports/site-content-tabs';
import type { SiteExportReport } from '@/components/reports/site-types';

/** Các tab báo cáo website; `export` = loại CSV tải được ở tab đó (null = không có) */
const TABS: { key: string; label: string; export: SiteExportReport | null }[] = [
  { key: 'overview', label: 'Tổng quan', export: 'traffic' },
  { key: 'traffic', label: 'Truy cập', export: 'traffic' },
  { key: 'pages', label: 'Trang', export: 'pages' },
  { key: 'sources', label: 'Nguồn & thiết bị', export: 'sources' },
  { key: 'content', label: 'Nội dung', export: null },
  { key: 'members', label: 'Thành viên', export: null },
  { key: 'engagement', label: 'Tương tác', export: null },
  { key: 'emails', label: 'Email', export: null },
];

function SiteReportsContent() {
  const range = useReportRange('overview');
  const { from, to, interval, tab, set, params } = range;
  const [exporting, setExporting] = useState(false);
  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0];
  const tabProps: SiteTabProps = { from, to, interval, setParams: set };
  // giữ nguyên khoảng thời gian khi chuyển sang báo cáo bán hàng (cùng tên tham số URL)
  const salesHref = `/reports/sales${qs({ range: params.range === '30d' ? undefined : params.range, from: params.from, to: params.to })}`;

  const exportCsv = async () => {
    if (!activeTab.export) return;
    setExporting(true);
    try {
      await api.download(`/admin/analytics/export.csv${qs({ report: activeTab.export, from, to, interval })}`, `thong-ke-${activeTab.export}-${from}_${to}.csv`);
      toast.success('Đã xuất file CSV');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageBody>
      <DateRangePicker range={range} />

      <Tabs value={activeTab.key} onValueChange={(v) => set({ tab: v })}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="max-w-full overflow-x-auto overflow-y-hidden">
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
        {/* TabsContent của Radix chỉ mount tab đang mở -> mỗi tab chỉ gọi API khi được xem */}
        <VizRoot className="mt-2">
          <TabsContent value="overview">
            <OverviewTab {...tabProps} salesHref={salesHref} />
          </TabsContent>
          <TabsContent value="traffic">
            <TrafficTab {...tabProps} />
          </TabsContent>
          <TabsContent value="pages">
            <PagesTab {...tabProps} />
          </TabsContent>
          <TabsContent value="sources">
            <SourcesTab {...tabProps} />
          </TabsContent>
          <TabsContent value="content">
            <ContentTab {...tabProps} />
          </TabsContent>
          <TabsContent value="members">
            <MembersTab {...tabProps} />
          </TabsContent>
          <TabsContent value="engagement">
            <EngagementTab {...tabProps} />
          </TabsContent>
          <TabsContent value="emails">
            <EmailsTab {...tabProps} />
          </TabsContent>
        </VizRoot>
      </Tabs>
    </PageBody>
  );
}

/** Báo cáo website: truy cập, trang, nguồn, nội dung, thành viên, tương tác, email */
export default function SiteReportsPage() {
  const { user, can } = useAuth();
  const allowed = can('reports.view');
  return (
    <>
      <PageHeader
        title="Báo cáo website"
        description="Lượt truy cập, trang xem nhiều, nguồn khách, nội dung, thành viên và tương tác"
        breadcrumbs={[{ label: 'Báo cáo', href: '/reports' }, { label: 'Tổng quan website' }]}
        actions={
          can('orders.read') && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/reports/sales">
                <ShoppingCart /> Báo cáo bán hàng
              </Link>
            </Button>
          )
        }
      />
      {user && !allowed ? (
        <PageBody>
          <EmptyState icon={Lock} title="Bạn không có quyền xem báo cáo" description="Tài khoản chưa được cấp quyền “reports.view”." />
        </PageBody>
      ) : (
        <Suspense
          fallback={
            <PageBody>
              <Skeleton className="h-8 w-80" />
              <Skeleton className="h-8 w-full max-w-2xl" />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-80 rounded-xl" />
            </PageBody>
          }
        >
          <SiteReportsContent />
        </Suspense>
      )}
    </>
  );
}
