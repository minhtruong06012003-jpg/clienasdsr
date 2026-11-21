'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3, CheckCircle2, Circle, ExternalLink, FileText, Lock, MessageSquare, Package, PackageX, Plus, Rocket, ShoppingCart, Sparkles, Star, Wallet, X } from 'lucide-react';
import { SERIES_COLORS, VIZ_CLASS } from '@/components/reports/chart-colors';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { StatusBadge } from '@/components/common/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, ApiError, errorMessage } from '@/lib/api';
import { HAS_WEB_URL, WEB_HOME } from '@/lib/site';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/common/empty-state';
import { formatBytes, formatMoney, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useFeatures } from '@/hooks/use-features';
import { typeLabel, useContentTypes } from '@/hooks/use-content-types';
import { ContentIcon } from '@/components/content/content-icon';
import { TodoTile } from '@/components/dashboard/todo-tile';

// Biểu đồ (recharts ~ vài trăm KB) nạp động, không render phía server; trong lúc tải hiện khung xương
const SalesChart = dynamic(() => import('@/components/dashboard/sales-chart'), { ssr: false, loading: () => <Skeleton className="h-full" /> });
// Tổng quan kinh doanh AI Studio (tiền nạp, gói nạp tiền, tác vụ AI, tiền chạy AI, khách, affiliate) — có biểu đồ nên cũng nạp động
const AiOverviewSection = dynamic(() => import('@/components/dashboard/ai-overview'), { ssr: false, loading: () => <Skeleton className="h-96 rounded-xl" /> });

interface DashboardData {
  counts: { pages: number; posts: number; products: number; customers: number; media: number; mediaSize: number };
  period: { days: number; orders: number; ordersChange: number; revenue: number; revenueChange: number };
  alerts: { pendingOrders: number; pendingReviews: number; pendingComments: number; lowStock: number };
  chart: { date: string; revenue: number; orders: number }[];
  lowStock: { id: string; sku: string | null; stockQuantity: number; name: string }[];
  recentOrders: { id: string; code: string; customerName: string; total: number; status: string; paymentStatus: string; createdAt: string }[];
  topProducts: { id: string; name: string; soldCount: number; featuredImage: { urls: Record<string, string>; url: string } | null }[];
}

function Trend({ value }: { value: number }) {
  const up = value >= 0;
  return (
    <span className={cn('inline-flex items-center text-xs font-medium', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {Math.abs(value)}%
    </span>
  );
}

function Stat({ title, value, icon: Icon, footer, href }: { title: string; value: React.ReactNode; icon: React.ElementType; footer?: React.ReactNode; href?: string }) {
  const body = (
    <Card className="gap-2 transition hover:shadow-md">
      <CardHeader className="flex flex-row items-center justify-between pb-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        {footer && <div className="mt-1 text-xs text-muted-foreground">{footer}</div>}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

interface SetupData {
  steps: { key: string; title: string; description: string; href: string; done: boolean; optional?: boolean }[];
  done: number;
  total: number;
}

const SETUP_HIDDEN_KEY = 'cmsnt-setup-hidden';

/** Hướng dẫn thiết lập website mới — tự ẩn khi đã xong, hoặc chủ web bấm ẩn */
function SetupChecklist() {
  const { can } = useAuth();
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(SETUP_HIDDEN_KEY) === '1');
    } catch {
      setHidden(false);
    }
  }, []);
  const setup = useQuery({ queryKey: ['dashboard-setup'], queryFn: () => api.get<SetupData>('/admin/dashboard/setup'), enabled: can('settings.manage') && !hidden });
  const d = setup.data;
  if (hidden || !d || d.done >= d.total) return null;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(SETUP_HIDDEN_KEY, '1');
    } catch {
      /* bỏ qua */
    }
  };
  const next = d.steps.find((s) => !s.done && !s.optional);

  return (
    <Card className="gap-4 overflow-hidden border-primary/20 py-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-4 py-4 sm:px-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Rocket className="size-5" />
        </div>
        {/* basis 10rem: điện thoại không đủ chỗ thì thanh tiến độ xuống dòng, chữ không bị bóp thành cột dọc */}
        <div className="min-w-0 flex-[1_1_10rem]">
          <h2 className="font-semibold">Hoàn thiện website của bạn</h2>
          <p className="text-sm text-muted-foreground">
            Đã xong {d.done}/{d.total} bước{next ? <> · Tiếp theo: <span className="font-medium text-foreground">{next.title}</span></> : null}
          </p>
        </div>
        {/* điện thoại: thanh tiến độ chiếm trọn dòng cuối; nút ẩn giữ ở góc phải dòng đầu */}
        <Progress value={(d.done / d.total) * 100} className="order-last h-2 w-full sm:order-none sm:w-40" />
        <Button variant="ghost" size="icon-sm" onClick={hide} title="Ẩn hướng dẫn" aria-label="Ẩn hướng dẫn" className="self-start sm:self-center">
          <X />
        </Button>
      </div>
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
        {d.steps.map((s) => (
          <Link key={s.key} href={s.href} className={cn('group flex gap-3 bg-card px-4 py-3.5 transition hover:bg-muted/60 sm:px-5', s.done && 'opacity-60')}>
            {s.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground/50" />}
            <span className="min-w-0 flex-1">
              <span className={cn('block text-sm font-medium', s.done && 'line-through decoration-muted-foreground/40')}>
                {s.title}
                {s.optional && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(tuỳ chọn)</span>}
              </span>
              <span className="block text-xs leading-relaxed text-muted-foreground">{s.description}</span>
            </span>
            {!s.done && <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />}
          </Link>
        ))}
      </div>
    </Card>
  );
}

/** Số bài theo từng loại nội dung tuỳ biến (Dự án, Dịch vụ...) + lối tắt thêm mới */
function ContentTypesCard() {
  const { can, isDeveloper } = useAuth();
  const types = useContentTypes();
  const list = (types.data ?? []).filter((t) => t.isActive);
  if (!list.length) return null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Nội dung tuỳ biến</CardTitle>
        {(isDeveloper && can('content_types.manage')) && (
          <Button variant="ghost" size="sm" asChild>
            <Link href="/content-types">Quản lý</Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        {list.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ContentIcon name={t.icon} className="size-4" />
            </span>
            <Link href={`/content/${t.key}`} className="min-w-0 flex-1 truncate text-sm font-medium">
              {typeLabel(t.labels, 'vi', 'plural', t.key)}
            </Link>
            <span className="text-sm tabular-nums text-muted-foreground">{t.entryCount ?? 0} bài</span>
            {can('entries.write') && (
              <Button variant="ghost" size="icon-xs" asChild title="Thêm mới">
                <Link href={`/content/${t.key}/new`}>
                  <Plus />
                </Link>
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? 'Chào buổi sáng' : h < 14 ? 'Chào buổi trưa' : h < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
}

export default function DashboardPage() {
  const { user, can } = useAuth();
  const [days, setDays] = useState('30');
  // biểu đồ 1 trục: chuyển giữa doanh thu và số đơn bằng toggle (không dùng 2 trục Y)
  const [metric, setMetric] = useState<'revenue' | 'orders'>('revenue');
  const canView = can('dashboard.view');
  // công tắc tính năng: tắt Bán hàng -> ẩn mọi widget doanh thu / đơn / sản phẩm; tắt Blog -> ẩn bình luận
  const { isOn } = useFeatures();
  const shop = isOn('shop');
  const blog = isOn('blog');
  const { data, isLoading, error } = useQuery({ queryKey: ['dashboard', days], queryFn: () => api.get<DashboardData>('/admin/dashboard', { days }), enabled: canView });
  const today = new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const title = `${greeting()}, ${user?.name ?? ''}`;

  // thiếu quyền (hoặc lỗi tải) -> hiện thông báo thay vì skeleton chờ mãi
  if ((user && !canView) || error) {
    const forbidden = !canView || (error instanceof ApiError && error.status === 403);
    return (
      <>
        <PageHeader title={title} description={today} />
        <PageBody>
          <EmptyState
            icon={forbidden ? Lock : AlertTriangle}
            title={forbidden ? 'Bạn không có quyền xem bảng điều khiển' : 'Không tải được dữ liệu bảng điều khiển'}
            description={forbidden ? 'Tài khoản chưa được cấp quyền “dashboard.view”. Hãy dùng menu bên trái để tới các mục bạn được phép quản lý.' : errorMessage(error)}
          />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={title}
        description={<span className="first-letter:uppercase">{today}</span>}
        actions={
          <>
            {/* chỉ hiện khi đã cấu hình địa chỉ website (NEXT_PUBLIC_WEB_URL) */}
            {HAS_WEB_URL && (
              <Button variant="outline" size="sm" asChild>
                <a href={WEB_HOME} target="_blank" rel="noreferrer">
                  <ExternalLink /> Xem website
                </a>
              </Button>
            )}
            {shop && can('products.write') && (
              <Button size="sm" asChild>
                <Link href="/products/new">
                  <Plus /> Thêm sản phẩm
                </Link>
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        <SetupChecklist />

        {/* việc cần làm của bán hàng / blog gộp chung vào ô "Cần xử lý" của phần tổng quan AI */}
        <AiOverviewSection
          extraTodos={
            data && (
              <>
                {shop && can('orders.read') && <TodoTile count={data.alerts.pendingOrders} label="Đơn hàng chờ xác nhận" href="/orders?status=PENDING" icon={ShoppingCart} tone="amber" action="Xử lý" />}
                {shop && isOn('reviews') && can('reviews.manage') && <TodoTile count={data.alerts.pendingReviews} label="Đánh giá chờ duyệt" href="/products/reviews?status=PENDING" icon={Star} tone="violet" action="Duyệt" />}
                {shop && can('products.read') && <TodoTile count={data.alerts.lowStock} label="Sản phẩm sắp hết hàng" href="/products?sort=stockQuantity&order=asc" icon={PackageX} tone="red" action="Nhập hàng" />}
              </>
            )
          }
        />

        {shop && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {isLoading || !data ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)
          ) : (
            <>
              <Stat title={`Doanh thu ${days} ngày`} value={formatMoney(data.period.revenue)} icon={Wallet} footer={<><Trend value={data.period.revenueChange} /> so với kỳ trước</>} href="/orders" />
              <Stat title={`Đơn hàng ${days} ngày`} value={data.period.orders} icon={ShoppingCart} footer={<><Trend value={data.period.ordersChange} /> so với kỳ trước</>} href="/orders" />
              <Stat title="Sản phẩm" value={data.counts.products} icon={Package} footer={`${data.counts.customers} khách hàng`} href="/products" />
              <Stat title="Nội dung" value={data.counts.pages + data.counts.posts} icon={FileText} footer={`${data.counts.pages} trang · ${data.counts.posts} bài · ${data.counts.media} media (${formatBytes(data.counts.mediaSize)})`} />
            </>
          )}
        </div>
        )}

        {shop && (
        <div className="grid gap-4 xl:grid-cols-3">
          {/* VIZ_CLASS cấp biến màu --viz-* cho cả ô màu chú thích ở tiêu đề lẫn biểu đồ */}
          <Card className={cn('xl:col-span-2', VIZ_CLASS)}>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-base">{metric === 'revenue' ? 'Doanh thu' : 'Đơn hàng'}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <ToggleGroup type="single" size="sm" value={metric} onValueChange={(v) => v && setMetric(v as 'revenue' | 'orders')} variant="outline" aria-label="Chỉ số">
                  <ToggleGroupItem value="revenue">
                    <span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: SERIES_COLORS[0] }} aria-hidden />
                    Doanh thu
                  </ToggleGroupItem>
                  <ToggleGroupItem value="orders">
                    <span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: SERIES_COLORS[1] }} aria-hidden />
                    Đơn hàng
                  </ToggleGroupItem>
                </ToggleGroup>
                <ToggleGroup type="single" size="sm" value={days} onValueChange={(v) => v && setDays(v)} variant="outline" aria-label="Khoảng thời gian">
                  <ToggleGroupItem value="7">7 ngày</ToggleGroupItem>
                  <ToggleGroupItem value="30">30 ngày</ToggleGroupItem>
                  <ToggleGroupItem value="90">90 ngày</ToggleGroupItem>
                </ToggleGroup>
                {can('orders.read') && (
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/reports/sales">
                      <BarChart3 /> Xem báo cáo
                    </Link>
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="h-72">
              {data ? (
                <SalesChart data={data.chart} metric={metric} />
              ) : (
                <Skeleton className="h-full" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sản phẩm bán chạy</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data?.topProducts.map((p, i) => (
                <Link key={p.id} href={`/products/${p.id}`} className="flex items-center gap-3 rounded-lg p-1 hover:bg-muted">
                  <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.featuredImage ? <img src={p.featuredImage.urls.thumb ?? p.featuredImage.url} alt="" className="size-10 rounded-md object-cover" /> : <div className="size-10 rounded-md bg-muted" />}
                  <span className="line-clamp-1 flex-1 text-sm">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.soldCount} đã bán</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
        )}

        <div className="grid gap-4 xl:grid-cols-3">
          {shop && can('products.read') && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <PackageX className="size-4 text-red-600 dark:text-red-400" /> Sắp hết hàng
                </CardTitle>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/products?sort=stockQuantity&order=asc">Xem tất cả</Link>
                </Button>
              </CardHeader>
              <CardContent className="space-y-1">
                {data?.lowStock.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    <Sparkles className="mx-auto mb-1 size-4 text-emerald-500" /> Mọi sản phẩm đều còn đủ hàng
                  </p>
                )}
                {data?.lowStock.map((p) => (
                  <Link key={p.id} href={`/products/${p.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.name || '(không tên)'}</div>
                      <div className="truncate text-xs text-muted-foreground">{p.sku ?? 'Chưa có SKU'}</div>
                    </div>
                    <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums', p.stockQuantity <= 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300')}>
                      {p.stockQuantity <= 0 ? 'Hết hàng' : `Còn ${p.stockQuantity}`}
                    </span>
                  </Link>
                ))}
                {data && data.alerts.lowStock > data.lowStock.length && (
                  <p className="px-2 pt-1 text-xs text-muted-foreground">và {data.alerts.lowStock - data.lowStock.length} sản phẩm khác…</p>
                )}
              </CardContent>
            </Card>
          )}
          {shop && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Đơn hàng gần đây</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/orders">Xem tất cả</Link>
              </Button>
            </CardHeader>
            <CardContent className="space-y-1">
              {data?.recentOrders.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Chưa có đơn hàng</p>}
              {data?.recentOrders.map((o) => (
                <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
                  <div className="flex-1">
                    <div className="text-sm font-medium">#{o.code}</div>
                    <div className="text-xs text-muted-foreground">
                      {o.customerName} · {timeAgo(o.createdAt)}
                    </div>
                  </div>
                  <StatusBadge status={o.status} />
                  <div className="w-28 text-right text-sm font-semibold">{formatMoney(o.total)}</div>
                </Link>
              ))}
            </CardContent>
          </Card>
          )}
          <ContentTypesCard />
        </div>

      </PageBody>
    </>
  );
}
