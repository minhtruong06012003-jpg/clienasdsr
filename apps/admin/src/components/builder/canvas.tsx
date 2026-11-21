'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { BlockSection, getBlock, type BlockNode, type RenderContext } from '@cmsnt/blocks';
import { EditorBridgeContext, type EditorBridge } from '@cmsnt/blocks/client';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useBuilder } from './store';
import { useCanvasContext } from './render-context';
import { useResolvedBlocks } from './use-resolved';
import { useBuilderEnv } from './builder-context';
import { BlockLibrary } from './library';

/** Độ rộng mô phỏng thiết bị; canvas được thu nhỏ (zoom) cho vừa khung nhưng layout giữ đúng độ rộng thật */
const WIDTH = { desktop: 1280, tablet: 820, mobile: 390 } as const;

function InsertButton({ index, className }: { index: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const add = useBuilder((s) => s.add);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('flex size-7 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg ring-4 ring-white transition hover:scale-110', className)}
          title="Chèn block"
          onClick={(e) => e.stopPropagation()}
        >
          <Plus className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="h-[420px] w-[340px] p-0" onClick={(e) => e.stopPropagation()}>
        <BlockLibrary
          compact
          onPick={(type) => {
            add(type, index);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function CanvasBlock({ block, index, total, ctx }: { block: BlockNode; index: number; total: number; ctx: RenderContext }) {
  const selected = useBuilder((s) => s.selectedId === block.id);
  const { select, move, duplicate, remove } = useBuilder.getState();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, data: { from: 'canvas' } });
  const def = getBlock(block.type);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-builder-id={block.id}
      className={cn('group/block relative', isDragging && 'z-30 opacity-60')}
      onClick={(e) => {
        e.stopPropagation();
        select(block.id);
      }}
    >
      <div className={cn('pointer-events-none absolute inset-0 z-10 transition', selected ? 'ring-2 ring-inset ring-blue-600' : 'group-hover/block:ring-2 group-hover/block:ring-inset group-hover/block:ring-blue-400/70')} />
      <div className={cn('absolute left-2 top-2 z-20 flex items-center gap-0.5 rounded-md bg-blue-600 px-1 py-0.5 text-white shadow-md transition', selected ? 'opacity-100' : 'opacity-0 group-hover/block:opacity-100')}>
        <button type="button" className="cursor-grab p-1 active:cursor-grabbing" title="Kéo để sắp xếp" {...attributes} {...listeners}>
          <GripVertical className="size-3.5" />
        </button>
        <span className="px-1 text-[11px] font-medium">{def?.label ?? block.type}</span>
        <button type="button" className="p-1 hover:bg-white/20 disabled:opacity-40" disabled={index === 0} onClick={(e) => (e.stopPropagation(), move(index, index - 1))} title="Lên trên">
          <ArrowUp className="size-3.5" />
        </button>
        <button type="button" className="p-1 hover:bg-white/20 disabled:opacity-40" disabled={index === total - 1} onClick={(e) => (e.stopPropagation(), move(index, index + 1))} title="Xuống dưới">
          <ArrowDown className="size-3.5" />
        </button>
        <button type="button" className="p-1 hover:bg-white/20" onClick={(e) => (e.stopPropagation(), duplicate(block.id))} title="Nhân bản">
          <Copy className="size-3.5" />
        </button>
        <button type="button" className="p-1 hover:bg-red-500" onClick={(e) => (e.stopPropagation(), remove(block.id))} title="Xoá">
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="absolute -top-3.5 left-1/2 z-20 -translate-x-1/2 opacity-0 transition group-hover/block:opacity-100">
        <InsertButton index={index} />
      </div>
      <BlockSection block={block} ctx={ctx} />
    </div>
  );
}

/** Khung xem trước có thể sửa trực tiếp: chọn block, sửa chữ tại chỗ, kéo thả sắp xếp */
export function Canvas({ locale }: { locale: string }) {
  const blocks = useBuilder((s) => s.blocks);
  const device = useBuilder((s) => s.device);
  const { updateData, select } = useBuilder.getState();
  const { ctx, style } = useCanvasContext(locale);
  // Theme Builder: gửi kèm bản ghi mẫu để block động hiển thị dữ liệu thật
  const { context } = useBuilderEnv();
  const resolved = useResolvedBlocks(blocks, locale, context);
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas-drop' });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(1280);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = WIDTH[device];
  const zoom = Math.min(1, available / width);

  const bridge = useMemo<EditorBridge>(() => ({ onChange: (id, path, value) => updateData(id, path, value), onSelect: (id) => select(id) }), [updateData, select]);
  const canvasCtx = useMemo<RenderContext>(
    () => ({
      ...ctx,
      renderBlocks: (nested) => nested.map((b) => <BlockSection key={b.id} block={b} ctx={{ ...ctx, mode: 'view' }} />),
    }),
    [ctx],
  );
  const withResolved = blocks.map((b) => (resolved[b.id] ? { ...b, resolved: resolved[b.id] } : b));

  return (
    <div data-builder-canvas className="h-full overflow-auto bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] bg-[length:16px_16px] dark:bg-[radial-gradient(#3f3f46_1px,transparent_1px)] p-4" onClick={() => select(null)}>
      <div ref={wrapRef} className="w-full" />
      <div
        ref={setNodeRef}
        style={{ width, zoom, ...style }}
        className={cn('cms-light @container mx-auto min-h-[calc(100%-1rem)] bg-white text-slate-900 shadow-xl transition-[width] duration-300', device !== 'desktop' && 'rounded-2xl', isOver && 'ring-2 ring-blue-500')}
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest('a')) e.preventDefault();
        }}
      >
        <EditorBridgeContext.Provider value={bridge}>
          <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {withResolved.map((b, i) => (
              <CanvasBlock key={b.id} block={b} index={i} total={blocks.length} ctx={canvasCtx} />
            ))}
          </SortableContext>
        </EditorBridgeContext.Provider>
        <div className={cn('flex flex-col items-center justify-center gap-3 p-10 text-center', blocks.length === 0 && 'min-h-[60vh]')}>
          {blocks.length === 0 && (
            <>
              <p className="text-lg font-semibold text-slate-700">Trang đang trống</p>
              <p className="max-w-sm text-sm text-slate-500">Kéo block từ thư viện bên trái thả vào đây, hoặc bấm nút + để thêm block đầu tiên.</p>
            </>
          )}
          <InsertButton index={blocks.length} className="size-9" />
        </div>
      </div>
    </div>
  );
}
