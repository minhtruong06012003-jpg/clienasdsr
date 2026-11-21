'use client';

import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import { EyeOff, GripVertical, Trash2 } from 'lucide-react';
import { getBlock, type BlockNode } from '@cmsnt/blocks';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useBuilder } from './store';

function summary(b: BlockNode) {
  const d = b.data as Record<string, unknown>;
  const text = d?.title ?? d?.text ?? d?.blockKey;
  return typeof text === 'string' ? text : '';
}

function LayerRow({ block }: { block: BlockNode }) {
  const selected = useBuilder((s) => s.selectedId === block.id);
  const { select, remove } = useBuilder.getState();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `layer:${block.id}`, data: { from: 'layers' } });
  const def = getBlock(block.type);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onClick={() => {
        select(block.id);
        document.querySelector(`[data-builder-id="${block.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}
      className={cn('group flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-sm', selected ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted', isDragging && 'z-10 bg-background shadow-md')}
    >
      <button type="button" className="cursor-grab text-muted-foreground" {...attributes} {...listeners}>
        <GripVertical className="size-3.5" />
      </button>
      <DynamicIcon name={(def?.icon ?? 'square') as IconName} className="size-4 shrink-0 text-muted-foreground" fallback={() => null} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{def?.label ?? block.type}</div>
        {summary(block) && <div className="truncate text-xs text-muted-foreground">{summary(block)}</div>}
      </div>
      {block.settings?.hideOn?.length ? <EyeOff className="size-3.5 text-muted-foreground" /> : null}
      <button type="button" className="p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onClick={(e) => (e.stopPropagation(), remove(block.id))}>
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

/** Danh sách cấu trúc block (kéo thả để sắp xếp) */
export function LayersPanel() {
  const blocks = useBuilder((s) => s.blocks);
  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-2">
        {blocks.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">Chưa có block</p>}
        <SortableContext items={blocks.map((b) => `layer:${b.id}`)} strategy={verticalListSortingStrategy}>
          {blocks.map((b) => (
            <LayerRow key={b.id} block={b} />
          ))}
        </SortableContext>
      </div>
    </ScrollArea>
  );
}
