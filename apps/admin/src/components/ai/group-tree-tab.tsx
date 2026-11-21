'use client';

/**
 * AI Studio › Công cụ AI › tab "Nhóm & model" (?tab=groups): quản lý theo tầng Nhóm (menu website khách) › Nhóm model.
 * - Mỗi nhóm là một thẻ: kéo tay nắm để sắp xếp thứ tự trên menu, bật / tắt hiển thị, thu gọn / mở,
 *   nút "Thêm nhóm model" (nhóm cha gợi ý = nhóm này), "Sửa" (tên, icon), "Xoá" (chỉ khi nhóm không còn công cụ).
 * - Trong thẻ là danh sách nhóm model thuộc nhóm (nhóm cha = nhóm của model đại diện, xem model-groups-tab.tsx):
 *   kéo tay nắm để sắp xếp (lưu bằng PUT /admin/ai/tools/order — xếp lại sortOrder công cụ của nhóm, website hiện đúng thứ tự),
 *   model trong nhóm, số model đang bật, bật / tắt cả nhóm model, sửa, tách nhóm.
 * - Nhóm model có nhóm cha lạ (không còn trong danh sách nhóm) gom vào thẻ "Nhóm khác" ở cuối.
 * API: /admin/ai/categories (thêm / sửa / sắp xếp / xoá nhóm), PUT /admin/ai/tools/:key (nhóm model gắn trên công cụ).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, ChevronDown, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, GripVertical, Layers, Pencil, Plus, Trash2, Unlink, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable } from '@/components/common/data-table';
import { useConfirm } from '@/components/common/confirm-dialog';
import { CategoryDialog, CategoryIcon } from '@/components/ai/categories-tab';
import { buildModelGroups, ModelGroupEditDialog, type GroupRow, type GroupTool } from '@/components/ai/model-groups-tab';
import { type ToolCategory, useToolCategories } from '@/components/ai/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Khoá giả cho thẻ gom nhóm model có nhóm cha không còn tồn tại */
const ORPHAN = '__orphan__';

export function GroupTreeTab({ tools, loading, error, onRetry, providerName }: { tools?: GroupTool[]; loading: boolean; error: unknown; onRetry: () => void; providerName: (key: string) => string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const cats = useToolCategories();
  const list = useMemo(() => cats.data ?? [], [cats.data]);
  // null = đóng; {} = thêm nhóm; có key = sửa nhóm
  const [editingCat, setEditingCat] = useState<Partial<ToolCategory> | null>(null);
  // null = đóng; name rỗng = tạo nhóm model mới (parent = nhóm cha gợi ý); có name = sửa nhóm model đó
  const [editingGroup, setEditingGroup] = useState<{ name: string; parent: string } | null>(null);
  // các thẻ nhóm đang thu gọn
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => buildModelGroups(tools), [tools]);
  // nhóm model theo nhóm cha; nhóm cha lạ gom vào ORPHAN
  const byParent = useMemo(() => {
    const known = new Set(list.map((c) => c.key));
    const map = new Map<string, GroupRow[]>();
    for (const g of groups) {
      const k = known.has(g.parent) ? g.parent : ORPHAN;
      map.set(k, [...(map.get(k) ?? []), g]);
    }
    return map;
  }, [groups, list]);
  // số công cụ đứng riêng (không thuộc nhóm model nào) của từng nhóm — công cụ gốc đã tách model không tính
  const standalone = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tools ?? []) if (!t.modelGroups.length && t.models === 0) map.set(t.category, (map.get(t.category) ?? 0) + 1);
    return map;
  }, [tools]);

  // đổi nhóm xong thì làm mới cả bảng công cụ (nhãn cột Nhóm, bộ lọc)
  const refreshCats = () => {
    void qc.invalidateQueries({ queryKey: ['ai-categories'] });
    void qc.invalidateQueries({ queryKey: ['ai-tools'] });
  };

  // ---- nhóm (tầng 1) ----
  const reorder = useMutation({
    mutationFn: (keys: string[]) => api.put('/admin/ai/categories/order', { keys }),
    // hiện thứ tự mới ngay khi thả, lỗi thì tải lại từ API
    onMutate: (keys) => qc.setQueryData<ToolCategory[]>(['ai-categories'], (old) => old && keys.map((k) => old.find((c) => c.key === k)!).filter(Boolean)),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: refreshCats,
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  /** Thả thẻ nhóm vào vị trí mới -> lưu thứ tự */
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const keys = list.map((c) => c.key);
    reorder.mutate(arrayMove(keys, keys.indexOf(String(active.id)), keys.indexOf(String(over.id))));
  };

  /** Bật / tắt nhóm trên website khách */
  const toggleCat = useMutation({
    mutationFn: (c: ToolCategory) => api.put(`/admin/ai/categories/${encodeURIComponent(c.key)}`, { enabled: !c.enabled }),
    onSuccess: (_d, c) => {
      toast.success(c.enabled ? `Đã tắt nhóm "${c.label}"` : `Đã bật nhóm "${c.label}"`);
      refreshCats();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const removeCat = useMutation({
    mutationFn: (key: string) => api.delete(`/admin/ai/categories/${encodeURIComponent(key)}`),
    onSuccess: () => {
      toast.success('Đã xoá nhóm');
      refreshCats();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const askRemoveCat = async (c: ToolCategory) => {
    if (await confirm({ title: `Xoá nhóm "${c.label}"?`, description: 'Nhóm sẽ biến mất khỏi menu website khách.', destructive: true, confirmText: 'Xoá' })) removeCat.mutate(c.key);
  };

  // ---- nhóm model (tầng 2) ----
  // tách nhóm = bỏ tên nhóm này khỏi mọi công cụ trong nhóm (công cụ vẫn giữ các nhóm khác)
  const ungroup = useMutation({
    mutationFn: async (g: GroupRow) => {
      for (const t of g.tools) await api.put(`/admin/ai/tools/${encodeURIComponent(t.key)}`, { modelGroups: t.modelGroups.filter((x) => x !== g.name) });
    },
    onSuccess: (_, g) => toast.success(`Đã tách nhóm “${g.name}”, ${g.tools.length} công cụ đứng riêng lại`),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
  });
  // bật / tắt nhóm model = bật hoặc tắt mọi model trong nhóm (chỉ gửi PUT cho model đang khác trạng thái)
  const setGroupEnabled = useMutation({
    mutationFn: async ({ g, enabled }: { g: GroupRow; enabled: boolean }) => {
      for (const t of g.tools) if (t.enabled !== enabled) await api.put(`/admin/ai/tools/${encodeURIComponent(t.key)}`, { enabled });
    },
    onSuccess: (_, { g, enabled }) => toast.success(enabled ? `Đã bật cả ${g.tools.length} model của nhóm “${g.name}”` : `Đã tắt nhóm model “${g.name}”`),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ai-tools'] }),
  });
  const askUngroup = async (g: GroupRow) => {
    if (await confirm({ title: `Tách nhóm model "${g.name}"?`, description: `Bỏ nhóm này khỏi ${g.tools.length} công cụ (công cụ thuộc nhóm khác vẫn ở nhóm đó, còn lại hiện riêng trên website). Không xoá công cụ nào.`, confirmText: 'Tách nhóm' })) ungroup.mutate(g);
  };

  // ---- sắp xếp nhóm model trong một nhóm (kéo thả) ----
  // thứ tự tạm (tên nhóm model) theo từng nhóm, hiện ngay khi thả cho tới khi tải lại xong danh sách công cụ & nhóm cha
  const [pendingOrder, setPendingOrder] = useState<Record<string, string[]>>({});
  const reorderGroups = useMutation({
    mutationFn: async ({ cat, names, keys }: { cat: string; names: string[]; keys: string[] }) => {
      await Promise.all([
        api.put('/admin/ai/tools/order', { keys }),
        ...(cat !== ORPHAN ? [api.put(`/admin/ai/categories/${encodeURIComponent(cat)}`, { groupOrder: names })] : []),
      ]);
    },
    onMutate: ({ cat, names }) => setPendingOrder((s) => ({ ...s, [cat]: names })),
    onSuccess: () => toast.success('Đã lưu thứ tự nhóm model'),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: async (_d, _e, { cat }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['ai-tools'] }),
        qc.invalidateQueries({ queryKey: ['ai-categories'] }),
      ]);
      setPendingOrder(({ [cat]: _, ...rest }) => rest);
    },
  });

  /**
   * Thứ tự công cụ mới của nhóm `cat` khi xếp lại nhóm model thành `names`.
   * Website hiện các mục của nhóm theo sortOrder: công cụ đứng riêng tại chỗ, công cụ đã gộp ở vị trí model đại diện.
   * Đặc biệt (T-496): nếu một nhóm `H` dùng chung 100% model với nhóm khác (không có model riêng độc quyền),
   * thì các nhóm có model độc quyền đứng trước KHÔNG được lấy mất model dùng chung của `H` sớm hơn vị trí của `H`,
   * đồng thời `groupOrder` của nhóm cha cũng được lưu trực tiếp để giữ cứng vị trí của `H` ở cả Admin lẫn Website.
   */
  const toolOrderFor = (cat: string, names: string[]) => {
    const inCat = (tools ?? []).filter((t) => t.category === cat);
    const rows = new Map((byParent.get(cat) ?? []).map((g) => [g.name, g]));
    // các nhóm không có model riêng độc quyền (100% model đều dùng chung với nhóm khác)
    const allSharedSet = new Set(
      [...rows.values()].filter((g) => !g.tools.some((t) => t.modelGroups.length <= 1)).map((g) => g.name),
    );
    // đếm số nhóm chọn mỗi tool làm đại diện (kể cả khi 2 nhóm dùng chung 1 rep.key vẫn sinh đủ slot)
    const repCount = new Map<string, number>();
    for (const g of rows.values()) {
      repCount.set(g.rep.key, (repCount.get(g.rep.key) ?? 0) + 1);
    }
    const slots = inCat.flatMap((t): ({ tool: GroupTool } | { group: true })[] => {
      if (!t.modelGroups.length) return [{ tool: t }];
      const n = repCount.get(t.key) ?? 0;
      return n > 0 ? Array.from({ length: n }, () => ({ group: true as const })) : [];
    });
    while (slots.filter((s) => 'group' in s).length < names.length) {
      slots.push({ group: true });
    }
    const queue = [...names];
    const done = new Set<string>();
    const keys: string[] = [];
    const take = (t: GroupTool) => {
      keys.push(t.key);
      done.add(t.key);
    };
    for (const s of slots) {
      if ('tool' in s) {
        take(s.tool);
        continue;
      }
      const gName = queue.shift();
      if (!gName) continue;
      const gRow = rows.get(gName);
      if (!gRow) continue;
      const remainingAllShared = new Set(queue.filter((qName) => allSharedSet.has(qName)));
      for (const t of gRow.tools) {
        if (t.category !== cat || done.has(t.key)) continue;
        // Nếu nhóm hiện tại đã có model đại diện riêng, nhường các model dùng chung cho nhóm thuần-dùng-chung xếp phía sau
        if (!allSharedSet.has(gName) && t.modelGroups.some((mg) => remainingAllShared.has(mg))) {
          continue;
        }
        take(t);
      }
    }
    for (const t of inCat) if (!done.has(t.key)) keys.push(t.key);
    return keys;
  };
  /** Nhóm model của nhóm `cat` theo thứ tự đang hiện (ưu tiên thứ tự tạm vừa kéo thả -> `groupOrder` đã lưu -> thứ tự mặc định) */
  const rowsOf = (cat: string) => {
    const rows = byParent.get(cat) ?? [];
    const savedOrder = list.find((c) => c.key === cat)?.groupOrder;
    const order = pendingOrder[cat] ?? (savedOrder && savedOrder.length ? savedOrder : undefined);
    if (!order) return rows;
    const pos = new Map(order.map((n, i) => [n, i]));
    return [...rows].sort(
      (a, b) => (pos.get(a.name) ?? order.length + rows.indexOf(a)) - (pos.get(b.name) ?? order.length + rows.indexOf(b)),
    );
  };
  const onGroupDragEnd = (cat: string) => ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const names = rowsOf(cat).map((g) => g.name);
    const next = arrayMove(names, names.indexOf(String(active.id)), names.indexOf(String(over.id)));
    reorderGroups.mutate({ cat, names: next, keys: toolOrderFor(cat, next) });
  };

  const catLabel = (k: string) => list.find((c) => c.key === k)?.label ?? k;
  const rowProps = {
    providerName,
    catLabel,
    onEdit: (r: GroupRow) => setEditingGroup({ name: r.name, parent: r.parent }),
    onUngroup: (r: GroupRow) => void askUngroup(r),
    onToggle: (r: GroupRow, enabled: boolean) => setGroupEnabled.mutate({ g: r, enabled }),
    busy: ungroup.isPending || setGroupEnabled.isPending,
  };

  /** Danh sách nhóm model trong một thẻ nhóm (kéo tay nắm để sắp xếp; thẻ "Nhóm khác" không sắp xếp) */
  const renderGroups = (key: string) => {
    const rows = rowsOf(key);
    const alone = standalone.get(key) ?? 0;
    const sortable = key !== ORPHAN;
    return (
      <div className="space-y-2">
        {rows.length ? (
          <div className="overflow-x-auto rounded-lg border">
            {/* tiêu đề cột (hiện từ màn rộng xl trở lên để không bị bóp chồng cột khi thu hẹp cửa sổ) */}
            <div className={cn(ROW_GRID, 'hidden bg-muted/50 py-2 text-xs font-semibold text-muted-foreground xl:grid')}>
              <span />
              <span>Nhóm model</span>
              <span>Model trong nhóm</span>
              <span>Đang bật</span>
              <span>Trạng thái</span>
              <span className="text-right">Thao tác</span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onGroupDragEnd(key)}>
              <SortableContext items={rows.map((g) => g.name)} strategy={verticalListSortingStrategy}>
                {rows.map((g) => (
                  <GroupRowItem key={g.name} row={g} sortable={sortable && !reorderGroups.isPending} {...rowProps} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa có nhóm model trong nhóm này</div>
        )}
        {alone > 0 && (
          <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <Wrench className="size-3.5" /> {alone} công cụ đứng riêng (không thuộc nhóm model nào)
          </p>
        )}
      </div>
    );
  };

  const allKeys = [...list.map((c) => c.key), ...(byParent.has(ORPHAN) ? [ORPHAN] : [])];
  const toggleCollapse = (k: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const allCollapsed = allKeys.length > 0 && allKeys.every((k) => collapsed.has(k));
  const err = error ?? cats.error;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Nhóm hiện trên menu website khách theo thứ tự dưới đây (kéo <GripVertical className="inline size-3.5" /> để sắp xếp); tắt nhóm sẽ ẩn cả nhóm lẫn công cụ trong nhóm. Các công cụ cùng nhóm model gộp thành 1 công cụ trên website, khách chọn model ngay trên trang công cụ.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={!allKeys.length} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(allKeys))}>
            {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />} {allCollapsed ? 'Mở tất cả' : 'Thu gọn tất cả'}
          </Button>
          <Button size="sm" onClick={() => setEditingCat({})}>
            <Plus /> Thêm nhóm
          </Button>
        </div>
      </div>

      {/* đang tải / lỗi / chưa có nhóm: để DataTable tự vẽ trạng thái */}
      {!tools || !cats.data || (!list.length && !groups.length) ? (
        <DataTable columns={[]} data={tools && cats.data ? [] : undefined} loading={loading || cats.isLoading} error={err} onRetry={() => {
            onRetry();
            void cats.refetch();
          }} emptyTitle="Chưa có nhóm" />
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={list.map((c) => c.key)} strategy={verticalListSortingStrategy}>
              {list.map((c) => (
                <CategoryCard
                  key={c.key}
                  cat={c}
                  groupCount={byParent.get(c.key)?.length ?? 0}
                  open={!collapsed.has(c.key)}
                  onToggleOpen={() => toggleCollapse(c.key)}
                  onToggleEnabled={() => toggleCat.mutate(c)}
                  togglePending={toggleCat.isPending}
                  onAddGroup={() => setEditingGroup({ name: '', parent: c.key })}
                  onEdit={() => setEditingCat(c)}
                  onRemove={() => void askRemoveCat(c)}
                  removePending={removeCat.isPending}
                >
                  {renderGroups(c.key)}
                </CategoryCard>
              ))}
            </SortableContext>
          </DndContext>
          {/* nhóm model có nhóm cha đã bị xoá / không rõ: gom riêng để admin chọn lại nhóm cha */}
          {byParent.has(ORPHAN) && (
            <section className="rounded-xl border border-amber-300 bg-card shadow-sm">
              <button type="button" className="flex w-full items-center gap-2.5 px-4 py-3 text-left" onClick={() => toggleCollapse(ORPHAN)}>
                <AlertTriangle className="size-5 text-amber-600" />
                <span className="font-semibold">Nhóm khác</span>
                <span className="text-sm text-muted-foreground">nhóm model có nhóm cha không còn tồn tại — mở Sửa để chọn lại nhóm cha</span>
                <ChevronDown className={cn('ml-auto size-4 transition', collapsed.has(ORPHAN) && '-rotate-90')} />
              </button>
              {!collapsed.has(ORPHAN) && <div className="border-t p-3 sm:p-4">{renderGroups(ORPHAN)}</div>}
            </section>
          )}
        </>
      )}

      {editingCat && <CategoryDialog category={editingCat} onClose={() => setEditingCat(null)} onSaved={refreshCats} />}
      {editingGroup && tools && (
        <ModelGroupEditDialog
          name={editingGroup.name}
          tools={tools}
          groups={groups.map((g) => g.name)}
          categories={list}
          defaultParent={editingGroup.parent || list[0]?.key || ''}
          providerName={providerName}
          onClose={() => setEditingGroup(null)}
        />
      )}
    </div>
  );
}

/** Thẻ một nhóm (tầng 1): tay nắm kéo thả, icon + tên, huy hiệu số lượng / hiển thị, nút thao tác, nội dung = bảng nhóm model */
function CategoryCard({
  cat,
  groupCount,
  open,
  onToggleOpen,
  onToggleEnabled,
  togglePending,
  onAddGroup,
  onEdit,
  onRemove,
  removePending,
  children,
}: {
  cat: ToolCategory;
  groupCount: number;
  open: boolean;
  onToggleOpen: () => void;
  onToggleEnabled: () => void;
  togglePending: boolean;
  onAddGroup: () => void;
  onEdit: () => void;
  onRemove: () => void;
  removePending: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cat.key });
  return (
    <section ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('rounded-xl border bg-card shadow-sm', isDragging && 'relative z-10 shadow-lg')}>
      {/* tiêu đề nhóm */}
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-3 sm:px-4">
        <button type="button" className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing" aria-label="Kéo để sắp xếp nhóm" {...attributes} {...listeners}>
          <GripVertical className="size-4" />
        </button>
        <span className={cn('inline-flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary', !cat.enabled && 'bg-muted text-muted-foreground')}>
          <CategoryIcon name={cat.icon} className="size-4" />
        </span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggleOpen}>
          <div className={cn('truncate font-semibold uppercase', !cat.enabled && 'text-muted-foreground line-through')}>{cat.label}</div>
          <div className="font-mono text-[11px] text-muted-foreground">{cat.key}</div>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" title="Số nhóm model">
            <Layers /> {groupCount}
          </Badge>
          <Badge variant="secondary" title="Số công cụ trong nhóm">
            <Wrench /> {cat.tools}
          </Badge>
          <Badge variant="outline" className={cat.enabled ? 'border-emerald-300 text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}>
            {cat.enabled ? <Eye /> : <EyeOff />} {cat.enabled ? 'Hiển thị' : 'Đang ẩn'}
          </Badge>
          <Switch checked={cat.enabled} disabled={togglePending} onCheckedChange={onToggleEnabled} aria-label={`Bật/tắt nhóm ${cat.label}`} title={cat.enabled ? 'Đang hiện trên website khách' : 'Đang ẩn khỏi website khách (cả công cụ trong nhóm)'} />
          <Button variant="ghost" size="icon-sm" aria-label={open ? 'Thu gọn' : 'Mở'} onClick={onToggleOpen}>
            <ChevronDown className={cn('transition', !open && '-rotate-90')} />
          </Button>
        </div>
      </div>
      {open && (
        <div className="space-y-3 border-t p-3 sm:p-4">
          {/* hàng nút thao tác của nhóm */}
          <div className="grid grid-cols-3 gap-2">
            <Button variant="outline" size="sm" className="border-primary/40 text-primary hover:bg-primary/5" onClick={onAddGroup}>
              <Plus /> <span className="truncate sm:hidden">Thêm</span>
              <span className="hidden truncate sm:inline">Thêm nhóm model</span>
            </Button>
            <Button variant="outline" size="sm" className="border-sky-300 text-sky-700 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-950" onClick={onEdit}>
              <Pencil /> Sửa
            </Button>
            {/* còn công cụ thì không xoá được (API cũng chặn) */}
            <Button variant="outline" size="sm" className="border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950" disabled={cat.tools > 0 || removePending} title={cat.tools > 0 ? 'Chuyển hết công cụ sang nhóm khác trước khi xoá' : undefined} onClick={onRemove}>
              <Trash2 /> Xoá
            </Button>
          </div>
          {children}
        </div>
      )}
    </section>
  );
}

/** Lưới cột của hàng nhóm model (màn rộng xl+): tay nắm, tên, model, đang bật, trạng thái, thao tác */
const ROW_GRID = 'grid grid-cols-[1.5rem_minmax(11rem,1fr)_minmax(14rem,2fr)_4.5rem_5rem_5.5rem] items-center gap-3 px-3';

/** Một hàng nhóm model (tầng 2): tay nắm kéo thả, tên, model trong nhóm, số đang bật, bật / tắt, sửa, tách nhóm */
function GroupRowItem({
  row,
  sortable,
  providerName,
  catLabel,
  onEdit,
  onUngroup,
  onToggle,
  busy,
}: {
  row: GroupRow;
  sortable: boolean;
  providerName: (key: string) => string;
  catLabel: (key: string) => string;
  onEdit: (r: GroupRow) => void;
  onUngroup: (r: GroupRow) => void;
  onToggle: (r: GroupRow, enabled: boolean) => void;
  busy: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.name, disabled: !sortable });
  // nhóm model coi là bật khi còn ít nhất 1 model bật; gạt tắt -> tắt hết, gạt bật -> bật hết
  const on = row.tools.some((t) => t.enabled);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-card px-3 py-2.5 first:border-t-0 xl:grid xl:px-3', ROW_GRID.replace('grid ', 'xl:grid '), 'hover:bg-muted/30', isDragging && 'z-10 shadow-lg')}
    >
      <button type="button" className={cn('touch-none text-muted-foreground hover:text-foreground', sortable ? 'cursor-grab active:cursor-grabbing' : 'invisible')} aria-label="Kéo để sắp xếp nhóm model" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <button type="button" className="flex min-w-[calc(100%-2.5rem)] flex-1 items-center gap-2.5 text-left xl:min-w-0 xl:flex-none" onClick={() => onEdit(row)}>
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Layers className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="font-medium">{row.name}</div>
          {row.parents.length > 1 && (
            <div className="flex items-center gap-1 text-[11px] text-amber-600" title="Mở Sửa nhóm model và chọn một nhóm cha để đồng nhất">
              <AlertTriangle className="size-3 shrink-0" /> Model thuộc nhiều nhóm cha: {row.parents.map(catLabel).join(', ')}
            </div>
          )}
        </div>
      </button>
      <div className="order-last flex min-w-0 w-full flex-wrap gap-1 xl:order-none xl:w-auto">
        {row.tools.map((t) => (
          <Badge
            key={t.key}
            variant={t.maintenance ? 'outline' : t.enabled ? 'secondary' : 'outline'}
            className={
              t.maintenance
                ? 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                : t.enabled
                  ? undefined
                  : 'text-muted-foreground line-through'
            }
            title={`${t.name} · ${providerName(t.provider)}${t.maintenance ? ' (đang bảo trì)' : t.enabled ? '' : ' (đang tắt)'}${t.modelGroups.length > 1 ? ` · cũng ở nhóm ${t.modelGroups.filter((x) => x !== row.name).join(', ')}` : ''}`}
          >
            {t.maintenance && <Wrench className="size-3" />}
            {t.modelLabel || t.name}
            {/* model dùng chung nhiều nhóm */}
            {t.modelGroups.length > 1 && <Layers className="size-3 opacity-60" />}
          </Badge>
        ))}
      </div>
      <span className="text-sm tabular-nums" title="Số model đang bật">
        {row.tools.filter((t) => t.enabled).length} / {row.tools.length}
      </span>
      <Switch checked={on} disabled={busy} onCheckedChange={(v) => onToggle(row, v)} aria-label={`Bật/tắt nhóm model ${row.name}`} title={on ? 'Tắt mọi model trong nhóm' : 'Bật mọi model trong nhóm'} />
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="Sửa" onClick={() => onEdit(row)}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Tách nhóm" title="Tách nhóm (công cụ đứng riêng lại)" disabled={busy} onClick={() => onUngroup(row)}>
          <Unlink />
        </Button>
      </div>
    </div>
  );
}
