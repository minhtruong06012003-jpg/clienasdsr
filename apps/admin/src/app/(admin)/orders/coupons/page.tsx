'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Dices, Loader2, MoreHorizontal, Pencil, Plus, Power, PowerOff, Trash2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { Field } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput, NumberInput } from '@/components/commerce/number-input';
import { ProductPicker } from '@/components/commerce/product-picker';
import { COUPON_TYPES, flattenTree, fromLocalInput, toLocalInput, toNum, toNumOrNull } from '@/components/commerce/utils';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, formatMoney, pickTr } from '@/lib/format';
import { useLanguages } from '@/hooks/use-languages';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';

type CouponType = 'PERCENT' | 'FIXED' | 'FREE_SHIPPING';

interface Coupon {
  id: string;
  code: string;
  description: string | null;
  type: CouponType;
  value: unknown;
  minOrderTotal: unknown;
  maxDiscount: unknown;
  usageLimit: number | null;
  usedCount: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
  productIds: string[];
  excludeProductIds: string[];
  categoryIds: string[];
  perUserLimit: number | null;
  firstOrderOnly: boolean;
  _count?: { usages: number };
}

interface CategoryRow {
  id: string;
  parentId: string | null;
  translations: { locale: string; name: string }[];
}

type CouponList = Paginated<Coupon> & { statusCounts?: Record<string, number> };

const STATUS_TABS = [
  { value: 'all', label: 'Tất cả' },
  { value: 'active', label: 'Đang hiệu lực' },
  { value: 'scheduled', label: 'Chưa bắt đầu' },
  { value: 'expired', label: 'Hết hạn' },
  { value: 'inactive', label: 'Đã tắt' },
];

interface FormState {
  code: string;
  description: string;
  type: CouponType;
  value: number | null;
  minOrderTotal: number | null;
  maxDiscount: number | null;
  usageLimit: number | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  productIds: string[];
  excludeProductIds: string[];
  categoryIds: string[];
  perUserLimit: number | null;
  firstOrderOnly: boolean;
}

const couponState = (c: Coupon) => {
  const now = Date.now();
  if (!c.isActive) return { label: 'Đã tắt', className: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' };
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) return { label: 'Hết lượt', className: 'bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300' };
  if (c.endsAt && new Date(c.endsAt).getTime() < now) return { label: 'Hết hạn', className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' };
  if (c.startsAt && new Date(c.startsAt).getTime() > now) return { label: 'Chưa bắt đầu', className: 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300' };
  return { label: 'Đang chạy', className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' };
};

const valueText = (c: { type: CouponType; value: unknown }) => (c.type === 'PERCENT' ? `${toNum(c.value)}%` : c.type === 'FIXED' ? formatMoney(toNum(c.value)) : 'Miễn phí ship');

const toBody = (c: Coupon) => ({
  code: c.code,
  description: c.description ?? undefined,
  type: c.type,
  value: toNum(c.value),
  minOrderTotal: toNumOrNull(c.minOrderTotal),
  maxDiscount: toNumOrNull(c.maxDiscount),
  usageLimit: c.usageLimit,
  startsAt: c.startsAt,
  endsAt: c.endsAt,
  isActive: c.isActive,
  productIds: c.productIds ?? [],
  excludeProductIds: c.excludeProductIds ?? [],
  categoryIds: c.categoryIds ?? [],
  perUserLimit: c.perUserLimit,
  firstOrderOnly: c.firstOrderOnly,
});

/** Mô tả ngắn điều kiện áp dụng để hiện trong bảng */
function restrictionText(c: Coupon) {
  const parts: string[] = [];
  if (c.productIds?.length) parts.push(`${c.productIds.length} sản phẩm`);
  if (c.categoryIds?.length) parts.push(`${c.categoryIds.length} danh mục`);
  if (c.excludeProductIds?.length) parts.push(`trừ ${c.excludeProductIds.length} SP`);
  return parts.join(' · ');
}

function CouponsList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { params, set, page, limit } = useListParams({ search: '', status: 'all' });
  const [editing, setEditing] = useState<Coupon | 'new' | null>(null);
  const canEdit = can('coupons.manage');
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // ?new=1 (từ nút "Tạo mới" / Tìm nhanh) -> mở ngay hộp thoại tạo mã
  useEffect(() => {
    if (sp.get('new') !== '1') return;
    if (canEdit) setEditing('new');
    router.replace(pathname, { scroll: false });
  }, [sp, canEdit, router, pathname]);

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['coupons', params], queryFn: () => api.get<CouponList>('/admin/coupons', { search: params.search, status: params.status === 'all' ? undefined : params.status, page, limit }),
  });
  const counts = list.data?.statusCounts;

  // id các mã đang tích chọn để thao tác hàng loạt (giữ qua các trang)
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();
  // nhớ dữ liệu các mã đã tải: PATCH bật/tắt cần gửi đủ body, kể cả mã được chọn ở trang khác
  const seen = useRef(new Map<string, Coupon>());
  useEffect(() => {
    for (const c of list.data?.data ?? []) seen.current.set(c.id, c);
  }, [list.data]);

  /** Làm mới danh sách và bỏ chọn sau khi xong thao tác hàng loạt */
  const afterBulk = () => {
    setSelected([]);
    void qc.invalidateQueries({ queryKey: ['coupons'] });
  };

  /** Bật/tắt hàng loạt: dùng lại PATCH đơn lẻ (giống công tắc trên từng dòng), bỏ qua mã đã đúng trạng thái */
  const bulkSetActive = (isActive: boolean) =>
    bulk.run({
      ids: [...selected],
      action: async (id) => {
        const c = seen.current.get(id);
        if (!c) throw new Error('Không tìm thấy dữ liệu mã, hãy tải lại trang');
        if (c.isActive === isActive) return;
        await api.patch(`/admin/coupons/${id}`, { ...toBody(c), isActive });
      },
      doneLabel: isActive ? 'Đã bật' : 'Đã tắt',
      onDone: afterBulk,
    });

  /** Xoá hàng loạt: hỏi xác nhận rồi gọi endpoint xoá đơn lẻ cho từng mã */
  const bulkRemove = async () => {
    const ids = [...selected];
    const used = ids.filter((id) => (seen.current.get(id)?.usedCount ?? 0) > 0).length;
    if (!(await confirm({ title: `Xoá ${ids.length} mã giảm giá?`, description: used ? `${used} mã đã được dùng. Đơn hàng cũ vẫn giữ thông tin mã.` : undefined, destructive: true, confirmText: 'Xoá' }))) return;
    await bulk.run({ ids, action: (id) => api.delete(`/admin/coupons/${id}`), doneLabel: 'Đã xoá', onDone: afterBulk });
  };

  const toggle = useMutation({
    mutationFn: (c: Coupon) => api.patch(`/admin/coupons/${c.id}`, { ...toBody(c), isActive: !c.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['coupons'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = async (c: Coupon) => {
    if (!(await confirm({ title: `Xoá mã "${c.code}"?`, description: c.usedCount ? `Mã đã được dùng ${c.usedCount} lần. Đơn hàng cũ vẫn giữ thông tin mã.` : undefined, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/coupons/${c.id}`);
      toast.success('Đã xoá mã giảm giá');
      void qc.invalidateQueries({ queryKey: ['coupons'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<Coupon>[] = [
    {
      key: 'code',
      header: 'Mã',
      cell: (c) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <button type="button" className="font-mono font-semibold tracking-wide hover:text-primary" onClick={() => canEdit && setEditing(c)}>
              {c.code}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Sao chép mã"
              onClick={() => {
                void navigator.clipboard?.writeText(c.code);
                toast.success('Đã sao chép mã');
              }}
            >
              <Copy />
            </Button>
          </div>
          {c.description && <div className="line-clamp-1 max-w-xs text-xs text-muted-foreground">{c.description}</div>}
        </div>
      ),
    },
    {
      key: 'value',
      header: 'Giảm',
      cell: (c) => (
        <div className="whitespace-nowrap">
          <span className="font-semibold">{valueText(c)}</span>
          {c.type === 'PERCENT' && toNumOrNull(c.maxDiscount) != null && <div className="text-xs text-muted-foreground">Tối đa {formatMoney(toNum(c.maxDiscount))}</div>}
        </div>
      ),
    },
    {
      key: 'min',
      header: 'Điều kiện',
      cell: (c) => {
        const r = restrictionText(c);
        return (
          <div className="whitespace-nowrap text-xs">
            <div className="tabular-nums">{toNumOrNull(c.minOrderTotal) != null ? `Đơn từ ${formatMoney(toNum(c.minOrderTotal))}` : 'Mọi đơn'}</div>
            {r && <div className="text-muted-foreground">{r}</div>}
            {c.firstOrderOnly && <div className="text-amber-700 dark:text-amber-400">Chỉ đơn đầu tiên</div>}
          </div>
        );
      },
    },
    {
      key: 'usage',
      header: 'Lượt dùng',
      cell: (c) => (
        <div className="w-28 space-y-1">
          <div className="text-sm tabular-nums">
            {c.usedCount}
            <span className="text-muted-foreground"> / {c.usageLimit ?? '∞'}</span>
          </div>
          {c.usageLimit != null && <Progress value={Math.min(100, (c.usedCount / Math.max(1, c.usageLimit)) * 100)} className="h-1.5" />}
          {c.perUserLimit != null && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <UserRound className="size-3" /> {c.perUserLimit} lần / khách
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'time',
      header: 'Thời gian',
      cell: (c) => (
        <div className="whitespace-nowrap text-xs">
          <div>
            <span className="text-muted-foreground">Từ </span>
            {c.startsAt ? formatDate(c.startsAt) : 'ngay'}
          </div>
          <div>
            <span className="text-muted-foreground">Đến </span>
            {c.endsAt ? formatDate(c.endsAt) : 'không giới hạn'}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (c) => {
        const s = couponState(c);
        return (
          <div className="flex items-center gap-2">
            <Switch size="sm" checked={c.isActive} disabled={!canEdit || toggle.isPending} onCheckedChange={() => toggle.mutate(c)} aria-label="Bật/tắt" />
            <Badge className={cn('border-transparent font-medium', s.className)}>{s.label}</Badge>
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (c) =>
        canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(c)}>
                <Pencil /> Chỉnh sửa
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => remove(c)}>
                <Trash2 /> Xoá
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Mã giảm giá"
        description="Tạo mã khuyến mãi cho khách khi thanh toán"
        breadcrumbs={[{ label: 'Đơn hàng', href: '/orders' }, { label: 'Mã giảm giá' }]}
        actions={
          canEdit && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Tạo mã giảm giá
            </Button>
          )
        }
      />
      <PageBody className="space-y-4">
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo mã hoặc mô tả..."
          filters={<StatusTabs value={params.status} onChange={(v) => set({ status: v })} options={STATUS_TABS.map((t) => ({ ...t, count: t.value === 'all' ? undefined : counts?.[t.value] }))} />}
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            canEdit && (
              <>
                <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => bulkSetActive(true)}>
                  <Power /> Bật
                </Button>
                <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => bulkSetActive(false)}>
                  <PowerOff /> Tắt
                </Button>
                <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={bulkRemove}>
                  {bulk.pending ? <Loader2 className="animate-spin" /> : <Trash2 />} Xoá
                </Button>
              </>
            )
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          // chỉ cho tích chọn khi có quyền quản lý mã (bật/tắt, xoá)
          selectable={canEdit}
          selected={selected}
          onSelectedChange={setSelected}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          emptyTitle={params.search || params.status !== 'all' ? 'Không tìm thấy mã giảm giá' : 'Chưa có mã giảm giá'}
          emptyAction={
            canEdit && !params.search && params.status === 'all' ? (
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus /> Tạo mã đầu tiên
              </Button>
            ) : undefined
          }
        />
      </PageBody>
      <CouponDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

const randomCode = () => Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');

const emptyForm = (): FormState => ({
  code: '',
  description: '',
  type: 'PERCENT',
  value: null,
  minOrderTotal: null,
  maxDiscount: null,
  usageLimit: null,
  startsAt: '',
  endsAt: '',
  isActive: true,
  productIds: [],
  excludeProductIds: [],
  categoryIds: [],
  perUserLimit: null,
  firstOrderOnly: false,
});

/** Chọn nhiều danh mục sản phẩm (cây phẳng có thụt lề) */
function CategoryPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { defaultLocale } = useLanguages();
  const cats = useQuery({ queryKey: ['product-categories'], queryFn: () => api.get<CategoryRow[]>('/admin/products/categories'), staleTime: 60_000 });
  const rows = flattenTree(cats.data ?? []);
  if (cats.isLoading) return <p className="text-xs text-muted-foreground">Đang tải danh mục...</p>;
  if (!rows.length) return <p className="text-xs text-muted-foreground">Chưa có danh mục sản phẩm</p>;
  return (
    <div className="max-h-44 overflow-y-auto rounded-lg border p-1.5">
      {rows.map((c) => (
        <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted" style={{ paddingLeft: 8 + c.depth * 16 }}>
          <Checkbox checked={value.includes(c.id)} onCheckedChange={(on) => onChange(on ? [...value, c.id] : value.filter((x) => x !== c.id))} />
          <span className="truncate">{pickTr(c.translations, defaultLocale)?.name ?? '(chưa có tên)'}</span>
        </label>
      ))}
    </div>
  );
}

function CouponDialog({ editing, onClose }: { editing: Coupon | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm);
  const coupon = editing && editing !== 'new' ? editing : null;
  const up = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!editing) return;
    setForm(
      coupon
        ? {
            code: coupon.code,
            description: coupon.description ?? '',
            type: coupon.type,
            value: toNum(coupon.value),
            minOrderTotal: toNumOrNull(coupon.minOrderTotal),
            maxDiscount: toNumOrNull(coupon.maxDiscount),
            usageLimit: coupon.usageLimit,
            startsAt: toLocalInput(coupon.startsAt),
            endsAt: toLocalInput(coupon.endsAt),
            isActive: coupon.isActive,
            productIds: coupon.productIds ?? [],
            excludeProductIds: coupon.excludeProductIds ?? [],
            categoryIds: coupon.categoryIds ?? [],
            perUserLimit: coupon.perUserLimit,
            firstOrderOnly: coupon.firstOrderOnly,
          }
        : emptyForm(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const save = useMutation({
    mutationFn: () => {
      const code = form.code.trim().toUpperCase();
      if (!code) throw new Error('Vui lòng nhập mã giảm giá');
      if (!/^[A-Z0-9_-]+$/.test(code)) throw new Error('Mã chỉ gồm chữ, số, gạch ngang hoặc gạch dưới');
      if (form.type !== 'FREE_SHIPPING' && !form.value) throw new Error('Vui lòng nhập giá trị giảm');
      if (form.type === 'PERCENT' && (form.value ?? 0) > 100) throw new Error('Phần trăm giảm tối đa 100');
      if (form.startsAt && form.endsAt && form.startsAt >= form.endsAt) throw new Error('Thời gian kết thúc phải sau thời gian bắt đầu');
      const body = {
        code,
        description: form.description.trim(),
        type: form.type,
        value: form.type === 'FREE_SHIPPING' ? 0 : (form.value ?? 0),
        minOrderTotal: form.minOrderTotal,
        maxDiscount: form.type === 'PERCENT' ? form.maxDiscount : null,
        usageLimit: form.usageLimit,
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
        isActive: form.isActive,
        productIds: form.productIds,
        excludeProductIds: form.excludeProductIds,
        categoryIds: form.categoryIds,
        perUserLimit: form.perUserLimit,
        firstOrderOnly: form.firstOrderOnly,
      };
      return coupon ? api.patch(`/admin/coupons/${coupon.id}`, body) : api.post('/admin/coupons', body);
    },
    onSuccess: () => {
      toast.success(coupon ? 'Đã lưu mã giảm giá' : 'Đã tạo mã giảm giá');
      void qc.invalidateQueries({ queryKey: ['coupons'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{coupon ? `Sửa mã ${coupon.code}` : 'Tạo mã giảm giá'}</DialogTitle>
          <DialogDescription>{coupon ? `Đã dùng ${coupon.usedCount} lần` : 'Khách nhập mã này ở bước thanh toán để được giảm giá.'}</DialogDescription>
        </DialogHeader>
        <form
          id="coupon-form"
          className="grid max-h-[65vh] gap-4 overflow-y-auto px-0.5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Mã giảm giá" required>
            <div className="flex gap-2">
              <Input value={form.code} onChange={(e) => up({ code: e.target.value.toUpperCase().replace(/\s/g, '') })} className="font-mono uppercase" placeholder="VD: SALE10" autoFocus />
              <Button type="button" variant="outline" size="icon" title="Tạo mã ngẫu nhiên" onClick={() => up({ code: randomCode() })}>
                <Dices />
              </Button>
            </div>
          </Field>
          <Field label="Loại giảm giá">
            <Select value={form.type} onValueChange={(v) => up({ type: v as CouponType })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUPON_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Mô tả" className="sm:col-span-2">
            <Input value={form.description} onChange={(e) => up({ description: e.target.value })} placeholder="Ghi chú nội bộ, vd: Khuyến mãi khai trương" />
          </Field>
          {form.type === 'PERCENT' && (
            <>
              <Field label="Phần trăm giảm" required>
                <NumberInput value={form.value} onChange={(v) => up({ value: v })} min={0} suffix="%" />
              </Field>
              <Field label="Giảm tối đa" help="Để trống = không giới hạn">
                <MoneyInput value={form.maxDiscount} onChange={(v) => up({ maxDiscount: v })} />
              </Field>
            </>
          )}
          {form.type === 'FIXED' && (
            <Field label="Số tiền giảm" required>
              <MoneyInput value={form.value} onChange={(v) => up({ value: v })} />
            </Field>
          )}
          <Field label="Giá trị đơn tối thiểu" help="Tính trên tạm tính">
            <MoneyInput value={form.minOrderTotal} onChange={(v) => up({ minOrderTotal: v })} placeholder="Không yêu cầu" />
          </Field>
          <Field label="Giới hạn lượt dùng" help={coupon ? `Đã dùng ${coupon.usedCount} lượt` : 'Để trống = không giới hạn'}>
            <NumberInput value={form.usageLimit} onChange={(v) => up({ usageLimit: v })} integer min={0} placeholder="Không giới hạn" />
          </Field>
          <Field label="Bắt đầu">
            <Input type="datetime-local" value={form.startsAt} onChange={(e) => up({ startsAt: e.target.value })} />
          </Field>
          <Field label="Kết thúc">
            <Input type="datetime-local" value={form.endsAt} onChange={(e) => up({ endsAt: e.target.value })} />
          </Field>

          <div className="space-y-4 rounded-lg border p-3 sm:col-span-2">
            <div>
              <p className="text-sm font-semibold">Điều kiện áp dụng</p>
              <p className="text-xs text-muted-foreground">Để trống = áp dụng cho mọi sản phẩm. Có chọn sản phẩm/danh mục thì chỉ giảm trên các dòng hàng thuộc danh sách đó (sản phẩm loại trừ luôn không được giảm).</p>
            </div>
            <Field label="Áp dụng cho sản phẩm">
              <ProductPicker value={form.productIds} onChange={(productIds) => up({ productIds })} exclude={form.excludeProductIds} emptyText="Mọi sản phẩm" />
            </Field>
            <Field label="Áp dụng cho danh mục">
              <CategoryPicker value={form.categoryIds} onChange={(categoryIds) => up({ categoryIds })} />
            </Field>
            <Field label="Loại trừ sản phẩm">
              <ProductPicker value={form.excludeProductIds} onChange={(excludeProductIds) => up({ excludeProductIds })} exclude={form.productIds} emptyText="Không loại trừ sản phẩm nào" placeholder="Tìm sản phẩm không được giảm..." />
            </Field>
          </div>

          <Field label="Giới hạn mỗi khách" help="Số lần một khách (theo tài khoản hoặc email) được dùng mã. Để trống = không giới hạn.">
            <NumberInput value={form.perUserLimit} onChange={(v) => up({ perUserLimit: v })} integer min={1} placeholder="Không giới hạn" suffix="lần" />
          </Field>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label>Chỉ đơn hàng đầu tiên</Label>
              <p className="text-xs text-muted-foreground">Khách đã có đơn (chưa huỷ) không dùng được</p>
            </div>
            <Switch checked={form.firstOrderOnly} onCheckedChange={(firstOrderOnly) => up({ firstOrderOnly })} />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
            <div>
              <Label>Kích hoạt</Label>
              <p className="text-xs text-muted-foreground">Tắt để tạm ngừng áp dụng mã</p>
            </div>
            <Switch checked={form.isActive} onCheckedChange={(v) => up({ isActive: v })} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="submit" form="coupon-form" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CouponsPage() {
  return (
    <Suspense>
      <CouponsList />
    </Suspense>
  );
}
