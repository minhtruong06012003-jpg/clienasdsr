'use client';

import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ListChecks, Plus, Trash2 } from 'lucide-react';
import { I18nInput } from '@/components/common/i18n-input';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import type { I18nText } from '@/lib/types';
import { cn } from '@/lib/utils';
import { uid } from './variants-editor';

export interface SpecRow {
  _key: string;
  label: I18nText;
  value: I18nText;
}

function SortableSpec({ row, onChange, onRemove }: { row: SpecRow; onChange: (patch: Partial<SpecRow>) => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row._key });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('flex items-start gap-2 rounded-lg border bg-card p-2', isDragging && 'z-10 shadow-lg')}>
      <button type="button" className="mt-2 cursor-grab touch-none text-muted-foreground hover:text-foreground" aria-label="Kéo để sắp xếp" {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <div className="grid flex-1 gap-2 sm:grid-cols-[2fr_3fr]">
        <I18nInput value={row.label} onChange={(label) => onChange({ label })} placeholder="Tên thông số (vd: Bảo hành)" />
        <I18nInput value={row.value} onChange={(value) => onChange({ value })} placeholder="Giá trị (vd: 12 tháng)" />
      </div>
      <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label="Xoá thông số">
        <Trash2 />
      </Button>
    </div>
  );
}

/** Danh sách thông số kỹ thuật đa ngôn ngữ, kéo thả sắp xếp */
export function SpecsEditor({ value, onChange }: { value: SpecRow[]; onChange: (v: SpecRow[]) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onChange(arrayMove(value, value.findIndex((s) => s._key === active.id), value.findIndex((s) => s._key === over.id)));
  };
  const add = () => onChange([...value, { _key: uid(), label: {}, value: {} }]);
  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <EmptyState icon={ListChecks} title="Chưa có thông số" description="Thêm các thông số như chất liệu, kích thước, bảo hành, xuất xứ..." action={<Button type="button" size="sm" variant="outline" onClick={add}><Plus /> Thêm thông số</Button>} />
      ) : (
        <>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={value.map((s) => s._key)} strategy={verticalListSortingStrategy}>
              {value.map((row) => (
                <SortableSpec key={row._key} row={row} onChange={(patch) => onChange(value.map((s) => (s._key === row._key ? { ...s, ...patch } : s)))} onRemove={() => onChange(value.filter((s) => s._key !== row._key))} />
              ))}
            </SortableContext>
          </DndContext>
          <Button type="button" size="sm" variant="outline" onClick={add}>
            <Plus /> Thêm thông số
          </Button>
        </>
      )}
    </div>
  );
}
