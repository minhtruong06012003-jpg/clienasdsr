'use client';

/**
 * AI Studio › Nhà cung cấp API (/ai/providers — chỉ hiển thị trên Web chính cho Siêu quản trị):
 * - Thiết kế bảng hàng ngang hài hoà, đồng bộ hệ màu trung tính tinh gọn của Admin (T-402).
 * - Đầy đủ thông tin đối soát: Số dư VNĐ / Thời hạn gói đếm ngược trực tiếp (T-404), Thống kê đơn/doanh thu/lợi nhuận,
 *   Chế độ giá bán Tự động / Cố định cho mọi nguồn (T-405), và menu Thao tác tinh gọn (T-403).
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock,
  ExternalLink,
  Gift,
  KeyRound,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  StickyNote,
  Wrench,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field } from '@/components/common/field';
import { NumberInput } from '@/components/common/number-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { PermissionGate } from '@/components/ai/shared';
import { AI_PROVIDER_META, AhiepCosts, type AiProviderMetaItem } from '@/components/settings/ai-tabs';
import { SecretInput, SwitchRow } from '@/components/settings/inputs';
import { SettingsGroup } from '@/components/settings/settings-group';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface ProviderRow {
  key: string;
  name: string;
  website: string | null;
  defaultBadge?: string;
  enabled: boolean;
  configured: boolean;
  rate: number;
  defaultRate: number | null;
  costUnit: string | null;
  markup: number;
  autoName?: boolean;
  autoPrice?: boolean;
  supportsCost?: boolean;
  tools: number;
  note?: string;
  sourcePromo?: string;
  expiresAt?: string;
  manualCredits?: number | null;
}

interface ToolLiteRow {
  key: string;
  provider: string;
  enabled: boolean;
  maintenance?: boolean;
  models: number;
}

interface ProviderRunStat {
  runs: number;
  succeeded: number;
  refunded: number;
  revenue: number;
  cost: number;
  profit: number;
}

interface RunStatsResponse {
  totals: ProviderRunStat;
  byProvider?: Record<string, ProviderRunStat>;
}

type StatsPeriod = 'all' | 'today' | 'yesterday' | '7d' | '30d';

const BALANCE_REFRESH_MS = 60_000;

const fmtRate = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
const fmtVnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

function computeBalanceVnd(p: ProviderRow, balance?: number, unit?: string): { vnd: number; rate: number } | null {
  if (balance === undefined || balance === null || !Number.isFinite(balance)) return null;
  const u = (unit ?? '').trim();
  const effRate = p.rate > 0 ? p.rate : p.defaultRate && p.defaultRate > 0 ? p.defaultRate : 1;
  if (/0\s*credit/i.test(u)) return { vnd: 0, rate: effRate };
  if (/^(lượt|luồng)$/i.test(u)) return null;
  if (p.costUnit && !/\blượt\b/i.test(u)) return { vnd: Math.round(balance * effRate), rate: effRate };
  if (/^(đ|vnđ|vnd)$/i.test(u)) return { vnd: Math.round(balance), rate: 1 };
  return null;
}

function estimateProfit(p: ProviderRow, stat?: ProviderRunStat): number {
  if (!stat || stat.revenue <= 0) return 0;
  if (stat.cost > 0) return stat.revenue - stat.cost;
  const mk = Number(p.markup) || 0;
  if (mk > 0) return Math.round(stat.revenue - stat.revenue / (1 + mk / 100));
  return 0;
}

function svSortOrder(badge?: string): number {
  if (!badge) return 999;
  const m = badge.match(/(\d+)/);
  return m ? Number(m[1]) : 999;
}

/** Tách con số % khuyến mãi nguồn (vd "20", "+25%", "+25% nạp") để cộng vào cột Tổng % (T-424) */
function parsePromoPercent(raw?: string): number {
  if (!raw?.trim()) return 0;
  const m = raw.match(/([+-]?\d+(?:[.,]\d+)?)/);
  if (!m) return 0;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Chuẩn hoá hiển thị Khuyến mãi nguồn: nếu nhập số thuần "20" thì hiện "+20%" */
function formatPromoDisplay(raw?: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(s)) {
    const clean = s.replace(/^\+/, '');
    return clean.startsWith('-') ? `${clean}%` : `+${clean}%`;
  }
  return s;
}

/** Định dạng thời gian còn hạn gói thuê (T-404) */
function formatRemainingExpiry(expiresAt: string | undefined, nowMs: number): {
  text: string;
  dateLabel: string;
  tone: 'ok' | 'warn' | 'expired';
} | null {
  if (!expiresAt?.trim()) return null;
  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) return null;
  const d = new Date(expMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateLabel = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diffMs = expMs - nowMs;
  if (diffMs <= 0) {
    return { text: 'Đã hết hạn', dateLabel, tone: 'expired' };
  }
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const text =
    days > 0
      ? `Còn ${days} ngày ${hours} giờ`
      : hours > 0
        ? `Còn ${hours} giờ ${mins} phút`
        : `Còn ${Math.max(1, mins)} phút`;
  const tone = diffMs < 24 * 3_600_000 ? 'warn' : 'ok';
  return { text, dateLabel, tone };
}

const HOURS_24 = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

function splitIsoTo24h(iso?: string): { date: string; hour: string; minute: string } {
  const ms = iso ? Date.parse(iso) : NaN;
  const d = Number.isFinite(ms) ? new Date(ms) : new Date(Date.now() + 7 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
  };
}

function buildIsoFrom24h(date: string, hour: string, minute: string): string | null {
  if (!date) return null;
  const ms = Date.parse(`${date}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Bộ chọn ngày + giờ chuẩn khung 24h (00:00 – 23:59, không bao giờ hiện SA / CH — T-414) */
function DateTime24Fields({
  date,
  hour,
  minute,
  onChangeDate,
  onChangeHour,
  onChangeMinute,
}: {
  date: string;
  hour: string;
  minute: string;
  onChangeDate: (v: string) => void;
  onChangeHour: (v: string) => void;
  onChangeMinute: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input type="date" value={date} onChange={(e) => onChangeDate(e.target.value)} className="h-8 min-w-0 flex-1 px-2 text-xs tabular-nums" />
      <div className="inline-flex h-8 shrink-0 items-center rounded-md border bg-background px-1.5 text-xs font-medium tabular-nums">
        <select
          aria-label="Giờ (00-23)"
          value={hour}
          onChange={(e) => onChangeHour(e.target.value)}
          className="cursor-pointer bg-transparent px-0.5 py-0.5 text-center outline-none"
        >
          {HOURS_24.map((h) => (
            <option key={h} value={h} className="bg-popover text-popover-foreground">
              {h}
            </option>
          ))}
        </select>
        <span className="px-0.5 text-muted-foreground">:</span>
        <select
          aria-label="Phút (00-59)"
          value={minute}
          onChange={(e) => onChangeMinute(e.target.value)}
          className="cursor-pointer bg-transparent px-0.5 py-0.5 text-center outline-none"
        >
          {MINUTES_60.map((m) => (
            <option key={m} value={m} className="bg-popover text-popover-foreground">
              {m}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default function AiProvidersPage() {
  return (
    <Suspense>
      <AiProvidersContent />
    </Suspense>
  );
}

function AiProvidersContent() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const confirm = useConfirm();
  const { isChildSite } = useAuth();
  const isMobile = useIsMobile();

  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'on' | 'off' | 'nokey'>('all');
  const [sortBy, setSortBy] = useState<'sv' | 'revenue' | 'orders' | 'tools' | 'name'>('sv');
  const [period, setPeriod] = useState<StatsPeriod>('all');
  const [editingKey, setEditingKey] = useState<string | null>(() => sp.get('edit'));
  const [balanceMap, setBalanceMap] = useState<Record<string, number | null>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const reportBalance = useCallback((key: string, vnd: number | null) => {
    setBalanceMap((prev) => (prev[key] === vnd ? prev : { ...prev, [key]: vnd }));
  }, []);

  useEffect(() => {
    const qEdit = sp.get('edit');
    if (qEdit) setEditingKey(qEdit);
  }, [sp]);

  const closeEdit = () => {
    setEditingKey(null);
    if (sp.has('edit')) {
      const next = new URLSearchParams(sp.toString());
      next.delete('edit');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  };

  const q = useQuery({
    queryKey: ['ai-tools'],
    queryFn: () => api.get<{ hideProviders?: boolean; providers: ProviderRow[]; tools: ToolLiteRow[] }>('/admin/ai/tools'),
    enabled: !isChildSite,
  });

  const statsQuery = useQuery({
    queryKey: ['ai-provider-run-stats', period],
    queryFn: () => api.get<RunStatsResponse>('/admin/ai/tools/run-stats', { period }),
    enabled: !isChildSite,
    staleTime: 20_000,
  });

  useEffect(() => {
    if (isChildSite || q.data?.hideProviders) {
      router.replace('/ai/tools');
    }
  }, [isChildSite, q.data?.hideProviders, router]);

  const providers = q.data?.providers ?? [];
  const tools = q.data?.tools ?? [];
  const byProviderStats = statsQuery.data?.byProvider ?? {};

  const toolStatsByProvider = useMemo(() => {
    const map = new Map<string, { total: number; enabled: number; maintenance: number; keys: string[] }>();
    for (const t of tools) {
      if (t.models > 0) continue;
      const cur = map.get(t.provider) ?? { total: 0, enabled: 0, maintenance: 0, keys: [] };
      cur.total += 1;
      if (t.enabled) cur.enabled += 1;
      if (t.enabled && t.maintenance) cur.maintenance += 1;
      cur.keys.push(t.key);
      map.set(t.provider, cur);
    }
    return map;
  }, [tools]);

  const metaMap = useMemo(() => {
    const m = new Map<string, AiProviderMetaItem>();
    for (const item of AI_PROVIDER_META) m.set(item.key, item);
    return m;
  }, []);

  const summary = useMemo(() => {
    let activeProviders = 0;
    let enabledTools = 0;
    let totalTools = 0;
    let maintenanceTools = 0;
    let totalBalanceVnd = 0;
    let totalOrders = 0;
    let totalRevenue = 0;
    let totalProfit = 0;
    for (const p of providers) {
      if (p.enabled && p.configured) {
        activeProviders += 1;
        const bVnd = balanceMap[p.key];
        if (typeof bVnd === 'number' && Number.isFinite(bVnd) && bVnd > 0) {
          totalBalanceVnd += bVnd;
        }
      }
      const st = toolStatsByProvider.get(p.key);
      if (st) {
        totalTools += st.total;
        enabledTools += st.enabled;
        maintenanceTools += st.maintenance;
      }
      const ps = byProviderStats[p.key];
      if (ps) {
        totalOrders += ps.succeeded;
        totalRevenue += ps.revenue;
        totalProfit += estimateProfit(p, ps);
      }
    }
    return {
      totalProviders: providers.length,
      activeProviders,
      enabledTools,
      totalTools,
      maintenanceTools,
      totalBalanceVnd,
      totalOrders,
      totalRevenue,
      totalProfit,
    };
  }, [providers, toolStatsByProvider, balanceMap, byProviderStats]);

  const filteredProviders = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return [...providers]
      .filter((p) => {
        const ready = p.enabled && p.configured;
        if (statusFilter === 'on' && !ready) return false;
        if (statusFilter === 'off' && (ready || !p.configured)) return false;
        if (statusFilter === 'nokey' && p.configured) return false;
        if (!kw) return true;
        const meta = metaMap.get(p.key);
        const hay = [p.key, p.name, p.defaultBadge ?? '', p.website ?? '', p.note ?? '', meta?.name ?? '', meta?.hint ?? ''].join(' ').toLowerCase();
        return hay.includes(kw);
      })
      .sort((a, b) => {
        if (sortBy === 'revenue') {
          return (byProviderStats[b.key]?.revenue ?? 0) - (byProviderStats[a.key]?.revenue ?? 0) || svSortOrder(a.defaultBadge) - svSortOrder(b.defaultBadge);
        }
        if (sortBy === 'orders') {
          return (byProviderStats[b.key]?.succeeded ?? 0) - (byProviderStats[a.key]?.succeeded ?? 0) || svSortOrder(a.defaultBadge) - svSortOrder(b.defaultBadge);
        }
        if (sortBy === 'tools') return b.tools - a.tools || svSortOrder(a.defaultBadge) - svSortOrder(b.defaultBadge);
        if (sortBy === 'name') return a.name.localeCompare(b.name, 'vi');
        return svSortOrder(a.defaultBadge) - svSortOrder(b.defaultBadge) || a.name.localeCompare(b.name, 'vi');
      });
  }, [providers, search, statusFilter, sortBy, metaMap, byProviderStats]);

  const bulkMaintenance = useMutation({
    mutationFn: (r: { keys: string[]; maintenance: boolean }) => api.put<{ updated: number }>('/admin/ai/tools/maintenance', r),
    onSuccess: (res, r) => {
      toast.success(
        r.maintenance
          ? `Đã bật bảo trì cho ${res.updated} công cụ của nguồn này`
          : `Đã tắt bảo trì cho ${res.updated} công cụ của nguồn này`,
      );
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const handleRefreshAll = () => {
    void q.refetch();
    void statsQuery.refetch();
    void qc.invalidateQueries({ queryKey: ['ai-provider-balance'] });
    toast.success('Đang làm mới số dư & thống kê toàn bộ nguồn API…');
  };

  if (isChildSite || q.data?.hideProviders) return null;

  const editingProvider = editingKey ? providers.find((x) => x.key === editingKey) ?? null : null;

  const triggerToggleMaintenance = async (p: ProviderRow, stats: { enabled: number; maintenance: number; keys: string[] }) => {
    if (!stats.keys.length) return;
    const allMaint = stats.enabled > 0 && stats.maintenance >= stats.enabled;
    const targetMaint = !allMaint;
    const ok = await confirm({
      title: targetMaint
        ? `Bật bảo trì toàn bộ nguồn ${p.defaultBadge ? `${p.defaultBadge} · ` : ''}${p.name}?`
        : `Tắt bảo trì toàn bộ nguồn ${p.defaultBadge ? `${p.defaultBadge} · ` : ''}${p.name}?`,
      description: targetMaint
        ? `Tất cả ${stats.keys.length} công cụ thuộc nguồn này sẽ tạm gắn nhãn "Đang bảo trì" trên website để khách không bấm tạo đơn mới.`
        : `Mở tạo đơn bình thường trở lại cho ${stats.keys.length} công cụ thuộc nguồn này.`,
      confirmText: targetMaint ? 'Bật bảo trì' : 'Tắt bảo trì',
    });
    if (ok) bulkMaintenance.mutate({ keys: stats.keys, maintenance: targetMaint });
  };

  return (
    <>
      <PageHeader
        title="Nhà cung cấp API"
        description={`Quản lý tập trung toàn bộ nguồn API (SV1–SV${Math.max(17, providers.length)}): theo dõi số dư VNĐ, thời hạn gói thuê, thống kê đơn hàng & lợi nhuận.`}
        breadcrumbs={[{ label: 'AI Studio' }, { label: 'Nhà cung cấp API' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition',
                  viewMode === 'table' ? 'bg-background text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <List className="size-3.5" /> Hàng ngang
              </button>
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition',
                  viewMode === 'grid' ? 'bg-background text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutGrid className="size-3.5" /> Thẻ hộp
              </button>
            </div>
            <Button size="sm" variant="outline" onClick={() => router.push('/ai/tools')}>
              <Wrench /> Danh sách công cụ
            </Button>
            <Button size="sm" onClick={handleRefreshAll} disabled={q.isFetching || statsQuery.isFetching}>
              <RefreshCw className={q.isFetching || statsQuery.isFetching ? 'animate-spin' : ''} /> Làm mới
            </Button>
          </div>
        }
      />
      <PageBody>
        <PermissionGate permission="ai.providers">
          {/* Thanh thống kê tổng hợp hài hoà, đồng bộ kiểu dáng của Admin */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="py-0">
              <CardContent className="p-3.5">
                <div className="text-xs text-muted-foreground">Nguồn đang kết nối</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold tabular-nums text-foreground">{summary.activeProviders}</span>
                  <span className="text-xs text-muted-foreground">
                    / {summary.totalProviders} nguồn · {summary.enabledTools}/{summary.totalTools} công cụ
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card className="py-0">
              <CardContent className="p-3.5">
                <div className="text-xs text-muted-foreground">Tổng số dư khả dụng</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold tabular-nums text-foreground">{fmtVnd(summary.totalBalanceVnd)}</span>
                  <span className="text-xs text-muted-foreground">quy đổi thực tế</span>
                </div>
              </CardContent>
            </Card>
            <Card className="py-0">
              <CardContent className="p-3.5">
                <div className="text-xs text-muted-foreground">Tổng đơn hoàn tất</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold tabular-nums text-foreground">
                    {summary.totalOrders.toLocaleString('vi-VN')}
                  </span>
                  <span className="text-xs text-muted-foreground">đơn thành công</span>
                </div>
              </CardContent>
            </Card>
            <Card className="py-0">
              <CardContent className="p-3.5">
                <div className="text-xs text-muted-foreground">Doanh thu · Lợi nhuận</div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xl font-semibold tabular-nums text-foreground">{fmtVnd(summary.totalRevenue)}</span>
                  <span className="text-xs font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    +{fmtVnd(summary.totalProfit)}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Thanh tìm kiếm & lọc nhanh */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border bg-card p-3">
            <div className="flex min-w-[240px] flex-1 flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Tìm mã SV1..SV${Math.max(17, providers.length)}, tên nguồn, domain hoặc ghi chú...`}
                  className="h-9 pl-9 pr-8 text-sm"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Xoá tìm kiếm"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>

              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
                <SelectTrigger className="h-9 w-[160px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả trạng thái</SelectItem>
                  <SelectItem value="on">Đang bật</SelectItem>
                  <SelectItem value="off">Đang tắt (có khoá)</SelectItem>
                  <SelectItem value="nokey">Chưa có khoá API</SelectItem>
                </SelectContent>
              </Select>

              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="h-9 w-[170px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sv">Thứ tự SV1 → SV{Math.max(17, providers.length)}</SelectItem>
                  <SelectItem value="revenue">Doanh thu cao nhất</SelectItem>
                  <SelectItem value="orders">Đơn hàng nhiều nhất</SelectItem>
                  <SelectItem value="tools">Nhiều công cụ nhất</SelectItem>
                  <SelectItem value="name">Tên nguồn A → Z</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Kỳ thống kê:</span>
              <Select value={period} onValueChange={(v) => setPeriod(v as StatsPeriod)}>
                <SelectTrigger className="h-9 w-[135px] text-xs font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toàn thời gian</SelectItem>
                  <SelectItem value="today">Hôm nay</SelectItem>
                  <SelectItem value="yesterday">Hôm qua</SelectItem>
                  <SelectItem value="7d">7 ngày qua</SelectItem>
                  <SelectItem value="30d">30 ngày qua</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {q.isLoading ? (
            <div className="space-y-2.5">
              {Array.from({ length: 6 }).map((_, idx) => (
                <Skeleton key={idx} className="h-20 w-full rounded-xl" />
              ))}
            </div>
          ) : filteredProviders.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
                <Server className="size-8 opacity-40" />
                <p>Không tìm thấy nhà cung cấp nào khớp bộ lọc hiện tại.</p>
                {(search || statusFilter !== 'all') && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSearch('');
                      setStatusFilter('all');
                    }}
                  >
                    Xoá bộ lọc
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : viewMode === 'table' && !isMobile ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table className="min-w-[1480px]">
                <TableHeader>
                  <TableRow className="bg-muted/35 hover:bg-muted/35">
                    <TableHead className="min-w-[230px] pl-4 text-xs font-medium text-muted-foreground">Nguồn kết nối</TableHead>
                    <TableHead className="min-w-[82px] text-center text-xs font-medium text-muted-foreground">Mã</TableHead>
                    <TableHead className="min-w-[190px] text-right text-xs font-medium text-muted-foreground">Số dư / Thời hạn</TableHead>
                    <TableHead className="min-w-[235px] text-xs font-medium text-muted-foreground">Thống kê</TableHead>
                    <TableHead className="min-w-[155px] text-xs font-medium text-muted-foreground">Tỉ giá</TableHead>
                    <TableHead className="min-w-[145px] text-xs font-medium text-muted-foreground">Khuyến mãi nguồn</TableHead>
                    <TableHead className="min-w-[105px] text-center text-xs font-medium text-muted-foreground">Lãi tăng</TableHead>
                    <TableHead className="min-w-[95px] text-center text-xs font-medium text-muted-foreground">Tổng %</TableHead>
                    <TableHead className="min-w-[190px] text-xs font-medium text-muted-foreground">Đồng bộ</TableHead>
                    <TableHead className="min-w-[68px] text-center text-xs font-medium text-muted-foreground">Bật</TableHead>
                    <TableHead className="min-w-[115px] pr-4 text-right text-xs font-medium text-muted-foreground">Thao tác</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProviders.map((p) => {
                    const stats = toolStatsByProvider.get(p.key) ?? { total: p.tools, enabled: 0, maintenance: 0, keys: [] };
                    const runStat = byProviderStats[p.key];
                    return (
                      <ProviderTableRow
                        key={p.key}
                        provider={p}
                        meta={metaMap.get(p.key)}
                        stats={stats}
                        runStat={runStat}
                        nowMs={nowMs}
                        onReportBalance={reportBalance}
                        onEdit={() => setEditingKey(p.key)}
                        onOpenTools={() => router.push(`/ai/tools?provider=${encodeURIComponent(p.key)}`)}
                        onOpenTasks={() => router.push(`/ai/tasks?provider=${encodeURIComponent(p.key)}`)}
                        onToggleAllMaintenance={() => void triggerToggleMaintenance(p, stats)}
                        maintenancePending={bulkMaintenance.isPending}
                      />
                    );
                  })}
                </TableBody>
              </Table>
              <div className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
                Hiển thị <span className="font-medium text-foreground">{filteredProviders.length}</span> / {providers.length} nguồn API
              </div>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredProviders.map((p) => {
                const stats = toolStatsByProvider.get(p.key) ?? { total: p.tools, enabled: 0, maintenance: 0, keys: [] };
                const runStat = byProviderStats[p.key];
                return (
                  <ProviderManageCard
                    key={p.key}
                    provider={p}
                    meta={metaMap.get(p.key)}
                    stats={stats}
                    runStat={runStat}
                    nowMs={nowMs}
                    onReportBalance={reportBalance}
                    onEdit={() => setEditingKey(p.key)}
                    onOpenTools={() => router.push(`/ai/tools?provider=${encodeURIComponent(p.key)}`)}
                    onToggleAllMaintenance={() => void triggerToggleMaintenance(p, stats)}
                    maintenancePending={bulkMaintenance.isPending}
                  />
                );
              })}
            </div>
          )}

          {editingProvider && (
            <EditProviderDialog
              provider={editingProvider}
              meta={metaMap.get(editingProvider.key)}
              onClose={closeEdit}
              onSaved={() => {
                void qc.invalidateQueries({ queryKey: ['ai-tools'] });
                void qc.invalidateQueries({ queryKey: ['ai-provider-balance', editingProvider.key] });
              }}
            />
          )}
        </PermissionGate>
      </PageBody>
    </>
  );
}

function useProviderRowController(p: ProviderRow, onReportBalance: (key: string, vnd: number | null) => void) {
  const qc = useQueryClient();
  const ready = p.enabled && p.configured;

  const [editingRate, setEditingRate] = useState(false);
  const [draftRate, setDraftRate] = useState<number | null>(p.rate);
  useEffect(() => {
    if (!editingRate) setDraftRate(p.rate);
  }, [p.rate, editingRate]);

  const [editingMarkup, setEditingMarkup] = useState(false);
  const [draftMarkup, setDraftMarkup] = useState<number | null>(p.markup);
  useEffect(() => {
    if (!editingMarkup) setDraftMarkup(p.markup);
  }, [p.markup, editingMarkup]);

  const [editingNote, setEditingNote] = useState(false);
  const [draftNote, setDraftNote] = useState<string>(p.note ?? '');
  useEffect(() => {
    if (!editingNote) setDraftNote(p.note ?? '');
  }, [p.note, editingNote]);

  const [editingPromo, setEditingPromo] = useState(false);
  const [draftPromo, setDraftPromo] = useState<string>(p.sourcePromo ?? '');
  useEffect(() => {
    if (!editingPromo) setDraftPromo(p.sourcePromo ?? '');
  }, [p.sourcePromo, editingPromo]);

  const [editingCredits, setEditingCredits] = useState(false);
  const [draftCredits, setDraftCredits] = useState<number | null>(p.manualCredits ?? null);
  useEffect(() => {
    if (!editingCredits) setDraftCredits(p.manualCredits ?? null);
  }, [p.manualCredits, editingCredits]);

  const bal = useQuery({
    queryKey: ['ai-provider-balance', p.key],
    queryFn: () =>
      api.get<{ supported: boolean; ok?: boolean; balance?: number; unit?: string; manualLedger?: boolean; error?: string }>(
        `/admin/ai/providers/${p.key}/balance`,
      ),
    enabled: ready,
    refetchInterval: (query) => (query.state.data?.supported === false ? false : BALANCE_REFRESH_MS),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });

  const vndInfo = bal.data?.supported && bal.data?.ok ? computeBalanceVnd(p, bal.data.balance, bal.data.unit) : null;

  useEffect(() => {
    onReportBalance(p.key, ready && vndInfo ? vndInfo.vnd : null);
  }, [p.key, ready, vndInfo, onReportBalance]);

  const quickPatch = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.put(`/admin/settings/ai_${p.key}`, patch),
    onSuccess: (_data, patch) => {
      if ('enabled' in patch) {
        toast.success(patch.enabled ? `Đã bật nguồn ${p.name}` : `Đã tắt nguồn ${p.name}`);
      } else if ('rate' in patch) {
        toast.success(`Đã cập nhật tỉ giá nguồn ${p.name}`);
        setEditingRate(false);
      } else if ('manualCredits' in patch) {
        toast.success(`Đã cập nhật số dư credit nguồn ${p.name}`);
        setEditingCredits(false);
      } else if ('markup' in patch) {
        toast.success(`Đã đồng bộ +${patch.markup}% tăng giá cho nguồn ${p.name}`);
        setEditingMarkup(false);
      } else if ('note' in patch) {
        toast.success(`Đã lưu ghi chú nguồn ${p.name}`);
        setEditingNote(false);
      } else if ('sourcePromo' in patch) {
        toast.success(`Đã cập nhật khuyến mãi nguồn ${p.name}`);
        setEditingPromo(false);
      } else if ('expiresAt' in patch) {
        toast.success(patch.expiresAt ? `Đã cập nhật thời hạn gói nguồn ${p.name}` : `Đã xoá thời hạn gói nguồn ${p.name}`);
      } else if ('autoName' in patch) {
        toast.success(patch.autoName ? `Đã bật tự cập nhật tên công cụ (${p.name})` : `Đã tắt tự cập nhật tên công cụ (${p.name})`);
      } else if ('autoPrice' in patch) {
        toast.success(patch.autoPrice ? `Đã chuyển sang Giá bán tự động (${p.name})` : `Đã chuyển sang Giá bán cố định (${p.name})`);
      }
      void qc.invalidateQueries({ queryKey: ['settings', `ai_${p.key}`] });
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
      void qc.invalidateQueries({ queryKey: ['ai-provider-balance', p.key] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const saveQuickRate = () => {
    const cleanRate = draftRate && draftRate > 0 ? draftRate : p.defaultRate ?? null;
    quickPatch.mutate({ rate: cleanRate });
  };

  const saveQuickMarkup = () => {
    const cleanMarkup = draftMarkup !== null && draftMarkup >= 0 ? draftMarkup : 0;
    quickPatch.mutate({ markup: cleanMarkup, applyMarkupAt: Date.now() });
  };

  const saveQuickNote = () => {
    const cleanNote = draftNote.trim();
    if (cleanNote === (p.note ?? '').trim()) {
      setEditingNote(false);
      return;
    }
    quickPatch.mutate({ note: cleanNote });
  };

  const saveQuickPromo = () => {
    const cleanPromo = draftPromo.trim();
    if (cleanPromo === (p.sourcePromo ?? '').trim()) {
      setEditingPromo(false);
      return;
    }
    quickPatch.mutate({ sourcePromo: cleanPromo });
  };

  const saveQuickCredits = () => {
    const cleanCredits = draftCredits !== null && Number.isFinite(draftCredits) && draftCredits >= 0 ? draftCredits : 0;
    quickPatch.mutate({ manualCredits: cleanCredits, manualCreditsAt: new Date().toISOString() });
  };

  return {
    ready,
    bal,
    vndInfo,
    quickPatch,
    editingRate,
    setEditingRate,
    draftRate,
    setDraftRate,
    saveQuickRate,
    editingMarkup,
    setEditingMarkup,
    draftMarkup,
    setDraftMarkup,
    saveQuickMarkup,
    editingNote,
    setEditingNote,
    draftNote,
    setDraftNote,
    saveQuickNote,
    editingPromo,
    setEditingPromo,
    draftPromo,
    setDraftPromo,
    saveQuickPromo,
    editingCredits,
    setEditingCredits,
    draftCredits,
    setDraftCredits,
    saveQuickCredits,
  };
}

/** Popover đặt mốc ngày giờ hết hạn chuẩn 24h (00:00 – 23:59 — T-404 & T-414) */
function ExpiryPopover({
  expiresAt,
  nowMs,
  pending,
  onSave,
  align = 'end',
}: {
  expiresAt?: string;
  nowMs: number;
  pending?: boolean;
  onSave: (iso: string) => void;
  align?: 'start' | 'center' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const init = splitIsoTo24h(expiresAt);
  const [datePart, setDatePart] = useState(init.date);
  const [hourPart, setHourPart] = useState(init.hour);
  const [minutePart, setMinutePart] = useState(init.minute);

  useEffect(() => {
    if (open) {
      const cur = splitIsoTo24h(expiresAt);
      setDatePart(cur.date);
      setHourPart(cur.hour);
      setMinutePart(cur.minute);
    }
  }, [open, expiresAt]);

  const info = formatRemainingExpiry(expiresAt, nowMs);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {info ? (
          <button
            type="button"
            title={`Hết hạn lúc ${info.dateLabel} — bấm để sửa mốc hết hạn`}
            className={cn(
              'inline-flex cursor-pointer flex-col items-end gap-0.5 rounded-md border px-2 py-1 text-right text-xs transition hover:bg-muted/60',
              info.tone === 'expired'
                ? 'border-red-500/30 bg-red-500/8 text-red-600 dark:text-red-400'
                : info.tone === 'warn'
                  ? 'border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300'
                  : 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300',
            )}
          >
            <span className="inline-flex items-center gap-1 font-semibold tabular-nums">
              <Clock className="size-3" />
              {info.text}
              <Pencil className="size-2.5 opacity-60" />
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">Hạn: {info.dateLabel}</span>
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
          >
            <CalendarClock className="size-3.5" />
            Đặt mốc hết hạn
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72 space-y-2.5 p-3.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-foreground">Mốc ngày giờ hết hạn</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Khung 00–24h</span>
        </div>

        <DateTime24Fields
          date={datePart}
          hour={hourPart}
          minute={minutePart}
          onChangeDate={setDatePart}
          onChangeHour={setHourPart}
          onChangeMinute={setMinutePart}
        />

        <div className="flex items-center justify-between gap-1.5 pt-0.5">
          {expiresAt ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-red-600 hover:text-red-700"
              disabled={pending}
              onClick={() => {
                onSave('');
                setOpen(false);
              }}
            >
              Xoá hạn
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={pending || !datePart}
            onClick={() => {
              const iso = buildIsoFrom24h(datePart, hourPart, minutePart);
              if (iso) {
                onSave(iso);
                setOpen(false);
              }
            }}
          >
            Đặt mốc hạn
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ProviderTableRow({
  provider: p,
  meta,
  stats,
  runStat,
  nowMs,
  onReportBalance,
  onEdit,
  onOpenTools,
  onOpenTasks,
  onToggleAllMaintenance,
  maintenancePending,
}: {
  provider: ProviderRow;
  meta?: AiProviderMetaItem;
  stats: { total: number; enabled: number; maintenance: number; keys: string[] };
  runStat?: ProviderRunStat;
  nowMs: number;
  onReportBalance: (key: string, vnd: number | null) => void;
  onEdit: () => void;
  onOpenTools: () => void;
  onOpenTasks: () => void;
  onToggleAllMaintenance: () => void;
  maintenancePending: boolean;
}) {
  const ctrl = useProviderRowController(p, onReportBalance);
  const { ready, bal, vndInfo, quickPatch } = ctrl;
  const allMaint = stats.enabled > 0 && stats.maintenance >= stats.enabled;
  const displayName = meta?.name?.split('·')[0]?.trim() || p.name;
  const domainHref = p.website ? (p.website.startsWith('http') ? p.website : `https://${p.website}`) : null;
  const cleanDomain = p.website ? p.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const profit = estimateProfit(p, runStat);
  const autoNameOn = p.autoName !== false;
  const autoPriceOn = !!p.autoPrice;

  return (
    <TableRow className="align-middle hover:bg-muted/20">
      {/* Cột 1: Nguồn kết nối */}
      <TableCell className="py-3.5 pl-4 align-middle">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{displayName}</span>
            {!ctrl.editingNote && (
              <button
                type="button"
                onClick={() => ctrl.setEditingNote(true)}
                title={p.note ? `Ghi chú: ${p.note} (bấm để sửa)` : 'Thêm ghi chú nhanh'}
                className={cn(
                  'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition',
                  p.note
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 dark:text-amber-300'
                    : 'border-dashed border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
                )}
              >
                <StickyNote className="size-3 shrink-0" />
                <span className="max-w-[155px] truncate">{p.note || '+ Ghi chú'}</span>
              </button>
            )}
          </div>

          {ctrl.editingNote && (
            <div className="flex items-center gap-1 pt-0.5">
              <input
                type="text"
                autoFocus
                maxLength={200}
                value={ctrl.draftNote}
                onChange={(e) => ctrl.setDraftNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    ctrl.saveQuickNote();
                  } else if (e.key === 'Escape') {
                    ctrl.setEditingNote(false);
                    ctrl.setDraftNote(p.note ?? '');
                  }
                }}
                placeholder="Nhập ghi chú... (Enter)"
                className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <Button size="sm" className="h-7 px-2" disabled={quickPatch.isPending} onClick={ctrl.saveQuickNote}>
                <Check className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1.5"
                onClick={() => {
                  ctrl.setEditingNote(false);
                  ctrl.setDraftNote(p.note ?? '');
                }}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          )}

          <div className="space-y-0.5 text-xs text-muted-foreground">
            <div>
              {domainHref ? (
                <a
                  href={domainHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline"
                >
                  {cleanDomain}
                  <ExternalLink className="size-3 opacity-70" />
                </a>
              ) : (
                <span>{p.key}</span>
              )}
            </div>
            <div>
              {p.configured ? (
                <button type="button" onClick={onEdit} className="hover:text-foreground hover:underline">
                  Đã kết nối Key
                </button>
              ) : (
                <button type="button" onClick={onEdit} className="text-amber-600 hover:underline dark:text-amber-400">
                  Chưa có Key
                </button>
              )}
            </div>
          </div>
        </div>
      </TableCell>

      {/* Cột 2: Mã SV */}
      <TableCell className="py-3.5 text-center align-middle">
        <div className="inline-flex flex-col items-center gap-0.5">
          <Badge variant="secondary" className="px-2 py-0.5 text-xs font-semibold">
            {p.defaultBadge || p.key.toUpperCase()}
          </Badge>
          <span className="text-[11px] text-muted-foreground">{p.key}</span>
        </div>
      </TableCell>

      {/* Cột 3: Số dư / Thời hạn */}
      <TableCell className="min-w-[190px] py-3.5 text-right align-middle">
        {!ready ? (
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs text-muted-foreground">{p.configured ? 'Đang tắt' : 'Chưa có khoá'}</span>
            {p.expiresAt ? (
              <ExpiryPopover
                expiresAt={p.expiresAt}
                nowMs={nowMs}
                pending={quickPatch.isPending}
                onSave={(expiresAt) => quickPatch.mutate({ expiresAt })}
              />
            ) : null}
          </div>
        ) : bal.error ? (
          <div className="space-y-1">
            <span className="block text-xs text-red-600 dark:text-red-400">{errorMessage(bal.error)}</span>
            <button
              type="button"
              onClick={() => void bal.refetch()}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={cn('size-3', bal.isFetching && 'animate-spin')} /> Thử lại
            </button>
          </div>
        ) : bal.data ? (
          bal.data.supported ? (
            bal.data.ok ? (
              ctrl.editingCredits ? (
                <div className="inline-flex items-center justify-end gap-1">
                  <div className="w-28">
                    <NumberInput
                      suffix={bal.data.unit || 'cr'}
                      min={0}
                      value={ctrl.draftCredits}
                      placeholder="Nhập credit"
                      onChange={ctrl.setDraftCredits}
                    />
                  </div>
                  <Button size="sm" className="h-7 px-1.5" disabled={quickPatch.isPending} onClick={ctrl.saveQuickCredits} title="Lưu số credit hiện tại">
                    <Check className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-1"
                    onClick={() => {
                      ctrl.setEditingCredits(false);
                      ctrl.setDraftCredits(p.manualCredits ?? bal.data?.balance ?? null);
                    }}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col items-end gap-0.5">
                  {vndInfo !== null ? (
                    <div
                      title={`${(bal.data.balance ?? 0).toLocaleString('vi-VN')} ${bal.data.unit ?? ''} × ${fmtRate(vndInfo.rate)}đ`}
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        vndInfo.vnd <= 0
                          ? 'text-red-600 dark:text-red-400'
                          : vndInfo.vnd < 100_000
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-foreground',
                      )}
                    >
                      {fmtVnd(vndInfo.vnd)}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground tabular-nums">
                    {bal.data.manualLedger ? (
                      <button
                        type="button"
                        onClick={() => {
                          ctrl.setDraftCredits(bal.data?.balance ?? p.manualCredits ?? 0);
                          ctrl.setEditingCredits(true);
                        }}
                        title="Bấm để cập nhật mốc credit thực tế trên nguồn (tự động trừ lùi theo đơn chạy)"
                        className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 transition hover:bg-muted hover:text-foreground"
                      >
                        <span>
                          {(bal.data.balance ?? 0).toLocaleString('vi-VN')} {bal.data.unit ?? ''}
                        </span>
                        <Pencil className="size-2.5 shrink-0 opacity-70" />
                      </button>
                    ) : (
                      <span>
                        {(bal.data.balance ?? 0).toLocaleString('vi-VN')} {bal.data.unit ?? ''}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void bal.refetch()}
                      disabled={bal.isFetching}
                      title="Làm mới số dư"
                      className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                    >
                      <RefreshCw className={cn('size-3', bal.isFetching && 'animate-spin')} />
                    </button>
                  </div>
                  {p.expiresAt ? (
                    <div className="pt-0.5">
                      <ExpiryPopover
                        expiresAt={p.expiresAt}
                        nowMs={nowMs}
                        pending={quickPatch.isPending}
                        onSave={(expiresAt) => quickPatch.mutate({ expiresAt })}
                      />
                    </div>
                  ) : null}
                </div>
              )
            ) : (
              <span className="text-xs text-red-600 dark:text-red-400">{bal.data.error}</span>
            )
          ) : (
            <ExpiryPopover
              expiresAt={p.expiresAt}
              nowMs={nowMs}
              pending={quickPatch.isPending}
              onSave={(expiresAt) => quickPatch.mutate({ expiresAt })}
            />
          )
        ) : (
          <span className="text-xs text-muted-foreground">Đang tải…</span>
        )}
      </TableCell>

      {/* Cột 4: Thống kê tinh gọn, chống bóp đè chữ khi thu hẹp cửa sổ (T-455) */}
      <TableCell className="min-w-[235px] py-3.5 align-middle">
        <div className="grid min-w-[220px] grid-cols-2 gap-x-2.5 gap-y-1 text-xs">
          <button
            type="button"
            onClick={onOpenTools}
            className="flex items-center justify-between gap-2 whitespace-nowrap rounded-md bg-muted/40 px-2 py-1 text-left transition hover:bg-muted"
          >
            <span className="shrink-0 text-muted-foreground">Công cụ</span>
            <span className="shrink-0 font-medium text-foreground tabular-nums">
              {stats.enabled}/{stats.total}
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenTasks}
            className="flex items-center justify-between gap-2 whitespace-nowrap rounded-md bg-muted/40 px-2 py-1 text-left transition hover:bg-muted"
          >
            <span className="shrink-0 text-muted-foreground">Đơn</span>
            <span className="shrink-0 font-medium text-foreground tabular-nums">{(runStat?.succeeded ?? 0).toLocaleString('vi-VN')}</span>
          </button>

          <div className="col-span-2 flex items-center justify-between gap-2 whitespace-nowrap rounded-md bg-muted/40 px-2 py-1">
            <span className="shrink-0 text-muted-foreground">Doanh thu</span>
            <span className="shrink-0 font-medium text-foreground tabular-nums">{fmtVnd(runStat?.revenue ?? 0)}</span>
          </div>

          <div className="col-span-2 flex items-center justify-between gap-2 whitespace-nowrap rounded-md bg-muted/40 px-2 py-1">
            <span className="shrink-0 text-muted-foreground">Lợi nhuận</span>
            <span
              className={cn(
                'shrink-0 font-medium tabular-nums',
                profit > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
              )}
            >
              {profit > 0 ? `+${fmtVnd(profit)}` : fmtVnd(profit)}
            </span>
          </div>
        </div>
      </TableCell>

      {/* Cột 5: Tỉ giá đặt ngay giữa Thống kê và Khuyến mãi nguồn (T-423) */}
      <TableCell className="py-3.5 align-middle text-xs">
        {p.costUnit ? (
          ctrl.editingRate ? (
            <div className="flex items-center gap-1">
              <div className="w-24">
                <NumberInput suffix="đ" min={0} value={ctrl.draftRate} placeholder={String(p.defaultRate ?? 1)} onChange={ctrl.setDraftRate} />
              </div>
              <Button size="sm" className="h-7 px-1.5" disabled={quickPatch.isPending} onClick={ctrl.saveQuickRate}>
                <Check className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1"
                onClick={() => {
                  ctrl.setEditingRate(false);
                  ctrl.setDraftRate(p.rate);
                }}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => ctrl.setEditingRate(true)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              title="Đổi tỉ giá quy đổi"
            >
              <span>
                1 {p.costUnit} = <span className="font-semibold text-foreground tabular-nums">{fmtRate(p.rate)}đ</span>
              </span>
              <Pencil className="size-2.5 shrink-0 opacity-60" />
            </button>
          )
        ) : (
          <span className="text-muted-foreground" title="Nguồn dùng gói cố định">
            —
          </span>
        )}
      </TableCell>

      {/* Cột 6: Khuyến mãi nguồn (T-412) */}
      <TableCell className="py-3.5 align-middle">
        {ctrl.editingPromo ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              autoFocus
              maxLength={120}
              value={ctrl.draftPromo}
              onChange={(e) => ctrl.setDraftPromo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  ctrl.saveQuickPromo();
                } else if (e.key === 'Escape') {
                  ctrl.setEditingPromo(false);
                  ctrl.setDraftPromo(p.sourcePromo ?? '');
                }
              }}
              placeholder="VD: +25% nạp..."
              className="h-7 w-28 min-w-0 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <Button size="sm" className="h-7 px-1.5" disabled={quickPatch.isPending} onClick={ctrl.saveQuickPromo}>
              <Check className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-1"
              onClick={() => {
                ctrl.setEditingPromo(false);
                ctrl.setDraftPromo(p.sourcePromo ?? '');
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : p.sourcePromo?.trim() ? (
          <button
            type="button"
            onClick={() => ctrl.setEditingPromo(true)}
            title={`Khuyến mãi nguồn: ${p.sourcePromo} (bấm để sửa)`}
            className="inline-flex max-w-[145px] cursor-pointer items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-500/15 dark:text-emerald-300"
          >
            <Gift className="size-3 shrink-0" />
            <span className="truncate">{formatPromoDisplay(p.sourcePromo)}</span>
            <Pencil className="size-2.5 shrink-0 opacity-60" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => ctrl.setEditingPromo(true)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"
          >
            <Gift className="size-3 shrink-0" />
            <span>+ Khuyến mãi</span>
          </button>
        )}
      </TableCell>

      {/* Cột 7: Lãi tăng tách riêng (T-412) */}
      <TableCell className="py-3.5 text-center align-middle">
        {ctrl.editingMarkup ? (
          <div className="inline-flex items-center justify-center gap-1">
            <div className="w-20">
              <NumberInput suffix="%" min={0} value={ctrl.draftMarkup} placeholder="0" onChange={ctrl.setDraftMarkup} />
            </div>
            <Button size="sm" className="h-7 px-1.5" disabled={quickPatch.isPending} onClick={ctrl.saveQuickMarkup}>
              <Check className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-1"
              onClick={() => {
                ctrl.setEditingMarkup(false);
                ctrl.setDraftMarkup(p.markup);
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => ctrl.setEditingMarkup(true)}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border bg-muted/40 px-2.5 py-1 text-xs font-semibold text-foreground tabular-nums transition hover:bg-muted"
            title="Sửa nhanh % lãi tăng"
          >
            <span>+{fmtRate(p.markup ?? 0)}%</span>
            <Pencil className="size-2.5 text-muted-foreground" />
          </button>
        )}
      </TableCell>

      {/* Cột 8: Tổng % = Khuyến mãi nguồn (%) + Lãi tăng (%) (T-424) */}
      {(() => {
        const promoPct = parsePromoPercent(p.sourcePromo);
        const markupPct = Number(p.markup) || 0;
        const totalPct = Math.round((promoPct + markupPct) * 100) / 100;
        const sign = totalPct >= 0 ? '+' : '';
        const promoSign = promoPct >= 0 ? '+' : '';
        return (
          <TableCell className="py-3.5 text-center align-middle">
            <span
              title={`Khuyến mãi nguồn (${promoSign}${fmtRate(promoPct)}%) + Lãi tăng (+${fmtRate(markupPct)}%) = ${sign}${fmtRate(totalPct)}%`}
              className={cn(
                'inline-flex items-center justify-center rounded-md border px-2.5 py-1 text-xs font-semibold tabular-nums',
                totalPct > 0
                  ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                  : totalPct < 0
                    ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                    : 'border-border bg-muted/40 text-muted-foreground',
              )}
            >
              {sign}
              {fmtRate(totalPct)}%
            </span>
          </TableCell>
        );
      })()}

      {/* Cột 9: Đồng bộ (Giá bán & Tên SP) */}
      <TableCell className="py-3.5 align-middle">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <button
            type="button"
            disabled={quickPatch.isPending}
            onClick={() => quickPatch.mutate({ autoPrice: !autoPriceOn, applyMarkupAt: Date.now() })}
            title="Bấm để chuyển đổi giữa Giá bán tự động (theo API) và Giá bán cố định"
            className={cn(
              'inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition',
              autoPriceOn
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300'
                : 'border-border bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            Giá: {autoPriceOn ? 'Tự động' : 'Cố định'}
          </button>

          <button
            type="button"
            disabled={quickPatch.isPending}
            onClick={() => quickPatch.mutate({ autoName: !autoNameOn })}
            title="Bấm để bật / tắt tự cập nhật tên công cụ"
            className={cn(
              'inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition',
              autoNameOn
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300'
                : 'border-border bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            Tên SP: {autoNameOn ? 'Tự động' : 'Tắt'}
          </button>
        </div>
      </TableCell>

      {/* Cột 8: Trạng thái */}
      <TableCell className="py-3.5 text-center align-middle">
        <Switch
          checked={p.enabled}
          disabled={quickPatch.isPending}
          onCheckedChange={(enabled) => quickPatch.mutate({ enabled })}
          aria-label={`Bật/tắt nguồn ${p.name}`}
        />
      </TableCell>

      {/* Cột 9: Thao tác (đã bỏ Kiểm tra lại số dư & Danh sách công cụ theo T-403 & T-413) */}
      <TableCell className="py-3.5 pr-4 text-right align-middle">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs font-medium">
              <Settings2 className="size-3.5" />
              Thao tác
              <ChevronDown className="size-3 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={onEdit}>
              <KeyRound className="size-4" />
              Sửa cấu hình / Khoá API
            </DropdownMenuItem>
            {stats.keys.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={maintenancePending} onClick={onToggleAllMaintenance}>
                  <ShieldAlert className="size-4 text-amber-600" />
                  {allMaint ? 'Tắt bảo trì cả nguồn' : 'Bật bảo trì cả nguồn'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function ProviderManageCard({
  provider: p,
  meta,
  stats,
  runStat,
  nowMs,
  onReportBalance,
  onEdit,
  onOpenTools,
  onToggleAllMaintenance,
  maintenancePending,
}: {
  provider: ProviderRow;
  meta?: AiProviderMetaItem;
  stats: { total: number; enabled: number; maintenance: number; keys: string[] };
  runStat?: ProviderRunStat;
  nowMs: number;
  onReportBalance: (key: string, vnd: number | null) => void;
  onEdit: () => void;
  onOpenTools: () => void;
  onToggleAllMaintenance: () => void;
  maintenancePending: boolean;
}) {
  const ctrl = useProviderRowController(p, onReportBalance);
  const { ready, bal, vndInfo, quickPatch } = ctrl;
  const allMaint = stats.enabled > 0 && stats.maintenance >= stats.enabled;
  const profit = estimateProfit(p, runStat);

  return (
    <Card className="py-0 transition-shadow hover:shadow-sm">
      <CardContent className="flex h-full flex-col justify-between gap-3 p-4">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {p.defaultBadge && (
                  <Badge variant="secondary" className="text-xs font-semibold">
                    {p.defaultBadge}
                  </Badge>
                )}
                <span className="truncate text-sm font-medium">{meta?.name?.split('·')[0]?.trim() || p.name}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{p.website ? p.website.replace(/^https?:\/\//, '') : p.key}</div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {ready ? (
                <Badge className="border-transparent bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 /> Đang bật
                </Badge>
              ) : (
                <Badge variant="secondary">
                  <CircleAlert /> {p.configured ? 'Đang tắt' : 'Chưa có khoá'}
                </Badge>
              )}
              <Switch
                checked={p.enabled}
                disabled={quickPatch.isPending}
                onCheckedChange={(enabled) => quickPatch.mutate({ enabled })}
                aria-label={`Bật/tắt nguồn ${p.name}`}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="min-w-0 flex-1 text-sm">
              <div className="text-[11px] text-muted-foreground">Số dư / Thời hạn</div>
              {!ready ? (
                <span className="text-xs text-muted-foreground">{p.configured ? 'Nguồn đang tắt' : 'Chưa nhập khoá API'}</span>
              ) : bal.data?.supported && bal.data?.ok ? (
                <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
                  {vndInfo !== null && <span className="text-sm font-semibold tabular-nums">{fmtVnd(vndInfo.vnd)}</span>}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {(bal.data.balance ?? 0).toLocaleString('vi-VN')} {bal.data.unit ?? ''}
                  </span>
                </div>
              ) : (
                <div className="mt-1">
                  <ExpiryPopover
                    expiresAt={p.expiresAt}
                    nowMs={nowMs}
                    pending={quickPatch.isPending}
                    onSave={(expiresAt) => quickPatch.mutate({ expiresAt })}
                    align="start"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5 text-xs">
            <span className="rounded-md bg-muted/40 px-2 py-1">
              Công cụ: <b className="tabular-nums">{stats.enabled}/{stats.total}</b>
            </span>
            <span className="rounded-md bg-muted/40 px-2 py-1 tabular-nums">
              Đơn: <b>{(runStat?.succeeded ?? 0).toLocaleString('vi-VN')}</b>
            </span>
            <span className="rounded-md bg-muted/40 px-2 py-1 tabular-nums">
              Doanh thu: <b>{fmtVnd(runStat?.revenue ?? 0)}</b>
            </span>
            <span className="rounded-md bg-muted/40 px-2 py-1 tabular-nums">
              Lợi nhuận: <b className="text-emerald-600 dark:text-emerald-400">{fmtVnd(profit)}</b>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
          <Button size="sm" variant="default" className="flex-1" onClick={onEdit}>
            <Settings2 /> Cấu hình / Key
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenTools}>
            <Wrench /> Công cụ ({stats.total})
          </Button>
          {stats.keys.length > 0 && (
            <Button size="sm" variant={allMaint ? 'secondary' : 'ghost'} disabled={maintenancePending} onClick={onToggleAllMaintenance}>
              <ShieldAlert className={allMaint ? 'text-amber-600' : 'text-muted-foreground'} />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EditProviderDialog({
  provider,
  meta,
  onClose,
  onSaved,
}: {
  provider: ProviderRow;
  meta?: AiProviderMetaItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            <span>
              Cấu hình {provider.defaultBadge ? `${provider.defaultBadge} · ` : ''}
              {meta?.name || provider.name}
            </span>
          </DialogTitle>
          {meta?.hint && <DialogDescription className="leading-relaxed">{meta.hint}</DialogDescription>}
        </DialogHeader>

        <SettingsGroup
          group={`ai_${provider.key}`}
          onSaved={() => {
            onSaved();
            onClose();
          }}
        >
          {(v, set) => {
            const isAutoPrice =
              v.autoPrice !== undefined ? v.autoPrice === true : provider.supportsCost ? provider.autoPrice !== false : false;
            const curExpires = typeof v.expiresAt === 'string' ? v.expiresAt : provider.expiresAt ?? '';
            const expParts = curExpires ? splitIsoTo24h(curExpires) : { date: '', hour: '00', minute: '00' };
            return (
              <div className="space-y-4 py-1">
                <SwitchRow
                  label="Bật nhà cung cấp"
                  description="Tắt thì toàn bộ công cụ thuộc nguồn này sẽ tự động ẩn với khách trên website"
                  checked={v.enabled === true}
                  onChange={(enabled) => set({ enabled })}
                />
                <SwitchRow
                  label="Tự cập nhật tên công cụ"
                  description="Mặc định Bật: tự động cập nhật tên công cụ & model từ nguồn; nếu tên dính ký tự / thương hiệu / tên miền của nguồn thì hệ thống tự lọc bỏ sạch trước khi đưa lên web."
                  checked={v.autoName !== false}
                  onChange={(autoName) => set({ autoName })}
                />

                {/* Ô chọn chế độ Giá bán Cố định hay Tự động hiển thị cho MỌI nguồn (T-405) */}
                <div className="rounded-xl border bg-muted/20 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="text-sm font-medium">Chế độ giá bán công cụ</div>
                      <div className="text-xs text-muted-foreground">
                        {isAutoPrice
                          ? 'Giá bán tự động: tự cập nhật theo chi phí gốc API × tỉ giá + % tăng giá bên dưới.'
                          : 'Giá bán cố định: giữ nguyên mức giá VNĐ đặt riêng ở từng công cụ, không tự nhảy theo nguồn.'}
                      </div>
                    </div>
                    <Select
                      value={isAutoPrice ? 'auto' : 'fixed'}
                      onValueChange={(mode) => set({ autoPrice: mode === 'auto', applyMarkupAt: Date.now() })}
                    >
                      <SelectTrigger className="h-9 w-[190px] text-xs font-medium">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Giá bán tự động (theo API)</SelectItem>
                        <SelectItem value="fixed">Giá bán cố định (giữ nguyên)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Khoá API / Thông tin kết nối">
                    <SecretInput value={v.apiKey as string} onChange={(apiKey) => set({ apiKey })} placeholder="Dán khoá API hoặc tài_khoản:mật_khẩu" />
                  </Field>
                  <Field label="URL gốc API" help="Giữ mặc định trừ khi nhà cung cấp đổi tên miền cổng API">
                    <Input value={(v.baseUrl as string) ?? ''} onChange={(e) => set({ baseUrl: e.target.value.trim() })} />
                  </Field>
                  {(provider.key === 'maivideo' || provider.key === 'aideepcut' || provider.key === 'plenxai') && (
                    <Field
                      label={
                        provider.key === 'plenxai'
                          ? 'Token phiên web plenxai.com (tuỳ chọn tự đồng bộ số dư)'
                          : 'Cookie phiên web nguồn (tuỳ chọn)'
                      }
                      help={
                        provider.key === 'plenxai'
                          ? 'Dán refresh_token / access_token hoặc email:mật_khẩu plenxai.com để tự đồng bộ số dư trực tiếp; nếu để trống, dùng ô Số dư Credit bên dưới (hệ thống tự trừ lùi theo đơn chạy).'
                          : 'Dùng để hệ thống tự động gọi lệnh huỷ đơn trực tiếp trên web nguồn khi API Key không mở cổng huỷ'
                      }
                      className="md:col-span-2"
                    >
                      <SecretInput
                        value={(v.sessionCookie as string) ?? ''}
                        onChange={(sessionCookie) => set({ sessionCookie })}
                        placeholder={
                          provider.key === 'plenxai'
                            ? 'Dán refresh_token hoặc email:mật_khẩu plenxai.com (không bắt buộc)'
                            : 'Dán Cookie phiên đăng nhập web nguồn (không bắt buộc)'
                        }
                      />
                    </Field>
                  )}
                  {provider.key === 'plenxai' && (
                    <Field
                      label="Số dư Credit hiện tại trên nguồn"
                      help="Nhập số credit hiện có trên tài khoản PlenxAI — hệ thống tự quy đổi sang VNĐ thực còn và tự động trừ lùi khi có đơn chạy thành công"
                    >
                      <NumberInput
                        suffix="credit"
                        min={0}
                        value={v.manualCredits !== undefined && v.manualCredits !== null ? (v.manualCredits as number) : (provider.manualCredits ?? null)}
                        placeholder="VD: 60000"
                        onChange={(manualCredits) =>
                          set({
                            manualCredits: manualCredits !== null && manualCredits >= 0 ? manualCredits : 0,
                            manualCreditsAt: new Date().toISOString(),
                          })
                        }
                      />
                    </Field>
                  )}
                  <Field label="Mốc hết hạn gói thuê (khung 00–24h)" help="Đặt ngày giờ hết hạn chuẩn 24h để đếm ngược ngoài bảng">
                    <div className="flex items-center gap-1.5">
                      <div className="min-w-0 flex-1">
                        <DateTime24Fields
                          date={expParts.date}
                          hour={expParts.hour}
                          minute={expParts.minute}
                          onChangeDate={(nextDate) => {
                            if (!nextDate) set({ expiresAt: '' });
                            else {
                              const iso = buildIsoFrom24h(nextDate, expParts.hour, expParts.minute);
                              if (iso) set({ expiresAt: iso });
                            }
                          }}
                          onChangeHour={(nextHour) => {
                            const baseDate = expParts.date || splitIsoTo24h().date;
                            const iso = buildIsoFrom24h(baseDate, nextHour, expParts.minute);
                            if (iso) set({ expiresAt: iso });
                          }}
                          onChangeMinute={(nextMinute) => {
                            const baseDate = expParts.date || splitIsoTo24h().date;
                            const iso = buildIsoFrom24h(baseDate, expParts.hour, nextMinute);
                            if (iso) set({ expiresAt: iso });
                          }}
                        />
                      </div>
                      {curExpires ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => set({ expiresAt: '' })} title="Xoá hạn">
                          <X className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  </Field>
                  <Field label="Khuyến mãi nguồn (tuỳ chọn)" help="Hiển thị ở cột Khuyến mãi nguồn ngoài bảng">
                    <Input
                      value={(v.sourcePromo as string) ?? provider.sourcePromo ?? ''}
                      maxLength={120}
                      placeholder="VD: +25% nạp, Giảm 20%..."
                      onChange={(e) => set({ sourcePromo: e.target.value })}
                    />
                  </Field>
                  <Field label="Ghi chú nội bộ" help="Ghi chú nhanh tài khoản nạp, ngày hết hạn hoặc lưu ý kiểm tra nguồn">
                    <Input
                      value={(v.note as string) ?? ''}
                      maxLength={200}
                      placeholder="VD: Gói Pro 5 luồng, nạp qua VietQR..."
                      onChange={(e) => set({ note: e.target.value })}
                    />
                  </Field>
                  {provider.costUnit && (
                    <Field
                      label={`Tỉ giá quy đổi: 1 ${provider.costUnit} = ? đ`}
                      help={`Giá khách trả = chi phí gốc × tỉ giá + % tăng giá. Để trống = mặc định ${(provider.defaultRate ?? 1).toLocaleString('vi-VN', { maximumFractionDigits: 4 })}đ`}
                    >
                      <NumberInput
                        suffix="đ"
                        min={0}
                        value={(v.rate as number) ?? null}
                        placeholder={String(provider.defaultRate ?? 1)}
                        onChange={(rate) => set({ rate: rate && rate > 0 ? rate : null })}
                      />
                    </Field>
                  )}
                  <Field
                    label="% Tăng giá so với giá gốc *"
                    help={
                      provider.supportsCost
                        ? 'Nhập 10 để tăng giá bán thêm 10% so với giá gốc, nhập 0 để giữ nguyên.'
                        : 'Nhập 10 để tăng giá bán thêm 10% so với mức giá cơ sở của từng công cụ thuộc nguồn này, nhập 0 để giữ nguyên.'
                    }
                  >
                    <NumberInput
                      suffix="%"
                      min={0}
                      value={v.markup !== undefined && v.markup !== null ? (v.markup as number) : provider.markup}
                      placeholder={String(provider.markup ?? 0)}
                      onChange={(markup) => set({ markup: markup !== null && markup >= 0 ? markup : 0, applyMarkupAt: Date.now() })}
                    />
                  </Field>
                  {meta?.extra?.map((x) => (
                    <Field key={x.name} label={x.label} help={x.help}>
                      <Input value={(v[x.name] as string) ?? ''} onChange={(e) => set({ [x.name]: e.target.value.trim() })} />
                    </Field>
                  ))}
                </div>

                {provider.key === 'ahiep' && <AhiepCosts v={v} set={set} />}
              </div>
            );
          }}
        </SettingsGroup>
      </DialogContent>
    </Dialog>
  );
}
