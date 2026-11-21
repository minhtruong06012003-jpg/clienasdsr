'use client';

import { useState } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FileDown, GripVertical, Link2, Paperclip, Plus, Trash2 } from 'lucide-react';
import { Field } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { MediaPickerDialog } from '@/components/media/media-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatBytes } from '@/lib/format';
import type { Media } from '@/lib/types';
import { cn } from '@/lib/utils';
import { NumberInput } from './number-input';
import { uid } from './variants-editor';

/** Một file tải về của sản phẩm số (form). mediaId ưu tiên hơn url. */
export interface DownloadForm {
  id?: string;
  _key: string;
  name: string;
  mediaId: string | null;
  media?: { id: string; originalName?: string; size?: number; url?: string } | null;
  url: string;
  downloadLimit: number | null;
  expiryDays: number | null;
}

export const emptyDownload = (): DownloadForm => ({ _key: uid(), name: '', mediaId: null, media: null, url: '', downloadLimit: null, expiryDays: null });

/** Danh sách file tải về: chọn từ thư viện media (mọi loại file) hoặc nhập URL ngoài, kéo thả sắp xếp */
export function DownloadsEditor({ value, onChange }: { value: DownloadForm[]; onChange: (v: DownloadForm[]) => void }) {
  const [picking, setPicking] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const update = (key: string, patch: Partial<DownloadForm>) => onChange(value.map((d) => (d._key === key ? { ...d, ...patch } : d)));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onChange(
      arrayMove(
        value,
        value.findIndex((d) => d._key === e.active.id),
        value.findIndex((d) => d._key === e.over!.id),
      ),
    );
  };
  const add = () => onChange([...value, emptyDownload()]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Khách nhận link tải (qua email và trang tài khoản) sau khi đơn hàng được thanh toán. Mỗi file có thể giới hạn số lượt tải và thời hạn.</p>
      {value.length === 0 ? (
        <EmptyState icon={FileDown} title="Chưa có file tải về" description="Thêm file từ thư viện media (PDF, ZIP, EPUB, MP3...) hoặc nhập URL ngoài." action={<Button type="button" size="sm" onClick={add}><Plus /> Thêm file</Button>} />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={value.map((d) => d._key)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {value.map((d, i) => (
                <DownloadRow key={d._key} item={d} index={i} onChange={(patch) => update(d._key, patch)} onPick={() => setPicking(d._key)} onRemove={() => onChange(value.filter((x) => x._key !== d._key))} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {value.length > 0 && (
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus /> Thêm file
        </Button>
      )}
      <MediaPickerDialog
        open={!!picking}
        onOpenChange={(o) => !o && setPicking(null)}
        accept="all"
        title="Chọn file tải về"
        onSelect={(items: Media[]) => {
          const m = items[0];
          if (!m || !picking) return;
          const cur = value.find((d) => d._key === picking);
          update(picking, { mediaId: m.id, media: { id: m.id, originalName: m.originalName, size: m.size, url: m.url }, url: '', name: cur?.name || m.originalName.replace(/\.[^.]+$/, '') });
        }}
      />
    </div>
  );
}

function DownloadRow({ item, index, onChange, onPick, onRemove }: { item: DownloadForm; index: number; onChange: (patch: Partial<DownloadForm>) => void; onPick: () => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item._key });
  const [mode, setMode] = useState<'media' | 'url'>(item.mediaId ? 'media' : item.url ? 'url' : 'media');
  const missing = !item.mediaId && !item.url.trim();
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn('rounded-lg border bg-muted/20 p-3', isDragging && 'z-10 opacity-70 shadow-md', missing && 'border-amber-300 dark:border-amber-700')}>
      <div className="flex items-start gap-2">
        <button type="button" className="mt-2 cursor-grab text-muted-foreground hover:text-foreground" aria-label="Kéo để sắp xếp" {...attributes} {...listeners}>
          <GripVertical className="size-4" />
        </button>
        <div className="grid flex-1 gap-3 sm:grid-cols-[1fr_1fr]">
          <Field label={`Tên hiển thị #${index + 1}`} required>
            <Input value={item.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Vd: Ebook PDF, Bộ cài đặt..." />
          </Field>
          <Field
            label="Nguồn file"
            error={missing ? 'Chọn file hoặc nhập URL' : undefined}
            action={
              <div className="flex gap-1 text-xs">
                <button type="button" className={cn('rounded px-1.5 py-0.5', mode === 'media' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')} onClick={() => setMode('media')}>
                  Thư viện
                </button>
                <button type="button" className={cn('rounded px-1.5 py-0.5', mode === 'url' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')} onClick={() => setMode('url')}>
                  URL ngoài
                </button>
              </div>
            }
          >
            {mode === 'media' ? (
              <div className="flex items-center gap-2">
                {item.mediaId ? (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-sm">
                    <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{item.media?.originalName ?? 'File trong thư viện'}</span>
                    {item.media?.size != null && <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.media.size)}</span>}
                  </span>
                ) : (
                  <span className="flex-1 text-sm text-muted-foreground">Chưa chọn file</span>
                )}
                <Button type="button" variant="outline" size="sm" onClick={onPick}>
                  {item.mediaId ? 'Đổi' : 'Chọn file'}
                </Button>
                {item.mediaId && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ mediaId: null, media: null })}>
                    Gỡ
                  </Button>
                )}
              </div>
            ) : (
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input className="pl-8" value={item.url} onChange={(e) => onChange({ url: e.target.value, mediaId: null, media: null })} placeholder="https://..." />
              </div>
            )}
          </Field>
          <Field label="Giới hạn lượt tải" help="Để trống = không giới hạn">
            <NumberInput value={item.downloadLimit} onChange={(v) => onChange({ downloadLimit: v })} integer min={1} placeholder="Không giới hạn" />
          </Field>
          <Field label="Hết hạn sau (ngày)" help="Tính từ lúc thanh toán. Để trống = vĩnh viễn">
            <NumberInput value={item.expiryDays} onChange={(v) => onChange({ expiryDays: v })} integer min={1} placeholder="Vĩnh viễn" suffix="ngày" />
          </Field>
        </div>
        <Button type="button" variant="ghost" size="icon" className="text-destructive" aria-label="Xoá file" onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}
