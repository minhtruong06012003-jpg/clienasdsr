'use client';

/**
 * AI Studio › Gói nạp tiền, 3 tab (số dư chạy AI chính là số dư ví, đơn vị VND):
 * - Gói nạp tiền: thêm / sửa / xoá gói (GET/POST/PUT/DELETE /admin/credits/plans) — giá phải trả (`price`),
 *   số tiền cộng vào ví (`credits`, VND), nhãn; % tặng thêm tự tính so với gói có tỉ lệ thấp nhất.
 *   Quyền lợi chung dưới bảng giá: Cài đặt › Nạp tiền & khuyến mãi.
 * - Lịch sử mua (GET /admin/credits/purchases).
 * - Sổ biến động số dư do AI Studio ghi (GET /admin/credits/transactions).
 * Ô số liệu trên cùng: doanh thu, tiền đã cộng ví qua gói / đã chi chạy AI / tổng số dư ví khách (GET /admin/credits/stats).
 */
import { Suspense, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Pencil, Plus, ReceiptText, ShoppingBag, Trash2, Users, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { Field } from '@/components/common/field';
import { MoneyInput, NumberInput } from '@/components/common/number-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { KpiCard } from '@/components/reports/kpi-card';
import { CREDIT_TXN, PermissionGate, ToneBadge, fmtCount, fmtCredits, type PaginatedWithCounts } from '@/components/ai/shared';
import { UserCell } from '@/components/affiliate/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';

interface Plan {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price: number;
  /** Số tiền (VND) cộng vào ví khi mua gói */
  credits: number;
  /** % tiền tặng thêm so với gói có tỉ lệ thấp nhất (API tính) */
  bonus?: number;
  badge: string | null;
  highlight: boolean;
  active: boolean;
  sortOrder: number;
  _count?: { purchases: number; users: number };
}

interface Stats {
  revenue: number;
  purchases: number;
  revenue30d: number;
  purchases30d: number;
  /** Tổng tiền (VND) đã cộng vào ví qua mua gói */
  creditsSold: number;
  /** Tổng tiền (VND) khách đã chi chạy công cụ AI */
  creditsUsed: number;
  /** Tổng số dư ví (VND) của mọi khách */
  creditsOutstanding: number;
  buyers: number;
}

/** Nhãn loại lần mua: gói nạp tiền (mới) hoặc gói cước tháng / năm (cơ chế cũ) */
const CYCLE_LABEL: Record<string, string> = { pack: 'Nạp tiền', month: 'Gói tháng', year: 'Gói năm' };

const TABS = [
  { key: 'plans', label: 'Gói nạp tiền' },
  { key: 'purchases', label: 'Lịch sử mua' },
  { key: 'transactions', label: 'Sổ biến động số dư' },
];

function PlansContent() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useAuth();
  const tab = TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab')! : 'plans';
  const stats = useQuery({ queryKey: ['credit-stats'], queryFn: () => api.get<Stats>('/admin/credits/stats'), enabled: can('credits.read') });
  const s = stats.data;
  return (
    <>
      <PageHeader title="Gói nạp tiền" description="Khách trả giá gói, nhận số tiền tương ứng (có thể kèm tặng thêm) vào ví để chạy công cụ AI; thanh toán qua cổng QR hoặc số dư ví. Quyền lợi chung dưới bảng giá: Cài đặt › Nạp tiền & khuyến mãi" breadcrumbs={[{ label: 'AI Studio' }, { label: 'Gói nạp tiền' }]} />
      <PageBody>
        {can('credits.read') && (
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard title="Doanh thu gói nạp tiền" icon={Wallet} loading={stats.isLoading} value={formatMoney(s?.revenue ?? 0)} hint={`30 ngày: ${formatMoney(s?.revenue30d ?? 0)}`} />
            <KpiCard title="Lượt mua" icon={ShoppingBag} loading={stats.isLoading} value={fmtCount(s?.purchases)} hint={`${fmtCount(s?.buyers)} khách đã mua`} />
            <KpiCard title="Đã cộng ví qua gói / đã chi chạy AI" icon={Coins} loading={stats.isLoading} value={fmtCredits(s?.creditsSold)} hint={`Đã chi chạy AI ${fmtCredits(s?.creditsUsed)}`} />
            <KpiCard title="Tổng số dư ví khách" icon={Users} loading={stats.isLoading} value={fmtCredits(s?.creditsOutstanding)} hint="Tổng số dư ví (VND) của mọi khách" />
          </div>
        )}
        <Tabs value={tab} onValueChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })} className="gap-6">
          <TabsList variant="line" className="w-full justify-start overflow-x-auto">
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="flex-none px-3">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="plans">{tab === 'plans' && <PermissionGate permission="credits.plans"><PlansTab /></PermissionGate>}</TabsContent>
          <TabsContent value="purchases">{tab === 'purchases' && <PermissionGate permission="credits.read"><PurchasesTab /></PermissionGate>}</TabsContent>
          <TabsContent value="transactions">{tab === 'transactions' && <PermissionGate permission="credits.read"><CreditTxnTab /></PermissionGate>}</TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}

/** Danh sách gói + thêm / sửa / xoá */
function PlansTab() {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Partial<Plan> | null>(null);
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['credit-plans'], queryFn: () => api.get<Plan[]>('/admin/credits/plans') });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ hidden?: boolean }>(`/admin/credits/plans/${id}`),
    onSuccess: (r) => {
      toast.success(r.hidden ? 'Gói đã có người mua nên được ẩn khỏi bảng giá' : 'Đã xoá gói');
      qc.invalidateQueries({ queryKey: ['credit-plans'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const columns: Column<Plan>[] = [
    {
      key: 'name',
      header: 'Gói',
      mobile: 'primary',
      cell: (r) => (
        <div>
          <div className="flex items-center gap-1.5 font-medium">
            {r.name} {r.badge && <Badge variant="secondary">{r.badge}</Badge>} {!r.active && <Badge variant="outline">Ẩn</Badge>}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">{r.slug}</div>
        </div>
      ),
    },
    { key: 'price', header: 'Giá', cell: (r) => <span className="font-semibold tabular-nums">{formatMoney(r.price)}</span> },
    { key: 'credits', header: 'Nhận vào ví', cell: (r) => <span className="tabular-nums">+{fmtCredits(r.credits)}</span> },
    {
      key: 'unit',
      header: 'Tặng thêm',
      // phần tiền nhận vào ví vượt quá giá phải trả (nếu có) + % tặng thêm do API tính
      cell: (r) => (
        <div className="text-sm tabular-nums">
          {r.credits > r.price ? `+${formatMoney(r.credits - r.price)}` : '-'}
          {!!r.bonus && <span className="ml-1.5 font-medium text-emerald-600">+{r.bonus}%</span>}
        </div>
      ),
    },
    { key: 'sold', header: 'Đã bán', cell: (r) => <span className="tabular-nums">{r._count?.purchases ?? 0}</span> },
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon-sm" onClick={(e) => (e.stopPropagation(), setEdit(r))} aria-label="Sửa">
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Xoá"
            onClick={async (e) => {
              e.stopPropagation();
              if (await confirm({ title: `Xoá gói ${r.name}?`, description: 'Gói đã có người mua sẽ chỉ bị ẩn khỏi bảng giá để giữ lịch sử.', destructive: true, confirmText: 'Xoá' })) remove.mutate(r.id);
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEdit({ active: true, price: 0, credits: 0, sortOrder: q.data?.length ?? 0 })}>
          <Plus /> Thêm gói
        </Button>
      </div>
      <DataTable columns={columns} data={q.data} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} onRowClick={(r) => setEdit(r)} emptyTitle="Chưa có gói nào" />
      {edit && <PlanDialog plan={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** Hộp thêm / sửa gói */
function PlanDialog({ plan, onClose }: { plan: Partial<Plan>; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    slug: plan.slug ?? '',
    name: plan.name ?? '',
    description: plan.description ?? '',
    price: plan.price ?? 0,
    credits: plan.credits ?? 0,
    badge: plan.badge ?? '',
    highlight: !!plan.highlight,
    active: plan.active !== false,
    sortOrder: plan.sortOrder ?? 0,
  });
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));
  const save = useMutation({
    mutationFn: () => {
      const body = f;
      return plan.id ? api.put(`/admin/credits/plans/${plan.id}`, body) : api.post('/admin/credits/plans', body);
    },
    onSuccess: () => {
      toast.success('Đã lưu gói');
      qc.invalidateQueries({ queryKey: ['credit-plans'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{plan.id ? `Sửa gói ${plan.name}` : 'Thêm gói nạp tiền'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tên gói" required>
              <Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Nạp 200.000đ" />
            </Field>
            <Field label="Mã gói (slug)" required help="Chữ không dấu, số, gạch ngang">
              <Input value={f.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="nap-200k" />
            </Field>
          </div>
          <Field label="Mô tả ngắn" help="Tuỳ chọn, hiện dưới khối giá">
            <Input value={f.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Giá bán" required>
              <MoneyInput value={f.price} onChange={(n) => set({ price: n ?? 0 })} />
            </Field>
            <Field label="Số tiền nhận vào ví" required help={f.price > 0 && f.credits > f.price ? `Tặng thêm ${formatMoney(f.credits - f.price)} (+${Math.round(((f.credits - f.price) / f.price) * 100)}%) · không hết hạn` : 'Cộng vào số dư ví, không hết hạn'}>
              <MoneyInput value={f.credits} onChange={(n) => set({ credits: n ?? 0 })} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nhãn" help="vd: Phổ biến, Giá trị nhất">
              <Input value={f.badge} onChange={(e) => set({ badge: e.target.value })} />
            </Field>
            <Field label="Thứ tự">
              <NumberInput integer value={f.sortOrder} onChange={(n) => set({ sortOrder: n ?? 0 })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={f.active} onCheckedChange={(active) => set({ active })} /> Hiện trên bảng giá
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={f.highlight} onCheckedChange={(highlight) => set({ highlight })} /> Làm nổi bật
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.name.trim() || !f.slug || f.price < 1000 || f.credits < 1}>
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Purchase {
  id: string;
  code: number;
  planName: string;
  listPrice: number;
  discount: number;
  paid: number;
  credits: number;
  cycle: string;
  refillsLeft: number;
  expiresAt: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
}

function PurchasesTab() {
  const { params, set, page, limit } = useListParams<Record<string, string>>({ tab: 'purchases', search: '' });
  const q = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['credit-purchases', params.search, page, limit],
    queryFn: () => api.get<PaginatedWithCounts<Purchase>>('/admin/credits/purchases', { search: params.search, page, limit }),
  });
  const columns: Column<Purchase>[] = [
    { key: 'code', header: 'Mã', mobile: 'primary', cell: (r) => <div className="font-mono font-semibold">#{r.code}</div> },
    { key: 'user', header: 'Khách', cell: (r) => <UserCell user={r.user} /> },
    {
      key: 'plan',
      header: 'Gói',
      cell: (r) => (
        <div className="flex items-center gap-1.5">
          {r.planName} <Badge variant={r.cycle === 'pack' ? 'default' : 'secondary'}>{CYCLE_LABEL[r.cycle] ?? r.cycle}</Badge>
        </div>
      ),
    },
    { key: 'paid', header: 'Thanh toán', cell: (r) => <span className="tabular-nums">{formatMoney(r.paid)}{r.discount > 0 ? ` (-${r.discount}%)` : ''}</span> },
    {
      key: 'credits',
      header: 'Nhận vào ví',
      cell: (r) => (
        <div className="tabular-nums">
          +{fmtCredits(r.credits)}
          {r.refillsLeft > 0 && <div className="text-[11px] text-muted-foreground">còn {r.refillsLeft} lần cộng</div>}
        </div>
      ),
    },
    { key: 'time', header: 'Thời gian', cell: (r) => <span className="text-xs">{formatDate(r.createdAt)}</span> },
  ];
  return (
    <div className="space-y-4">
      <ListToolbar search={params.search} onSearchChange={(v) => set({ search: v })} placeholder="Tìm email / tên khách..." />
      <DataTable columns={columns} data={q.data?.data} meta={q.data?.meta} loading={q.isLoading} error={q.error} onPageChange={(p) => set({ page: p })} onLimitChange={(l) => set({ limit: l })} emptyTitle="Chưa có lượt mua" />
    </div>
  );
}

interface CreditTxn {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
  createdBy: { id: string; name: string } | null;
}

function CreditTxnTab() {
  const { params, set, page, limit } = useListParams<Record<string, string>>({ tab: 'transactions', search: '' });
  const q = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['credit-txns', params.search, page, limit],
    queryFn: () => api.get<PaginatedWithCounts<CreditTxn>>('/admin/credits/transactions', { search: params.search, page, limit }),
  });
  const columns: Column<CreditTxn>[] = [
    { key: 'time', header: 'Thời gian', mobile: 'primary', cell: (r) => <span className="text-xs whitespace-nowrap">{formatDate(r.createdAt)}</span> },
    { key: 'user', header: 'Khách', cell: (r) => <UserCell user={r.user} /> },
    { key: 'type', header: 'Loại', cell: (r) => <ToneBadge map={CREDIT_TXN} value={r.type} /> },
    { key: 'note', header: 'Diễn giải', cell: (r) => <span className="line-clamp-1 max-w-72 text-sm">{r.note}{r.createdBy ? ` · ${r.createdBy.name}` : ''}</span> },
    { key: 'amount', header: 'Số tiền', cell: (r) => <span className={r.amount > 0 ? 'font-semibold text-emerald-600' : 'font-semibold text-red-600'}>{r.amount > 0 ? '+' : ''}{fmtCredits(r.amount)}</span> },
    { key: 'after', header: 'Số dư sau', cell: (r) => <span className="tabular-nums">{fmtCredits(r.balanceAfter)}</span> },
  ];
  return (
    <div className="space-y-4">
      <ListToolbar search={params.search} onSearchChange={(v) => set({ search: v })} placeholder="Tìm email / tên khách..." />
      <DataTable columns={columns} data={q.data?.data} meta={q.data?.meta} loading={q.isLoading} error={q.error} onPageChange={(p) => set({ page: p })} onLimitChange={(l) => set({ limit: l })} emptyTitle="Chưa có biến động" />
    </div>
  );
}

export default function PlansPage() {
  return (
    <Suspense>
      <PlansContent />
    </Suspense>
  );
}
