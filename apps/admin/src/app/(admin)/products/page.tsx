'use client';

import Link from 'next/link';
import { Suspense, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, MoreHorizontal, Pencil, Plus, RotateCcw, SquarePen, Star, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { StatusBadge } from '@/components/common/status-badge';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ContentDateCell } from '@/components/common/date-cell';
import { QuickEditDialog, type QuickEditBase } from '@/components/common/quick-edit-dialog';
import { Field } from '@/components/common/field';
import { MoneyInput, NumberInput } from '@/components/commerce/number-input';
import { ExportCsvButton, ProductImportDialog } from '@/components/commerce/product-import-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatMoney, pickTr } from '@/lib/format';
import { contentStatusTabs, type StatusCounts } from '@/lib/publish';
import { HAS_WEB_URL, siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import type { ContentStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useListLocale } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';
import { flattenTree, fromLocalInput, PRODUCT_TYPES, STOCK_STATUSES, toLocalInput, toNum, toNumOrNull } from '@/components/commerce/utils';

interface ProductRow {
  id: string;
  type: 'SIMPLE' | 'VARIABLE' | 'DIGITAL';
  status: string;
  sku: string | null;
  price: unknown;
  salePrice: unknown;
  manageStock: boolean;
  stockQuantity: number;
  stockStatus: string;
  lowStockThreshold: number | null;
  isFeatured: boolean;
  soldCount: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  featuredImage: { url: string; urls: Record<string, string> } | null;
  brand: { id: string; name: string } | null;
  translations: { locale: string; name: string; slug: string }[];
  categories: { category: { id: string; translations: { locale: string; name: string }[] } }[];
  _count: { variants: number };
  /** sản phẩm ảo (không cần giao hàng) — có khi API đã có module kho mã */
  isVirtual?: boolean;
  /** bán theo kho mã: tồn kho = số mã còn trong kho */
  codeDelivery?: boolean;
}

interface Category {
  id: string;
  parentId: string | null;
  translations: { locale: string; name: string }[];
}

interface QuickEditProduct extends QuickEditBase {
  id: string;
  locale: string;
  type: ProductRow['type'];
  sku: string;
  price: number | null;
  salePrice: number | null;
  manageStock: boolean;
  stockQuantity: number | null;
  stockStatus: string;
  isFeatured: boolean;
  /** bán theo kho mã -> tồn kho chỉ đọc (tự tính theo số mã) */
  codeDelivery: boolean;
}

function ProductsList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { locale, setLocale, languages, defaultLocale } = useListLocale();
  const { params, set, page, limit } = useListParams({ status: '', search: '', categoryId: '', brandId: '', type: '', stockStatus: '', trashed: '', sort: 'createdAt', order: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [quick, setQuick] = useState<QuickEditProduct | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const trashed = params.trashed === '1';

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['products', params],
    queryFn: () => api.get<Paginated<ProductRow> & { statusCounts?: StatusCounts }>('/admin/products', { ...params, page, limit }),
  });
  const categories = useQuery({ queryKey: ['product-categories', 'all'], queryFn: () => api.get<Category[]>('/admin/products/categories') });
  const brands = useQuery({ queryKey: ['product-brands'], queryFn: () => api.get<{ id: string; name: string }[]>('/admin/products/brands') });
  const categoryTree = useMemo(() => flattenTree(categories.data ?? []), [categories.data]);

  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: string }) => api.post<{ success: boolean; skipped?: number; message?: string }>('/admin/products/bulk', { ids, action }),
    onSuccess: (r) => {
      // xoá vĩnh viễn: sản phẩm đã có mã giao cho khách bị bỏ qua -> báo cho admin
      if (r?.skipped) toast.warning(r.message ?? `Bỏ qua ${r.skipped} sản phẩm`);
      else toast.success('Đã cập nhật');
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<{ id: string }>(`/admin/products/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Đã nhân bản sản phẩm (bản nháp)');
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const runBulk = async (ids: string[], action: string) => {
    if (action === 'destroy' && !(await confirm({ title: `Xoá vĩnh viễn ${ids.length} sản phẩm?`, description: 'Không thể khôi phục sau khi xoá. Đơn hàng cũ vẫn giữ thông tin sản phẩm.', destructive: true, confirmText: 'Xoá vĩnh viễn' }))) return;
    bulk.mutate({ ids, action });
  };

  const openQuickEdit = (r: ProductRow) => {
    const tr = pickTr(r.translations, locale);
    if (!tr) return;
    setQuick({
      id: r.id,
      locale: tr.locale,
      title: tr.name,
      slug: tr.slug,
      status: r.status as ContentStatus,
      publishedAt: toLocalInput(r.publishedAt),
      type: r.type,
      sku: r.sku ?? '',
      price: toNumOrNull(r.price),
      salePrice: toNumOrNull(r.salePrice),
      manageStock: r.manageStock,
      stockQuantity: r.stockQuantity,
      stockStatus: r.stockStatus,
      isFeatured: r.isFeatured,
      codeDelivery: !!r.codeDelivery,
    });
  };
  const saveQuick = async (f: QuickEditProduct) => {
    if (f.type !== 'VARIABLE' && f.salePrice != null && f.salePrice >= (f.price ?? 0)) throw new Error('Giá khuyến mãi phải nhỏ hơn giá bán');
    await api.patch(`/admin/products/${f.id}`, {
      status: f.status,
      publishedAt: f.publishedAt ? fromLocalInput(f.publishedAt) : undefined,
      sku: f.sku.trim() || null,
      isFeatured: f.isFeatured,
      // sản phẩm có biến thể: giá/kho tính từ biến thể -> không sửa nhanh
      ...(f.type !== 'VARIABLE' ? { price: f.price ?? 0, salePrice: f.salePrice, manageStock: f.manageStock, stockStatus: f.stockStatus, ...(f.codeDelivery ? {} : { stockQuantity: f.stockQuantity ?? 0 }) } : {}),
      translations: [{ locale: f.locale, name: f.title, slug: f.slug }],
    });
    toast.success('Đã cập nhật sản phẩm');
    void qc.invalidateQueries({ queryKey: ['products'] });
    void qc.invalidateQueries({ queryKey: ['product', f.id] });
  };

  const columns: Column<ProductRow>[] = [
    {
      key: 'name',
      header: 'Sản phẩm',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        return (
          <div className="flex min-w-56 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {r.featuredImage ? <img src={r.featuredImage.urls.thumb ?? r.featuredImage.url} alt="" className="size-11 shrink-0 rounded-md border object-cover" /> : <div className="size-11 shrink-0 rounded-md bg-muted" />}
            <div className="min-w-0">
              <Link href={`/products/${r.id}`} className="line-clamp-1 font-medium hover:text-primary">
                {tr?.name ?? '(chưa có tên)'}
                {tr && tr.locale !== locale && <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">[{tr.locale}]</span>}
              </Link>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {languages.length > 1 && (
                  <span className="flex gap-1">
                    {languages.map((l) => (
                      <span key={l.code} className={r.translations.some((t) => t.locale === l.code) ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-40'} title={l.name}>
                        {l.code.toUpperCase()}
                      </span>
                    ))}
                  </span>
                )}
                {r.type !== 'SIMPLE' && <span>· {r.type === 'VARIABLE' ? 'Có biến thể' : 'Sản phẩm số'}</span>}
                {/* nhãn nhỏ: bán theo kho mã / sản phẩm ảo (không cần giao hàng) */}
                {r.codeDelivery ? (
                  <Badge variant="outline" className="h-4 border-violet-300 px-1 text-[10px] text-violet-700 dark:border-violet-800 dark:text-violet-300">Kho mã</Badge>
                ) : r.isVirtual && r.type !== 'DIGITAL' ? (
                  <Badge variant="outline" className="h-4 px-1 text-[10px]">Ảo</Badge>
                ) : null}
                {r.brand && <span>· {r.brand.name}</span>}
              </div>
            </div>
          </div>
        );
      },
    },
    { key: 'sku', header: 'SKU', cell: (r) => <span className="font-mono text-xs">{r.sku || '—'}</span> },
    {
      key: 'price',
      header: 'Giá',
      sortable: true,
      cell: (r) => {
        const price = toNum(r.price);
        const sale = toNumOrNull(r.salePrice);
        return (
          <div className="whitespace-nowrap tabular-nums">
            {r.type === 'VARIABLE' && <span className="text-xs text-muted-foreground">Từ </span>}
            {sale != null && sale < price ? (
              <>
                <span className="font-medium text-red-600 dark:text-red-400">{formatMoney(sale)}</span>
                <div className="text-xs text-muted-foreground line-through">{formatMoney(price)}</div>
              </>
            ) : (
              <span className="font-medium">{formatMoney(price)}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'stockQuantity',
      header: 'Kho',
      sortable: true,
      cell: (r) => {
        const low = r.manageStock && r.stockStatus === 'IN_STOCK' && r.lowStockThreshold != null && r.stockQuantity <= r.lowStockThreshold;
        return (
          <div className="space-y-0.5">
            <StatusBadge status={r.stockStatus} />
            {r.manageStock && <div className={cn('text-xs tabular-nums', low ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>{low ? `Sắp hết: ${r.stockQuantity}` : `${r.stockQuantity} trong kho`}</div>}
          </div>
        );
      },
    },
    {
      key: 'variants',
      header: 'Biến thể',
      cell: (r) => (r.type === 'VARIABLE' ? <Badge variant="secondary">{r._count.variants}</Badge> : <span className="text-muted-foreground">—</span>),
    },
    {
      key: 'categories',
      header: 'Danh mục',
      cell: (r) => <span className="line-clamp-2 text-sm text-muted-foreground">{r.categories.map((c) => pickTr(c.category.translations, locale)?.name).join(', ') || '—'}</span>,
    },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'featured',
      header: <Star className="size-3.5" />,
      className: 'w-10',
      // thẻ điện thoại: nút ngôi sao nằm cạnh menu ⋯ thay vì thành một ô có nhãn là icon
      mobile: 'action',
      cell: (r) => (
        <button
          type="button"
          title={r.isFeatured ? 'Bỏ nổi bật' : 'Đánh dấu nổi bật'}
          disabled={!can('products.write') || trashed}
          onClick={() => bulk.mutate({ ids: [r.id], action: r.isFeatured ? 'unfeature' : 'feature' })}
          className="text-muted-foreground transition hover:text-amber-500 disabled:pointer-events-none"
        >
          <Star className={cn('size-4', r.isFeatured && 'fill-amber-400 text-amber-400')} />
        </button>
      ),
    },
    { key: 'soldCount', header: 'Đã bán', sortable: true, cell: (r) => <span className="tabular-nums">{r.soldCount}</span> },
    { key: 'createdAt', header: 'Ngày', sortable: true, cell: (r) => <ContentDateCell status={r.status} publishedAt={r.publishedAt} fallback={r.createdAt} fallbackLabel="Tạo" /> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {trashed ? (
                <>
                  {can('products.delete') ? (
                    <DropdownMenuItem onClick={() => runBulk([r.id], 'restore')}>
                      <RotateCcw /> Khôi phục
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem disabled>Cần quyền xoá sản phẩm</DropdownMenuItem>
                  )}
                  {can('products.delete') && (
                    <DropdownMenuItem variant="destructive" onClick={() => runBulk([r.id], 'destroy')}>
                      <Trash2 /> Xoá vĩnh viễn
                    </DropdownMenuItem>
                  )}
                </>
              ) : (
                <>
                  <DropdownMenuItem asChild>
                    <Link href={`/products/${r.id}`}>
                      <Pencil /> Chỉnh sửa
                    </Link>
                  </DropdownMenuItem>
                  {can('products.write') && tr && (
                    <DropdownMenuItem onClick={() => openQuickEdit(r)}>
                      <SquarePen /> Sửa nhanh
                    </DropdownMenuItem>
                  )}
                  {HAS_WEB_URL && tr && r.status === 'PUBLISHED' && (
                    <DropdownMenuItem asChild>
                      <a href={siteUrl('product', tr.slug, tr.locale, defaultLocale)} target="_blank" rel="noreferrer">
                        <ExternalLink /> Xem trên web
                      </a>
                    </DropdownMenuItem>
                  )}
                  {can('products.write') && (
                    <DropdownMenuItem onClick={() => duplicate.mutate(r.id)}>
                      <Copy /> Nhân bản
                    </DropdownMenuItem>
                  )}
                  {can('products.delete') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => runBulk([r.id], 'trash')}>
                        <Trash2 /> Chuyển vào thùng rác
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const filterSelect = (key: 'categoryId' | 'brandId' | 'type' | 'stockStatus', placeholder: string, allLabel: string, options: { value: string; label: string }[], width = 'w-44') => (
    <Select value={params[key] || 'all'} onValueChange={(v) => set({ [key]: v === 'all' ? '' : v })}>
      <SelectTrigger className={width}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <>
      <PageHeader
        title="Sản phẩm"
        description="Quản lý sản phẩm, giá bán và tồn kho"
        actions={
          <>
            <LocaleTabs languages={languages} value={locale} onChange={setLocale} />
            {can('products.write') && !trashed && <ExportCsvButton params={{ ...params, locale }} />}
            {can('products.write') && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload /> Nhập CSV
              </Button>
            )}
            {can('products.write') && (
              <Button asChild>
                <Link href="/products/new">
                  <Plus /> Thêm sản phẩm
                </Link>
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        <StatusTabs
          value={trashed ? 'trash' : params.status}
          onChange={(v) => (v === 'trash' ? set({ trashed: '1', status: '' }) : set({ status: v, trashed: '' }))}
          options={contentStatusTabs(list.data?.statusCounts)}
        />
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo tên, SKU..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          filters={
            <>
              {filterSelect(
                'categoryId',
                'Danh mục',
                'Tất cả danh mục',
                categoryTree.map((c) => ({ value: c.id, label: `${'— '.repeat(c.depth)}${pickTr(c.translations, locale)?.name ?? ''}` })),
                'w-48',
              )}
              {filterSelect(
                'brandId',
                'Thương hiệu',
                'Tất cả thương hiệu',
                (brands.data ?? []).map((b) => ({ value: b.id, label: b.name })),
              )}
              {filterSelect('type', 'Loại', 'Tất cả loại', PRODUCT_TYPES.map((t) => ({ ...t })))}
              {filterSelect('stockStatus', 'Tình trạng kho', 'Mọi tình trạng kho', STOCK_STATUSES.map((s) => ({ ...s })))}
            </>
          }
          bulkActions={
            trashed ? (
              <>
                {can('products.delete') && (
                  <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'restore')}>
                    Khôi phục
                  </Button>
                )}
                {can('products.delete') && (
                  <Button size="sm" variant="destructive" onClick={() => runBulk(selected, 'destroy')}>
                    Xoá vĩnh viễn
                  </Button>
                )}
              </>
            ) : (
              <>
                {can('products.publish') && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'publish')}>
                      Xuất bản
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'draft')}>
                      Chuyển nháp
                    </Button>
                  </>
                )}
                <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'feature')}>
                  Nổi bật
                </Button>
                <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'unfeature')}>
                  Bỏ nổi bật
                </Button>
                {can('products.delete') && (
                  <Button size="sm" variant="destructive" onClick={() => runBulk(selected, 'trash')}>
                    Thùng rác
                  </Button>
                )}
              </>
            )
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          selectable={can('products.write')}
          selected={selected}
          onSelectedChange={setSelected}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          sort={{ key: params.sort, order: params.order as 'asc' | 'desc' }}
          onSortChange={(s) => set({ sort: s.key, order: s.order })}
          emptyTitle={trashed ? 'Thùng rác trống' : 'Chưa có sản phẩm'}
          emptyDescription={!trashed && (params.search || params.categoryId || params.brandId || params.type || params.stockStatus) ? 'Thử thay đổi bộ lọc hoặc từ khoá tìm kiếm.' : undefined}
          emptyAction={
            !trashed && can('products.write') ? (
              <Button asChild size="sm">
                <Link href="/products/new">
                  <Plus /> Thêm sản phẩm
                </Link>
              </Button>
            ) : undefined
          }
        />
      </PageBody>
      <ProductImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <QuickEditDialog
        initial={quick}
        onClose={() => setQuick(null)}
        onSave={saveQuick}
        heading="Sửa nhanh sản phẩm"
        titleLabel="Tên sản phẩm"
        localeLabel={languages.find((l) => l.code === quick?.locale)?.name}
        slugPrefix={quick ? `/${quick.locale !== defaultLocale ? `${quick.locale}/` : ''}products/` : undefined}
        canPublish={can('products.publish')}
        extra={(f, set) => (
          <>
            {f.type === 'VARIABLE' ? (
              <p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">Sản phẩm có biến thể: giá và tồn kho đặt cho từng biến thể trong trình soạn thảo.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Giá bán">
                  <MoneyInput value={f.price} onChange={(v) => set({ price: v })} placeholder="0" />
                </Field>
                <Field label="Giá khuyến mãi" error={f.salePrice != null && f.salePrice >= (f.price ?? 0) ? 'Phải nhỏ hơn giá bán' : undefined}>
                  <MoneyInput value={f.salePrice} onChange={(v) => set({ salePrice: v })} />
                </Field>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Mã SKU">
                <Input value={f.sku} onChange={(e) => set({ sku: e.target.value })} className="font-mono" />
              </Field>
              {f.type !== 'VARIABLE' && f.manageStock && (
                <Field label="Tồn kho" help={f.codeDelivery ? 'Tính theo kho mã, không sửa tay' : undefined}>
                  <NumberInput value={f.stockQuantity} onChange={(v) => set({ stockQuantity: v })} integer disabled={f.codeDelivery} />
                </Field>
              )}
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Sản phẩm nổi bật</Label>
              <Switch checked={f.isFeatured} onCheckedChange={(v) => set({ isFeatured: v })} />
            </div>
          </>
        )}
      />
    </>
  );
}

export default function ProductsPage() {
  return (
    <Suspense>
      <ProductsList />
    </Suspense>
  );
}
