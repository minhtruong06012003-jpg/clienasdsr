'use client';

import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  Coins,
  Loader2,
  Percent,
  Plus,
  ReceiptText,
  Scissors,
  Trash2,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ProfitSegment {
  index: number;
  milestoneId: string;
  milestoneEffectiveAt: string;
  fromAt: string;
  toAt: string;
  isCurrent: boolean;
  isCutPoint: boolean;
  prevTotalPercent: number | null;
  deltaPercent: number;
  basePercent: number;
  markupExtra: number;
  totalPercent: number;
  note: string | null;
  depositCount: number;
  depositTotal: number;
  grossProfitAmount: number;
  deductAmount: number;
  profitAmount: number;
}

interface ProfitMilestone {
  id: string;
  effectiveAt: string;
  basePercent: number;
  markupExtra: number;
  totalPercent: number;
  note?: string;
}

interface ProfitStatsResponse {
  preset: string;
  from: string;
  to: string;
  canManageRate: boolean;
  currentRate: {
    basePercent: number;
    markupExtra: number;
    totalPercent: number;
    effectiveAt: string;
  };
  summary: {
    depositTotal: number;
    depositCount: number;
    grossProfitAmount: number;
    bonusDeductionAmount: number;
    discountDeductionAmount: number;
    deductAmount: number;
    profitAmount: number;
    allTimeDeposits: number;
    allTimeDepositCount: number;
    allTimeGrossProfit: number;
    allTimeDeduct: number;
    allTimeProfit: number;
    cutCount: number;
  };
  segments: ProfitSegment[];
  milestones: ProfitMilestone[];
  daily: { date: string; deposits: number; profit: number; count: number; rates: number[] }[];
  recentDeposits: {
    id: string;
    amount: number;
    grossProfit: number;
    deductAmount: number;
    profit: number;
    grossPercent: number;
    bonusPercent: number;
    discountPercent: number;
    percent: number;
    markupExtra: number;
    segmentIndex: number;
    source: string;
    provider: string | null;
    createdAt: string;
    user: { id: string; name: string; email: string };
  }[];
}

const PRESETS = [
  { key: 'this_month', label: 'Tháng này' },
  { key: 'last_month', label: 'Tháng trước' },
  { key: 'today', label: 'Hôm nay' },
  { key: '7d', label: '7 ngày' },
  { key: '30d', label: '30 ngày' },
  { key: 'all', label: 'Toàn thời gian' },
] as const;

function fmtExtra(n: number) {
  if (n > 0) return `+${n}%`;
  if (n < 0) return `${n}%`;
  return '0%';
}

export default function ProfitPage() {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<string>('this_month');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const [baseDraft, setBaseDraft] = useState('10');
  const [markupDraft, setMarkupDraft] = useState('0');
  const [effectiveMode, setEffectiveMode] = useState<'now' | 'custom'>('now');
  const [effectiveCustom, setEffectiveCustom] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  const queryParams =
    preset === 'custom' && (customFrom || customTo)
      ? { preset: 'custom', from: customFrom || customTo, to: customTo || customFrom }
      : { preset };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin-profit', queryParams.preset, queryParams.from ?? '', queryParams.to ?? ''],
    queryFn: () => api.get<ProfitStatsResponse>('/admin/dashboard/profit', queryParams),
    refetchInterval: 60_000,
  });

  const openAdjustDialog = () => {
    setBaseDraft(String(data?.currentRate.basePercent ?? 10));
    setMarkupDraft(String(data?.currentRate.markupExtra ?? 0));
    setEffectiveMode('now');
    const localIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setEffectiveCustom(localIso);
    setNoteDraft('');
    setDialogOpen(true);
  };

  const addMilestoneMut = useMutation({
    mutationFn: (payload: { basePercent: number; markupExtra: number; effectiveAt?: string; note?: string }) =>
      api.post('/admin/dashboard/profit/milestones', payload),
    onSuccess: () => {
      toast.success('Đã tạo mốc điều chỉnh % lợi nhuận & cột cắt thống kê mới!');
      setDialogOpen(false);
      void qc.invalidateQueries({ queryKey: ['admin-profit'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const removeMilestoneMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/dashboard/profit/milestones/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success('Đã xoá mốc điều chỉnh %');
      void qc.invalidateQueries({ queryKey: ['admin-profit'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const displayFrom = preset === 'custom' ? customFrom : (data?.from ?? customFrom);
  const displayTo = preset === 'custom' ? customTo : (data?.to ?? customTo);
  const previewTotalPct = Math.max(0, Math.round(((Number(baseDraft) || 0) + (Number(markupDraft) || 0)) * 100) / 100);

  return (
    <>
      <PageHeader
        title="Lợi nhuận"
        description="Theo dõi tổng số tiền khách đã nạp và lợi nhuận thực nhận (mặc định 10% + % chênh giá bán − % khuyến mãi nạp − % giảm giá riêng của khách), tự động tách cột cắt khi đổi % giữa tháng."
        breadcrumbs={[{ label: 'Tổng quan' }, { label: 'Lợi nhuận' }]}
        actions={
          data?.canManageRate ? (
            <Button size="sm" onClick={openAdjustDialog}>
              <Scissors className="size-4" /> Điều chỉnh % / Tạo cột cắt
            </Button>
          ) : undefined
        }
      />

      <PageBody className="space-y-6">
        {/* Thanh lọc kỳ xem */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              size="sm"
              value={preset === 'custom' ? '' : preset}
              onValueChange={(v) => v && setPreset(v)}
              variant="outline"
              className="flex-wrap"
            >
              {PRESETS.map((p) => (
                <ToggleGroupItem key={p.key} value={p.key}>
                  {p.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </div>

          <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs">
            <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="date"
              value={displayFrom}
              onChange={(e) => {
                setCustomFrom(e.target.value);
                if (!customTo && data?.to) setCustomTo(data.to);
                setPreset('custom');
              }}
              aria-label="Từ ngày"
              className="bg-transparent text-xs font-medium outline-none"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="date"
              value={displayTo}
              onChange={(e) => {
                setCustomTo(e.target.value);
                if (!customFrom && data?.from) setCustomFrom(data.from);
                setPreset('custom');
              }}
              aria-label="Đến ngày"
              className="bg-transparent text-xs font-medium outline-none"
            />
          </div>
        </div>

        {isLoading || !data ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : (
          <>
            {/* 3 thẻ KPI cốt lõi */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="gap-2">
                <CardHeader className="flex flex-row items-start justify-between pb-0">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Tổng số tiền khách đã nạp</CardTitle>
                  <div className="flex size-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                    <Wallet className="size-4.5" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold tracking-tight tabular-nums sm:text-3xl">
                    {formatMoney(data.summary.depositTotal)}
                  </div>
                  <div className="mt-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{data.summary.depositCount.toLocaleString('vi-VN')}</span> lượt nạp trong kỳ
                    {' · '}Tích luỹ toàn thời gian: <span className="font-medium text-foreground">{formatMoney(data.summary.allTimeDeposits)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-2 border-emerald-500/30 bg-emerald-500/[0.04]">
                <CardHeader className="flex flex-row items-start justify-between pb-0">
                  <CardTitle className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    Số tiền sẽ nhận được (Lợi nhuận)
                  </CardTitle>
                  <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    <Coins className="size-4.5" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div
                    className={cn(
                      'text-2xl font-bold tracking-tight tabular-nums sm:text-3xl',
                      data.summary.profitAmount < 0
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-emerald-600 dark:text-emerald-400',
                    )}
                  >
                    {formatMoney(data.summary.profitAmount)}
                  </div>
                  {data.summary.deductAmount > 0 ? (
                    <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                      <div>
                        Gốc: <span className="font-medium text-foreground">{formatMoney(data.summary.grossProfitAmount)}</span>
                        {data.summary.bonusDeductionAmount > 0 && (
                          <span className="text-amber-700 dark:text-amber-400">
                            {' '}− KM nạp {formatMoney(data.summary.bonusDeductionAmount)}
                          </span>
                        )}
                        {data.summary.discountDeductionAmount > 0 && (
                          <span className="text-rose-600 dark:text-rose-400">
                            {' '}− Giảm giá khách {formatMoney(data.summary.discountDeductionAmount)}
                          </span>
                        )}
                      </div>
                      <div>
                        Tích luỹ toàn thời gian:{' '}
                        <span className="font-semibold text-emerald-700 dark:text-emerald-300">{formatMoney(data.summary.allTimeProfit)}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1.5 text-xs text-muted-foreground">
                      Đã cộng chuẩn theo từng mốc % giai đoạn
                      {' · '}Tích luỹ toàn thời gian:{' '}
                      <span className="font-semibold text-emerald-700 dark:text-emerald-300">{formatMoney(data.summary.allTimeProfit)}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="gap-2">
                <CardHeader className="flex flex-row items-start justify-between pb-0">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Tỷ lệ lợi nhuận đang áp dụng</CardTitle>
                  <div className="flex size-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    <Percent className="size-4.5" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold tracking-tight tabular-nums sm:text-3xl">
                      {data.currentRate.totalPercent}%
                    </span>
                    <Badge variant="secondary" className="text-xs font-medium">
                      {data.currentRate.basePercent}% mặc định{' '}
                      {data.currentRate.markupExtra >= 0 ? `+ ${data.currentRate.markupExtra}%` : `${data.currentRate.markupExtra}%`} giá web
                    </Badge>
                  </div>
                  <div className="mt-1.5 text-xs text-muted-foreground">
                    Tự động trừ % khuyến mãi nạp &amp; % giảm giá riêng của khách
                    {data.summary.cutCount > 0 ? ` · ${data.summary.cutCount} mốc cắt %` : ''}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Bảng Cột cắt thống kê theo khúc giao thoa tăng / giảm % */}
            <Card>
              <CardHeader className="border-b pb-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Scissors className="size-4 text-primary" />
                      <span>Bảng thống kê theo từng giai đoạn &amp; cột cắt giao thoa %</span>
                    </CardTitle>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Khi thay đổi % chênh lệch giá bán giữa tháng, hệ thống tự động chốt số liệu khúc cũ ở mức % cũ và mở khúc mới từ đúng thời điểm đổi để đối soát minh bạch.
                    </p>
                  </div>
                  <Badge variant="outline" className="tabular-nums">
                    Kỳ xem: {data.from === data.to ? data.from : `${data.from} → ${data.to}`}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="pt-4">
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left text-xs font-semibold text-muted-foreground">
                        <th className="px-3.5 py-2.5">Giai đoạn / Khúc thời gian</th>
                        <th className="px-3.5 py-2.5">Công thức % hưởng</th>
                        <th className="px-3.5 py-2.5 text-right">Tỷ lệ gốc</th>
                        <th className="px-3.5 py-2.5 text-right">Lượt nạp</th>
                        <th className="px-3.5 py-2.5 text-right">Tổng tiền khách nạp</th>
                        <th className="px-3.5 py-2.5 text-right">Trừ KM / Giảm giá</th>
                        <th className="px-3.5 py-2.5 text-right">Lợi nhuận thực nhận</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.segments.map((seg) => (
                        <Fragment key={`${seg.milestoneId}-${seg.index}`}>
                          {seg.isCutPoint && (
                            <tr className="bg-amber-500/[0.08] dark:bg-amber-500/[0.12]">
                              <td colSpan={7} className="px-3.5 py-2">
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                  <div className="flex flex-wrap items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-0.5">
                                      <Scissors className="size-3" /> CỘT CẮT GIAO THOA #{seg.index - 1}
                                    </span>
                                    <span>Thời điểm cắt: {formatDate(seg.fromAt, 'HH:mm:ss dd/MM/yyyy')}</span>
                                    <span className="inline-flex items-center gap-0.5 rounded-md border border-amber-500/30 bg-background/80 px-2 py-0.5 tabular-nums">
                                      {seg.prevTotalPercent}% → {seg.totalPercent}% (
                                      {seg.deltaPercent >= 0 ? (
                                        <span className="inline-flex items-center text-emerald-600 dark:text-emerald-400">
                                          <ArrowUpRight className="size-3" />+{seg.deltaPercent}%
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center text-rose-600 dark:text-rose-400">
                                          <ArrowDownRight className="size-3" />
                                          {seg.deltaPercent}%
                                        </span>
                                      )}
                                      )
                                    </span>
                                    {seg.note && <span className="font-normal text-muted-foreground">· {seg.note}</span>}
                                  </div>
                                  {data.canManageRate && data.milestones.length > 1 && seg.milestoneId !== 'initial' && (
                                    <button
                                      type="button"
                                      disabled={removeMilestoneMut.isPending}
                                      onClick={() => removeMilestoneMut.mutate(seg.milestoneId)}
                                      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-rose-600 transition hover:bg-rose-500/10"
                                      title="Xoá mốc cắt này"
                                    >
                                      <Trash2 className="size-3" /> Xoá mốc
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}

                          <tr className={cn('transition hover:bg-muted/30', seg.isCurrent && 'bg-emerald-500/[0.02]')}>
                            <td className="px-3.5 py-3">
                              <div className="flex items-center gap-2 font-medium">
                                <Badge variant={seg.isCurrent ? 'default' : 'secondary'} className="text-[11px]">
                                  Khúc {seg.index}
                                </Badge>
                                <span className="tabular-nums text-xs sm:text-sm">
                                  {formatDate(seg.fromAt, 'HH:mm dd/MM/yyyy')} →{' '}
                                  {seg.isCurrent ? 'Hiện tại' : formatDate(seg.toAt, 'HH:mm dd/MM/yyyy')}
                                </span>
                              </div>
                            </td>
                            <td className="px-3.5 py-3 text-xs text-muted-foreground">
                              Mặc định <b className="text-foreground">{seg.basePercent}%</b>
                              {' + '}Chênh giá{' '}
                              <b className={cn(seg.markupExtra > 0 ? 'text-emerald-600 dark:text-emerald-400' : seg.markupExtra < 0 ? 'text-rose-600' : 'text-foreground')}>
                                {fmtExtra(seg.markupExtra)}
                              </b>
                              {' − '}KM/Giảm khách
                            </td>
                            <td className="px-3.5 py-3 text-right">
                              <span className="inline-flex rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold tabular-nums text-primary">
                                {seg.totalPercent}%
                              </span>
                            </td>
                            <td className="px-3.5 py-3 text-right tabular-nums">{seg.depositCount.toLocaleString('vi-VN')}</td>
                            <td className="px-3.5 py-3 text-right font-medium tabular-nums">{formatMoney(seg.depositTotal)}</td>
                            <td className="px-3.5 py-3 text-right tabular-nums">
                              {seg.deductAmount > 0 ? (
                                <span className="font-medium text-amber-700 dark:text-amber-400">
                                  −{formatMoney(seg.deductAmount)}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">0đ</span>
                              )}
                            </td>
                            <td className="px-3.5 py-3 text-right tabular-nums">
                              <div
                                className={cn(
                                  'font-bold',
                                  seg.profitAmount < 0
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : 'text-emerald-600 dark:text-emerald-400',
                                )}
                              >
                                {formatMoney(seg.profitAmount)}
                              </div>
                              {seg.deductAmount > 0 && (
                                <div className="text-[11px] text-muted-foreground">Gốc {formatMoney(seg.grossProfitAmount)}</div>
                              )}
                            </td>
                          </tr>
                        </Fragment>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t bg-muted/40 font-semibold">
                        <td className="px-3.5 py-3" colSpan={3}>
                          Tổng cộng kỳ đang xem ({data.segments.length} giai đoạn)
                        </td>
                        <td className="px-3.5 py-3 text-right tabular-nums">{data.summary.depositCount.toLocaleString('vi-VN')}</td>
                        <td className="px-3.5 py-3 text-right tabular-nums">{formatMoney(data.summary.depositTotal)}</td>
                        <td className="px-3.5 py-3 text-right tabular-nums">
                          {data.summary.deductAmount > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400">−{formatMoney(data.summary.deductAmount)}</span>
                          ) : (
                            <span className="text-xs font-normal text-muted-foreground">0đ</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            'px-3.5 py-3 text-right font-bold tabular-nums',
                            data.summary.profitAmount < 0
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-emerald-600 dark:text-emerald-400',
                          )}
                        >
                          {formatMoney(data.summary.profitAmount)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Chi tiết các giao dịch khách nạp trong kỳ */}
            <Card>
              <CardHeader className="border-b pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ReceiptText className="size-4 text-muted-foreground" />
                  <span>Chi tiết giao dịch khách nạp trong kỳ</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                {data.recentDeposits.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">Chưa có giao dịch nạp tiền nào trong khoảng thời gian đã chọn.</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full min-w-[740px] text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left text-xs font-semibold text-muted-foreground">
                          <th className="px-3.5 py-2.5">Thời gian</th>
                          <th className="px-3.5 py-2.5">Khách hàng</th>
                          <th className="px-3.5 py-2.5">Khúc áp dụng</th>
                          <th className="px-3.5 py-2.5 text-right">Số tiền nạp</th>
                          <th className="px-3.5 py-2.5 text-right">Công thức %</th>
                          <th className="px-3.5 py-2.5 text-right">Lợi nhuận nhận</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {data.recentDeposits.map((tx) => {
                          const hasDeduct = tx.bonusPercent > 0 || tx.discountPercent > 0;
                          return (
                            <tr key={tx.id} className="transition hover:bg-muted/30">
                              <td className="whitespace-nowrap px-3.5 py-2.5 text-xs tabular-nums text-muted-foreground">
                                {formatDate(tx.createdAt, 'HH:mm:ss dd/MM/yyyy')}
                              </td>
                              <td className="px-3.5 py-2.5">
                                <div className="font-medium">{tx.user.name || tx.user.email}</div>
                                <div className="text-xs text-muted-foreground">{tx.user.email}</div>
                              </td>
                              <td className="px-3.5 py-2.5 text-xs">
                                <Badge variant="outline" className="text-[11px]">
                                  Khúc {tx.segmentIndex} ({fmtExtra(tx.markupExtra)} giá)
                                </Badge>
                              </td>
                              <td className="px-3.5 py-2.5 text-right font-medium tabular-nums">{formatMoney(tx.amount)}</td>
                              <td className="px-3.5 py-2.5 text-right tabular-nums">
                                {hasDeduct ? (
                                  <div className="inline-flex flex-wrap items-center justify-end gap-1 text-xs">
                                    <span className="text-muted-foreground">{tx.grossPercent}%</span>
                                    {tx.bonusPercent > 0 && (
                                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                        −{tx.bonusPercent}% KM nạp
                                      </span>
                                    )}
                                    {tx.discountPercent > 0 && (
                                      <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                                        −{tx.discountPercent}% giảm khách
                                      </span>
                                    )}
                                    <span className="rounded-md bg-muted px-2 py-0.5 font-semibold">= {tx.percent}%</span>
                                  </div>
                                ) : (
                                  <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold">{tx.percent}%</span>
                                )}
                              </td>
                              <td className="px-3.5 py-2.5 text-right tabular-nums">
                                <div
                                  className={cn(
                                    'font-semibold',
                                    tx.profit < 0
                                      ? 'text-rose-600 dark:text-rose-400'
                                      : tx.profit === 0
                                        ? 'text-muted-foreground'
                                        : 'text-emerald-600 dark:text-emerald-400',
                                  )}
                                >
                                  {tx.profit > 0 ? `+${formatMoney(tx.profit)}` : formatMoney(tx.profit)}
                                </div>
                                {hasDeduct && (
                                  <div className="text-[11px] text-muted-foreground">
                                    Gốc +{formatMoney(tx.grossProfit)} · Trừ {formatMoney(tx.deductAmount)}
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </PageBody>

      {/* Hộp thoại chỉ dành cho Siêu quản trị (`*`) tạo cột cắt giao thoa điều chỉnh % */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="size-4 text-primary" /> Điều chỉnh % &amp; Tạo cột cắt thống kê
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const effectiveAt =
                effectiveMode === 'custom' && effectiveCustom
                  ? new Date(effectiveCustom).toISOString()
                  : undefined;
              addMilestoneMut.mutate({
                basePercent: Number(baseDraft) || 0,
                markupExtra: Number(markupDraft) || 0,
                effectiveAt,
                note: noteDraft.trim() || undefined,
              });
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>% Mặc định gốc</Label>
                <Input
                  type="number"
                  step="0.5"
                  min={0}
                  max={100}
                  value={baseDraft}
                  onChange={(e) => setBaseDraft(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>% Tăng / giảm giá web con</Label>
                <Input
                  type="number"
                  step="0.5"
                  min={-100}
                  max={500}
                  value={markupDraft}
                  onChange={(e) => setMarkupDraft(e.target.value)}
                />
              </div>
            </div>

            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3.5 py-2.5 text-xs">
              Tổng tỷ lệ lợi nhuận nhận được từ mốc này:{' '}
              <b className="text-sm text-emerald-700 dark:text-emerald-300">{previewTotalPct}%</b>
              {' '}({Number(baseDraft) || 0}% mặc định + {fmtExtra(Number(markupDraft) || 0)} giá bán)
            </div>

            <div className="space-y-1.5">
              <Label>Thời điểm bắt đầu cắt thống kê</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveMode === 'now' ? 'default' : 'outline'}
                  onClick={() => setEffectiveMode('now')}
                >
                  Ngay bây giờ
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveMode === 'custom' ? 'default' : 'outline'}
                  onClick={() => setEffectiveMode('custom')}
                >
                  Chọn ngày giờ cụ thể
                </Button>
              </div>
              {effectiveMode === 'custom' && (
                <Input
                  type="datetime-local"
                  value={effectiveCustom}
                  onChange={(e) => setEffectiveCustom(e.target.value)}
                  className="mt-2"
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Ghi chú hiển thị trên cột cắt (tuỳ chọn)</Label>
              <Input
                value={noteDraft}
                maxLength={160}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="VD: Web con tăng giá bán thêm +10% từ giữa tháng"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Huỷ
              </Button>
              <Button type="submit" disabled={addMilestoneMut.isPending}>
                {addMilestoneMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Lưu mốc cắt mới
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
