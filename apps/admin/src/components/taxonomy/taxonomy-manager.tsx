'use client';

import { Suspense, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Eye, EyeOff, ExternalLink, FolderTree, GripVertical, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ROUTE_PREFIX, type ContentType } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { EmptyState } from '@/components/common/empty-state';
import { Field } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { SlugInput } from '@/components/common/slug-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ImageIdField } from '@/components/media/media-picker';
import { CustomFieldsPanel } from '@/components/custom-fields/custom-fields-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { pickTr } from '@/lib/format';
import { HAS_WEB_URL, siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useLanguages, useListLocale } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';
import { flattenTree } from '@/components/commerce/utils';

export interface TermTranslation {
  locale: string;
  name: string;
  slug: string;
  description?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
}

export interface Term {
  id: string;
  parentId?: string | null;
  imageId?: string | null;
  image?: { id: string; url: string; urls: Record<string, string> } | null;
  sortOrder?: number;
  isActive?: boolean;
  customFields?: Record<string, unknown>;
  translations: TermTranslation[];
  _count?: Record<string, number>;
}

type RoutePrefix = Exclude<ContentType, 'page' | 'home' | 'post' | 'product'>;

export interface TaxonomyManagerProps {
  /** Endpoint API, vd /admin/products/categories */
  endpoint: string;
  /** Query key của danh sách */
  queryKey: string;
  title: string;
  description?: string;
  /** Tên số ít, vd "danh mục" */
  singular: string;
  breadcrumbs?: { label: string; href?: string }[];
  /** Có danh mục cha + kéo thả sắp xếp (POST {endpoint}/reorder) */
  hasParent?: boolean;
  hasImage?: boolean;
  hasActive?: boolean;
  hasDescription?: boolean;
  hasSeo?: boolean;
  /** API trả { data, meta } (vd thẻ) */
  paginated?: boolean;
  routePrefix: RoutePrefix;
  /** Tên field trong _count, vd products / posts */
  countKey: string;
  countLabel: string;
  /** Quyền cần để thêm / sửa / xoá */
  permission: string;
  /** Loại nội dung của trường tuỳ chỉnh (hiện panel nhóm trường trong form) */
  customFieldsEntity?: 'post_category' | 'product_category';
  /** Query key khác cần làm mới sau khi thay đổi */
  invalidate?: string[];
}

type FlatTerm = Term & { parentId: string | null; depth: number };

const INDENT = 28;

const termName = (t: Term, locale: string) => pickTr(t.translations, locale);

function getProjection(items: FlatTerm[], activeId: string, overId: string, dragOffset: number) {
  const overIndex = items.findIndex((i) => i.id === overId);
  const activeIndex = items.findIndex((i) => i.id === activeId);
  const activeItem = items[activeIndex];
  const newItems = arrayMove(items, activeIndex, overIndex);
  const previous = newItems[overIndex - 1];
  const next = newItems[overIndex + 1];
  const projected = activeItem.depth + Math.round(dragOffset / INDENT);
  const maxDepth = previous ? previous.depth + 1 : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.min(Math.max(projected, minDepth), maxDepth);
  let parentId: string | null = null;
  if (depth > 0 && previous) {
    if (depth === previous.depth) parentId = previous.parentId;
    else if (depth > previous.depth) parentId = previous.id;
    else parentId = newItems.slice(0, overIndex).reverse().find((i) => i.depth === depth)?.parentId ?? null;
  }
  return { depth, parentId };
}

function descendantsOf(flat: FlatTerm[], id: string) {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const i of flat) {
      if (i.parentId === cur && !out.has(i.id)) {
        out.add(i.id);
        stack.push(i.id);
      }
    }
  }
  return out;
}

export function TaxonomyManager(props: TaxonomyManagerProps) {
  return (
    <Suspense>
      <Manager {...props} />
    </Suspense>
  );
}

function Manager(props: TaxonomyManagerProps) {
  const { endpoint, queryKey, title, description, singular, breadcrumbs, hasParent, paginated, permission } = props;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { locale, setLocale, languages, defaultLocale } = useListLocale();
  const { params, set, page, limit } = useListParams({ search: '' });
  const [editing, setEditing] = useState<Term | 'new' | null>(null);
  const canEdit = can(permission);

  const list = useQuery<Paginated<Term> | Term[]>({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: [queryKey, paginated ? { ...params } : 'all'],
    queryFn: () => (paginated ? api.get<Paginated<Term>>(endpoint, { search: params.search, page, limit }) : api.get<Term[]>(endpoint)),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [queryKey] });
    for (const k of props.invalidate ?? []) void qc.invalidateQueries({ queryKey: [k] });
  };

  const remove = async (t: Term) => {
    const name = termName(t, locale)?.name ?? '';
    const ok = await confirm({
      title: `Xoá ${singular} "${name}"?`,
      description: hasParent ? `Các ${singular} con sẽ được chuyển lên cấp gốc. Nội dung thuộc ${singular} này không bị xoá.` : `Nội dung gắn ${singular} này không bị xoá.`,
      destructive: true,
      confirmText: 'Xoá',
    });
    if (!ok) return;
    try {
      await api.delete(`${endpoint}/${t.id}`);
      toast.success(`Đã xoá ${singular}`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const toggleActive = useMutation({
    mutationFn: (t: Term) => api.patch(`${endpoint}/${t.id}`, { isActive: !t.isActive, translations: t.translations.map(cleanTr) }),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const rows = paginated ? (list.data as Paginated<Term> | undefined)?.data : (list.data as Term[] | undefined);
  const flatAll = useMemo(() => (paginated || !rows ? [] : flattenTree((rows ?? []).map((r) => ({ ...r, parentId: r.parentId ?? null })))), [rows, paginated]);

  // ---- Tích chọn + thao tác hàng loạt (xoá, hiện/ẩn) ----
  // API chưa có endpoint /bulk → gọi endpoint đơn lẻ cho từng id qua useBulkAction (kiểm tra quyền phía server vẫn áp dụng)
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();
  const afterBulk = () => {
    setSelected([]);
    refresh();
  };
  /** id → term của các dòng đã tải (dạng cây: toàn bộ; dạng phân trang: trang hiện tại) */
  const termById = useMemo(() => new Map((rows ?? []).map((t) => [t.id, t])), [rows]);

  const bulkRemove = async () => {
    const ids = selected;
    const picked = new Set(ids);
    // danh mục con KHÔNG được chọn nhưng có cha bị xoá → API đưa lên cấp gốc; báo rõ cho người dùng
    const orphaned = hasParent ? (rows ?? []).filter((t) => t.parentId && picked.has(t.parentId) && !picked.has(t.id)).length : 0;
    const ok = await confirm({
      title: `Xoá ${ids.length} ${singular}?`,
      description: [
        orphaned > 0 ? `${orphaned} ${singular} con của các mục đã chọn sẽ được chuyển lên cấp gốc.` : hasParent ? `Các ${singular} con (nếu có) sẽ được chuyển lên cấp gốc.` : '',
        `Nội dung gắn các ${singular} này không bị xoá.`,
      ]
        .filter(Boolean)
        .join(' '),
      destructive: true,
      confirmText: 'Xoá',
    });
    if (!ok) return;
    void bulk.run({ ids, action: (id) => api.delete(`${endpoint}/${id}`), doneLabel: 'Đã xoá', onDone: afterBulk });
  };

  // Hiện/ẩn hàng loạt: PATCH giống công tắc từng dòng (gửi kèm translations như toggleActive), bỏ qua mục đã đúng trạng thái
  const bulkSetActive = (isActive: boolean) => {
    const targets = selected.map((id) => termById.get(id)).filter((t): t is Term => !!t && (t.isActive ?? true) !== isActive);
    if (!targets.length) return void toast.info(isActive ? `Các ${singular} đã chọn đều đang hiển thị` : `Các ${singular} đã chọn đều đang ẩn`);
    const byId = new Map(targets.map((t) => [t.id, t]));
    void bulk.run({
      ids: targets.map((t) => t.id),
      action: (id) => api.patch(`${endpoint}/${id}`, { isActive, translations: byId.get(id)!.translations.map(cleanTr) }),
      doneLabel: isActive ? 'Đã hiện' : 'Đã ẩn',
      onDone: afterBulk,
    });
  };

  const bulkActions = (
    <>
      {props.hasActive && (
        <>
          <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => bulkSetActive(true)}>
            <Eye /> Hiện
          </Button>
          <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => bulkSetActive(false)}>
            <EyeOff /> Ẩn
          </Button>
        </>
      )}
      <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={bulkRemove}>
        <Trash2 /> Xoá
      </Button>
    </>
  );

  const rowActions = (t: Term) => {
    const tr = termName(t, locale);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canEdit && (
            <DropdownMenuItem onClick={() => setEditing(t)}>
              <Pencil /> Chỉnh sửa
            </DropdownMenuItem>
          )}
          {HAS_WEB_URL && tr && (t.isActive ?? true) && (
            <DropdownMenuItem asChild>
              <a href={siteUrl(props.routePrefix, tr.slug, tr.locale, defaultLocale)} target="_blank" rel="noreferrer">
                <ExternalLink /> Xem trên web
              </a>
            </DropdownMenuItem>
          )}
          {canEdit && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => remove(t)}>
                <Trash2 /> Xoá
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const nameCell = (t: Term) => {
    const tr = termName(t, locale);
    return (
      <div className="flex min-w-0 items-center gap-3">
        {props.hasImage &&
          (t.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.image.urls.thumb ?? t.image.url} alt="" className="size-9 shrink-0 rounded-md object-cover" />
          ) : (
            <div className="size-9 shrink-0 rounded-md bg-muted" />
          ))}
        <div className="min-w-0">
          <button type="button" className="line-clamp-1 text-left font-medium hover:text-primary" onClick={() => canEdit && setEditing(t)}>
            {tr?.name ?? '(chưa đặt tên)'}
            {tr && tr.locale !== locale && <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">[{tr.locale}]</span>}
          </button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">/{tr?.slug}</span>
            {languages.length > 1 && (
              <span className="flex gap-1">
                {languages.map((l) => (
                  <span key={l.code} className={t.translations.some((x) => x.locale === l.code) ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-40'} title={l.name}>
                    {l.code.toUpperCase()}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
        actions={
          <>
            <LocaleTabs languages={languages} value={locale} onChange={setLocale} />
            {canEdit && (
              <Button onClick={() => setEditing('new')}>
                <Plus /> Thêm {singular}
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        {paginated ? (
          <>
            <ListToolbar
              search={params.search}
              onSearchChange={(v) => {
                // đổi từ khoá → bỏ chọn để không thao tác nhầm mục đang bị ẩn khỏi danh sách
                setSelected([]);
                set({ search: v });
              }}
              placeholder={`Tìm ${singular}...`}
              selectedCount={selected.length}
              onClearSelection={() => setSelected([])}
              bulkActions={bulkActions}
            />
            <DataTable
              columns={
                [
                  { key: 'name', header: 'Tên', cell: nameCell },
                  { key: 'count', header: props.countLabel, className: 'w-32', cell: (t) => <Badge variant="secondary">{t._count?.[props.countKey] ?? 0}</Badge> },
                  { key: 'actions', header: '', className: 'w-10', cell: rowActions },
                ] satisfies Column<Term>[]
              }
              data={rows}
              meta={(list.data as Paginated<Term> | undefined)?.meta}
              loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
              selectable={canEdit}
              selected={selected}
              onSelectedChange={setSelected}
              // hiện/ẩn hàng loạt cần dữ liệu dòng đang hiển thị → bỏ chọn khi sang trang
              onPageChange={(p) => {
                setSelected([]);
                set({ page: p });
              }}
              onLimitChange={(l) => set({ limit: l })}
              emptyTitle={params.search ? 'Không tìm thấy kết quả' : `Chưa có ${singular} nào`}
              emptyAction={
                canEdit && !params.search ? (
                  <Button size="sm" onClick={() => setEditing('new')}>
                    <Plus /> Thêm {singular}
                  </Button>
                ) : undefined
              }
            />
          </>
        ) : (
          <TreeList
            {...props}
            flat={flatAll}
            loading={list.isLoading}
            canEdit={canEdit}
            nameCell={nameCell}
            rowActions={rowActions}
            onToggleActive={(t) => toggleActive.mutate(t)}
            onAdd={() => setEditing('new')}
            onReordered={refresh}
            selected={selected}
            onSelectedChange={setSelected}
            bulkActions={bulkActions}
          />
        )}
      </PageBody>
      <TermSheet {...props} editing={editing} onClose={() => setEditing(null)} all={flatAll} onSaved={refresh} />
    </>
  );
}

const cleanTr = (t: TermTranslation) => ({
  locale: t.locale,
  name: t.name,
  slug: t.slug,
  description: t.description || null,
  seoTitle: t.seoTitle || null,
  seoDescription: t.seoDescription || null,
});

interface TreeListProps extends TaxonomyManagerProps {
  flat: FlatTerm[];
  loading: boolean;
  canEdit: boolean;
  nameCell: (t: Term) => ReactNode;
  rowActions: (t: Term) => ReactNode;
  onToggleActive: (t: Term) => void;
  onAdd: () => void;
  onReordered: () => void;
  /** id các mục đang tích chọn (thao tác hàng loạt) */
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  bulkActions: ReactNode;
}

function TreeList({ flat, loading, canEdit, nameCell, rowActions, onToggleActive, onAdd, onReordered, endpoint, queryKey, hasParent, hasActive, countKey, countLabel, singular, selected, onSelectedChange, bulkActions }: TreeListProps) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const reorder = useMutation({
    mutationFn: (items: { id: string; parentId: string | null; sortOrder: number }[]) => api.post(`${endpoint}/reorder`, { items }),
    onSuccess: () => {
      toast.success('Đã lưu thứ tự');
      onReordered();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: [queryKey] });
    },
  });

  const q = search.trim().toLowerCase();
  const filtered = q ? flat.filter((t) => t.translations.some((tr) => tr.name.toLowerCase().includes(q) || tr.slug.includes(q))) : flat;
  const draggable = !!hasParent && canEdit && !q;

  const hidden = useMemo(() => (activeId ? descendantsOf(flat, activeId) : new Set<string>()), [flat, activeId]);
  const visible = draggable ? flat.filter((t) => !hidden.has(t.id)) : filtered;
  const projection = activeId && overId ? getProjection(visible, activeId, overId, offset) : null;

  // ô "chọn tất cả" chỉ áp dụng cho các dòng đang hiển thị (sau khi lọc theo từ khoá)
  const visibleIds = visible.map((t) => t.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
  const someSelected = !allSelected && visibleIds.some((id) => selected.includes(id));
  const toggleAll = () => onSelectedChange(allSelected ? selected.filter((id) => !visibleIds.includes(id)) : [...new Set([...selected, ...visibleIds])]);
  const toggleOne = (id: string) => onSelectedChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const reset = () => {
    setActiveId(null);
    setOverId(null);
    setOffset(0);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const proj = projection;
    reset();
    if (!over || !proj) return;
    const cloned = flat.map((t) => ({ ...t }));
    const activeIndex = cloned.findIndex((t) => t.id === active.id);
    const overIndex = cloned.findIndex((t) => t.id === over.id);
    const prev = cloned[activeIndex];
    if (activeIndex === overIndex && prev.parentId === proj.parentId) return;
    cloned[activeIndex] = { ...prev, depth: proj.depth, parentId: proj.parentId };
    const sorted = arrayMove(cloned, activeIndex, overIndex);
    const counters = new Map<string, number>();
    const items = sorted.map((t) => {
      const k = t.parentId ?? '';
      const n = counters.get(k) ?? 0;
      counters.set(k, n + 1);
      return { id: t.id, parentId: t.parentId, sortOrder: n };
    });
    qc.setQueryData<Term[]>([queryKey, 'all'], (old) => old?.map((t) => ({ ...t, ...items.find((i) => i.id === t.id) })));
    reorder.mutate(items);
  };

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border bg-card">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Tìm ${singular}...`} className="pl-8" />
        </div>
        {hasParent && canEdit && (
          <p className="text-xs text-muted-foreground">
            <GripVertical className="mr-1 inline size-3.5" />
            Kéo thả để sắp xếp. Kéo sang phải để đặt làm {singular} con.
          </p>
        )}
        {reorder.isPending && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />}
        {/* thanh thao tác hàng loạt (tự hiện khi có mục được chọn) */}
        {canEdit && selected.length > 0 && (
          <div className="ml-auto">
            <ListToolbar selectedCount={selected.length} onClearSelection={() => onSelectedChange([])} bulkActions={bulkActions} />
          </div>
        )}
      </div>
      {flat.length === 0 ? (
        <EmptyState
          icon={FolderTree}
          title={`Chưa có ${singular} nào`}
          description={`Tạo ${singular} để phân loại nội dung.`}
          action={
            canEdit ? (
              <Button size="sm" onClick={onAdd}>
                <Plus /> Thêm {singular}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {canEdit && <Checkbox checked={allSelected ? true : someSelected ? 'indeterminate' : false} onCheckedChange={toggleAll} aria-label="Chọn tất cả" />}
            <span className="flex-1">Tên</span>
            {hasActive && <span className="w-16 text-center">Hiển thị</span>}
            <span className="w-20 text-center">{countLabel}</span>
            <span className="w-7" />
          </div>
          {visible.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Không tìm thấy {singular} phù hợp</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={({ active }: DragStartEvent) => {
                setActiveId(String(active.id));
                setOverId(String(active.id));
              }}
              onDragMove={({ delta }: DragMoveEvent) => setOffset(delta.x)}
              onDragOver={({ over }: DragOverEvent) => setOverId(over ? String(over.id) : null)}
              onDragEnd={onDragEnd}
              onDragCancel={reset}
            >
              <SortableContext items={visible.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {visible.map((t) => (
                  <TreeRow
                    key={t.id}
                    term={t}
                    depth={t.id === activeId && projection ? projection.depth : q ? 0 : t.depth}
                    draggable={draggable}
                    hasActive={hasActive}
                    canEdit={canEdit}
                    count={t._count?.[countKey] ?? 0}
                    childCount={activeId === t.id ? hidden.size : 0}
                    nameCell={nameCell}
                    rowActions={rowActions}
                    onToggleActive={onToggleActive}
                    checked={canEdit ? selected.includes(t.id) : undefined}
                    onCheckedChange={() => toggleOne(t.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      )}
    </div>
  );
}

function TreeRow({ term, depth, draggable, hasActive, canEdit, count, childCount, nameCell, rowActions, onToggleActive, checked, onCheckedChange }: { term: FlatTerm; depth: number; draggable: boolean; hasActive?: boolean; canEdit: boolean; count: number; childCount: number; nameCell: (t: Term) => ReactNode; rowActions: (t: Term) => ReactNode; onToggleActive: (t: Term) => void; /** undefined = không hiện ô tích chọn */ checked?: boolean; onCheckedChange: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: term.id, disabled: !draggable });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} data-state={checked ? 'selected' : undefined} className={cn('relative border-b bg-card last:border-b-0 data-[state=selected]:bg-primary/5', isDragging && 'z-10 shadow-lg ring-1 ring-primary/40')}>
      <div className="flex items-center gap-3 px-3 py-2">
        {/* ô tích chọn đặt ngoài phần thụt lề để luôn thẳng cột với ô "chọn tất cả" ở tiêu đề */}
        {checked !== undefined && <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label="Chọn" />}
        <div className="flex min-w-0 flex-1 items-center gap-3" style={{ paddingLeft: depth * INDENT }}>
        {draggable ? (
          <button type="button" className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing" aria-label="Kéo để sắp xếp" {...attributes} {...listeners}>
            <GripVertical className="size-4" />
          </button>
        ) : (
          depth > 0 && <span className="text-muted-foreground/50">└</span>
        )}
        <div className="min-w-0 flex-1">{nameCell(term)}</div>
        {childCount > 0 && <Badge variant="outline">+{childCount} con</Badge>}
        {hasActive && (
          <div className="flex w-16 justify-center">
            <Switch size="sm" checked={term.isActive ?? true} disabled={!canEdit} onCheckedChange={() => onToggleActive(term)} aria-label="Hiển thị" />
          </div>
        )}
        <div className="w-20 text-center">
          <Badge variant="secondary" className="tabular-nums">
            {count}
          </Badge>
        </div>
        {rowActions(term)}
        </div>
      </div>
    </div>
  );
}

interface FormState {
  parentId: string | null;
  imageId: string | null;
  isActive: boolean;
  customFields: Record<string, unknown>;
  translations: Record<string, TermTranslation>;
}

const emptyTr = (locale: string): TermTranslation => ({ locale, name: '', slug: '', description: '', seoTitle: '', seoDescription: '' });

function TermSheet({ editing, onClose, all, onSaved, endpoint, singular, hasParent, hasImage, hasActive, hasDescription, hasSeo, routePrefix, customFieldsEntity }: TaxonomyManagerProps & { editing: Term | 'new' | null; onClose: () => void; all: FlatTerm[]; onSaved: () => void }) {
  const { languages, defaultLocale } = useLanguages();
  const [locale, setLocale] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const active = locale ?? defaultLocale;
  const isNew = editing === 'new';
  const term = editing && editing !== 'new' ? editing : null;

  useEffect(() => {
    if (!editing) return;
    setLocale(null);
    setForm(
      term
        ? {
            parentId: term.parentId ?? null,
            imageId: term.imageId ?? null,
            isActive: term.isActive ?? true,
            customFields: term.customFields ?? {},
            translations: Object.fromEntries(term.translations.map((t) => [t.locale, { ...emptyTr(t.locale), ...t }])),
          }
        : { parentId: null, imageId: null, isActive: true, customFields: {}, translations: {} },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const parentOptions = useMemo(() => {
    if (!term) return all;
    const exclude = descendantsOf(all, term.id);
    exclude.add(term.id);
    return all.filter((t) => !exclude.has(t.id));
  }, [all, term]);

  const tr = form?.translations[active] ?? emptyTr(active);
  const updateTr = (patch: Partial<TermTranslation>) => setForm((f) => (f ? { ...f, translations: { ...f.translations, [active]: { ...(f.translations[active] ?? emptyTr(active)), ...patch } } } : f));

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      const translations = Object.values(form.translations).filter((t) => t.name.trim());
      if (!translations.length) throw new Error(`Vui lòng nhập tên ${singular}`);
      const body: Record<string, unknown> = { translations: translations.map(cleanTr) };
      if (hasParent) body.parentId = form.parentId;
      if (hasImage) body.imageId = form.imageId;
      if (hasActive) body.isActive = form.isActive;
      if (customFieldsEntity) body.customFields = form.customFields;
      if (isNew && hasParent) body.sortOrder = all.filter((t) => t.parentId === form.parentId).length;
      return isNew ? api.post(endpoint, body) : api.patch(`${endpoint}/${term!.id}`, body);
    },
    onSuccess: () => {
      toast.success(isNew ? `Đã thêm ${singular}` : 'Đã lưu thay đổi');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const prefix = `/${active !== defaultLocale ? `${active}/` : ''}${ROUTE_PREFIX[routePrefix]}/`;

  return (
    <Sheet open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 data-[side=right]:sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{isNew ? `Thêm ${singular}` : `Sửa ${singular}`}</SheetTitle>
          <SheetDescription>{isNew ? 'Điền thông tin rồi bấm Lưu.' : pickTr(term?.translations, defaultLocale)?.name}</SheetDescription>
        </SheetHeader>
        {form && (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="flex-1 space-y-5 overflow-y-auto p-4">
              {languages.length > 1 && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Ngôn ngữ</span>
                  <LocaleTabs languages={languages} value={active} onChange={setLocale} has={(c) => !!form.translations[c]?.name} />
                </div>
              )}
              <Field label="Tên" required={active === defaultLocale} help={active !== defaultLocale ? 'Để trống nếu chưa có bản dịch cho ngôn ngữ này' : undefined}>
                <Input value={tr.name} onChange={(e) => updateTr({ name: e.target.value })} placeholder={pickTr(Object.values(form.translations), defaultLocale)?.name || `Tên ${singular}`} autoFocus />
              </Field>
              <Field label="Đường dẫn (slug)" help="Để trống sẽ tự tạo từ tên">
                <SlugInput value={tr.slug} onChange={(slug) => updateTr({ slug })} source={tr.name} prefix={prefix} />
              </Field>
              {hasDescription && (
                <Field label="Mô tả">
                  <Textarea value={tr.description ?? ''} onChange={(e) => updateTr({ description: e.target.value })} rows={3} />
                </Field>
              )}
              {hasParent && (
                <Field label={`${singular[0].toUpperCase()}${singular.slice(1)} cha`}>
                  <Select value={form.parentId ?? 'none'} onValueChange={(v) => setForm({ ...form, parentId: v === 'none' ? null : v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Không có (cấp gốc) —</SelectItem>
                      {parentOptions.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {'— '.repeat(p.depth)}
                          {pickTr(p.translations, defaultLocale)?.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {hasImage && (
                <Field label="Ảnh">
                  <ImageIdField value={form.imageId} initial={term?.image} onChange={(id) => setForm({ ...form, imageId: id })} aspect="aspect-[2/1]" />
                </Field>
              )}
              {hasActive && (
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label>Hiển thị</Label>
                    <p className="text-xs text-muted-foreground">Tắt để ẩn {singular} khỏi website</p>
                  </div>
                  <Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
                </div>
              )}
              {customFieldsEntity && (
                <div className="space-y-4 rounded-lg border p-3">
                  <CustomFieldsPanel entity={customFieldsEntity} variant="plain" value={form.customFields} onChange={(customFields) => setForm({ ...form, customFields })} locale={active} />
                </div>
              )}
              {hasSeo && (
                <div className="space-y-4 rounded-lg border p-3">
                  <p className="text-sm font-medium">SEO</p>
                  <Field label="Tiêu đề SEO" help={`${(tr.seoTitle ?? '').length}/60 ký tự`}>
                    <Input value={tr.seoTitle ?? ''} onChange={(e) => updateTr({ seoTitle: e.target.value })} placeholder={tr.name} />
                  </Field>
                  <Field label="Mô tả SEO" help={`${(tr.seoDescription ?? '').length}/160 ký tự`}>
                    <Textarea value={tr.seoDescription ?? ''} onChange={(e) => updateTr({ seoDescription: e.target.value })} rows={3} />
                  </Field>
                </div>
              )}
            </div>
            <SheetFooter className="flex-row justify-end border-t">
              <Button type="button" variant="outline" onClick={onClose}>
                Huỷ
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}
                Lưu
              </Button>
            </SheetFooter>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
