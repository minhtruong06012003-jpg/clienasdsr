'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  CalendarDays,
  Check,
  Coins,
  ExternalLink,
  Eye,
  Globe,
  Layers,
  Loader2,
  Pencil,
  Percent,
  RefreshCw,
  Scissors,
  Search,
  Trash2,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

interface ChildSiteProfitItem {
  siteCode: string;
  domain: string;
  siteName: string;
  publicOrigin: string;
  online: boolean;
  ramMb?: number | null;
  error: string | null;
  owner: { id: string; name: string; email: string } | null;
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
    parentRetained: number;
    allTimeDeposits: number;
    allTimeDepositCount: number;
    allTimeGrossProfit: number;
    allTimeDeduct: number;
    allTimeProfit: number;
    allTimeParentRetained: number;
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

interface VpsSystemStats {
  mem: { total: number; used: number; available: number; pct: number };
  swap: { total: number; used: number; pct: number };
  disk: { size: number; used: number; avail: number; pct: number };
  cpus: number;
  room: number;
}

interface ChildProfitsResponse {
  preset: string;
  from: string;
  to: string;
  system?: VpsSystemStats | null;
  totals: {
    siteCount: number;
    onlineCount: number;
    activeDepositSites: number;
    depositTotal: number;
    depositCount: number;
    grossProfitAmount: number;
    bonusDeductionAmount: number;
    discountDeductionAmount: number;
    deductAmount: number;
    childProfitTotal: number;
    parentRetainedTotal: number;
    allTimeDeposits: number;
    allTimeDepositCount: number;
    allTimeChildProfit: number;
    allTimeParentRetained: number;
  };
  sites: ChildSiteProfitItem[];
}

const PRESETS = [
  { key: 'this_month', label: 'Tháng này' },
  { key: 'last_month', label: 'Tháng trước' },
  { key: 'today', label: 'Hôm nay' },
  { key: '7d', label: '7 ngày' },
  { key: '30d', label: '30 ngày' },
  { key: 'all', label: 'Toàn thời gian' },
] as const;

type SortBy = 'deposit_desc' | 'profit_desc' | 'rate_desc' | 'domain_asc';

function fmtSignedPct(n: number) {
  if (n > 0) return `+${n}%`;
  if (n < 0) return `${n}%`;
  return '0%';
}

export default function ChildProfitPage() {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<string>('this_month');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortBy>('deposit_desc');
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);

  const [editingSiteCode, setEditingSiteCode] = useState<string | null>(null);
  const [detailSiteCode, setDetailSiteCode] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState<boolean>(false);

  // State form chỉnh sửa % đơn lẻ hoặc hàng loạt
  const [editAction, setEditAction] = useState<'update' | 'milestone'>('update');
  const [baseDraft, setBaseDraft] = useState('10');
  const [markupDraft, setMarkupDraft] = useState('0');
  const [effectiveMode, setEffectiveMode] = useState<'now' | 'custom'>('now');
  const [effectiveCustom, setEffectiveCustom] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  const queryParams =
    preset === 'custom' && (customFrom || customTo)
      ? { preset: 'custom', from: customFrom || customTo, to: customTo || customFrom }
      : { preset };

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin-child-profits', queryParams.preset, queryParams.from ?? '', queryParams.to ?? ''],
    queryFn: () => api.get<ChildProfitsResponse>('/admin/dashboard/child-profits', queryParams),
    refetchInterval: 60_000,
  });

  const editingSite = useMemo(
    () => data?.sites.find((s) => s.siteCode === editingSiteCode) ?? null,
    [data?.sites, editingSiteCode],
  );

  const detailSite = useMemo(
    () => data?.sites.find((s) => s.siteCode === detailSiteCode) ?? null,
    [data?.sites, detailSiteCode],
  );

  const filteredSites = useMemo(() => {
    const list = [...(data?.sites ?? [])];
    const kw = search.trim().toLowerCase();
    const matched = kw
      ? list.filter(
          (s) =>
            s.domain.toLowerCase().includes(kw) ||
            s.siteName.toLowerCase().includes(kw) ||
            s.siteCode.toLowerCase().includes(kw) ||
            (s.owner?.email ?? '').toLowerCase().includes(kw) ||
            (s.owner?.name ?? '').toLowerCase().includes(kw),
        )
      : list;

    matched.sort((a, b) => {
      if (sortBy === 'deposit_desc') return b.summary.depositTotal - a.summary.depositTotal || b.summary.allTimeDeposits - a.summary.allTimeDeposits || a.domain.localeCompare(b.domain);
      if (sortBy === 'profit_desc') return b.summary.profitAmount - a.summary.profitAmount || b.summary.allTimeProfit - a.summary.allTimeProfit || a.domain.localeCompare(b.domain);
      if (sortBy === 'rate_desc') return b.currentRate.totalPercent - a.currentRate.totalPercent || a.domain.localeCompare(b.domain);
      return a.domain.localeCompare(b.domain);
    });
    return matched;
  }, [data?.sites, search, sortBy]);

  const openEditForSite = (site: ChildSiteProfitItem) => {
    setBaseDraft(String(site.currentRate.basePercent ?? 10));
    setMarkupDraft(String(site.currentRate.markupExtra ?? 0));
    setEditAction('update');
    setEffectiveMode('now');
    const localIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setEffectiveCustom(localIso);
    setNoteDraft('');
    setEditingSiteCode(site.siteCode);
  };

  const openBulkDialog = () => {
    setBaseDraft('10');
    setMarkupDraft('0');
    setEditAction('update');
    setEffectiveMode('now');
    const localIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setEffectiveCustom(localIso);
    setNoteDraft('');
    setBulkOpen(true);
  };

  const saveSingleMut = useMutation({
    mutationFn: async () => {
      if (!editingSite) return;
      const basePercent = Number(baseDraft);
      const markupExtra = Number(markupDraft);
      if (editAction === 'milestone') {
        const effectiveAt =
          effectiveMode === 'custom' && effectiveCustom ? new Date(effectiveCustom).toISOString() : undefined;
        return api.post(`/admin/dashboard/child-profits/${encodeURIComponent(editingSite.siteCode)}/milestones`, {
          basePercent,
          markupExtra,
          effectiveAt,
          note: noteDraft.trim() || undefined,
        });
      }
      return api.put(`/admin/dashboard/child-profits/${encodeURIComponent(editingSite.siteCode)}/rate`, {
        basePercent,
        markupExtra,
        note: noteDraft.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success(
        editAction === 'milestone'
          ? `Đã tạo cột cắt % lợi nhuận mới cho ${editingSite?.domain}`
          : `Đã cập nhật % lợi nhuận cho ${editingSite?.domain}`,
      );
      void qc.invalidateQueries({ queryKey: ['admin-child-profits'] });
      setEditingSiteCode(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const deleteMilestoneMut = useMutation({
    mutationFn: ({ siteCode, id }: { siteCode: string; id: string }) =>
      api.delete(`/admin/dashboard/child-profits/${encodeURIComponent(siteCode)}/milestones/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success('Đã xoá mốc điều chỉnh %');
      void qc.invalidateQueries({ queryKey: ['admin-child-profits'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const saveBulkMut = useMutation({
    mutationFn: () => {
      const basePercent = Number(baseDraft);
      const markupExtra = Number(markupDraft);
      const effectiveAt =
        editAction === 'milestone' && effectiveMode === 'custom' && effectiveCustom
          ? new Date(effectiveCustom).toISOString()
          : undefined;
      return api.post<{ updatedCount: number; failed: { siteCode: string; error: string }[] }>(
        '/admin/dashboard/child-profits/bulk-rate',
        {
          siteCodes: selectedCodes.length ? selectedCodes : undefined,
          mode: editAction,
          basePercent,
          markupExtra,
          effectiveAt,
          note: noteDraft.trim() || undefined,
        },
      );
    },
    onSuccess: (res) => {
      if (res.failed?.length) {
        toast.warning(`Đã cập nhật ${res.updatedCount} web con, lỗi ${res.failed.length} web con`);
      } else {
        toast.success(`Đã đồng bộ % lợi nhuận cho ${res.updatedCount} web con!`);
      }
      setBulkOpen(false);
      setSelectedCodes([]);
      void qc.invalidateQueries({ queryKey: ['admin-child-profits'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const toggleCode = (code: string) => {
    setSelectedCodes((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]));
  };

  const allFilteredCodes = filteredSites.map((s) => s.siteCode);
  const allSelected = allFilteredCodes.length > 0 && allFilteredCodes.every((c) => selectedCodes.includes(c));

  const displayFrom = preset === 'custom' ? customFrom : (data?.from ?? customFrom);
  const displayTo = preset === 'custom' ? customTo : (data?.to ?? customTo);
  const previewTotalPct = Math.max(0, Math.round(((Number(baseDraft) || 0) + (Number(markupDraft) || 0)) * 100) / 100);
  const retainedPct =
    data && data.totals.depositTotal > 0
      ? Math.round((data.totals.parentRetainedTotal / data.totals.depositTotal) * 1000) / 10
      : 0;

  return (
    <>
      <PageHeader
        title="Lợi nhuận Website con"
        description="Thống kê tập trung tổng tiền khách nạp, lợi nhuận chia CTV / chủ web con, doanh thu giữ lại về nov.ai.vn và điều chỉnh trực tiếp % lợi nhuận / cột cắt cho từng website con."
        breadcrumbs={[{ label: 'Tài chính & Đối tác' }, { label: 'Lợi nhuận' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} /> Làm mới
            </Button>
            <Button size="sm" onClick={openBulkDialog}>
              <Layers className="size-4" />
              {selectedCodes.length > 0
                ? `Chỉnh % hàng loạt (${selectedCodes.length} web)`
                : 'Đồng bộ % toàn bộ web con'}
            </Button>
          </div>
        }
      />

      <PageBody className="space-y-4">
        {/* 4 thẻ thống kê RAM / Swap / Ổ đĩa / Sức chứa VPS (hài hoà đồng bộ hệ thống — T-482, T-489) */}
        {data?.system && (
          <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="flex flex-col justify-between rounded-xl border bg-card px-4 py-3.5">
              <div>
                <div className="text-xs font-medium text-muted-foreground">RAM</div>
                <div className="mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums">{data.system.mem.pct}%</div>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      data.system.mem.pct >= 90
                        ? 'bg-rose-500'
                        : data.system.mem.pct >= 75
                          ? 'bg-amber-500'
                          : 'bg-primary/85',
                    )}
                    style={{ width: `${data.system.mem.pct}%` }}
                  />
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground tabular-nums">
                {data.system.mem.used.toLocaleString('vi-VN')} / {data.system.mem.total.toLocaleString('vi-VN')} MB · còn{' '}
                {data.system.mem.available.toLocaleString('vi-VN')} MB
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-xl border bg-card px-4 py-3.5">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Swap</div>
                <div className="mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums">{data.system.swap.pct}%</div>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      data.system.swap.pct >= 90
                        ? 'bg-rose-500'
                        : data.system.swap.pct >= 75
                          ? 'bg-amber-500'
                          : 'bg-primary/85',
                    )}
                    style={{ width: `${data.system.swap.pct}%` }}
                  />
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground tabular-nums">
                {data.system.swap.used.toLocaleString('vi-VN')} / {data.system.swap.total.toLocaleString('vi-VN')} MB
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-xl border bg-card px-4 py-3.5">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Ổ đĩa /</div>
                <div className="mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums">{data.system.disk.pct}%</div>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      data.system.disk.pct >= 90
                        ? 'bg-rose-500'
                        : data.system.disk.pct >= 75
                          ? 'bg-amber-500'
                          : 'bg-primary/85',
                    )}
                    style={{ width: `${data.system.disk.pct}%` }}
                  />
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground tabular-nums">
                {data.system.disk.used.toLocaleString('vi-VN')} / {data.system.disk.size.toLocaleString('vi-VN')} GB · còn{' '}
                {data.system.disk.avail.toLocaleString('vi-VN')} GB
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-xl border bg-card px-4 py-3.5">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Còn chạy thêm được</div>
                <div
                  className={cn(
                    'mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums',
                    data.system.room <= 0 && 'text-rose-600 dark:text-rose-400',
                  )}
                >
                  ~{data.system.room} web con
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {data.system.cpus} nhân CPU · ước 500 MB RAM mỗi web con
              </div>
            </div>
          </div>
        )}

        {/* Thanh lọc kỳ xem + tìm kiếm + sắp xếp */}
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
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
                  <ToggleGroupItem key={p.key} value={p.key} className="text-xs font-medium">
                    {p.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </div>

            <div className="flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs">
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
                className="bg-transparent text-xs outline-none"
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
                className="bg-transparent text-xs outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2.5 border-t pt-3">
            <div className="relative min-w-[240px] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm theo tên miền, tên site, mã site, email CTV..."
                className="h-9 pl-9 text-sm"
              />
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Sắp xếp:</span>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                <SelectTrigger className="h-9 w-52 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deposit_desc">Tiền nạp cao → thấp</SelectItem>
                  <SelectItem value="profit_desc">Lợi nhuận CTV cao → thấp</SelectItem>
                  <SelectItem value="rate_desc">Tỷ lệ % chia cao → thấp</SelectItem>
                  <SelectItem value="domain_asc">Tên miền A → Z</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {isLoading || !data ? (
          <div className="space-y-4">
            <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
              <Skeleton className="h-28 rounded-xl" />
              <Skeleton className="h-28 rounded-xl" />
              <Skeleton className="h-28 rounded-xl" />
              <Skeleton className="h-28 rounded-xl" />
            </div>
            <Skeleton className="h-80 rounded-xl" />
          </div>
        ) : (
          <>
            {/* 4 Thẻ KPI Tổng hợp toàn hệ thống web con */}
            <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
              <Card className="gap-1.5 py-4 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between px-4 pb-0">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Tổng nạp toàn bộ Web con</CardTitle>
                  <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Wallet className="size-4" />
                  </div>
                </CardHeader>
                <CardContent className="px-4">
                  <div className="text-xl font-semibold tracking-tight text-foreground tabular-nums">
                    {formatMoney(data.totals.depositTotal)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{data.totals.depositCount.toLocaleString('vi-VN')}</span> lượt nạp
                    {' · '}Tích luỹ: <span className="font-medium text-foreground">{formatMoney(data.totals.allTimeDeposits)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-1.5 py-4 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between px-4 pb-0">
                  <CardTitle className="text-xs font-medium text-muted-foreground">
                    Tổng lợi nhuận chia CTV
                  </CardTitle>
                  <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <Coins className="size-4" />
                  </div>
                </CardHeader>
                <CardContent className="px-4">
                  <div className="text-xl font-semibold tracking-tight text-emerald-600 tabular-nums dark:text-emerald-400">
                    {formatMoney(data.totals.childProfitTotal)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {data.totals.deductAmount > 0 ? (
                      <>
                        Gốc {formatMoney(data.totals.grossProfitAmount)} − Khấu trừ {formatMoney(data.totals.deductAmount)}
                        {' · '}
                      </>
                    ) : null}
                    Tích luỹ: <span className="font-medium text-foreground">{formatMoney(data.totals.allTimeChildProfit)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-1.5 py-4 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between px-4 pb-0">
                  <CardTitle className="text-xs font-medium text-muted-foreground">
                    Doanh thu giữ lại nov.ai.vn
                  </CardTitle>
                  <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <TrendingUp className="size-4" />
                  </div>
                </CardHeader>
                <CardContent className="px-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xl font-semibold tracking-tight text-foreground tabular-nums">
                      {formatMoney(data.totals.parentRetainedTotal)}
                    </span>
                    {data.totals.depositTotal > 0 && (
                      <Badge variant="secondary" className="text-[11px] font-normal">
                        {retainedPct}%
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Tích luỹ giữ lại: <span className="font-medium text-foreground">{formatMoney(data.totals.allTimeParentRetained)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-1.5 py-4 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between px-4 pb-0">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Quy mô Hệ thống Web con</CardTitle>
                  <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Building2 className="size-4" />
                  </div>
                </CardHeader>
                <CardContent className="px-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xl font-semibold tracking-tight text-foreground tabular-nums">
                      {data.totals.onlineCount}/{data.totals.siteCount}
                    </span>
                    <span className="text-xs text-muted-foreground">web đang online</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{data.totals.activeDepositSites}</span> web con phát sinh khách nạp trong kỳ
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Bảng thống kê & chỉnh sửa lợi nhuận từng Website con */}
            <Card className="overflow-hidden py-0 shadow-none">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1140px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/35 text-left text-xs font-medium text-muted-foreground">
                      <th className="w-10 px-3 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() =>
                            setSelectedCodes(allSelected ? [] : allFilteredCodes)
                          }
                          aria-label="Chọn tất cả"
                          className="size-4 rounded border accent-primary"
                        />
                      </th>
                      <th className="min-w-[220px] px-3.5 py-2.5 font-medium">Website con / Đối tác</th>
                      <th className="min-w-[160px] px-3.5 py-2.5 font-medium">Tỷ lệ % áp dụng</th>
                      <th className="min-w-[90px] px-3.5 py-2.5 text-right font-medium">Lượt nạp</th>
                      <th className="min-w-[145px] px-3.5 py-2.5 text-right font-medium">Tổng tiền khách nạp</th>
                      <th className="min-w-[120px] px-3.5 py-2.5 text-right font-medium">Khấu trừ KM/GG</th>
                      <th className="min-w-[150px] px-3.5 py-2.5 text-right font-medium">Lợi nhuận chia CTV</th>
                      <th className="min-w-[145px] px-3.5 py-2.5 text-right font-medium">Giữ lại nov.ai.vn</th>
                      <th className="min-w-[180px] px-3.5 py-2.5 text-right font-medium">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredSites.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                          Không tìm thấy website con nào khớp bộ lọc.
                        </td>
                      </tr>
                    ) : (
                      filteredSites.map((s) => {
                        const checked = selectedCodes.includes(s.siteCode);
                        return (
                          <tr
                            key={s.siteCode}
                            className={cn(
                              'transition-colors hover:bg-muted/25',
                              checked && 'bg-muted/40',
                            )}
                          >
                            <td className="px-3 py-3 text-center">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleCode(s.siteCode)}
                                aria-label={`Chọn ${s.domain}`}
                                className="size-4 rounded border accent-primary"
                              />
                            </td>
                            <td className="px-3.5 py-3">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    'inline-block size-2 shrink-0 rounded-full',
                                    s.online ? 'bg-emerald-500' : 'bg-rose-500',
                                  )}
                                  title={s.online ? 'Đang hoạt động' : s.error || 'Mất kết nối'}
                                />
                                <a
                                  href={s.publicOrigin}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary hover:underline"
                                >
                                  {s.domain}
                                  <ExternalLink className="size-3 text-muted-foreground" />
                                </a>
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                <span>{s.siteName}</span>
                                <span>·</span>
                                <span>{s.siteCode}</span>
                                {typeof s.ramMb === 'number' && s.ramMb > 0 && (
                                  <>
                                    <span>·</span>
                                    <span className="tabular-nums" title="RAM đang tiêu thụ của 3 tiến trình web con">
                                      {s.ramMb} MB
                                    </span>
                                  </>
                                )}
                                {s.owner && (
                                  <>
                                    <span>·</span>
                                    <span className="max-w-[180px] truncate" title={`${s.owner.name} (${s.owner.email})`}>
                                      {s.owner.name || s.owner.email}
                                    </span>
                                  </>
                                )}
                              </div>
                            </td>
                            <td className="px-3.5 py-3">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Badge variant="secondary" className="font-medium tabular-nums">
                                  {s.currentRate.totalPercent}%
                                </Badge>
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  ({s.currentRate.basePercent}% {fmtSignedPct(s.currentRate.markupExtra)})
                                </span>
                              </div>
                              {s.summary.cutCount > 0 && (
                                <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                  <Scissors className="size-3" /> {s.summary.cutCount} mốc cắt giai đoạn
                                </div>
                              )}
                            </td>
                            <td className="px-3.5 py-3 text-right tabular-nums">
                              <div className="font-medium text-foreground">{s.summary.depositCount.toLocaleString('vi-VN')}</div>
                              <div className="text-xs text-muted-foreground">
                                Tổng: {s.summary.allTimeDepositCount.toLocaleString('vi-VN')}
                              </div>
                            </td>
                            <td className="px-3.5 py-3 text-right tabular-nums">
                              <div className="font-medium text-foreground">{formatMoney(s.summary.depositTotal)}</div>
                              <div className="text-xs text-muted-foreground">
                                Tích luỹ: {formatMoney(s.summary.allTimeDeposits)}
                              </div>
                            </td>
                            <td className="px-3.5 py-3 text-right tabular-nums text-muted-foreground">
                              {s.summary.deductAmount > 0 ? (
                                <span className="text-foreground/80">
                                  −{formatMoney(s.summary.deductAmount)}
                                </span>
                              ) : (
                                '0đ'
                              )}
                            </td>
                            <td className="px-3.5 py-3 text-right tabular-nums">
                              <div className="font-semibold text-emerald-600 dark:text-emerald-400">
                                {formatMoney(s.summary.profitAmount)}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Tích luỹ: {formatMoney(s.summary.allTimeProfit)}
                              </div>
                            </td>
                            <td className="px-3.5 py-3 text-right tabular-nums">
                              <div className="font-medium text-foreground">
                                {formatMoney(s.summary.parentRetained)}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Tích luỹ: {formatMoney(s.summary.allTimeParentRetained)}
                              </div>
                            </td>
                            <td className="px-3.5 py-3 text-right">
                              <div className="inline-flex items-center justify-end gap-1.5">
                                <Button
                                  variant="outline"
                                  size="xs"
                                  onClick={() => openEditForSite(s)}
                                  disabled={!s.online}
                                  title="Điều chỉnh % lợi nhuận hoặc tạo mốc cắt giai đoạn"
                                >
                                  <Pencil className="size-3.5" /> Chỉnh %
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => setDetailSiteCode(s.siteCode)}
                                  disabled={!s.online}
                                  title="Xem chi tiết các giai đoạn cột cắt & giao dịch nạp"
                                >
                                  <Eye className="size-3.5" /> Chi tiết
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  {filteredSites.length > 0 && (
                    <tfoot>
                      <tr className="border-t bg-muted/35 text-sm font-medium">
                        <td className="px-3 py-3" />
                        <td className="px-3.5 py-3 text-foreground">
                          Tổng cộng ({filteredSites.length} website con)
                        </td>
                        <td className="px-3.5 py-3 text-xs text-muted-foreground">—</td>
                        <td className="px-3.5 py-3 text-right tabular-nums">
                          {filteredSites.reduce((s, x) => s + x.summary.depositCount, 0).toLocaleString('vi-VN')}
                        </td>
                        <td className="px-3.5 py-3 text-right font-semibold tabular-nums">
                          {formatMoney(filteredSites.reduce((s, x) => s + x.summary.depositTotal, 0))}
                        </td>
                        <td className="px-3.5 py-3 text-right tabular-nums text-muted-foreground">
                          {filteredSites.reduce((s, x) => s + x.summary.deductAmount, 0) > 0
                            ? `−${formatMoney(filteredSites.reduce((s, x) => s + x.summary.deductAmount, 0))}`
                            : '0đ'}
                        </td>
                        <td className="px-3.5 py-3 text-right font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatMoney(filteredSites.reduce((s, x) => s + x.summary.profitAmount, 0))}
                        </td>
                        <td className="px-3.5 py-3 text-right font-semibold tabular-nums text-foreground">
                          {formatMoney(filteredSites.reduce((s, x) => s + x.summary.parentRetained, 0))}
                        </td>
                        <td className="px-3.5 py-3" />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </Card>
          </>
        )}
      </PageBody>

      {/* Dialog chỉnh % lợi nhuận / Tạo cột cắt cho 1 Website con */}
      <Dialog open={!!editingSite} onOpenChange={(o) => !o && setEditingSiteCode(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Percent className="size-4 text-emerald-600" />
              Chỉnh sửa lợi nhuận · {editingSite?.domain}
            </DialogTitle>
            <DialogDescription>
              Cập nhật trực tiếp tỷ lệ % hiện tại hoặc tạo mốc cắt giai đoạn mới (tự động tách riêng doanh thu trước và sau thời điểm đổi %).
            </DialogDescription>
          </DialogHeader>

          {editingSite && (
            <div className="space-y-4">
              {/* Chọn kiểu cập nhật */}
              <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-1">
                <button
                  type="button"
                  onClick={() => setEditAction('update')}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition',
                    editAction === 'update'
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Pencil className="size-3.5" /> Sửa thẳng % hiện tại
                </button>
                <button
                  type="button"
                  onClick={() => setEditAction('milestone')}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition',
                    editAction === 'milestone'
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Scissors className="size-3.5" /> Tạo cột cắt % mới
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>% Lợi nhuận gốc mặc định</Label>
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    max="100"
                    value={baseDraft}
                    onChange={(e) => setBaseDraft(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">Mặc định 10% trên tiền nạp của khách</p>
                </div>
                <div className="space-y-1.5">
                  <Label>% Cộng/trừ chênh giá bán web con</Label>
                  <Input
                    type="number"
                    step="0.5"
                    min="-100"
                    max="500"
                    value={markupDraft}
                    onChange={(e) => setMarkupDraft(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">Vd web con tăng giá bán +10% → nhập 10</p>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] px-3.5 py-2.5">
                <span className="text-xs font-medium text-muted-foreground">Tổng % lợi nhuận áp dụng:</span>
                <span className="text-lg font-bold text-emerald-600 tabular-nums dark:text-emerald-400">
                  {previewTotalPct}%
                </span>
              </div>

              {editAction === 'milestone' && (
                <div className="space-y-2 rounded-xl border p-3">
                  <Label className="text-xs font-semibold">Thời điểm bắt đầu tách cột cắt mới</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant={effectiveMode === 'now' ? 'default' : 'outline'}
                      onClick={() => setEffectiveMode('now')}
                    >
                      Từ ngay bây giờ
                    </Button>
                    <Button
                      type="button"
                      size="xs"
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
              )}

              <div className="space-y-1.5">
                <Label>Ghi chú (tuỳ chọn)</Label>
                <Input
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Vd: Nâng chiết khấu đối tác VIP tháng 11..."
                />
              </div>

              {/* Danh sách các mốc điều chỉnh % đang có trên web con này */}
              {editingSite.milestones.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <div className="text-xs font-semibold text-muted-foreground">
                    Lịch sử các mốc % trên {editingSite.domain} ({editingSite.milestones.length} mốc)
                  </div>
                  <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
                    {editingSite.milestones.map((m, idx) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 font-semibold">
                            <span className="text-emerald-600 dark:text-emerald-400">{m.totalPercent}%</span>
                            <span className="font-normal text-muted-foreground">
                              ({m.basePercent}% {fmtSignedPct(m.markupExtra)})
                            </span>
                            {idx === editingSite.milestones.length - 1 && (
                              <Badge variant="secondary" className="text-[10px]">
                                Đang áp dụng
                              </Badge>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            Từ: {new Date(m.effectiveAt).getTime() <= 86_400_000 ? 'Mốc khởi tạo gốc' : formatDate(m.effectiveAt)}
                            {m.note ? ` · ${m.note}` : ''}
                          </div>
                        </div>
                        {editingSite.milestones.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="text-destructive hover:bg-destructive/10"
                            disabled={deleteMilestoneMut.isPending}
                            onClick={() =>
                              deleteMilestoneMut.mutate({ siteCode: editingSite.siteCode, id: m.id })
                            }
                            title="Xoá mốc cắt này"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSiteCode(null)}>
              Huỷ
            </Button>
            <Button onClick={() => saveSingleMut.mutate()} disabled={saveSingleMut.isPending}>
              {saveSingleMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {editAction === 'milestone' ? 'Tạo cột cắt % mới' : 'Lưu cập nhật %'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog đồng bộ % hàng loạt */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="size-4 text-primary" />
              {selectedCodes.length > 0
                ? `Đồng bộ % cho ${selectedCodes.length} web con đã chọn`
                : `Đồng bộ % cho toàn bộ ${data?.sites.length ?? 0} web con`}
            </DialogTitle>
            <DialogDescription>
              Áp dụng thống nhất mức % lợi nhuận hoặc tạo mốc cắt đồng loạt từ trung tâm quản trị nov.ai.vn.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-1">
              <button
                type="button"
                onClick={() => setEditAction('update')}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition',
                  editAction === 'update'
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Pencil className="size-3.5" /> Sửa thẳng % hiện tại
              </button>
              <button
                type="button"
                onClick={() => setEditAction('milestone')}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition',
                  editAction === 'milestone'
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Scissors className="size-3.5" /> Tạo cột cắt % mới
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>% Lợi nhuận gốc mặc định</Label>
                <Input type="number" step="0.5" min="0" max="100" value={baseDraft} onChange={(e) => setBaseDraft(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>% Cộng/trừ chênh giá bán</Label>
                <Input type="number" step="0.5" min="-100" max="500" value={markupDraft} onChange={(e) => setMarkupDraft(e.target.value)} />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] px-3.5 py-2.5">
              <span className="text-xs font-medium text-muted-foreground">Tổng % lợi nhuận sau đồng bộ:</span>
              <span className="text-lg font-bold text-emerald-600 tabular-nums dark:text-emerald-400">{previewTotalPct}%</span>
            </div>

            {editAction === 'milestone' && (
              <div className="space-y-2 rounded-xl border p-3">
                <Label className="text-xs font-semibold">Thời điểm áp dụng cột cắt</Label>
                <div className="flex gap-2">
                  <Button type="button" size="xs" variant={effectiveMode === 'now' ? 'default' : 'outline'} onClick={() => setEffectiveMode('now')}>
                    Từ ngay bây giờ
                  </Button>
                  <Button type="button" size="xs" variant={effectiveMode === 'custom' ? 'default' : 'outline'} onClick={() => setEffectiveMode('custom')}>
                    Chọn ngày giờ
                  </Button>
                </div>
                {effectiveMode === 'custom' && (
                  <Input type="datetime-local" value={effectiveCustom} onChange={(e) => setEffectiveCustom(e.target.value)} className="mt-2" />
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Ghi chú (tuỳ chọn)</Label>
              <Input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Ghi chú đợt điều chỉnh..." />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              Huỷ
            </Button>
            <Button onClick={() => saveBulkMut.mutate()} disabled={saveBulkMut.isPending}>
              {saveBulkMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Áp dụng ngay
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog xem chi tiết giai đoạn cột cắt & giao dịch khách nạp của 1 Website con */}
      <Dialog open={!!detailSite} onOpenChange={(o) => !o && setDetailSiteCode(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <Globe className="size-4 text-primary" />
              Chi tiết Lợi nhuận · {detailSite?.domain}
              {detailSite && (
                <Badge variant="secondary" className="font-medium">
                  Đang áp dụng {detailSite.currentRate.totalPercent}%
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Đối soát chi tiết từng giai đoạn (cột cắt %) và danh sách các giao dịch khách nạp trên {detailSite?.siteName}.
            </DialogDescription>
          </DialogHeader>

          {detailSite && (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border bg-card p-3.5">
                  <div className="text-xs text-muted-foreground">Tổng khách nạp trong kỳ</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">{formatMoney(detailSite.summary.depositTotal)}</div>
                  <div className="text-xs text-muted-foreground">{detailSite.summary.depositCount} lượt nạp</div>
                </div>
                <div className="rounded-xl border bg-card p-3.5">
                  <div className="text-xs text-muted-foreground">Lợi nhuận CTV nhận</div>
                  <div className="mt-1 text-lg font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
                    {formatMoney(detailSite.summary.profitAmount)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Tích luỹ: {formatMoney(detailSite.summary.allTimeProfit)}
                  </div>
                </div>
                <div className="rounded-xl border bg-card p-3.5">
                  <div className="text-xs text-muted-foreground">Giữ lại về nov.ai.vn</div>
                  <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">
                    {formatMoney(detailSite.summary.parentRetained)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Tích luỹ: {formatMoney(detailSite.summary.allTimeParentRetained)}
                  </div>
                </div>
              </div>

              {/* Các giai đoạn cột cắt */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Các giai đoạn / Cột cắt trong kỳ ({detailSite.segments.length})
                  </h4>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      const target = detailSite;
                      setDetailSiteCode(null);
                      openEditForSite(target);
                    }}
                  >
                    <Scissors className="size-3.5" /> Chỉnh % / Tạo cột cắt
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-xl border">
                  <table className="w-full min-w-[680px] text-xs">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left font-semibold text-muted-foreground">
                        <th className="px-3 py-2">Giai đoạn</th>
                        <th className="px-3 py-2">Mức %</th>
                        <th className="px-3 py-2 text-right">Lượt nạp</th>
                        <th className="px-3 py-2 text-right">Tiền nạp</th>
                        <th className="px-3 py-2 text-right">Khấu trừ</th>
                        <th className="px-3 py-2 text-right">Lợi nhuận CTV</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {detailSite.segments.map((seg) => (
                        <tr key={`${seg.milestoneId}-${seg.index}`}>
                          <td className="px-3 py-2">
                            <div className="font-medium">
                              Giai đoạn #{seg.index} {seg.isCurrent ? '(Hiện tại)' : ''}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {formatDate(seg.fromAt)} → {formatDate(seg.toAt)}
                            </div>
                          </td>
                          <td className="px-3 py-2 font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                            {seg.totalPercent}% ({seg.basePercent}% {fmtSignedPct(seg.markupExtra)})
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{seg.depositCount}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(seg.depositTotal)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {seg.deductAmount > 0 ? `−${formatMoney(seg.deductAmount)}` : '0đ'}
                          </td>
                          <td className="px-3 py-2 text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                            {formatMoney(seg.profitAmount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Giao dịch nạp gần nhất */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Giao dịch khách nạp gần nhất ({detailSite.recentDeposits.length})
                </h4>
                {detailSite.recentDeposits.length === 0 ? (
                  <div className="rounded-xl border py-6 text-center text-xs text-muted-foreground">
                    Chưa có giao dịch nạp nào trong kỳ đã chọn.
                  </div>
                ) : (
                  <div className="max-h-64 overflow-auto rounded-xl border">
                    <table className="w-full min-w-[680px] text-xs">
                      <thead className="sticky top-0 bg-muted">
                        <tr className="border-b text-left font-semibold text-muted-foreground">
                          <th className="px-3 py-2">Thời gian</th>
                          <th className="px-3 py-2">Khách hàng</th>
                          <th className="px-3 py-2 text-right">Số tiền nạp</th>
                          <th className="px-3 py-2 text-right">% Thực nhận</th>
                          <th className="px-3 py-2 text-right">Lợi nhuận CTV</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {detailSite.recentDeposits.map((dep) => (
                          <tr key={dep.id}>
                            <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(dep.createdAt)}</td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{dep.user.name || dep.user.email}</div>
                              <div className="text-[11px] text-muted-foreground">{dep.user.email}</div>
                            </td>
                            <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatMoney(dep.amount)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {dep.percent}%
                              {(dep.bonusPercent > 0 || dep.discountPercent > 0) && (
                                <span className="ml-1 text-[10px] text-amber-600">
                                  (gốc {dep.grossPercent}%)
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                              {formatMoney(dep.profit)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
