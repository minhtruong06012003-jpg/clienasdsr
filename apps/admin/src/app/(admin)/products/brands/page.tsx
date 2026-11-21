'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, Loader2, MoreHorizontal, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { Field } from '@/components/common/field';
import { SlugInput } from '@/components/common/slug-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ImageIdField } from '@/components/media/media-picker';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBulkAction } from '@/hooks/use-bulk-action';

interface Brand {
  id: string;
  name: string;
  slug: string;
  logoId: string | null;
  logo: { id: string; url: string; urls: Record<string, string> } | null;
  website: string | null;
  description: string | null;
  _count: { products: number };
}

interface FormState {
  name: string;
  slug: string;
  logoId: string | null;
  website: string;
  description: string;
}

export default function BrandsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Brand | 'new' | null>(null);
  const canEdit = can('products.taxonomy');
  // id các thương hiệu đang tích chọn để thao tác hàng loạt
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();

  const list = useQuery({ queryKey: ['product-brands'], queryFn: () => api.get<Brand[]>('/admin/products/brands') });
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data ?? []).filter((b) => !q || b.name.toLowerCase().includes(q) || b.slug.includes(q));
  }, [list.data, search]);

  const remove = async (b: Brand) => {
    if (!(await confirm({ title: `Xoá thương hiệu "${b.name}"?`, description: b._count.products ? `${b._count.products} sản phẩm sẽ được gỡ thương hiệu này.` : undefined, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/products/brands/${b.id}`);
      toast.success('Đã xoá thương hiệu');
      void qc.invalidateQueries({ queryKey: ['product-brands'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** Xoá hàng loạt: hỏi xác nhận rồi gọi endpoint xoá đơn lẻ cho từng thương hiệu đã chọn */
  const bulkRemove = async () => {
    const ids = [...selected];
    const productCount = (list.data ?? []).filter((b) => ids.includes(b.id)).reduce((n, b) => n + b._count.products, 0);
    if (!(await confirm({ title: `Xoá ${ids.length} thương hiệu?`, description: productCount ? `${productCount} sản phẩm sẽ được gỡ thương hiệu.` : undefined, destructive: true, confirmText: 'Xoá' }))) return;
    await bulk.run({
      ids,
      action: (id) => api.delete(`/admin/products/brands/${id}`),
      doneLabel: 'Đã xoá',
      onDone: () => {
        setSelected([]);
        void qc.invalidateQueries({ queryKey: ['product-brands'] });
      },
    });
  };

  const columns: Column<Brand>[] = [
    {
      key: 'name',
      header: 'Thương hiệu',
      cell: (b) => (
        <div className="flex items-center gap-3">
          {b.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.logo.urls.thumb ?? b.logo.url} alt="" className="size-11 rounded-md border bg-white object-contain p-1" />
          ) : (
            <div className="flex size-11 items-center justify-center rounded-md bg-muted text-sm font-semibold uppercase text-muted-foreground">{b.name.slice(0, 2)}</div>
          )}
          <div className="min-w-0">
            <button type="button" className="font-medium hover:text-primary" onClick={() => canEdit && setEditing(b)}>
              {b.name}
            </button>
            <div className="text-xs text-muted-foreground">/{b.slug}</div>
          </div>
        </div>
      ),
    },
    { key: 'description', header: 'Mô tả', cell: (b) => <span className="line-clamp-2 max-w-md text-sm text-muted-foreground">{b.description || '—'}</span> },
    {
      key: 'website',
      header: 'Website',
      cell: (b) =>
        b.website ? (
          <a href={b.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <Globe className="size-3.5" />
            {b.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'products',
      header: 'Sản phẩm',
      className: 'w-28',
      cell: (b) => (
        <Link href={`/products?brandId=${b.id}`}>
          <Badge variant="secondary" className="tabular-nums hover:bg-secondary/70">
            {b._count.products}
          </Badge>
        </Link>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (b) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canEdit && (
              <DropdownMenuItem onClick={() => setEditing(b)}>
                <Pencil /> Chỉnh sửa
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link href={`/products?brandId=${b.id}`}>
                <Package /> Xem sản phẩm
              </Link>
            </DropdownMenuItem>
            {b.website && (
              <DropdownMenuItem asChild>
                <a href={b.website} target="_blank" rel="noreferrer">
                  <ExternalLink /> Mở website
                </a>
              </DropdownMenuItem>
            )}
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => remove(b)}>
                  <Trash2 /> Xoá
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Thương hiệu"
        description="Quản lý thương hiệu / nhà sản xuất"
        breadcrumbs={[{ label: 'Sản phẩm', href: '/products' }, { label: 'Thương hiệu' }]}
        actions={
          canEdit && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Thêm thương hiệu
            </Button>
          )
        }
      />
      <PageBody className="space-y-4">
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          placeholder="Tìm thương hiệu..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            canEdit && (
              <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={bulkRemove}>
                {bulk.pending ? <Loader2 className="animate-spin" /> : <Trash2 />} Xoá
              </Button>
            )
          }
        />
        <DataTable
          columns={columns}
          data={rows}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          // chỉ cho tích chọn khi có quyền xoá thương hiệu (thao tác hàng loạt duy nhất)
          selectable={canEdit}
          selected={selected}
          onSelectedChange={setSelected}
          emptyTitle={search ? 'Không tìm thấy thương hiệu' : 'Chưa có thương hiệu'}
          emptyAction={
            canEdit && !search ? (
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus /> Thêm thương hiệu
              </Button>
            ) : undefined
          }
        />
      </PageBody>
      <BrandDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function BrandDialog({ editing, onClose }: { editing: Brand | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>({ name: '', slug: '', logoId: null, website: '', description: '' });
  const brand = editing && editing !== 'new' ? editing : null;

  useEffect(() => {
    if (!editing) return;
    setForm(brand ? { name: brand.name, slug: brand.slug, logoId: brand.logoId, website: brand.website ?? '', description: brand.description ?? '' } : { name: '', slug: '', logoId: null, website: '', description: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const save = useMutation({
    mutationFn: () => {
      if (!form.name.trim()) throw new Error('Vui lòng nhập tên thương hiệu');
      let website = form.website.trim();
      if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
      const body = { name: form.name.trim(), slug: form.slug || undefined, logoId: form.logoId, website: website || null, description: form.description.trim() || null };
      return brand ? api.patch(`/admin/products/brands/${brand.id}`, body) : api.post('/admin/products/brands', body);
    },
    onSuccess: () => {
      toast.success(brand ? 'Đã lưu thương hiệu' : 'Đã thêm thương hiệu');
      void qc.invalidateQueries({ queryKey: ['product-brands'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{brand ? 'Sửa thương hiệu' : 'Thêm thương hiệu'}</DialogTitle>
          <DialogDescription>Thương hiệu hiển thị trên trang sản phẩm và bộ lọc cửa hàng.</DialogDescription>
        </DialogHeader>
        <form
          id="brand-form"
          className="grid gap-4 sm:grid-cols-[1fr_140px]"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-4">
            <Field label="Tên thương hiệu" required>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </Field>
            <Field label="Slug" help="Để trống sẽ tự tạo từ tên">
              <SlugInput value={form.slug} onChange={(slug) => setForm({ ...form, slug })} source={form.name} />
            </Field>
            <Field label="Website">
              <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://..." />
            </Field>
          </div>
          <Field label="Logo">
            <ImageIdField value={form.logoId} initial={brand?.logo} onChange={(id) => setForm({ ...form, logoId: id })} aspect="aspect-square" label="Chọn logo" />
          </Field>
          <Field label="Mô tả" className="sm:col-span-2">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="submit" form="brand-form" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
