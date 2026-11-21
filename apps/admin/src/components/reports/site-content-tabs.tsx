'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BadgeCheck, MailCheck, MailMinus, MailX, ShieldCheck, UserCheck, UserPlus, Users } from 'lucide-react';
import { DataTable, type Column } from '@/components/common/data-table';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';
import { formatBytes, formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DonutChart, SERIES_COLORS, TimeSeriesChart } from './charts';
import { KpiCard } from './kpi-card';
import {
  ChartSkeleton,
  IntervalToggle,
  MetricToggle,
  MultiBarChart,
  Note,
  QueryError,
  RankCard,
  ReportCard,
  SITE_KEY,
  SeriesCard,
  ShareBar,
  intervalWord,
  mediaTypeLabel,
  num,
  ratio,
  type SiteTabProps,
} from './site-common';
import type { ContentReport, EmailsReport, EngagementReport, MembersReport, StatusCount } from './site-types';

// ------------------------------------------------------------------ Nội dung

const CONTENT_SERIES = [
  { key: 'pages', label: 'Trang', color: SERIES_COLORS[0] },
  { key: 'posts', label: 'Bài viết', color: SERIES_COLORS[1] },
  { key: 'products', label: 'Sản phẩm', color: SERIES_COLORS[2] },
] as const;

const STATUS_COLS: { key: keyof StatusCount; label: string; query: string }[] = [
  { key: 'published', label: 'Đã xuất bản', query: '?status=PUBLISHED' },
  { key: 'draft', label: 'Nháp', query: '?status=DRAFT' },
  { key: 'scheduled', label: 'Hẹn giờ', query: '?status=SCHEDULED' },
  { key: 'archived', label: 'Lưu trữ', query: '?status=ARCHIVED' },
  { key: 'trash', label: 'Thùng rác', query: '?trashed=1' },
  { key: 'total', label: 'Tổng', query: '' },
];

const CONTENT_ROWS = [
  { key: 'pages', label: 'Trang', href: '/pages' },
  { key: 'posts', label: 'Bài viết', href: '/posts' },
  { key: 'products', label: 'Sản phẩm', href: '/products' },
] as const;

export function ContentTab({ from, to, interval, setParams }: SiteTabProps) {
  // 'all' = cột nhóm 3 chuỗi; còn lại = 1 chuỗi
  const [series, setSeries] = useState<'all' | 'pages' | 'posts' | 'products'>('all');
  const q = useQuery({ queryKey: [SITE_KEY, 'content', from, to, interval], queryFn: () => api.get<ContentReport>('/admin/analytics/content', { from, to, interval }) });
  if (q.error) return <QueryError error={q.error} />;
  const d = q.data;
  const single = CONTENT_SERIES.find((s) => s.key === series);
  const seriesEmpty = d && d.series.every((p) => !p.pages && !p.posts && !p.products);

  type TopPost = ContentReport['topPosts'][number];
  const topCols: Column<TopPost>[] = [
    { key: 'rank', header: '#', className: 'w-10 text-muted-foreground', cell: (r) => (d?.topPosts.indexOf(r) ?? 0) + 1 },
    {
      key: 'title',
      header: 'Bài viết',
      cell: (r) => (
        <Link href={`/posts/${r.id}`} className="line-clamp-1 font-medium hover:underline">
          {r.title || '(không tiêu đề)'}
        </Link>
      ),
    },
    { key: 'views', header: 'Lượt xem', className: 'text-right font-medium tabular-nums', headClassName: 'text-right', cell: (r) => num(r.viewCount) },
    { key: 'comments', header: 'Bình luận', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.commentCount) },
    { key: 'published', header: 'Ngày đăng', className: 'whitespace-nowrap text-muted-foreground', cell: (r) => formatDate(r.publishedAt, 'dd/MM/yyyy') },
  ];
  const maxMedia = Math.max(1, ...(d?.media.byType.map((m) => m.bytes) ?? [0]));

  return (
    <div className="space-y-4">
      {/* Số lượng theo trạng thái */}
      <ReportCard title="Số lượng nội dung theo trạng thái" description="Số liệu hiện tại, không phụ thuộc khoảng thời gian. Bấm vào số để mở danh sách." contentClassName="px-0">
        {q.isLoading || !d ? (
          <div className="px-6">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Loại</TableHead>
                  {STATUS_COLS.map((c) => (
                    <TableHead key={c.key} className={cn('text-right', c.key === 'total' && 'pr-6')}>
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {CONTENT_ROWS.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell className="pl-6 font-medium">{row.label}</TableCell>
                    {STATUS_COLS.map((c) => {
                      const v = d.counts[row.key][c.key];
                      return (
                        <TableCell key={c.key} className={cn('text-right tabular-nums', c.key === 'total' ? 'pr-6 font-semibold' : !v && 'text-muted-foreground')}>
                          {v ? (
                            <Link href={`${row.href}${c.query}`} className="hover:underline">
                              {num(v)}
                            </Link>
                          ) : (
                            '0'
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </ReportCard>

      {/* Nội dung xuất bản mới theo kỳ */}
      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <CardTitle className="text-base">Nội dung xuất bản mới theo {intervalWord(interval)}</CardTitle>
            <CardDescription>Tính theo ngày xuất bản</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup type="single" size="sm" variant="outline" value={series} onValueChange={(v) => v && setSeries(v as typeof series)} aria-label="Loại nội dung" className="flex-wrap">
              <ToggleGroupItem value="all">Tất cả</ToggleGroupItem>
              {CONTENT_SERIES.map((s) => (
                <ToggleGroupItem key={s.key} value={s.key}>
                  <span className="mr-1.5 inline-block size-2 rounded-sm" style={{ background: s.color }} aria-hidden />
                  {s.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <IntervalToggle value={interval} onChange={(v) => setParams({ interval: v })} />
          </div>
        </CardHeader>
        <CardContent>
          {q.isLoading || !d ? (
            <Skeleton className="h-64 w-full" />
          ) : seriesEmpty ? (
            <Note>Không có nội dung nào được xuất bản trong kỳ</Note>
          ) : single ? (
            <TimeSeriesChart data={d.series} xKey="period" yKey={single.key} name={single.label} color={single.color} kind="bar" interval={d.interval} height={260} />
          ) : (
            <MultiBarChart data={d.series} series={CONTENT_SERIES} interval={d.interval} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="space-y-2 xl:col-span-3">
          <h3 className="text-sm font-semibold">Bài viết xem nhiều nhất</h3>
          <DataTable columns={topCols} data={d?.topPosts} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle="Chưa có bài viết nào" />
          <p className="text-xs text-muted-foreground">Tổng lượt xem từ trước tới nay của bài viết.</p>
        </div>
        <RankCard className="xl:col-span-2" title="Tác giả" description="Số bài xuất bản trong kỳ" data={d?.authors.map((a) => ({ name: a.name, value: a.posts }))} name="Bài viết" loading={q.isLoading} emptyText="Chưa có bài viết xuất bản trong kỳ" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankCard title="Chuyên mục bài viết" description="Số bài viết theo chuyên mục" data={d?.postCategories} name="Bài viết" loading={q.isLoading} />
        <RankCard title="Danh mục sản phẩm" description="Số sản phẩm theo danh mục" data={d?.productCategories} name="Sản phẩm" loading={q.isLoading} />
      </div>

      <ReportCard title="Thư viện media" description={d ? `${num(d.media.total)} file · ${formatBytes(d.media.bytes)}` : undefined}>
        {q.isLoading || !d ? (
          <ChartSkeleton className="h-44" />
        ) : !d.media.total ? (
          <Note>Thư viện media đang trống</Note>
        ) : (
          <div className="grid items-center gap-6 lg:grid-cols-2">
            <DonutChart data={d.media.byType.map((m) => ({ name: mediaTypeLabel(m.name), value: m.count }))} centerLabel="file" />
            <ul className="space-y-3 text-sm">
              {d.media.byType.map((m) => (
                <li key={m.name} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate">{mediaTypeLabel(m.name)}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {num(m.count)} file · <span className="font-medium text-foreground">{formatBytes(m.bytes)}</span>
                    </span>
                  </div>
                  <ShareBar value={m.bytes} max={maxMedia} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </ReportCard>
    </div>
  );
}

// ------------------------------------------------------------------ Thành viên

const MEMBER_METRICS = [
  { key: 'signups', label: 'Đăng ký mới', color: SERIES_COLORS[0] },
  { key: 'logins', label: 'Lượt đăng nhập', color: SERIES_COLORS[1] },
] as const;

export function MembersTab({ from, to, interval, setParams }: SiteTabProps) {
  const q = useQuery({ queryKey: [SITE_KEY, 'members', from, to, interval], queryFn: () => api.get<MembersReport>('/admin/analytics/members', { from, to, interval }) });
  if (q.error) return <QueryError error={q.error} />;
  const d = q.data;
  const t = d?.totals;
  const loading = q.isLoading;
  const statusData = t
    ? [
        { name: 'Hoạt động', value: t.active },
        { name: 'Ngừng', value: t.inactive },
        { name: 'Bị khoá', value: t.banned },
        { name: 'Chờ duyệt', value: t.pending },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard title="Tổng thành viên" value={t ? num(t.total) : '—'} hint={t ? `${num(t.active)} đang hoạt động` : undefined} icon={Users} loading={loading} />
        <KpiCard title="Đăng ký mới" value={t ? num(t.newUsers) : '—'} hint="trong kỳ" icon={UserPlus} loading={loading} />
        <KpiCard title="Hoạt động trong kỳ" value={t ? num(t.activeUsers) : '—'} hint="có đăng nhập" icon={UserCheck} loading={loading} />
        <KpiCard title="Đã xác minh email" value={t ? num(t.verified) : '—'} hint={t ? `${ratio(t.verified, t.total)} thành viên` : undefined} icon={BadgeCheck} loading={loading} />
        <KpiCard title="Bật 2FA" value={t ? ratio(t.twoFactor, t.total) : '—'} hint={t ? `${num(t.twoFactor)} tài khoản` : undefined} icon={ShieldCheck} loading={loading} />
      </div>

      <SeriesCard
        title={(m) => `${m.label} theo ${intervalWord(interval)}`}
        metrics={MEMBER_METRICS}
        data={d?.series}
        interval={interval}
        dataInterval={d?.interval}
        onInterval={(v) => setParams({ interval: v })}
        loading={loading}
        defaultKind="bar"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ReportCard title="Theo vai trò" description="Toàn bộ thành viên hiện có">
          {loading || !d ? <ChartSkeleton className="h-44" /> : <DonutChart data={d.byRole} centerLabel="thành viên" emptyText="Chưa có thành viên" />}
        </ReportCard>
        <ReportCard title="Theo trạng thái" description="Toàn bộ thành viên hiện có">
          {loading || !d ? <ChartSkeleton className="h-44" /> : <DonutChart data={statusData} centerLabel="thành viên" emptyText="Chưa có thành viên" />}
        </ReportCard>
      </div>

      {/* API trả null khi người xem không có quyền users.read -> ẩn danh sách có email */}
      {d?.recent !== null && (
      <ReportCard title="Đăng ký gần đây">
        {loading || !d || !d.recent ? (
          <ChartSkeleton className="h-40" />
        ) : d.recent.length ? (
          <ul className="divide-y text-sm">
            {d.recent.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-2">
                <div className="min-w-0">
                  <Link href={`/users/${u.id}`} className="font-medium hover:underline">
                    {u.name || u.email}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {u.email} · {u.role}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground" title={formatDate(u.createdAt)}>
                  {timeAgo(u.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Note>Chưa có thành viên đăng ký</Note>
        )}
      </ReportCard>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Tương tác

const ENGAGEMENT_METRICS = [
  { key: 'comments', label: 'Bình luận', color: SERIES_COLORS[0] },
  { key: 'reviews', label: 'Đánh giá', color: SERIES_COLORS[2] },
] as const;

/** Phân bố số sao 5 → 1: thanh ngang + số lượng + tỉ lệ */
function RatingBars({ ratings }: { ratings: EngagementReport['ratings'] }) {
  const sorted = [...ratings].sort((a, b) => b.rating - a.rating);
  const total = sorted.reduce((s, r) => s + r.count, 0);
  const max = Math.max(1, ...sorted.map((r) => r.count));
  const avg = total ? sorted.reduce((s, r) => s + r.rating * r.count, 0) / total : null;
  if (!total) return <Note>Chưa có đánh giá trong kỳ</Note>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Trung bình <span className="text-lg font-bold text-foreground tabular-nums">{avg?.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} ★</span> từ {num(total)} đánh giá
      </p>
      <ul className="space-y-2">
        {sorted.map((r) => (
          <li key={r.rating} className="grid grid-cols-[2.5rem_minmax(0,1fr)_5.5rem] items-center gap-3 text-sm">
            <span className="tabular-nums">{r.rating} ★</span>
            <ShareBar value={r.count} max={max} color="var(--viz-3)" className="h-2" />
            <span className="text-right tabular-nums">
              {num(r.count)} <span className="text-xs text-muted-foreground">({ratio(r.count, total)})</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EngagementTab({ from, to, interval, setParams }: SiteTabProps) {
  const q = useQuery({ queryKey: [SITE_KEY, 'engagement', from, to, interval], queryFn: () => api.get<EngagementReport>('/admin/analytics/engagement', { from, to, interval }) });
  if (q.error) return <QueryError error={q.error} />;
  const d = q.data;
  const loading = q.isLoading;
  return (
    <div className="space-y-4">
      <SeriesCard
        title={(m) => `${m.label} theo ${intervalWord(interval)}`}
        metrics={ENGAGEMENT_METRICS}
        data={d?.series}
        interval={interval}
        dataInterval={d?.interval}
        onInterval={(v) => setParams({ interval: v })}
        loading={loading}
        defaultKind="bar"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ReportCard title="Trạng thái bình luận" description="Bình luận tạo trong kỳ">
          {loading || !d ? <ChartSkeleton className="h-44" /> : <DonutChart data={d.commentStatus} centerLabel="bình luận" emptyText="Chưa có bình luận trong kỳ" />}
        </ReportCard>
        <ReportCard title="Phân bố đánh giá sản phẩm" description="Đánh giá tạo trong kỳ">
          {loading || !d ? <ChartSkeleton className="h-44" /> : <RatingBars ratings={d.ratings} />}
        </ReportCard>
      </div>

      <div className="grid gap-4">
        <ReportCard title="Bài viết nhiều bình luận" description="Số bình luận tạo trong kỳ">
          {loading || !d ? (
            <ChartSkeleton className="h-40" />
          ) : d.topCommented.length ? (
            <ul className="space-y-2.5 text-sm">
              {d.topCommented.map((p) => (
                <li key={p.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/posts/${p.id}`} className="min-w-0 truncate hover:underline">
                      {p.title || '(không tiêu đề)'}
                    </Link>
                    <span className="shrink-0 tabular-nums">{num(p.comments)}</span>
                  </div>
                  <ShareBar value={p.comments} max={Math.max(1, ...d.topCommented.map((x) => x.comments))} />
                </li>
              ))}
            </ul>
          ) : (
            <Note>Chưa có bình luận trong kỳ</Note>
          )}
        </ReportCard>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Email

const EMAIL_SERIES = [
  { key: 'sent', label: 'Đã gửi', color: SERIES_COLORS[1] },
  { key: 'failed', label: 'Lỗi', color: SERIES_COLORS[4] },
] as const;

export function EmailsTab({ from, to, interval, setParams }: SiteTabProps) {
  const [metric, setMetric] = useState<'all' | 'sent' | 'failed'>('all');
  const q = useQuery({ queryKey: [SITE_KEY, 'emails', from, to, interval], queryFn: () => api.get<EmailsReport>('/admin/analytics/emails', { from, to, interval }) });
  if (q.error) return <QueryError error={q.error} />;
  const d = q.data;
  const t = d?.totals;
  const loading = q.isLoading;
  const single = EMAIL_SERIES.find((s) => s.key === metric);

  type TemplateRow = EmailsReport['templates'][number] & { id: string };
  const templates: TemplateRow[] = (d?.templates ?? []).map((r) => ({ ...r, id: r.key }));
  const templateCols: Column<TemplateRow>[] = [
    {
      key: 'key',
      header: 'Mẫu email',
      // email gửi không theo mẫu (key mặc định "(tuỳ chỉnh)") không có trang sửa -> không gắn link
      cell: (r) =>
        r.key.startsWith('(') ? (
          <span className="font-mono text-xs text-muted-foreground">{r.key}</span>
        ) : (
          <Link href={`/settings/emails/${encodeURIComponent(r.key)}`} className="font-mono text-xs font-medium hover:underline">
            {r.key}
          </Link>
        ),
    },
    { key: 'sent', header: 'Đã gửi', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => num(r.sent) },
    { key: 'failed', header: 'Lỗi', className: 'text-right tabular-nums', headClassName: 'text-right', cell: (r) => <span className={cn(r.failed > 0 && 'font-medium text-red-600 dark:text-red-400')}>{num(r.failed)}</span> },
    { key: 'skipped', header: 'Bỏ qua', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => num(r.skipped) },
    { key: 'rate', header: 'Tỉ lệ lỗi', className: 'text-right tabular-nums text-muted-foreground', headClassName: 'text-right', cell: (r) => ratio(r.failed, r.sent + r.failed) },
  ];
  type FailRow = NonNullable<EmailsReport['recentFailed']>[number];
  const failCols: Column<FailRow>[] = [
    { key: 'time', header: 'Thời gian', className: 'whitespace-nowrap text-muted-foreground', cell: (r) => formatDate(r.createdAt) },
    { key: 'to', header: 'Người nhận', className: 'max-w-48 truncate', cell: (r) => r.to },
    { key: 'subject', header: 'Tiêu đề', cell: (r) => <span className="line-clamp-1">{r.subject}</span> },
    {
      key: 'error',
      header: 'Lỗi',
      cell: (r) => (
        <span className="line-clamp-2 text-xs text-red-600 dark:text-red-400" title={r.error ?? undefined}>
          {r.error || 'Không rõ'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard title="Đã gửi" value={t ? num(t.sent) : '—'} icon={MailCheck} loading={loading} />
        <KpiCard title="Gửi lỗi" value={t ? num(t.failed) : '—'} icon={MailX} loading={loading} />
        <KpiCard title="Bỏ qua" value={t ? num(t.skipped) : '—'} hint="chưa cấu hình SMTP hoặc bị chặn" icon={MailMinus} loading={loading} />
        <KpiCard title="Tỉ lệ lỗi" value={t ? ratio(t.failed, t.sent + t.failed) : '—'} icon={AlertTriangle} loading={loading} />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <CardTitle className="text-base">Email gửi theo {intervalWord(interval)}</CardTitle>
            <CardDescription>Số email gửi thành công và gửi lỗi</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <MetricToggle metrics={[{ key: 'all', label: 'Tất cả', color: 'var(--muted-foreground)' }, ...EMAIL_SERIES]} value={metric} onChange={(v) => setMetric(v as typeof metric)} />
            <IntervalToggle value={interval} onChange={(v) => setParams({ interval: v })} />
          </div>
        </CardHeader>
        <CardContent>
          {loading || !d ? (
            <Skeleton className="h-64 w-full" />
          ) : single ? (
            <TimeSeriesChart data={d.series} xKey="period" yKey={single.key} name={single.label} color={single.color} kind="bar" interval={d.interval} height={260} />
          ) : (
            <MultiBarChart data={d.series} series={EMAIL_SERIES} interval={d.interval} stacked />
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Theo mẫu email</h3>
        <DataTable columns={templateCols} data={templates} loading={loading} error={q.error} onRetry={() => void q.refetch()} emptyTitle="Chưa gửi email nào trong kỳ" />
      </div>
      {/* API trả null khi người xem không có quyền settings.manage -> ẩn bảng có địa chỉ người nhận */}
      {d?.recentFailed !== null && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Lỗi gần đây</h3>
          <DataTable columns={failCols} data={d?.recentFailed ?? undefined} loading={loading} error={q.error} onRetry={() => void q.refetch()} emptyTitle="Không có email lỗi trong kỳ" />
        </div>
      )}
    </div>
  );
}
