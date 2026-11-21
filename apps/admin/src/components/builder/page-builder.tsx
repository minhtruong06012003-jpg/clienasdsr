'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { DndContext, DragOverlay, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { DynamicIcon, type IconName } from 'lucide-react/dynamic';
import { Layers, LayoutGrid, Monitor, Redo2, Smartphone, Tablet, Undo2 } from 'lucide-react';
import { getBlock } from '@cmsnt/blocks';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { createBlock, useBuilder, type Device } from './store';
import { Canvas } from './canvas';
import { BlockLibrary } from './library';
import { LayersPanel } from './layers';
import { Inspector } from './inspector';
import { ThemeToggle } from '@/components/common/theme-toggle';
import { BuilderEnvProvider, type BuilderEnv } from './builder-context';

export interface BuilderPanel {
  key: string;
  label: string;
  content: ReactNode;
}

interface PageBuilderProps {
  locale: string;
  /** Thanh trên: nút quay lại, tiêu đề, chọn ngôn ngữ... (bên trái) */
  header: ReactNode;
  /** Nút hành động bên phải (lưu, xuất bản...) */
  actions: ReactNode;
  /** Tab bổ sung ở panel phải (Cài đặt trang, SEO...) */
  panels?: BuilderPanel[];
  /** Nội dung thay canvas (vd: màn hình tạo bản dịch) */
  overlay?: ReactNode;
  /** Theme Builder: đánh dấu đang soạn mẫu + dữ liệu mẫu (target, bản ghi) cho block động */
  env?: BuilderEnv;
}

const DEFAULT_ENV: BuilderEnv = { isTemplate: false };

/**
 * Trình dựng trang trực quan: thư viện block (trái) – canvas sửa trực tiếp (giữa) – thuộc tính (phải).
 * Hỗ trợ kéo thả từ thư viện vào canvas, sắp xếp, xem trước theo thiết bị, undo/redo (Ctrl+Z / Ctrl+Shift+Z).
 */
export function PageBuilder({ locale, header, actions, panels = [], overlay, env = DEFAULT_ENV }: PageBuilderProps) {
  const device = useBuilder((s) => s.device);
  const canUndo = useBuilder((s) => s.past.length > 0);
  const canRedo = useBuilder((s) => s.future.length > 0);
  const selectedId = useBuilder((s) => s.selectedId);
  const { setDevice, undo, redo, add, insert, move } = useBuilder.getState();
  const [leftTab, setLeftTab] = useState('library');
  const [rightTab, setRightTab] = useState(panels[0]?.key ?? 'block');
  const [dragType, setDragType] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  /** Khi overlay (vd: TranslationGate) đang che canvas thì khoá thư viện block / inspector */
  const locked = !!overlay;

  useEffect(() => {
    if (selectedId) setRightTab('block');
  }, [selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // đang hiện màn hình tạo bản dịch -> builder phía sau bị khoá
      if (locked) return;
      const target = e.target as HTMLElement;
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      const s = useBuilder.getState();
      // chỉ xoá block khi focus ở body hoặc trong canvas (không phải nút/menu/checkbox ở panel, dialog...)
      const focusOk = target === document.body || target === document.documentElement || !!target.closest('[data-builder-canvas]');
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedId && focusOk) {
        e.preventDefault();
        s.remove(s.selectedId);
      }
      if (e.key === 'Escape' && focusOk) s.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, locked]);

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setDragType(id.startsWith('lib:') ? id.slice(4) : null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragType(null);
    const active = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (locked) return;
    const blocks = useBuilder.getState().blocks;
    const indexOf = (id: string) => blocks.findIndex((b) => b.id === id.replace(/^layer:/, ''));
    if (active.startsWith('lib:')) {
      if (!over) return;
      const idx = over === 'canvas-drop' ? blocks.length : indexOf(over);
      insert(createBlock(active.slice(4)), idx < 0 ? blocks.length : idx);
      return;
    }
    if (!over || over === active || over === 'canvas-drop') return;
    const from = indexOf(active);
    const to = indexOf(over);
    if (from >= 0 && to >= 0) move(from, to);
  };

  const dragDef = dragType ? getBlock(dragType) : null;

  return (
    <BuilderEnvProvider value={env}>
      <div className="fixed inset-0 z-40 flex flex-col bg-background">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">{header}</div>
          {/* điện thoại: bỏ các nút phụ (khung thiết bị, giao diện, hoàn tác) để nút Lưu/Xuất bản không tràn khỏi màn hình */}
          <ToggleGroup type="single" variant="outline" size="sm" value={device} onValueChange={(v) => v && setDevice(v as Device)} className="max-md:hidden">
            <ToggleGroupItem value="desktop" aria-label="Máy tính" title="Máy tính">
              <Monitor />
            </ToggleGroupItem>
            <ToggleGroupItem value="tablet" aria-label="Máy tính bảng" title="Máy tính bảng">
              <Tablet />
            </ToggleGroupItem>
            <ToggleGroupItem value="mobile" aria-label="Điện thoại" title="Điện thoại">
              <Smartphone />
            </ToggleGroupItem>
          </ToggleGroup>
          <ThemeToggle className="max-md:hidden" />
          <div className="flex items-center max-md:hidden">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={!canUndo || locked} onClick={undo}>
                  <Undo2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hoàn tác (Ctrl+Z)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled={!canRedo || locked} onClick={redo}>
                  <Redo2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Làm lại (Ctrl+Shift+Z)</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 md:flex-1">{actions}</div>
        </div>
        {/* màn hẹp không có thư viện block / bảng thuộc tính → nói rõ để người dùng không tưởng là lỗi */}
        <div className="shrink-0 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-800 md:hidden dark:bg-amber-950/40 dark:text-amber-300">
          Trên điện thoại chỉ xem trước và lưu được. Mở trên máy tính để thêm và chỉnh block.
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragType(null)}>
          <div className="flex min-h-0 flex-1">
            <aside className={cn('hidden w-72 shrink-0 flex-col border-r lg:flex', locked && 'pointer-events-none select-none opacity-50')} inert={locked}>
              <Tabs value={leftTab} onValueChange={setLeftTab} className="flex min-h-0 flex-1 flex-col gap-0">
                <TabsList className="m-2 grid w-auto grid-cols-2">
                  <TabsTrigger value="library">
                    <LayoutGrid /> Block
                  </TabsTrigger>
                  <TabsTrigger value="layers">
                    <Layers /> Cấu trúc
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="library" className="min-h-0 flex-1">
                  <BlockLibrary onPick={(type) => add(type, (() => {
                    const s = useBuilder.getState();
                    const i = s.blocks.findIndex((b) => b.id === s.selectedId);
                    return i >= 0 ? i + 1 : s.blocks.length;
                  })())} />
                </TabsContent>
                <TabsContent value="layers" className="min-h-0 flex-1">
                  <LayersPanel />
                </TabsContent>
              </Tabs>
            </aside>

            <main className="relative min-w-0 flex-1 bg-muted/40">{overlay ?? <Canvas locale={locale} />}</main>

            <aside className="hidden w-[340px] shrink-0 flex-col border-l md:flex">
              <Tabs value={rightTab} onValueChange={setRightTab} className="flex min-h-0 flex-1 flex-col gap-0">
                <TabsList className="m-2 grid w-auto" style={{ gridTemplateColumns: `repeat(${panels.length + 1}, minmax(0, 1fr))` }}>
                  {panels.map((p) => (
                    <TabsTrigger key={p.key} value={p.key}>
                      {p.label}
                    </TabsTrigger>
                  ))}
                  <TabsTrigger value="block">Block</TabsTrigger>
                </TabsList>
                {panels.map((p) => (
                  <TabsContent key={p.key} value={p.key} className="min-h-0 flex-1">
                    <ScrollArea className="h-full">
                      <div className="p-3">{p.content}</div>
                    </ScrollArea>
                  </TabsContent>
                ))}
                <TabsContent value="block" className="min-h-0 flex-1">
                  {locked ? (
                    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">Tạo bản dịch cho ngôn ngữ này trước khi chỉnh sửa block.</div>
                  ) : (
                    <Inspector locale={locale} />
                  )}
                </TabsContent>
              </Tabs>
            </aside>
          </div>
          <DragOverlay dropAnimation={null}>
            {dragDef && (
              <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-medium shadow-xl">
                <DynamicIcon name={dragDef.icon as IconName} className="size-4 text-primary" fallback={() => null} />
                {dragDef.label}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </div>
    </BuilderEnvProvider>
  );
}
