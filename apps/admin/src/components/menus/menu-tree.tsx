'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ExternalLink, GripVertical, ListTree, Trash2 } from 'lucide-react';
import type { MenuItemNode } from '@cmsnt/shared';
import { Field } from '@/components/common/field';
import { I18nInput } from '@/components/common/i18n-input';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguages } from '@/hooks/use-languages';
import { cn } from '@/lib/utils';
import { TYPE_LABELS } from './menu-sources';
import { buildTree, countDescendants, flatten, getProjection, indentNode, INDENT, MAX_DEPTH, moveSibling, outdentNode, removeChildrenOf, removeNode, subtreeHeight, updateNode, type FlatItem } from './tree-utils';

interface TreeProps {
  items: MenuItemNode[];
  onChange: (items: MenuItemNode[]) => void;
  /** Tên nội dung gốc theo refId (để hiển thị “Gốc: ...”) */
  refNames?: Record<string, string>;
}

/** Cây menu kéo thả: sắp xếp + kéo ngang để đổi cấp (tối đa 3 cấp) */
export function MenuTree({ items, onChange, refNames = {} }: TreeProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const flat = useMemo(() => {
    const all = flatten(items);
    return activeId ? removeChildrenOf(all, [activeId]) : all;
  }, [items, activeId]);

  const projected = activeId && overId ? getProjection(flat, activeId, overId, offsetLeft) : null;
  const activeItem = activeId ? flat.find((f) => f.id === activeId) : null;

  const reset = () => {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
    document.body.style.cursor = '';
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    setOverId(String(active.id));
    setOpenIds((o) => o.filter((x) => x !== active.id));
    document.body.style.cursor = 'grabbing';
  };
  const onDragMove = ({ delta }: DragMoveEvent) => setOffsetLeft(delta.x);
  const onDragOver = ({ over }: DragOverEvent) => setOverId(over ? String(over.id) : null);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (projected && over) {
      const all = flatten(items);
      const activeIndex = all.findIndex((f) => f.id === active.id);
      const overIndex = all.findIndex((f) => f.id === over.id);
      const cloned: FlatItem[] = all.map((f) => (f.id === active.id ? { ...f, depth: projected.depth, parentId: projected.parentId } : f));
      // các mục con vẫn giữ parentId = mục đang kéo nên buildTree sẽ mang chúng theo
      const sorted = arrayMove(cloned, activeIndex, overIndex);
      onChange(buildTree(sorted));
    }
    reset();
  };

  const toggleOpen = (id: string) => setOpenIds((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  if (!items.length) {
    return <EmptyState icon={ListTree} title="Menu chưa có mục nào" description="Chọn trang, bài viết, danh mục... ở cột bên trái rồi bấm “Thêm vào menu”." />;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }} onDragStart={onDragStart} onDragMove={onDragMove} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={reset}>
      <SortableContext items={flat.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-1.5">
          {flat.map((f) => (
            <SortableMenuItem
              key={f.id}
              item={f}
              depth={f.id === activeId && projected ? projected.depth : f.depth}
              open={openIds.includes(f.id)}
              onToggle={() => toggleOpen(f.id)}
              items={items}
              onChange={onChange}
              refName={f.node.refId ? refNames[`${f.node.type}:${f.node.refId}`] : undefined}
            />
          ))}
        </div>
      </SortableContext>
      {typeof document !== 'undefined' &&
        createPortal(
          <DragOverlay dropAnimation={null}>{activeItem ? <OverlayItem node={activeItem.node} /> : null}</DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
}

function OverlayItem({ node }: { node: MenuItemNode }) {
  const { defaultLocale } = useLanguages();
  const count = countDescendants(node);
  return (
    <div className="flex w-[min(520px,80vw)] items-center gap-2 rounded-lg border border-primary bg-card px-3 py-2.5 shadow-lg">
      <GripVertical className="size-4 text-muted-foreground" />
      <span className="flex-1 truncate text-sm font-medium">{node.label[defaultLocale] || Object.values(node.label).find(Boolean) || '(không nhãn)'}</span>
      {count > 0 && <Badge variant="secondary">+{count} mục con</Badge>}
    </div>
  );
}

function SortableMenuItem({
  item,
  depth,
  open,
  onToggle,
  items,
  onChange,
  refName,
}: {
  item: FlatItem;
  depth: number;
  open: boolean;
  onToggle: () => void;
  items: MenuItemNode[];
  onChange: (items: MenuItemNode[]) => void;
  refName?: string;
}) {
  const { defaultLocale } = useLanguages();
  const confirm = useConfirm();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const n = item.node;
  const label = n.label?.[defaultLocale] || Object.values(n.label ?? {}).find(Boolean) || '';
  const patch = (p: Partial<MenuItemNode>) => onChange(updateNode(items, n.id, p));

  const canIndent = !!indentNode(items, n.id);
  const canOutdent = item.depth > 0;
  const canUp = !!moveSibling(items, n.id, -1);
  const canDown = !!moveSibling(items, n.id, 1);
  const childCount = countDescendants(n);

  const remove = async () => {
    if (childCount > 0 && !(await confirm({ title: `Xoá “${label}” và ${childCount} mục con?`, destructive: true, confirmText: 'Xoá' }))) return;
    onChange(removeNode(items, n.id));
  };

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition, marginLeft: depth * INDENT }} className={cn('relative', isDragging && 'z-10')}>
      {isDragging ? (
        <div className="h-11 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5" />
      ) : (
        <div className={cn('rounded-lg border bg-card shadow-xs transition', open && 'ring-1 ring-primary/30')}>
          <div className="group flex items-center gap-1.5 py-1.5 pl-1.5 pr-2">
            <button ref={setActivatorNodeRef} type="button" className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing" aria-label="Kéo để sắp xếp" {...attributes} {...listeners}>
              <GripVertical className="size-4" />
            </button>
            <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className={cn('truncate text-sm font-medium', !label && 'italic text-muted-foreground')}>{label || '(chưa có nhãn)'}</span>
              {n.target === '_blank' && <ExternalLink className="size-3 shrink-0 text-muted-foreground" />}
              {childCount > 0 && <span className="shrink-0 text-xs text-muted-foreground">· {childCount} mục con</span>}
            </button>
            <div className="hidden items-center gap-0.5 opacity-0 transition group-hover:opacity-100 sm:flex">
              <IconBtn label="Thụt ra (lên 1 cấp)" disabled={!canOutdent} onClick={() => onChange(outdentNode(items, n.id) ?? items)}>
                <ArrowLeft />
              </IconBtn>
              <IconBtn label="Thụt vào (thành mục con của mục phía trên)" disabled={!canIndent} onClick={() => onChange(indentNode(items, n.id) ?? items)}>
                <ArrowRight />
              </IconBtn>
              <IconBtn label="Lên" disabled={!canUp} onClick={() => onChange(moveSibling(items, n.id, -1) ?? items)}>
                <ArrowUp />
              </IconBtn>
              <IconBtn label="Xuống" disabled={!canDown} onClick={() => onChange(moveSibling(items, n.id, 1) ?? items)}>
                <ArrowDown />
              </IconBtn>
            </div>
            <Badge variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground">
              {TYPE_LABELS[n.type] ?? n.type}
            </Badge>
            <Button type="button" variant="ghost" size="icon-xs" onClick={onToggle} aria-label="Mở rộng">
              <ChevronDown className={cn('transition', open && 'rotate-180')} />
            </Button>
          </div>

          {open && (
            <div className="space-y-3 border-t px-3 py-3">
              <Field label="Nhãn hiển thị">
                <I18nInput value={n.label} onChange={(label) => patch({ label })} />
              </Field>
              {n.type === 'custom' ? (
                <Field label="URL">
                  <Input value={n.url ?? ''} onChange={(e) => patch({ url: e.target.value })} placeholder="https://... hoặc /duong-dan" className="font-mono text-xs" />
                </Field>
              ) : n.type !== 'home' ? (
                <p className="text-xs text-muted-foreground">
                  Liên kết tới {TYPE_LABELS[n.type]?.toLowerCase()}: <span className="font-medium text-foreground">{refName || label || 'nội dung đã chọn'}</span>. Đường dẫn tự cập nhật theo slug từng ngôn ngữ.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Liên kết tới trang chủ của ngôn ngữ đang xem.</p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Icon" help="Tên icon (lucide) hoặc emoji">
                  <Input value={n.icon ?? ''} onChange={(e) => patch({ icon: e.target.value || null })} placeholder="vd: phone, 🔥" className="h-8" />
                </Field>
                <Field label="CSS class">
                  <Input value={n.cssClass ?? ''} onChange={(e) => patch({ cssClass: e.target.value || null })} placeholder="vd: highlight" className="h-8 font-mono text-xs" />
                </Field>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={n.target === '_blank'} onCheckedChange={(v) => patch({ target: v ? '_blank' : '_self' })} />
                Mở trong tab mới
              </label>
              <div className="flex flex-wrap items-center gap-1 border-t pt-3">
                <Button type="button" variant="ghost" size="xs" disabled={!canOutdent} onClick={() => onChange(outdentNode(items, n.id) ?? items)}>
                  <ArrowLeft /> Thụt ra
                </Button>
                <Button type="button" variant="ghost" size="xs" disabled={!canIndent} onClick={() => onChange(indentNode(items, n.id) ?? items)}>
                  <ArrowRight /> Thụt vào
                </Button>
                <Button type="button" variant="ghost" size="xs" disabled={!canUp} onClick={() => onChange(moveSibling(items, n.id, -1) ?? items)}>
                  <ArrowUp /> Lên
                </Button>
                <Button type="button" variant="ghost" size="xs" disabled={!canDown} onClick={() => onChange(moveSibling(items, n.id, 1) ?? items)}>
                  <ArrowDown /> Xuống
                </Button>
                <Button type="button" variant="ghost" size="xs" className="ml-auto text-destructive hover:text-destructive" onClick={remove}>
                  <Trash2 /> Xoá
                </Button>
              </div>
              {item.depth + subtreeHeight(n) >= MAX_DEPTH && !canIndent && item.depth > 0 && <p className="text-[11px] text-muted-foreground">Menu hỗ trợ tối đa {MAX_DEPTH + 1} cấp.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
