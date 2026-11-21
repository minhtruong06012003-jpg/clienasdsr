'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Filter, Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PRODUCT_ATTRIBUTE_TYPE_LABELS, PRODUCT_ATTRIBUTE_TYPES, slugify, type ProductAttribute, type ProductAttributeType, type ProductAttributeValue } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { Field } from '@/components/common/field';
import { I18nInput } from '@/components/common/i18n-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ImageIdField } from '@/components/media/media-picker';
import { AttributeSwatch, PRODUCT_ATTRIBUTES_KEY, useProductAttributes } from '@/components/commerce/variants-editor';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { i18n } from '@/lib/format';
import { useLanguages } from '@/hooks/use-languages';
import { useBulkAction } from '@/hooks/use-bulk-action';

/** Dữ liệu form sửa thuộc tính */
interface FormState {
  key: string;
  name: Record<string, string>;
  type: ProductAttributeType;
  filterable: boolean;
  values: ProductAttributeValue[];
}

const EMPTY: FormState = { key: '', name: {}, type: 'select', filterable: true, values: [] };

/** Sản phẩm › Thuộc tính: định nghĩa thuộc tính dùng chung (màu, size...) cho biến thể, swatch và bộ lọc storefront */
export default function ProductAttributesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { defaultLocale } = useLanguages();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ProductAttribute | 'new' | null>(null);
  const canEdit = can('products.taxonomy');
  // id các thuộc tính đang tích chọn để thao tác hàng loạt
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();

  const list = useProductAttributes();
  const usage = useQuery({ queryKey: [...PRODUCT_ATTRIBUTES_KEY, 'usage'], queryFn: () => api.get<Record<string, number>>('/admin/product-attributes/usage') });
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data ?? []).filter((a) => !q || a.key.includes(q) || i18n(a.name, defaultLocale).toLowerCase().includes(q));
  }, [list.data, search, defaultLocale]);

  const refresh = () => void qc.invalidateQueries({ queryKey: PRODUCT_ATTRIBUTES_KEY });

  const remove = async (a: ProductAttribute) => {
    const used = usage.data?.[a.key] ?? 0;
    if (!(await confirm({ title: `Xoá thuộc tính "${i18n(a.name, defaultLocale) || a.key}"?`, description: used ? `${used} sản phẩm đang dùng mã "${a.key}": biến thể vẫn giữ nguyên, chỉ mất swatch và bộ lọc.` : undefined, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/product-attributes/${a.id}`);
      toast.success('Đã xoá thuộc tính');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** Xoá hàng loạt: hỏi xác nhận (kèm số sản phẩm đang dùng) rồi gọi endpoint xoá đơn lẻ cho từng thuộc tính */
  const bulkRemove = async () => {
    const ids = [...selected];
    const used = (list.data ?? []).filter((a) => ids.includes(a.id)).reduce((n, a) => n + (usage.data?.[a.key] ?? 0), 0);
    if (!(await confirm({ title: `Xoá ${ids.length} thuộc tính?`, description: used ? `Có ${used} lượt sản phẩm đang dùng các thuộc tính này: biến thể vẫn giữ nguyên, chỉ mất swatch và bộ lọc.` : undefined, destructive: true, confirmText: 'Xoá' }))) return;
    await bulk.run({
      ids,
      action: (id) => api.delete(`/admin/product-attributes/${id}`),
      doneLabel: 'Đã xoá',
      onDone: () => {
        setSelected([]);
        refresh();
      },
    });
  };

  /** Đổi thứ tự lên/xuống rồi lưu cả danh sách */
  const move = async (a: ProductAttribute, dir: -1 | 1) => {
    const all = [...(list.data ?? [])];
    const i = all.findIndex((x) => x.id === a.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    try {
      await api.post('/admin/product-attributes/reorder', { ids: all.map((x) => x.id) });
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<ProductAttribute>[] = [
    {
      key: 'name',
      header: 'Thuộc tính',
      cell: (a) => (
        <div className="min-w-0">
          <button type="button" className="font-medium hover:text-primary" onClick={() => canEdit && setEditing(a)}>
            {i18n(a.name, defaultLocale) || a.key}
          </button>
          <div className="font-mono text-xs text-muted-foreground">{a.key}</div>
        </div>
      ),
    },
    { key: 'type', header: 'Kiểu', className: 'w-40', cell: (a) => <span className="text-sm text-muted-foreground">{PRODUCT_ATTRIBUTE_TYPE_LABELS[a.type] ?? a.type}</span> },
    {
      key: 'values',
      header: 'Giá trị',
      cell: (a) => (
        <div className="flex max-w-lg flex-wrap gap-1.5">
          {a.values.slice(0, 12).map((v) => (
            <span key={v.value} className="inline-flex items-center gap-1.5 rounded-md border bg-background px-1.5 py-0.5 text-xs">
              <AttributeSwatch type={a.type} value={v} />
              {i18n(v.label, defaultLocale) || v.value}
            </span>
          ))}
          {a.values.length > 12 && <span className="text-xs text-muted-foreground">+{a.values.length - 12}</span>}
          {!a.values.length && <span className="text-sm text-muted-foreground">—</span>}
        </div>
      ),
    },
    {
      key: 'filterable',
      header: 'Bộ lọc',
      className: 'w-24',
      cell: (a) => (a.filterable ? <Badge variant="secondary" className="gap-1"><Filter className="size-3" /> Có</Badge> : <span className="text-sm text-muted-foreground">Không</span>),
    },
    { key: 'usage', header: 'Sản phẩm', className: 'w-24', cell: (a) => <Badge variant="outline" className="tabular-nums">{usage.data?.[a.key] ?? 0}</Badge> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (a) =>
        canEdit ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Thao tác">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(a)}>
                <Pencil /> Chỉnh sửa
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => move(a, -1)}>
                <ArrowUp /> Lên trên
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => move(a, 1)}>
                <ArrowDown /> Xuống dưới
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => remove(a)}>
                <Trash2 /> Xoá
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Thuộc tính sản phẩm"
        description="Thuộc tính dùng chung cho biến thể (màu, kích cỡ...): chọn nhanh khi tạo biến thể, hiện ô màu ở trang sản phẩm và làm bộ lọc cửa hàng"
        breadcrumbs={[{ label: 'Sản phẩm', href: '/products' }, { label: 'Thuộc tính' }]}
        actions={
          canEdit && (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Thêm thuộc tính
            </Button>
          )
        }
      />
      <PageBody className="space-y-4">
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          placeholder="Tìm thuộc tính..."
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
          // chỉ cho tích chọn khi có quyền xoá thuộc tính (thao tác hàng loạt duy nhất)
          selectable={canEdit}
          selected={selected}
          onSelectedChange={setSelected}
          emptyTitle={search ? 'Không tìm thấy thuộc tính' : 'Chưa có thuộc tính'}
          emptyDescription={search ? undefined : 'Tạo thuộc tính như Màu sắc (ô màu) hoặc Kích cỡ (nút) để dùng lại cho mọi sản phẩm biến thể.'}
          emptyAction={
            canEdit && !search ? (
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus /> Thêm thuộc tính
              </Button>
            ) : undefined
          }
        />
      </PageBody>
      <AttributeDialog editing={editing} onClose={() => setEditing(null)} onSaved={refresh} />
    </>
  );
}

function AttributeDialog({ editing, onClose, onSaved }: { editing: ProductAttribute | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const { defaultLocale } = useLanguages();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [input, setInput] = useState('');
  const attr = editing && editing !== 'new' ? editing : null;

  useEffect(() => {
    if (!editing) return;
    setForm(attr ? { key: attr.key, name: attr.name ?? {}, type: attr.type, filterable: attr.filterable, values: attr.values ?? [] } : EMPTY);
    setInput('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /** Mã tự sinh từ tên khi chưa sửa tay */
  const setName = (name: Record<string, string>) => {
    const auto = !form.key || form.key === slugify(i18n(form.name, defaultLocale)).replace(/-/g, '_');
    setForm({ ...form, name, ...(auto ? { key: slugify(i18n(name, defaultLocale)).replace(/-/g, '_') } : {}) });
  };
  const setValue = (i: number, patch: Partial<ProductAttributeValue>) => setForm({ ...form, values: form.values.map((v, j) => (j === i ? { ...v, ...patch } : v)) });

  /** Thêm nhiều giá trị: "Đỏ, Xanh" */
  const addValues = () => {
    const labels = input.split(',').map((s) => s.trim()).filter(Boolean);
    if (!labels.length) return;
    const next = [...form.values];
    for (const label of labels) {
      const value = slugify(label) || label;
      if (next.some((v) => v.value === value)) continue;
      next.push({ value, label: { [defaultLocale]: label }, color: form.type === 'color' ? '#cccccc' : null, imageId: null });
    }
    setForm({ ...form, values: next });
    setInput('');
  };

  const save = useMutation({
    mutationFn: () => {
      if (!i18n(form.name, defaultLocale).trim()) throw new Error('Vui lòng nhập tên thuộc tính');
      const body = { key: form.key || undefined, name: form.name, type: form.type, filterable: form.filterable, values: form.values.map(({ value, label, color, imageId }) => ({ value, label, color: color || null, imageId: imageId || null })) };
      return attr ? api.patch(`/admin/product-attributes/${attr.id}`, body) : api.post('/admin/product-attributes', body);
    },
    onSuccess: () => {
      toast.success(attr ? 'Đã lưu thuộc tính' : 'Đã thêm thuộc tính');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{attr ? 'Sửa thuộc tính' : 'Thêm thuộc tính'}</DialogTitle>
          <DialogDescription>Mã thuộc tính và mã giá trị phải khớp với biến thể sản phẩm (đổi mã cần tạo lại biến thể ở sản phẩm đang dùng).</DialogDescription>
        </DialogHeader>
        <form
          id="attribute-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_160px_180px]">
            <Field label="Tên thuộc tính" required>
              <I18nInput value={form.name} onChange={setName} placeholder="Vd: Màu sắc" />
            </Field>
            <Field label="Mã" help="a-z, 0-9, _">
              <Input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} onBlur={(e) => setForm({ ...form, key: slugify(e.target.value).replace(/-/g, '_') })} className="font-mono text-xs" placeholder="color" />
            </Field>
            <Field label="Kiểu hiển thị">
              <Select value={form.type} onValueChange={(type) => setForm({ ...form, type: type as ProductAttributeType })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_ATTRIBUTE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {PRODUCT_ATTRIBUTE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <span>
              <span className="block text-sm font-medium">Dùng làm bộ lọc</span>
              <span className="block text-xs text-muted-foreground">Hiện ở trang danh sách sản phẩm (?attr_{form.key || 'ma'}=...)</span>
            </span>
            <Switch checked={form.filterable} onCheckedChange={(filterable) => setForm({ ...form, filterable })} />
          </label>

          <div className="space-y-2">
            <div className="text-sm font-medium">Giá trị</div>
            {form.values.length > 0 && (
              <div className="divide-y rounded-lg border">
                {form.values.map((v, i) => (
                  <div key={i} className="grid items-start gap-2 p-2 sm:grid-cols-[1fr_140px_auto_auto]">
                    <I18nInput value={v.label} onChange={(label) => setValue(i, { label })} placeholder="Nhãn" />
                    <Input value={v.value} onChange={(e) => setValue(i, { value: e.target.value })} className="font-mono text-xs" placeholder="Mã" aria-label="Mã giá trị" />
                    {form.type === 'color' ? (
                      <div className="flex items-center gap-1.5">
                        <input type="color" value={v.color || '#cccccc'} onChange={(e) => setValue(i, { color: e.target.value })} className="size-9 cursor-pointer rounded-md border bg-background p-1" aria-label="Chọn màu" />
                        <Input value={v.color ?? ''} onChange={(e) => setValue(i, { color: e.target.value })} className="w-24 font-mono text-xs" placeholder="#rrggbb" />
                      </div>
                    ) : form.type === 'image' ? (
                      <div className="w-20">
                        <ImageIdField value={v.imageId} initial={v.imageId && v.image ? { id: v.imageId, url: v.image.url, urls: { thumb: v.image.thumb ?? v.image.url } } : undefined} onChange={(imageId) => setValue(i, { imageId })} aspect="aspect-square" label="Ảnh" />
                      </div>
                    ) : (
                      <span />
                    )}
                    <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label="Xoá giá trị" onClick={() => setForm({ ...form, values: form.values.filter((_, j) => j !== i) })}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addValues();
                  }
                }}
                placeholder="Nhập giá trị, phân cách bằng dấu phẩy (vd: Đỏ, Xanh, Đen) rồi Enter"
              />
              <Button type="button" variant="outline" onClick={addValues}>
                <Plus /> Thêm
              </Button>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button type="submit" form="attribute-form" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
