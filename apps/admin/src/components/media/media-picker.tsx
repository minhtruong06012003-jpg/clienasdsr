'use client';

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ImagePlus, Plus, RefreshCw, X } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Media } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MediaLibrary } from './media-library';

/** Hộp thoại chọn file từ thư viện Media (có upload) */
export function MediaPickerDialog({ open, onOpenChange, multiple, accept = 'image', onSelect, title }: { open: boolean; onOpenChange: (o: boolean) => void; multiple?: boolean; accept?: 'image' | 'all'; onSelect: (items: Media[]) => void; title?: string }) {
  const [selected, setSelected] = useState<Media[]>([]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setSelected([]);
        onOpenChange(o);
      }}
    >
      <DialogContent className="flex h-[85vh] max-w-[min(1200px,95vw)] flex-col gap-3 p-4 sm:max-w-[min(1200px,95vw)]">
        <DialogHeader>
          <DialogTitle>{title ?? (accept === 'image' ? 'Chọn ảnh' : 'Chọn file')}</DialogTitle>
        </DialogHeader>
        <MediaLibrary mode="picker" multiple={multiple} accept={accept} selected={selected} onSelectedChange={setSelected} />
        <DialogFooter className="items-center">
          <span className="mr-auto text-sm text-muted-foreground">{selected.length ? `Đã chọn ${selected.length}` : 'Bấm vào file để chọn'}</span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button
            disabled={!selected.length}
            onClick={() => {
              onSelect(selected);
              setSelected([]);
              onOpenChange(false);
            }}
          >
            Chọn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lấy object media từ id (dùng cho field lưu id như featuredImageId) */
export function useMediaById(id: string | null | undefined) {
  return useQuery({ queryKey: ['media', 'item', id], queryFn: () => api.get<Media>(`/admin/media/${id}`), enabled: !!id, staleTime: 5 * 60_000 });
}

type ImageLike = { id?: string; url: string; urls?: Record<string, string> } | null | undefined;

/** Ô chọn 1 ảnh. value là Media (hoặc MediaRef có url). */
export function ImageField({ value, onChange, aspect = 'aspect-video', label = 'Chọn ảnh', className }: { value: ImageLike; onChange: (m: Media | null) => void; aspect?: string; label?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const src = value?.urls?.medium ?? value?.url;
  return (
    <div className={className}>
      {src ? (
        <div className={cn('group relative overflow-hidden rounded-lg border bg-muted', aspect)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-0 transition group-hover:opacity-100">
            <Button size="sm" variant="secondary" type="button" onClick={() => setOpen(true)}>
              <RefreshCw /> Đổi
            </Button>
            <Button size="sm" variant="destructive" type="button" onClick={() => onChange(null)}>
              <X /> Gỡ
            </Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={cn('flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-sm text-muted-foreground transition hover:border-primary hover:text-primary', aspect)}>
          <ImagePlus className="size-6" />
          {label}
        </button>
      )}
      <MediaPickerDialog open={open} onOpenChange={setOpen} onSelect={(items) => onChange(items[0] ?? null)} />
    </div>
  );
}

/** Ô chọn ảnh theo id (featuredImageId...). Tự tải thông tin ảnh để hiển thị. */
export function ImageIdField({ value, onChange, initial, aspect, label }: { value: string | null | undefined; onChange: (id: string | null, media: Media | null) => void; initial?: ImageLike; aspect?: string; label?: ReactNode }) {
  const [picked, setPicked] = useState<Media | null>(null);
  const fetched = useMediaById(value && !picked && initial?.id !== value ? value : null);
  const current: ImageLike = !value ? null : picked?.id === value ? picked : initial?.id === value ? initial : fetched.data;
  return (
    <ImageField
      value={current}
      aspect={aspect}
      label={label}
      onChange={(m) => {
        setPicked(m);
        onChange(m?.id ?? null, m);
      }}
    />
  );
}

function SortableThumb({ item, onRemove }: { item: { id: string; url: string; urls?: Record<string, string> }; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn('group relative aspect-square overflow-hidden rounded-lg border bg-muted', isDragging && 'z-10 opacity-70')} {...attributes} {...listeners}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={item.urls?.thumb ?? item.url} alt="" className="h-full w-full object-cover" draggable={false} />
      <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onRemove} className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 group-hover:opacity-100" aria-label="Gỡ ảnh">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Danh sách nhiều ảnh, kéo thả sắp xếp */
export function GalleryField<T extends { id: string; url: string; urls?: Record<string, string> }>({ value, onChange, mapMedia }: { value: T[]; onChange: (items: T[]) => void; mapMedia: (m: Media) => T }) {
  const [open, setOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = value.findIndex((v) => v.id === e.active.id);
    const to = value.findIndex((v) => v.id === e.over!.id);
    onChange(arrayMove(value, from, to));
  };
  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={value.map((v) => v.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-4 gap-2">
            {value.map((item) => (
              <SortableThumb key={item.id} item={item} onRemove={() => onChange(value.filter((v) => v.id !== item.id))} />
            ))}
            <button type="button" onClick={() => setOpen(true)} className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed text-muted-foreground hover:border-primary hover:text-primary" aria-label="Thêm ảnh">
              <Plus className="size-5" />
            </button>
          </div>
        </SortableContext>
      </DndContext>
      <MediaPickerDialog
        open={open}
        onOpenChange={setOpen}
        multiple
        onSelect={(items) => {
          const add = items.filter((m) => !value.some((v) => v.id === m.id)).map(mapMedia);
          onChange([...value, ...add]);
        }}
      />
    </div>
  );
}
