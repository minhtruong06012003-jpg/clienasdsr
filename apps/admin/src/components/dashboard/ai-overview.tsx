'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  Coins,
  CreditCard,
  Gift,
  Globe,
  HandCoins,
  Hourglass,
  Loader2,
  PackageCheck,
  PiggyBank,
  RefreshCw,
  Sparkles,
  TrendingUp,
  TriangleAlert,
  UserPlus,
  UserRound,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DonutChart, SERIES_COLORS, TimeSeriesChart, VizRoot } from '@/components/reports/charts';
import { Delta } from '@/components/reports/kpi-card';
import { StatRow } from '@/components/reports/site-common';
import type { SiteOverview } from '@/components/reports/site-types';
import { TASK_STATUS, ToneBadge, fmtCredits } from '@/components/ai/shared';
import { TodoTile } from '@/components/dashboard/todo-tile';
import { api } from '@/lib/api';
import { formatMoney, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Người dùng rút gọn trong các danh sách */
interface MiniUser {
  id: string;
  name: string;
  email: string;
}

/** Dữ liệu GET /admin/dashboard/ai — mục nào thiếu quyền thì API trả null */
interface AiOverview {
  days: number;
  hideProviders?: boolean;
  money: {
    deposits: number;
    depositsCount: number;
    depositsChange: number;
    depositsToday: number;
    depositsAllTime: number;
    walletBalance: number;
    pendingCards: number;
    needsRefund: number;
    bySource: { name: string; value: number; count: number; real: boolean }[];
    recent: { id: string; amount: number; note: string | null; source: string; createdAt: string; user: MiniUser }[];
    topDepositors: (MiniUser & { total: number; count: number })[];
  } | null;
  credits: {
    sales: number;
    salesCount: number;
    salesChange: number;
    salesToday: number;
    salesAllTime: number;
    /** Các số liệu sau tính bằng VND (1 credit cũ = 1đ): tiền khách đã chi chạy AI, % thay đổi, tiền đã cộng vào ví, tổng số dư ví khách */
    creditsUsed: number;
    creditsUsedChange: number;
    creditsIssued: number;
    creditBalance: number;
    activePlanUsers: number;
    activePlans: { name: string; value: number }[];
    byPlan: { name: string; value: number; count: number }[];
    recent: { id: string; code: number; planName: string; paid: number; credits: number; cycle: string; createdAt: string; user: MiniUser }[];
  } | null;
  tasks: {
    total: number;
    change: number;
    today: number;
    counts: Record<string, number>;
    successRate: number | null;
    running: number;
    stuck: number;
    failed24h: number;
    slow30m?: number;
    byProvider: { key: string; name: string; total: number; ok: number; failed: number; credits: number }[];
    topTools: { key: string; name: string; category: string; providerName: string; total: number; ok: number; failed: number; credits: number }[];
    slowTools?: {
      key: string;
      name: string;
      category: string;
      providerName: string;
      total: number;
      slow: number;
      slowOk: number;
      slowFailed: number;
      slowRunning: number;
      avgMinutes: number;
      maxMinutes: number;
    }[];
    recent: { id: string; code: string; status: string; credits: number; refunded: boolean; provider: string; error: string | null; createdAt: string; tool: { name: string }; user: MiniUser }[];
    topUsers: (MiniUser & { tasks: number; credits: number })[];
  } | null;
  users: {
    total: number;
    new: number;
    newChange: number;
    today: number;
    active7d: number;
    locked: number;
    recent: (MiniUser & { createdAt: string; walletBalance: number; referredBy: { name: string } | null })[];
  } | null;
  affiliate: { commission: number; pendingPayouts: number; pendingPayoutAmount: number; balance: number; referred: number } | null;
  providers: { key: string; name: string; enabled: boolean; hasKey: boolean; tools: number }[] | null;
  chart: { date: string; deposits: number; sales: number; tasks: number; credits: number; users: number }[];
}

/** Các chỉ số có thể xem trên biểu đồ theo ngày */
const METRICS = [
  { key: 'deposits', label: 'Tiền nạp', money: true, kind: 'area', section: 'money' },
  { key: 'sales', label: 'Bán gói nạp', money: true, kind: 'area', section: 'credits' },
  { key: 'tasks', label: 'Tác vụ AI', money: false, kind: 'bar', section: 'tasks' },
  { key: 'credits', label: 'Tiền chạy AI', money: true, kind: 'bar', section: 'credits' },
  { key: 'users', label: 'Khách mới', money: false, kind: 'bar', section: 'users' },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

const PERIOD_LABEL: Record<string, string> = { '1': 'hôm nay', '7': '7 ngày', '30': '30 ngày', '90': '90 ngày' };

/** Mũi tên % thay đổi so với kỳ trước */
function Trend({ value }: { value: number }) {
  const up = value >= 0;
  return (
    <span className={cn('inline-flex items-center text-xs font-medium', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {Math.abs(value)}%
    </span>
  );
}

/** Ô chỉ số chính (KPI) */
function Kpi({ title, value, icon: Icon, footer, href, tone = 'bg-primary/10 text-primary' }: { title: string; value: React.ReactNode; icon: React.ElementType; footer?: React.ReactNode; href?: string; tone?: string }) {
  const body = (
    <Card className="h-full gap-2 transition hover:shadow-md">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-0">
        <CardTitle className="text-xs font-medium text-muted-foreground sm:text-sm">{title}</CardTitle>
        <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tone)}>
          <Icon className="size-4" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="truncate text-lg font-bold tracking-tight tabular-nums sm:text-2xl">{value}</div>
        {footer && <div className="mt-1 text-xs text-muted-foreground">{footer}</div>}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** Thẻ danh sách có tiêu đề + nút "Xem tất cả" */
function ListCard({ title, href, children, className }: { title: React.ReactNode; href?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{title}</CardTitle>
        {href && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={href}>Xem tất cả</Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-1">{children}</CardContent>
    </Card>
  );
}

const Empty = ({ text }: { text: string }) => <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>;

/** Dòng khách hàng: tên + email, bấm mở hồ sơ */
function UserLine({ user, right, sub }: { user: MiniUser; right: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Link href={`/users/${user.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold uppercase text-primary">{(user.name || user.email).slice(0, 1)}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{user.name || user.email}</div>
        <div className="truncate text-xs text-muted-foreground">{sub ?? user.email}</div>
      </div>
      <div className="shrink-0 text-right text-sm">{right}</div>
    </Link>
  );
}

/** Thanh tỉ lệ thành công / lỗi của một nhóm tác vụ */
function SuccessBar({ ok, failed, total }: { ok: number; failed: number; total: number }) {
  if (!total) return null;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="bg-emerald-500" style={{ width: `${(ok / total) * 100}%` }} />
      <div className="bg-red-500" style={{ width: `${(failed / total) * 100}%` }} />
    </div>
  );
}

const DEPOSIT_SOURCE: Record<string, string> = { gateway: 'Cổng thanh toán', card_topup: 'Thẻ cào', admin: 'Admin cộng tay', affiliate_payout: 'Rút hoa hồng' };

interface SourceWebsiteStatItem {
  key: string;
  name: string;
  website: string | null;
  enabled: boolean;
  flatRental?: boolean;
  totalOrders: number;
  completedOrders: number;
  processingOrders?: number;
  refundedOrders: number;
  processingRevenue?: number;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number;
}

interface SourceWebsiteStatsResponse {
  preset: string;
  scope?: 'all' | 'main' | 'children';
  from: string;
  to: string;
  updatedAt?: string;
  childSiteCount?: number;
  mainOrders?: number;
  childOrders?: number;
  summary: {
    totalOrders: number;
    completedOrders: number;
    processingOrders?: number;
    refundedOrders: number;
    processingRevenue?: number;
    revenue: number;
    cost: number;
    profit: number;
    marginPct: number;
  };
  items: SourceWebsiteStatItem[];
}

const SOURCE_PRESETS = [
  { key: 'today', label: 'Hôm nay' },
  { key: 'yesterday', label: 'Hôm qua' },
  { key: '7d', label: '7 ngày' },
  { key: '30d', label: '30 ngày' },
  { key: 'this_month', label: 'Tháng này' },
] as const;

/** Khối thống kê Thành viên (Tổng thành viên, Đăng ký mới trong kỳ, Hoạt động trong kỳ) chuyển từ Báo cáo sang Bảng điều khiển */
function MembersSummaryCard({ days, fallbackUsers }: { days: string; fallbackUsers: AiOverview['users'] }) {
  const nDays = Math.max(1, Number(days) || 30);
  const toIso = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const fromIso = new Date(Date.now() + 7 * 3_600_000 - (nDays - 1) * 86_400_000).toISOString().slice(0, 10);

  const overview = useQuery({
    queryKey: ['dashboard-members-overview', fromIso, toIso],
    queryFn: () => api.get<SiteOverview>('/admin/analytics/overview', { from: fromIso, to: toIso }),
    staleTime: 60_000,
  });

  const m = overview.data?.members;
  if (!m && !fallbackUsers) return null;

  const total = m?.total ?? fallbackUsers?.total ?? 0;
  const newUsers = m?.newUsers ?? fallbackUsers?.new ?? 0;
  const newUsersChange = m ? m.newUsersChange : (fallbackUsers?.newChange ?? null);
  const activeUsers = m?.activeUsers ?? fallbackUsers?.active7d ?? 0;

  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserRound className="size-4 text-muted-foreground" /> Thành viên
        </CardTitle>
        <Button variant="ghost" size="sm" className="-mr-2 h-7 text-xs" asChild>
          <Link href="/users">
            Xem chi tiết <ArrowRight className="size-3.5" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="divide-y">
        <StatRow label="Tổng thành viên" value={total.toLocaleString('vi-VN')} />
        <StatRow label="Đăng ký mới trong kỳ" value={newUsers.toLocaleString('vi-VN')} sub={<Delta value={newUsersChange} />} />
        <StatRow label="Hoạt động trong kỳ" value={activeUsers.toLocaleString('vi-VN')} />
      </CardContent>
    </Card>
  );
}

/** Khối thống kê Doanh thu · Chi phí · Lợi nhuận · Tổng đơn hàng của các Website nguồn (có lọc theo ngày) */
function SourceWebsitesStatsSection() {
  const [preset, setPreset] = useState<string>('today');
  const [scope, setScope] = useState<'all' | 'main' | 'children'>('all');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');

  const queryParams =
    preset === 'custom' && (customFrom || customTo)
      ? { preset: 'custom', from: customFrom || customTo, to: customTo || customFrom, scope }
      : { preset, scope };

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['dashboard-source-stats', queryParams.preset, queryParams.from ?? '', queryParams.to ?? '', scope],
    queryFn: () => api.get<SourceWebsiteStatsResponse | null>('/admin/dashboard/source-stats', queryParams),
    refetchInterval: 8_000,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  if (!isLoading && data === null) return null;

  const displayFrom = preset === 'custom' ? customFrom : (data?.from ?? customFrom);
  const displayTo = preset === 'custom' ? customTo : (data?.to ?? customTo);
  const summary = data?.summary;
  const items = data?.items ?? [];
  const updatedTimeStr = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : null;

  const handlePickFrom = (val: string) => {
    setCustomFrom(val);
    if (!customTo && data?.to) setCustomTo(data.to);
    setPreset('custom');
  };

  const handlePickTo = (val: string) => {
    setCustomTo(val);
    if (!customFrom && data?.from) setCustomFrom(data.from);
    setPreset('custom');
  };

  return (
    <section className="space-y-3">
      <Card>
        <CardHeader className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Globe className="size-4 text-primary" />
              <span>Doanh thu & lợi nhuận theo website nguồn</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                Real-time{updatedTimeStr ? ` · ${updatedTimeStr}` : ''}
              </span>
              {isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tổng hợp đơn hàng đã hoàn tất thực tế (trừ đơn hoàn & tách riêng đơn đang chạy), doanh thu, vốn API và lợi nhuận ròng
              {data ? ` · Kỳ xem: ${data.from === data.to ? data.from : `${data.from} → ${data.to}`}` : ''}
              {scope === 'all' && (data?.childSiteCount ?? 0) > 0
                ? ` · Gộp Web chính (${(data?.mainOrders ?? 0).toLocaleString('vi-VN')} đơn) + ${data?.childSiteCount} Web con (${(data?.childOrders ?? 0).toLocaleString('vi-VN')} đơn)`
                : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(data?.childSiteCount ?? 0) > 0 && (
              <ToggleGroup
                type="single"
                size="sm"
                value={scope}
                onValueChange={(v) => {
                  if (v === 'all' || v === 'main' || v === 'children') setScope(v);
                }}
                variant="outline"
                aria-label="Phạm vi hệ thống"
              >
                <ToggleGroupItem value="all">Toàn hệ thống</ToggleGroupItem>
                <ToggleGroupItem value="main">Web chính</ToggleGroupItem>
                <ToggleGroupItem value="children">Web con</ToggleGroupItem>
              </ToggleGroup>
            )}

            <ToggleGroup
              type="single"
              size="sm"
              value={preset === 'custom' ? '' : preset}
              onValueChange={(v) => {
                if (v) setPreset(v);
              }}
              variant="outline"
              aria-label="Chọn kỳ thống kê nguồn"
              className="flex-wrap"
            >
              {SOURCE_PRESETS.map((p) => (
                <ToggleGroupItem key={p.key} value={p.key}>
                  {p.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs">
              <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                type="date"
                value={displayFrom}
                onChange={(e) => handlePickFrom(e.target.value)}
                aria-label="Từ ngày"
                className="bg-transparent text-xs font-medium outline-none"
              />
              <span className="text-muted-foreground">→</span>
              <input
                type="date"
                value={displayTo}
                onChange={(e) => handlePickTo(e.target.value)}
                aria-label="Đến ngày"
                className="bg-transparent text-xs font-medium outline-none"
              />
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => void refetch()}
              disabled={isFetching}
              title="Làm mới ngay lập tức"
            >
              <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
              Làm mới
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pt-4">
          {isLoading || !summary ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-48 rounded-xl" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <div className="rounded-xl border bg-muted/20 p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Tổng số đơn hàng</span>
                    <PackageCheck className="size-4 text-indigo-500" />
                  </div>
                  <div className="mt-1.5 text-xl font-bold tabular-nums">{summary.totalOrders.toLocaleString('vi-VN')}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">{summary.completedOrders.toLocaleString('vi-VN')} thành công</span>
                    {(summary.processingOrders ?? 0) > 0 && (
                      <>
                        {' · '}
                        <span className="font-medium text-indigo-600 dark:text-indigo-400">
                          {(summary.processingOrders ?? 0).toLocaleString('vi-VN')} đang chạy
                        </span>
                      </>
                    )}
                    {' · '}
                    <span>{summary.refundedOrders.toLocaleString('vi-VN')} hoàn tiền</span>
                  </div>
                </div>

                <div className="rounded-xl border bg-muted/20 p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Tổng doanh thu</span>
                    <Coins className="size-4 text-amber-500" />
                  </div>
                  <div className="mt-1.5 text-xl font-bold tabular-nums">{formatMoney(summary.revenue)}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Thực thu đơn đã hoàn tất
                    {(summary.processingRevenue ?? 0) > 0 ? ` · Đang chạy: ${formatMoney(summary.processingRevenue ?? 0)}` : ''}
                  </div>
                </div>

                <div className="rounded-xl border bg-muted/20 p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Chi phí nguồn</span>
                    <Wallet className="size-4 text-sky-500" />
                  </div>
                  <div className="mt-1.5 text-xl font-bold tabular-nums">{formatMoney(summary.cost)}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">Vốn API ước tính theo cấu hình nguồn</div>
                </div>

                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3.5">
                  <div className="flex items-center justify-between text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    <span>Lợi nhuận ròng</span>
                    <TrendingUp className="size-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="mt-1.5 text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatMoney(summary.profit)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Biên lợi nhuận: <span className="font-semibold text-foreground">{summary.marginPct}%</span>
                  </div>
                </div>
              </div>

              {items.length === 0 ? (
                <Empty text="Chưa có dữ liệu đơn hàng nguồn trong khoảng ngày đã chọn" />
              ) : (
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full min-w-[680px] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs font-semibold text-muted-foreground">
                        <th className="px-3.5 py-2.5">Website nguồn</th>
                        <th className="px-3.5 py-2.5 text-right">Tổng đơn hàng</th>
                        <th className="px-3.5 py-2.5 text-right">Thành công / Hoàn</th>
                        <th className="px-3.5 py-2.5 text-right">Doanh thu</th>
                        <th className="px-3.5 py-2.5 text-right">Chi phí nguồn</th>
                        <th className="px-3.5 py-2.5 text-right">Lợi nhuận</th>
                        <th className="px-3.5 py-2.5 text-right">Biên lãi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.map((item) => {
                        const revShare = summary.revenue > 0 ? Math.min(100, Math.round((item.revenue / summary.revenue) * 100)) : 0;
                        return (
                          <tr key={item.key} className="transition hover:bg-muted/30">
                            <td className="px-3.5 py-2.5">
                              <div className="flex items-center gap-2">
                                <span className={cn('size-2 shrink-0 rounded-full', item.enabled ? 'bg-emerald-500' : 'bg-zinc-400')} />
                                <div>
                                  <div className="font-medium text-foreground">{item.name}</div>
                                  {item.website && <div className="text-[11px] text-muted-foreground">{item.website}</div>}
                                </div>
                              </div>
                            </td>
                            <td className="px-3.5 py-2.5 text-right font-semibold tabular-nums">
                              {item.totalOrders.toLocaleString('vi-VN')}
                            </td>
                            <td className="px-3.5 py-2.5 text-right text-xs tabular-nums">
                              <span className="font-medium text-emerald-600 dark:text-emerald-400">{item.completedOrders.toLocaleString('vi-VN')}</span>
                              {(item.processingOrders ?? 0) > 0 && (
                                <>
                                  <span className="text-muted-foreground"> · </span>
                                  <span className="font-medium text-indigo-600 dark:text-indigo-400" title="Đang xử lý">
                                    {(item.processingOrders ?? 0).toLocaleString('vi-VN')}⏳
                                  </span>
                                </>
                              )}
                              <span className="text-muted-foreground"> / </span>
                              <span className={cn(item.refundedOrders > 0 ? 'text-red-500' : 'text-muted-foreground')}>
                                {item.refundedOrders.toLocaleString('vi-VN')}
                              </span>
                            </td>
                            <td className="px-3.5 py-2.5 text-right font-medium tabular-nums">
                              <div>{formatMoney(item.revenue)}</div>
                              {revShare > 0 && <div className="text-[10.5px] text-muted-foreground">{revShare}% tổng thu</div>}
                            </td>
                            <td className="px-3.5 py-2.5 text-right tabular-nums text-muted-foreground">
                              {item.flatRental && item.cost === 0 && item.revenue > 0 ? (
                                <span className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px]">Thuê luồng cố định</span>
                              ) : (
                                formatMoney(item.cost)
                              )}
                            </td>
                            <td className={cn('px-3.5 py-2.5 text-right font-semibold tabular-nums', item.profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                              {item.profit > 0 ? `+${formatMoney(item.profit)}` : formatMoney(item.profit)}
                            </td>
                            <td className="px-3.5 py-2.5 text-right tabular-nums">
                              <span
                                className={cn(
                                  'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold',
                                  item.revenue === 0
                                    ? 'bg-muted text-muted-foreground'
                                    : item.profit >= 0
                                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                      : 'bg-red-500/10 text-red-700 dark:text-red-300',
                                )}
                              >
                                {item.revenue > 0 ? `${item.marginPct}%` : '—'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t bg-muted/40 font-semibold">
                        <td className="px-3.5 py-2.5">Tổng cộng ({items.length} nguồn)</td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums">{summary.totalOrders.toLocaleString('vi-VN')}</td>
                        <td className="px-3.5 py-2.5 text-right text-xs tabular-nums">
                          <span className="text-emerald-600 dark:text-emerald-400">{summary.completedOrders.toLocaleString('vi-VN')}</span>
                          <span className="text-muted-foreground"> / </span>
                          <span>{summary.refundedOrders.toLocaleString('vi-VN')}</span>
                        </td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums">{formatMoney(summary.revenue)}</td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums text-muted-foreground">{formatMoney(summary.cost)}</td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                          {summary.profit > 0 ? `+${formatMoney(summary.profit)}` : formatMoney(summary.profit)}
                        </td>
                        <td className="px-3.5 py-2.5 text-right tabular-nums">{summary.revenue > 0 ? `${summary.marginPct}%` : '—'}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * Tổng quan kinh doanh AI Studio trên /admin/dashboard: việc cần xử lý, KPI theo kỳ, biểu đồ theo ngày,
 * cơ cấu nguồn nạp / gói nạp tiền, thống kê tác vụ theo nhà cung cấp & công cụ, top khách, hoạt động gần đây.
 * Nạp động (recharts) từ trang dashboard.
 */
export default function AiOverviewSection({ extraTodos }: { extraTodos?: React.ReactNode }) {
  const [days, setDays] = useState('30');
  const [metric, setMetric] = useState<MetricKey>('deposits');
  const { data: d, isLoading } = useQuery({
    queryKey: ['dashboard-ai', days],
    queryFn: () => api.get<AiOverview>('/admin/dashboard/ai', { days }),
    // tự động cập nhật real-time mỗi 15 giây để số liệu doanh thu, nạp tiền & tác vụ luôn sát thực tế (T-375)
    refetchInterval: 15_000,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const period = PERIOD_LABEL[days];

  if (isLoading || !d) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    );
  }

  const { money, credits, tasks, users, affiliate } = d;
  // chỉ cho chọn chỉ số mà người xem có quyền
  const metrics = METRICS.filter((m) => d[m.section] !== null);
  const cur = metrics.find((m) => m.key === metric) ?? metrics[0];
  const metricTotal = cur ? d.chart.reduce((s, r) => s + r[cur.key], 0) : 0;
  const taskStatusData = tasks ? ['SUCCEEDED', 'FAILED', 'PROCESSING', 'PENDING', 'CANCELLED'].map((s) => ({ name: TASK_STATUS[s].label, value: tasks.counts[s] ?? 0 })) : [];

  return (
    <div className="space-y-6">
      {/* Việc cần xử lý: tác vụ treo/lỗi, rút hoa hồng, thẻ cào, giao dịch cần hoàn tiền */}
      {(tasks || affiliate || money || extraTodos) && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Cần xử lý</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tasks && (
              <TodoTile
                count={tasks.running}
                label="Tác vụ AI đang chạy"
                hint={tasks.stuck > 0 ? <span className="font-medium text-red-600 dark:text-red-400">{tasks.stuck} tác vụ chạy quá 30 phút</span> : 'Không có tác vụ bị treo'}
                href={tasks.stuck > 0 ? '/ai/tasks?status=STUCK' : '/ai/tasks?status=PROCESSING'}
                icon={Loader2}
                tone={tasks.stuck > 0 ? 'red' : 'indigo'}
                action="Theo dõi"
              />
            )}
            {tasks && <TodoTile count={tasks.failed24h} label="Tác vụ lỗi trong 24 giờ" hint="Đã tự hoàn tiền vào ví khách" href="/ai/tasks?status=FAILED" icon={XCircle} tone="red" action="Xem lỗi" />}
            {affiliate && (
              <TodoTile
                count={affiliate.pendingPayouts}
                label="Yêu cầu rút hoa hồng chờ duyệt"
                hint={affiliate.pendingPayouts > 0 ? `Tổng ${formatMoney(affiliate.pendingPayoutAmount)}` : undefined}
                href="/ai/affiliate?tab=payouts"
                icon={HandCoins}
                tone="amber"
                action="Duyệt"
              />
            )}
            {money && (
              <TodoTile
                count={money.pendingCards + money.needsRefund}
                label="Thẻ cào chờ / giao dịch cần hoàn"
                hint={`${money.pendingCards} thẻ cào chờ · ${money.needsRefund} cần hoàn tiền`}
                href={money.needsRefund > 0 ? '/orders/payments' : '/orders/card-topups'}
                icon={CreditCard}
                tone="violet"
                action="Kiểm tra"
              />
            )}
            {/* việc của bán hàng / blog (đơn chờ, đánh giá, bình luận...) do trang dashboard truyền vào */}
            {extraTodos}
          </div>
        </section>
      )}

      {/* KPI theo kỳ */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Kinh doanh {period}</h2>
          <ToggleGroup type="single" size="sm" value={days} onValueChange={(v) => v && setDays(v)} variant="outline" aria-label="Khoảng thời gian">
            <ToggleGroupItem value="1">Hôm nay</ToggleGroupItem>
            <ToggleGroupItem value="7">7 ngày</ToggleGroupItem>
            <ToggleGroupItem value="30">30 ngày</ToggleGroupItem>
            <ToggleGroupItem value="90">90 ngày</ToggleGroupItem>
          </ToggleGroup>
        </div>
        {/* điện thoại: 2 cột cho gọn (12 ô) */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {money && (
            <Kpi
              title="Tiền khách nạp"
              value={formatMoney(money.deposits)}
              icon={Wallet}
              tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              footer={
                <>
                  <Trend value={money.depositsChange} /> so với kỳ trước · {money.depositsCount} lượt
                </>
              }
              href="/orders/payments"
            />
          )}
          {credits && (
            <Kpi
              title="Doanh thu gói nạp tiền"
              value={formatMoney(credits.sales)}
              icon={Coins}
              tone="bg-amber-500/10 text-amber-600 dark:text-amber-400"
              footer={
                <>
                  <Trend value={credits.salesChange} /> so với kỳ trước · {credits.salesCount} gói
                </>
              }
              href="/ai/plans?tab=purchases"
            />
          )}
          {tasks && (
            <Kpi
              title="Tác vụ AI"
              value={tasks.total.toLocaleString('vi-VN')}
              icon={Sparkles}
              tone="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
              footer={
                <>
                  <Trend value={tasks.change} /> · thành công {tasks.successRate === null ? '—' : `${tasks.successRate}%`}
                </>
              }
              href="/ai/tasks"
            />
          )}
          {credits && (
            <Kpi
              title="Tiền chạy AI"
              value={fmtCredits(credits.creditsUsed)}
              icon={Bot}
              tone="bg-sky-500/10 text-sky-600 dark:text-sky-400"
              footer={
                <>
                  <Trend value={credits.creditsUsedChange} /> · đã cộng ví {fmtCredits(credits.creditsIssued)}
                </>
              }
              href="/ai/plans?tab=transactions"
            />
          )}
          {users && (
            <Kpi
              title="Khách hàng mới"
              value={users.new.toLocaleString('vi-VN')}
              icon={UserPlus}
              footer={
                <>
                  <Trend value={users.newChange} /> · tổng {users.total.toLocaleString('vi-VN')} khách
                </>
              }
              href="/users"
            />
          )}
          {users && <Kpi title="Khách hoạt động 7 ngày" value={users.active7d.toLocaleString('vi-VN')} icon={Users} footer={`${users.locked} tài khoản bị khoá / chưa kích hoạt`} href="/users" />}
          {money && <Kpi title="Số dư ví của khách" value={formatMoney(money.walletBalance)} icon={PiggyBank} footer={`Tổng đã nạp từ trước tới nay ${formatMoney(money.depositsAllTime)}`} />}
          {credits && <Kpi title="Tổng số dư ví khách" value={fmtCredits(credits.creditBalance)} icon={Coins} footer={`${credits.activePlanUsers} khách có gói còn hạn`} />}
          {affiliate && (
            <Kpi title="Hoa hồng giới thiệu" value={formatMoney(affiliate.commission)} icon={Gift} footer={`${affiliate.referred} khách mới qua giới thiệu · ví hoa hồng ${formatMoney(affiliate.balance)}`} href="/ai/affiliate" />
          )}
          {credits && <Kpi title="Tổng doanh thu gói nạp" value={formatMoney(credits.salesAllTime)} icon={CheckCircle2} footer={`Hôm nay ${formatMoney(credits.salesToday)}`} />}
          {money && <Kpi title="Nạp hôm nay" value={formatMoney(money.depositsToday)} icon={Hourglass} footer="Tính theo giờ Việt Nam" />}
          {tasks && <Kpi title="Tác vụ hôm nay" value={tasks.today.toLocaleString('vi-VN')} icon={Sparkles} footer={`${users?.today ?? 0} khách đăng ký hôm nay`} />}
        </div>
      </section>

      {/* Thẻ Thành viên chuyển từ Báo cáo sang Bảng điều khiển */}
      <MembersSummaryCard days={days} fallbackUsers={users} />

      {/* Doanh thu, lợi nhuận & tổng đơn hàng theo website nguồn (chỉ hiển thị trên Web chính cho Siêu quản trị) */}
      {!d.hideProviders && <SourceWebsitesStatsSection />}

      {/* Biểu đồ theo ngày + cơ cấu nguồn nạp */}
      {cur && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base">{cur.label} theo ngày</CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Tổng {period}: <span className="font-medium text-foreground">{cur.money ? formatMoney(metricTotal) : metricTotal.toLocaleString('vi-VN')}</span>
                </p>
              </div>
              <ToggleGroup type="single" size="sm" value={cur.key} onValueChange={(v) => v && setMetric(v as MetricKey)} variant="outline" aria-label="Chỉ số" className="flex-wrap">
                {metrics.map((m) => (
                  <ToggleGroupItem key={m.key} value={m.key}>
                    {m.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </CardHeader>
            <CardContent className="h-72">
              <VizRoot className="h-full">
                <TimeSeriesChart data={d.chart} xKey="date" yKey={cur.key} name={cur.label} money={cur.money} kind={cur.kind} color={SERIES_COLORS[METRICS.findIndex((m) => m.key === cur.key)]} interval="day" height={288} />
              </VizRoot>
            </CardContent>
          </Card>
          {money ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Nguồn tiền vào ví</CardTitle>
                <p className="text-xs text-muted-foreground">Tiền thật = cổng thanh toán + thẻ cào; admin cộng tay / rút hoa hồng không tính vào tiền nạp</p>
              </CardHeader>
              <CardContent>
                <VizRoot>
                  <DonutChart data={money.bySource} money centerLabel={period} stacked />
                </VizRoot>
              </CardContent>
            </Card>
          ) : (
            tasks && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Trạng thái tác vụ</CardTitle>
                </CardHeader>
                <CardContent>
                  <VizRoot>
                    <DonutChart data={taskStatusData} centerLabel="tác vụ" stacked />
                  </VizRoot>
                </CardContent>
              </Card>
            )
          )}
        </div>
      )}

      {/* Tác vụ: theo nhà cung cấp, top công cụ, công cụ tạo trên 30 phút */}
      <div className="grid gap-4 xl:grid-cols-3">
        {tasks && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{d.hideProviders ? 'Trạng thái tác vụ AI' : 'Tác vụ theo nhà cung cấp'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {['SUCCEEDED', 'FAILED', 'PROCESSING', 'PENDING', 'CANCELLED'].map((s) => (
                  <Link key={s} href={`/ai/tasks?status=${s}`} className="inline-flex items-center gap-1.5">
                    <ToneBadge map={TASK_STATUS} value={s} />
                    <span className="text-xs tabular-nums text-muted-foreground">{tasks.counts[s] ?? 0}</span>
                  </Link>
                ))}
              </div>
              {d.hideProviders ? (
                <VizRoot>
                  <DonutChart data={taskStatusData} centerLabel="tác vụ" emptyText={`Chưa có tác vụ trong ${period}`} stacked />
                </VizRoot>
              ) : (
                <>
                  {tasks.byProvider.length === 0 && <Empty text={`Chưa có tác vụ trong ${period}`} />}
                  {tasks.byProvider.map((p) => (
                    <div key={p.key} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {p.total} tác vụ · <span className="text-emerald-600 dark:text-emerald-400">{p.ok} ✓</span> · <span className="text-red-600 dark:text-red-400">{p.failed} ✗</span> · {fmtCredits(p.credits)}
                        </span>
                      </div>
                      <SuccessBar ok={p.ok} failed={p.failed} total={p.total} />
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {tasks && (
          <ListCard title="Công cụ dùng nhiều nhất" href={d.hideProviders ? undefined : '/ai/tools'}>
            {tasks.topTools.length === 0 && <Empty text={`Chưa có tác vụ trong ${period}`} />}
            {tasks.topTools.map((t, i) => (
              <div key={t.key} className="space-y-1.5 rounded-lg px-2 py-2">
                <div className="flex items-center gap-3">
                  <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.providerName ? `${t.providerName} · ${fmtCredits(t.credits)}` : fmtCredits(t.credits)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold tabular-nums">{t.total}</div>
                    <div className="text-[11px] text-muted-foreground">{t.ok + t.failed ? `${Math.round((t.ok / (t.ok + t.failed)) * 100)}% thành công` : 'đang chạy'}</div>
                  </div>
                </div>
                <div className="pl-7">
                  <SuccessBar ok={t.ok} failed={t.failed} total={t.total} />
                </div>
              </div>
            ))}
          </ListCard>
        )}

        {tasks && (
          <ListCard
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>Công cụ tạo trên 30 phút</span>
                {(tasks.slow30m ?? 0) > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium tabular-nums text-amber-700 dark:text-amber-400">
                    {(tasks.slow30m ?? 0).toLocaleString('vi-VN')} đơn
                  </span>
                )}
              </span>
            }
            href="/ai/tasks"
          >
            {(tasks.slowTools ?? []).length === 0 && <Empty text={`Không có công cụ nào tạo quá 30 phút trong ${period}`} />}
            {(tasks.slowTools ?? []).map((t, i) => (
              <Link
                key={t.key}
                href={`/ai/tasks?search=${encodeURIComponent(t.name)}`}
                className="block space-y-1.5 rounded-lg px-2 py-2 transition hover:bg-muted/60"
              >
                <div className="flex items-center gap-3">
                  <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t.providerName ? `${t.providerName} · ` : ''}TB {t.avgMinutes}p · tối đa {t.maxMinutes}p
                      {t.slowOk > 0 && <span className="text-emerald-600 dark:text-emerald-400"> · {t.slowOk} ✓</span>}
                      {t.slowFailed > 0 && <span className="text-red-600 dark:text-red-400"> · {t.slowFailed} ✗</span>}
                      {t.slowRunning > 0 && <span className="text-amber-600 dark:text-amber-400"> · {t.slowRunning} đang chạy</span>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold tabular-nums text-amber-600 dark:text-amber-400">{t.slow} đơn</div>
                    <div className="text-[11px] tabular-nums text-muted-foreground">
                      {Math.round((t.slow / Math.max(1, t.total)) * 100)}% / {t.total} đơn
                    </div>
                  </div>
                </div>
                <div className="pl-7">
                  <SuccessBar ok={t.slowOk} failed={t.slowFailed} total={t.slow} />
                </div>
              </Link>
            ))}
          </ListCard>
        )}
      </div>

      {/* Top khách */}
      {(money || tasks) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {money && (
            <ListCard title={`Khách nạp nhiều nhất · ${period}`}>
              {money.topDepositors.length === 0 && <Empty text="Chưa có lượt nạp tiền" />}
              {money.topDepositors.map((u) => (
                <UserLine key={u.id} user={u} right={<><div className="font-semibold tabular-nums">{formatMoney(u.total)}</div><div className="text-[11px] text-muted-foreground">{u.count} lượt</div></>} />
              ))}
            </ListCard>
          )}
          {tasks && (
            <ListCard title={`Khách dùng AI nhiều nhất · ${period}`}>
              {tasks.topUsers.length === 0 && <Empty text="Chưa có tác vụ" />}
              {tasks.topUsers.map((u) => (
                <UserLine key={u.id} user={u} right={<><div className="font-semibold tabular-nums">{fmtCredits(u.credits)}</div><div className="text-[11px] text-muted-foreground">{u.tasks} tác vụ</div></>} />
              ))}
            </ListCard>
          )}
        </div>
      )}

      {/* Hoạt động gần đây */}
      <div className="grid gap-4 lg:grid-cols-2">
        {money && (
          <ListCard title="Nạp tiền gần đây" href="/orders/payments">
            {money.recent.length === 0 && <Empty text="Chưa có lượt nạp tiền" />}
            {money.recent.map((r) => (
              <UserLine
                key={r.id}
                user={r.user}
                sub={`${DEPOSIT_SOURCE[r.source] ?? r.source} · ${timeAgo(r.createdAt)}`}
                right={<span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">+{formatMoney(r.amount)}</span>}
              />
            ))}
          </ListCard>
        )}
        {credits && (
          <ListCard title="Mua gói gần đây" href="/ai/plans?tab=purchases">
            {credits.recent.length === 0 && <Empty text="Chưa có lượt mua gói" />}
            {credits.recent.map((r) => (
              <UserLine
                key={r.id}
                user={r.user}
                sub={`#${r.code} · ${r.planName}${r.cycle === 'year' ? ' (gói năm)' : r.cycle === 'month' ? ' (gói tháng)' : ''} · ${timeAgo(r.createdAt)}`}
                right={<><div className="font-semibold tabular-nums">{formatMoney(r.paid)}</div><div className="text-[11px] text-muted-foreground">+{fmtCredits(r.credits)} vào ví</div></>}
              />
            ))}
          </ListCard>
        )}
        {tasks && (
          <ListCard title="Tác vụ AI gần đây" href="/ai/tasks">
            {tasks.recent.length === 0 && <Empty text="Chưa có tác vụ" />}
            {tasks.recent.map((t) => (
              <Link key={t.id} href={`/ai/tasks?search=${t.code}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    <span className="font-mono">{t.code}</span> · {t.tool.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground" title={t.error ?? undefined}>
                    {t.user.name || t.user.email} · {timeAgo(t.createdAt)}
                    {t.error && <span className="text-red-600 dark:text-red-400"> · {t.error}</span>}
                  </div>
                </div>
                <ToneBadge map={TASK_STATUS} value={t.status} />
                <span className={cn('w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground', t.refunded && 'line-through')} title={t.refunded ? 'Đã hoàn tiền vào ví khách' : undefined}>
                  {fmtCredits(t.credits)}
                </span>
              </Link>
            ))}
          </ListCard>
        )}
        {users && (
          <ListCard title="Khách đăng ký mới" href="/users">
            {users.recent.length === 0 && <Empty text="Chưa có khách hàng" />}
            {users.recent.map((u) => (
              <UserLine
                key={u.id}
                user={u}
                sub={`${timeAgo(u.createdAt)}${u.referredBy ? ` · giới thiệu bởi ${u.referredBy.name}` : ''}`}
                right={<div className="tabular-nums">{formatMoney(u.walletBalance)}</div>}
              />
            ))}
          </ListCard>
        )}
      </div>

      {tasks && tasks.stuck > 0 && (
        <p className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <TriangleAlert className="size-3.5" />{' '}
          {d.hideProviders
            ? `Có ${tasks.stuck} tác vụ chạy quá 30 phút — hệ thống sẽ tự động rà soát và hoàn tiền vào ví khách nếu quá hạn.`
            : `Có ${tasks.stuck} tác vụ chạy quá 30 phút — kiểm tra khoá API / số dư tài khoản nhà cung cấp.`}
        </p>
      )}
    </div>
  );
}
