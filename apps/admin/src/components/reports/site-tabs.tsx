'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Mail,
  MessagesSquare,
  Monitor,
  MousePointerClick,
  Search,
  ShoppingCart,
  Smartphone,
  Tablet,
  Users,
  UserRound,
  LogOut,
} from 'lucide-react';
import { DataTable, type Column } from '@/components/common/data-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatBytes, formatDate, formatMoney } from '@/lib/format';
import { HAS_WEB_URL, WEB_URL } from '@/lib/site';
import { cn } from '@/lib/utils';
import { DonutChart, SERIES_COLORS } from './charts';
import { Delta, KpiCard } from './kpi-card';
import { HoursHeatmap } from './site-heatmap';
import {
  CHANNEL_LABELS,
  ChartSkeleton,
  LiveDot,
  NoTrafficNote,
  Note,
  QueryError,
  RankCard,
  ReportCard,
  SITE_KEY,
  SeriesCard,
  ShareBar,
  StatRow,
  countryName,
  deviceLabel,
  formatDuration,
  intervalWord,
  localeName,
  num,
  pct,
  ratio,
  type SiteTabProps,
} from './site-common';
import type { DevicesReport, HoursReport, PageRow, PagesReport, RealtimeReport, SiteOverview, SourcesReport, TrafficSeries } from './site-types';

const TRAFFIC_METRICS = [
  { key: 'visitors', label: 'Khách truy cập', color: SERIES_COLORS[0] },
  { key: 'pageviews', label: 'Lượt xem trang', color: SERIES_COLORS[1] },
  { key: 'sessions', label: 'Phiên', color: SERIES_COLORS[2] },
] as const;

/** Truy vấn chuỗi truy cập theo kỳ (dùng chung khoá cho tab Tổng quan & Truy cập để không tải lại) */
function useTrafficSeries(from: string, to: string, interval: SiteTabProps['interval']) {
  return useQuery({ queryKey: [SITE_KEY, 'traffic', from, to, interval], queryFn: () => api.get<TrafficSeries>('/admin/analytics/traffic', { from, to, interval }) });
}

/** Thẻ biểu đồ truy cập theo kỳ (khách / lượt xem / phiên) */
function TrafficChartCard({ from, to, interval, setParams }: SiteTabProps) {
  const q = useTrafficSeries(from, to, interval);
  const empty = q.data && q.data.data.every((d) => !d.pageviews && !d.visitors && !d.sessions);
  if (q.error) return <QueryError error={q.error} />;
  return (
    <SeriesCard
      title={(m) => `${m.label} theo ${intervalWord(interval)}`}
      description="Khách được đếm theo mã ẩn danh đổi mỗi ngày nên tổng nhiều ngày là cộng dồn khách theo ngày."
      metrics={TRAFFIC_METRICS}
      data={q.data?.data}
      interval={interval}
      dataInterval={q.data?.interval}
      onInterval={(v) => setParams({ interval: v })}
      loading={q.isLoading}
      empty={empty ? <NoTrafficNote /> : undefined}
    />
  );
}

// ------------------------------------------------------------------ Tổng quan

/** Thẻ tóm tắt 1 mảng (nội dung, thành viên...) + nút sang tab chi tiết */
function SummaryCard({ icon: Icon, title, onMore, moreLabel = 'Xem chi tiết', footer, children }: { icon: React.ElementType; title: string; onMore?: () => void; moreLabel?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4 text-muted-foreground" /> {title}
        </CardTitle>
        {onMore && (
          <Button variant="ghost" size="sm" className="-mr-2 h-7 text-xs" onClick={onMore}>
            {moreLabel} <ArrowRight className="size-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="divide-y">{children}</CardContent>
      {footer && <div className="px-6">{footer}</div>}
    </Card>
  );
}

export function OverviewTab(props: SiteTabProps & { salesHref: string }) {
  const { from, to, setParams, salesHref } = props;
  const q = useQuery({ queryKey: [SITE_KEY, 'overview', from, to], queryFn: () => api.get<SiteOverview>('/admin/analytics/overview', { from, to }) });
  if (q.error) return <QueryError error={q.error} />;
  const d = q.data;
  const t = d?.traffic;
  const c = d?.trafficChange;
  const loading = q.isLoading;
  const go = (tab: string) => () => setParams({ tab });

  return (
    <div className="space-y-4">
      {/* KPI truy cập */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <KpiCard title="Khách truy cập" value={t ? num(t.visitors) : '—'} change={c?.visitors} icon={Users} loading={loading} />
        <KpiCard title="Lượt xem trang" value={t ? num(t.pageviews) : '—'} change={c?.pageviews} hint={t ? `${t.pagesPerSession.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} trang/phiên` : undefined} icon={Eye} loading={loading} />
        <KpiCard title="Phiên" value={t ? num(t.sessions) : '—'} change={c?.sessions} icon={MousePointerClick} loading={loading} />
        <KpiCard title="Tỉ lệ thoát" value={t ? pct(t.bounceRate) : '—'} change={c?.bounceRate} changeUnit=" điểm" invert icon={LogOut} loading={loading} />
        <KpiCard title="Thời lượng TB" value={t ? formatDuration(t.avgDuration) : '—'} change={c?.avgDuration} icon={Clock} loading={loading} />
        <KpiCard
          title="Đang online"
          value={
            d ? (
              <span className="inline-flex items-center gap-2">
                <LiveDot /> {num(d.online)}
              </span>
            ) : (
              '—'
            )
          }
          hint="khách trong 5 phút qua"
          icon={Globe}
          loading={loading}
        />
      </div>

      <TrafficChartCard {...props} />

      {/* Thẻ tóm tắt các mảng */}
      {loading || !d ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <SummaryCard icon={FileText} title="Nội dung" onMore={go('content')}>
            <StatRow label="Trang đang xuất bản" value={num(d.content.pages)} sub={d.content.newPages ? `+${num(d.content.newPages)} mới` : undefined} />
            <StatRow label="Bài viết đang xuất bản" value={num(d.content.posts)} sub={d.content.newPosts ? `+${num(d.content.newPosts)} mới` : undefined} />
            <StatRow label="Sản phẩm đang bán" value={num(d.content.products)} sub={d.content.newProducts ? `+${num(d.content.newProducts)} mới` : undefined} />
            <StatRow label="Thư viện media" value={`${num(d.content.media)} file`} sub={formatBytes(d.content.mediaBytes)} />
          </SummaryCard>

          <SummaryCard icon={UserRound} title="Thành viên" onMore={go('members')}>
            <StatRow label="Tổng thành viên" value={num(d.members.total)} />
            <StatRow label="Đăng ký mới trong kỳ" value={num(d.members.newUsers)} sub={<Delta value={d.members.newUsersChange} />} />
            <StatRow label="Hoạt động trong kỳ" value={num(d.members.activeUsers)} />
          </SummaryCard>

          <SummaryCard icon={MessagesSquare} title="Tương tác" onMore={go('engagement')}>
            <StatRow label="Bình luận" value={num(d.engagement.comments)} sub={<Delta value={d.engagement.commentsChange} />} />
            <StatRow
              label="Chờ duyệt"
              value={
                d.engagement.pendingComments ? (
                  <Link href="/posts/comments" className="text-amber-600 hover:underline dark:text-amber-400">
                    {num(d.engagement.pendingComments)}
                  </Link>
                ) : (
                  '0'
                )
              }
            />
            <StatRow label="Đánh giá sản phẩm" value={num(d.engagement.reviews)} sub={<Delta value={d.engagement.reviewsChange} />} />
            <StatRow label="Điểm đánh giá TB" value={d.engagement.avgRating == null ? '—' : `${d.engagement.avgRating.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} ★`} />
          </SummaryCard>

          <SummaryCard icon={Mail} title="Email" onMore={go('emails')}>
            <StatRow label="Đã gửi" value={num(d.emails.sent)} />
            <StatRow label="Gửi lỗi" value={<span className={cn(d.emails.failed > 0 && 'text-red-600 dark:text-red-400')}>{num(d.emails.failed)}</span>} />
            <StatRow label="Tỉ lệ lỗi" value={ratio(d.emails.failed, d.emails.sent + d.emails.failed)} />
          </SummaryCard>

          {d.sales && (
            <SummaryCard
              icon={ShoppingCart}
              title="Bán hàng"
              footer={
                <Button variant="outline" size="sm" className="mb-1 w-full" asChild>
                  <Link href={salesHref}>
                    Xem báo cáo bán hàng <ArrowRight />
                  </Link>
                </Button>
              }
            >
              <StatRow label="Doanh thu thuần" value={formatMoney(d.sales.revenue)} sub={<Delta value={d.sales.revenueChange} />} />
              <StatRow label="Đơn hàng" value={num(d.sales.orders)} sub={<Delta value={d.sales.ordersChange} />} />
              <StatRow label="Tỉ lệ chuyển đổi" value={pct(d.sales.conversionRate)} sub="đơn / phiên" />
            </SummaryCard>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Truy cập

const DEVICE_ICONS: Record<string, React.ElementType> = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

/** Khối thời gian thực: số khách online, trang đang xem, lượt xem gần nhất (tự làm mới 30 giây) */
function RealtimeCard() {
  const q = useQuery({ queryKey: [SITE_KEY, 'realtime'], queryFn: () => api.get<RealtimeReport>('/admin/analytics/realtime'), refetchInterval: 30_000 });
  const d = q.data;
  const maxPage = Math.max(1, ...(d?.pages.map((p) => p.visitors) ?? [0]));
  return (
    <ReportCard
      title={
        <span className="inline-flex items-center gap-2">
          <LiveDot /> Thời gian thực
        </span>
      }
      description="Khách hoạt động trong 5 phút gần nhất · tự làm mới mỗi 30 giây"
      actions={d && <span className="text-2xl font-bold tabular-nums">{num(d.online)} <span className="text-sm font-normal text-muted-foreground">đang online</span></span>}
    >
      {q.error ? (
        <QueryError error={q.error} />
      ) : !d ? (
        <ChartSkeleton className="h-56" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-2 lg:col-span-2">
            <h4 className="text-sm font-medium">Trang đang được xem</h4>
            {d.pages.length ? (
              <ul className="space-y-2.5">
                {d.pages.slice(0, 10).map((p) => (
                  <li key={p.path} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate" title={p.path}>
                        {p.title || p.path}
                      </span>
                      <span className="shrink-0 tabular-nums">{num(p.visitors)}</span>
                    </div>
                    <ShareBar value={p.visitors} max={maxPage} />
                  </li>
                ))}
              </ul>
            ) : (
              <Note className="py-6">Hiện không có ai trên website</Note>
            )}
          </div>
          <div className="min-w-0 space-y-2 lg:col-span-3">
            <h4 className="text-sm font-medium">20 lượt xem gần nhất</h4>
            {d.recent.length ? (
              <ul className="divide-y text-sm">
                {d.recent.slice(0, 20).map((r, i) => {
                  const DevIcon = DEVICE_ICONS[r.device?.toLowerCase()] ?? Monitor;
                  return (
                    <li key={`${r.createdAt}-${i}`} className="flex items-start gap-3 py-2">
                      <span className="w-14 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{formatDate(r.createdAt, 'HH:mm:ss')}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate" title={r.path}>
                          {r.title || r.path}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <DevIcon className="size-3" /> {deviceLabel(r.device)}
                          </span>
                          {(r.browser || r.os) && <span>{[r.browser, r.os].filter(Boolean).join(' · ')}</span>}
                          {r.country && <span>{countryName(r.country)}</span>}
                          <span className="truncate">{r.referrerHost ? `từ ${r.referrerHost}` : 'truy cập trực tiếp'}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Note className="py-6">Chưa có lượt xem nào trong 5 phút qua</Note>
            )}
          </div>
        </div>
      )}
    </ReportCard>
  );
}

export function TrafficTab(props: SiteTabProps) {
  const { from, to } = props;
  const hours = useQuery({ queryKey: [SITE_KEY, 'hours', from, to], queryFn: () => api.get<HoursReport>('/admin/analytics/hours', { from, to }) });
  return (
    <div className="space-y-4">
      <TrafficChartCard {...props} />
      <ReportCard title="Lượt xem theo giờ trong tuần" description="Màu càng đậm càng nhiều lượt xem (giờ theo múi giờ website). Rê chuột lên ô để xem số liệu.">
        {hours.error ? <QueryError error={hours.error} /> : hours.isLoading || !hours.data ? <ChartSkeleton className="h-52" /> : <HoursHeatmap data={hours.data.data} />}
      </ReportCard>
      <RealtimeCard />
    </div>
  );
}

// ------------------------------------------------------------------ Trang

type PageTableRow = PageRow & { id: string };

export function PagesTab({ from, to }: SiteTabProps) {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  // chờ người dùng gõ xong 350ms rồi mới gọi API
  useEffect(() => {
    const t = setTimeout(() => setSearch(input.trim()), 350);
    return () => clearTimeout(t);
  }, [input]);

  const q = useQuery({ queryKey: [SITE_KEY, 'pages', from, to, search], queryFn: () => api.get<PagesReport>('/admin/analytics/pages', { from, to, limit: 100, search }) });
  if (q.error) return <QueryError error={q.error} />;
  const rows: PageTableRow[] = (q.data?.data ?? []).map((r) => ({ ...r, id: r.path }));
  const totalViews = q.data?.totals.pageviews ?? 0;
  const maxViews = Math.max(1, ...rows.map((r) => r.pageviews));

  const columns: Column<PageTableRow>[] = [
    { key: 'rank', header: '#', className: 'w-10 text-muted-foreground', cell: (r) => rows.indexOf(r) + 1 },
    {
      key: 'page',
      header: 'Trang',
      cell: (r) => (
        <div className="min-w-0 max-w-[22rem]">
          <div className="truncate font-medium" title={r.title ?? r.path}>
            {r.title || r.path}
          </div>
          {/* có địa chỉ website thì đường dẫn bấm mở được, không thì chỉ hiện chữ */}
          {HAS_WEB_URL ? (
            <a href={`${WEB_URL}${r.path}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
              <span className="truncate">{r.path}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <span className="block truncate text-xs text-muted-foreground">{r.path}</span>
          )}
        </div>
      ),
    },
    { key: 'pageviews', header: 'Lượt xem', className: 'text-right font-medium tabular-nums', headClassName: 'text-right', cell: (r) => num(r.pageviews) },
    { key: 'visitors', header: 'Khách', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.visitors) },
    { key: 'entries', header: 'Lượt vào', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.entries) },
    { key: 'bounce', header: 'Tỉ lệ thoát', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => (r.entries ? pct(r.bounceRate) : '—') },
    {
      key: 'share',
      header: 'Tỉ trọng',
      className: 'w-32',
      cell: (r) => (
        <div className="space-y-1">
          <div className="text-right text-xs tabular-nums text-muted-foreground">{ratio(r.pageviews, totalViews)}</div>
          <ShareBar value={r.pageviews} max={maxViews} />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Tìm theo đường dẫn hoặc tiêu đề…" className="pl-8" aria-label="Tìm trang" />
        </div>
        {q.data && (
          <p className="text-sm text-muted-foreground">
            Tổng: <span className="font-medium text-foreground">{num(q.data.totals.pageviews)}</span> lượt xem · <span className="font-medium text-foreground">{num(q.data.totals.visitors)}</span> khách
          </p>
        )}
      </div>
      {!q.isLoading && !rows.length && !search ? (
        <NoTrafficNote />
      ) : (
        <DataTable columns={columns} data={rows} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle={search ? 'Không có trang nào khớp từ khoá' : 'Chưa có lượt xem trong kỳ'} />
      )}
      <p className="text-xs text-muted-foreground">Lượt vào = số phiên bắt đầu ở trang này. Tỉ lệ thoát = % phiên vào trang này rồi rời đi mà không xem trang khác. Hiển thị tối đa 100 trang.</p>
    </div>
  );
}

// ------------------------------------------------------------------ Nguồn & thiết bị

type CampaignRow = SourcesReport['campaigns'][number] & { id: string };

export function SourcesTab({ from, to }: SiteTabProps) {
  const src = useQuery({ queryKey: [SITE_KEY, 'sources', from, to], queryFn: () => api.get<SourcesReport>('/admin/analytics/sources', { from, to }) });
  const dev = useQuery({ queryKey: [SITE_KEY, 'devices', from, to], queryFn: () => api.get<DevicesReport>('/admin/analytics/devices', { from, to }) });
  if (src.error) return <QueryError error={src.error} />;
  if (dev.error) return <QueryError error={dev.error} />;

  const s = src.data;
  const d = dev.data;
  const campaigns: CampaignRow[] = (s?.campaigns ?? []).map((c, i) => ({ ...c, id: `${c.source}|${c.medium ?? ''}|${c.campaign ?? ''}|${i}` }));
  const campaignCols: Column<CampaignRow>[] = [
    { key: 'source', header: 'Nguồn (utm_source)', cell: (r) => <span className="font-medium">{r.source}</span> },
    { key: 'medium', header: 'Kênh (utm_medium)', className: 'text-muted-foreground', cell: (r) => r.medium || '—' },
    { key: 'campaign', header: 'Chiến dịch', className: 'text-muted-foreground', cell: (r) => r.campaign || '—' },
    { key: 'sessions', header: 'Phiên', className: 'text-right font-medium tabular-nums', headClassName: 'text-right', cell: (r) => num(r.sessions) },
    { key: 'visitors', header: 'Khách', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.visitors) },
  ];
  const countries = (d?.countries ?? []).map((x) => ({ name: countryName(x.name), value: x.value }));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ReportCard title="Kênh truy cập" description="Số phiên theo nguồn khách đến website">
          {src.isLoading || !s ? <ChartSkeleton className="h-44" /> : <DonutChart data={s.channels.map((c) => ({ name: CHANNEL_LABELS[c.channel] ?? c.channel, value: c.sessions }))} centerLabel="phiên" />}
        </ReportCard>
        <ReportCard title="Thiết bị" description="Số khách theo loại thiết bị">
          {dev.isLoading || !d ? <ChartSkeleton className="h-44" /> : <DonutChart data={d.devices.map((x) => ({ name: deviceLabel(x.name), value: x.value }))} centerLabel="khách" />}
        </ReportCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankCard title="Website giới thiệu" description="Top 10 tên miền dẫn khách tới (theo phiên)" data={s?.referrers.map((r) => ({ name: r.host, value: r.sessions }))} name="Phiên" loading={src.isLoading} emptyText="Chưa có lượt truy cập từ website khác trong kỳ" />
        <RankCard title="Trình duyệt" description="Theo số khách" data={d?.browsers} name="Khách" loading={dev.isLoading} />
        <RankCard title="Hệ điều hành" description="Theo số khách" data={d?.os} name="Khách" loading={dev.isLoading} />
        <RankCard title="Ngôn ngữ trang" description="Theo số khách" data={d?.locales.map((x) => ({ name: localeName(x.name), value: x.value }))} name="Khách" loading={dev.isLoading} />
        {/* quốc gia chỉ có khi máy chủ/proxy cung cấp thông tin vị trí -> ẩn thẻ nếu rỗng */}
        {countries.some((x) => x.value > 0) && <RankCard title="Quốc gia" description="Theo số khách" data={countries} name="Khách" />}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Chiến dịch UTM</h3>
        <DataTable columns={campaignCols} data={campaigns} loading={src.isLoading} error={src.error} onRetry={() => void src.refetch()} emptyTitle="Chưa có lượt truy cập từ chiến dịch" emptyDescription="Gắn tham số utm_source, utm_medium, utm_campaign vào liên kết quảng cáo để theo dõi." />
      </div>
    </div>
  );
}
