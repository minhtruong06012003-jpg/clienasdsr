'use client';

/**
 * Trang "Kho mã số": quản lý kho key / tài khoản / acc game / thẻ cào bán tự động.
 * Tab: Tồn kho · Danh sách mã · Báo lỗi · Đơn chờ mã. Trạng thái tab + bộ lọc lưu trên URL
 * (?tab=&productId=&variantId=&status=&batch=&search=&reportStatus=&page=) để trang khác link tới.
 */

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { EyeOff, Loader2, Lock, Plus, Settings2 } from 'lucide-react';
import type { DigitalStockSummary } from '@cmsnt/shared';
import { EmptyState } from '@/components/common/empty-state';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CodesTab } from '@/components/digital-codes/codes-tab';
import { ImportCodesDialog } from '@/components/digital-codes/import-dialog';
import { PendingOrdersTab } from '@/components/digital-codes/pending-orders-tab';
import { ReportsTab } from '@/components/digital-codes/reports-tab';
import { DIGITAL_QK, invalidateDigital, StatTile } from '@/components/digital-codes/shared';
import { useConfirm } from '@/components/common/confirm-dialog';
import { StockTab } from '@/components/digital-codes/stock-tab';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';

const TABS = ['stock', 'codes', 'reports', 'pending'] as const;
type Tab = (typeof TABS)[number];

/** Mặc định của các tham số URL (giá trị bằng mặc định sẽ bị bỏ khỏi URL) */
const DEFAULTS = { tab: 'stock', productId: '', variantId: '', status: '', batch: '', search: '', reportStatus: '' };

function DigitalCodesContent() {
  const { can } = useAuth();
  const canManage = can('digital_codes.manage');
  const canReveal = can('digital_codes.reveal');
  const canExport = can('digital_codes.export');
  const canSettings = can('settings.manage');
  const qc = useQueryClient();
  const confirm = useConfirm();
  // tính lại bản che (preview) của mọi mã theo quy tắc che hiện tại — dùng sau khi nâng cấp hoặc đổi nhãn phần mã
  const rebuild = useMutation({
    mutationFn: () => api.post<{ scanned: number; updated: number; failed: number }>('/admin/digital-codes/rebuild-previews'),
    onSuccess: (r) => {
      toast.success(`Đã kiểm tra ${r.scanned} mã, cập nhật bản che ${r.updated} mã${r.failed ? `, ${r.failed} mã không giải mã được (sai khoá?)` : ''}`);
      invalidateDigital(qc);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const { params, set, page, limit } = useListParams(DEFAULTS);
  const tab: Tab = (TABS as readonly string[]).includes(params.tab) ? (params.tab as Tab) : 'stock';
  // dialog nhập mã: null = đóng; {} = chọn sản phẩm trong dialog
  const [importFor, setImportFor] = useState<{ productId?: string; variantId?: string | null } | null>(null);

  // thống kê tồn kho (lọc theo sản phẩm nếu URL có productId) — dùng cho ô số, tab Tồn kho và bộ lọc
  const summary = useQuery({
    queryKey: [DIGITAL_QK, 'summary', params.productId],
    queryFn: () => api.get<DigitalStockSummary>('/admin/digital-codes/summary', { productId: params.productId || undefined }),
    refetchInterval: 60_000,
  });
  const s = summary.data;

  /** Chuyển tab: giữ bộ lọc sản phẩm, bỏ các bộ lọc riêng của tab cũ */
  const goTab = (t: Tab, extra: Record<string, string> = {}) => set({ tab: t, variantId: '', status: '', batch: '', search: '', reportStatus: '', ...extra });

  return (
    <>
      <PageHeader
        title="Kho mã số"
        description="Bán key, tài khoản, acc game, thẻ cào — giao tự động khi đơn được thanh toán"
        breadcrumbs={[{ label: 'Sản phẩm', href: '/products' }, { label: 'Kho mã số' }]}
        actions={
          <>
            {canSettings && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings?tab=digital">
                  <Settings2 /> Cài đặt
                </Link>
              </Button>
            )}
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                disabled={rebuild.isPending}
                title="Tính lại bản che của mọi mã (không thay đổi nội dung mã)"
                onClick={async () => {
                  if (await confirm({ title: 'Tính lại bản che?', description: 'Giải mã từng mã và tạo lại bản che theo quy tắc hiện tại. Nội dung mã không thay đổi.', confirmText: 'Tính lại' })) rebuild.mutate();
                }}
              >
                {rebuild.isPending ? <Loader2 className="animate-spin" /> : <EyeOff />} Tính lại bản che
              </Button>
            )}
            {canManage && (
              <Button size="sm" onClick={() => setImportFor({ productId: params.productId || undefined, variantId: params.variantId || null })}>
                <Plus /> Nhập mã
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        {/* Ô số tổng */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
          {summary.isLoading || !s ? (
            Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)
          ) : (
            <>
              <StatTile label="Còn trong kho" value={s.totals.available} hint={`${s.rows.filter((r) => r.lowStock).length} dòng sắp hết`} />
              <StatTile label="Đang giữ cho đơn" value={s.totals.reserved} hint="Chờ thanh toán" />
              <StatTile label="Đã giao" value={s.totals.sold} />
              <StatTile label="Tạm khoá" value={s.totals.disabled} />
              <StatTile label="Đã thu hồi" value={s.totals.revoked} />
              <StatTile label="Báo lỗi chờ xử lý" value={s.openReports} tone="danger" onClick={() => goTab('reports')} />
              <StatTile label="Đơn chờ mã" value={s.pendingOrders} tone="warn" hint="Đã thanh toán, thiếu mã" onClick={() => goTab('pending')} />
            </>
          )}
        </div>

        {params.productId && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Đang xem sản phẩm:</span>
            <span className="font-medium">{s?.rows.find((r) => r.productId === params.productId)?.productName ?? params.productId.slice(0, 8)}</span>
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => set({ productId: '', variantId: '', batch: '' })}>
              Xem tất cả sản phẩm
            </Button>
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => goTab(v as Tab)}>
          <div className="overflow-x-auto">
            <TabsList>
              <TabsTrigger value="stock">Tồn kho</TabsTrigger>
              <TabsTrigger value="codes">Danh sách mã</TabsTrigger>
              <TabsTrigger value="reports">
                Báo lỗi
                {!!s?.openReports && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">{s.openReports}</span>}
              </TabsTrigger>
              <TabsTrigger value="pending">
                Đơn chờ mã
                {!!s?.pendingOrders && <span className="rounded-full bg-orange-500 px-1.5 text-[10px] font-semibold text-white">{s.pendingOrders}</span>}
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>

        {tab === 'stock' && (
          <StockTab
            summary={s}
            loading={summary.isLoading}
            error={summary.error}
            onRetry={() => void summary.refetch()}
            canManage={canManage}
            onImport={(productId, variantId) => setImportFor({ productId, variantId })}
            onViewCodes={(productId, variantId) => goTab('codes', { productId, variantId: variantId ?? '' })}
          />
        )}
        {tab === 'codes' && (
          <CodesTab
            filter={{ productId: params.productId, variantId: params.variantId, status: params.status, batch: params.batch, search: params.search }}
            page={page}
            limit={limit}
            onFilterChange={set}
            stockRows={s?.rows ?? []}
            canManage={canManage}
            canReveal={canReveal}
            canExport={canExport}
          />
        )}
        {tab === 'reports' && <ReportsTab reportStatus={params.reportStatus} productId={params.productId} page={page} onChange={set} openCount={s?.openReports} canManage={canManage} canReveal={canReveal} />}
        {tab === 'pending' && <PendingOrdersTab pendingCount={s?.pendingOrders} canManage={canManage} />}
      </PageBody>

      <ImportCodesDialog open={!!importFor} onOpenChange={(o) => !o && setImportFor(null)} productId={importFor?.productId} variantId={importFor?.variantId} />
    </>
  );
}

export default function DigitalCodesPage() {
  const { user, can } = useAuth();
  // chưa có thông tin tài khoản -> chờ, không gọi API kho mã
  if (!user) return null;
  // thiếu quyền xem -> báo không có quyền và không render nội dung (không gọi API nào)
  if (!can('digital_codes.read')) {
    return (
      <>
        <PageHeader title="Kho mã số" breadcrumbs={[{ label: 'Sản phẩm', href: '/products' }, { label: 'Kho mã số' }]} />
        <PageBody>
          <EmptyState icon={Lock} title="Bạn không có quyền xem kho mã số" description="Tài khoản chưa được cấp quyền “digital_codes.read”." />
        </PageBody>
      </>
    );
  }
  return (
    <Suspense>
      <DigitalCodesContent />
    </Suspense>
  );
}
