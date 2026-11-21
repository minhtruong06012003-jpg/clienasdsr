'use client';

import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, ChevronDown, Copy, Crop, Download, File, FileText, Film, Link2, Loader2, Replace, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { I18nInput } from '@/components/common/i18n-input';
import { Field } from '@/components/common/field';
import { isImage } from './use-upload';
import { downloadMedia, fileKind, folderPath, isRasterImage, type MediaFolder, type MediaItem } from './media-api';
import { ImageEditorDialog } from './image-editor-dialog';
import { UsageList, useMediaUsage } from './media-usage';

const SIZE_LABEL: Record<string, string> = { original: 'Gốc', thumb: 'Thumb (320px)', medium: 'Medium (768px)', large: 'Large (1600px)', webp: 'WebP (gốc)' };

interface MediaDetailsProps {
  media: MediaItem;
  folders?: MediaFolder[];
  onClose: () => void;
  /** Sau khi lưu/chỉnh/thay file -> cập nhật item đang chọn */
  onChanged?: (m: MediaItem) => void;
  onTrash?: (m: MediaItem) => void;
  onRestore?: (m: MediaItem) => void;
  onDestroy?: (m: MediaItem) => void;
  className?: string;
}

/** Panel chi tiết file: thông tin, alt/caption, URL các cỡ, chỉnh ảnh, thay file, tải xuống, đang dùng ở */
export function MediaDetails({ media, folders, onClose, onChanged, onTrash, onRestore, onDestroy, className }: MediaDetailsProps) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const trashed = !!media.deletedAt;
  const [alt, setAlt] = useState(media.alt ?? {});
  const [caption, setCaption] = useState(media.caption ?? {});
  const [name, setName] = useState(media.originalName);
  const [key, setKey] = useState(media.id);
  if (key !== media.id) {
    setKey(media.id);
    setAlt(media.alt ?? {});
    setCaption(media.caption ?? {});
    setName(media.originalName);
  }
  const [sizeKey, setSizeKey] = useState('original');
  const [editing, setEditing] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const replaceRef = useRef<HTMLInputElement>(null);
  const usage = useMediaUsage(media.id, usageOpen);

  const save = useMutation({
    mutationFn: () => api.patch<MediaItem>(`/admin/media/${media.id}`, { alt, caption, originalName: name }),
    onSuccess: (m) => {
      toast.success('Đã lưu');
      onChanged?.(m);
      void qc.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const replace = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.upload<MediaItem>(`/admin/media/${media.id}/replace`, fd);
    },
    onSuccess: (m) => {
      toast.success('Đã thay file');
      onChanged?.(m);
      void qc.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const urls = media.urls ?? { original: media.url };
  const currentUrl = urls[sizeKey] ?? media.url;
  const copy = (text: string, msg = 'Đã copy URL') => {
    void navigator.clipboard.writeText(text);
    toast.success(msg);
  };
  const dir = folderPath(folders, media.folderId);

  return (
    <aside className={cn('hidden w-80 shrink-0 flex-col border-l lg:flex', className)}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Chi tiết</span>
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Đóng">
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          <div className="flex items-center justify-center overflow-hidden rounded-lg border bg-[repeating-conic-gradient(#f1f5f9_0_25%,#fff_0_50%)] bg-[length:16px_16px] dark:bg-[repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)]">
            {isImage(media) ? (
              // key theo path để ảnh mới (sau chỉnh/thay) không bị cache
              // eslint-disable-next-line @next/next/no-img-element
              <img key={media.path} src={media.urls?.medium ?? media.url} alt="" className="max-h-56 w-full object-contain" />
            ) : media.mimeType.startsWith('video/') ? (
              <video key={media.path} src={media.url} controls preload="metadata" className="max-h-56 w-full" />
            ) : (
              <div className="flex h-32 items-center justify-center">{media.mimeType === 'application/pdf' ? <FileText className="size-12 text-red-500" /> : media.mimeType.startsWith('video/') ? <Film className="size-12 text-muted-foreground" /> : <File className="size-12 text-muted-foreground" />}</div>
            )}
          </div>
          {trashed && <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">Đang trong thùng rác (xoá {formatDate(media.deletedAt)}). Tự xoá vĩnh viễn sau 30 ngày.</div>}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Loại</dt>
            <dd className="truncate" title={media.mimeType}>
              {fileKind(media)} <span className="text-muted-foreground">({media.mimeType})</span>
            </dd>
            <dt className="text-muted-foreground">Dung lượng</dt>
            <dd>{formatBytes(media.size)}</dd>
            {media.width && (
              <>
                <dt className="text-muted-foreground">Kích thước</dt>
                <dd>
                  {media.width} × {media.height}px
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Ngày tải</dt>
            <dd>{formatDate(media.createdAt)}</dd>
            {media.uploader && (
              <>
                <dt className="text-muted-foreground">Người tải</dt>
                <dd>{media.uploader.name}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Thư mục</dt>
            <dd className="truncate">{dir || 'Chưa phân loại'}</dd>
            <dt className="text-muted-foreground">File</dt>
            <dd className="truncate" title={media.path}>
              {media.filename}
            </dd>
          </dl>

          <Field label="Tên file">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" disabled={trashed} />
          </Field>
          {isImage(media) && (
            <>
              <Field label="Văn bản thay thế (alt)" help="Mô tả ảnh cho SEO & người khiếm thị">
                <I18nInput value={alt} onChange={setAlt} />
              </Field>
              <Field label="Chú thích (caption)" help="Hiển thị dưới ảnh khi block/bài viết dùng chú thích">
                <I18nInput value={caption} onChange={setCaption} />
              </Field>
            </>
          )}

          <Field label="Đường dẫn">
            <div className="space-y-1.5">
              {Object.keys(urls).length > 1 && (
                <Select value={sizeKey} onValueChange={setSizeKey}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['original', 'thumb', 'medium', 'large', 'webp'].filter((k) => urls[k]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {SIZE_LABEL[k] ?? k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="flex gap-1">
                <Input readOnly value={currentUrl} className="h-8 text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button size="icon-sm" variant="outline" onClick={() => copy(currentUrl)} title="Copy URL">
                  <Copy />
                </Button>
              </div>
              {Object.keys(urls).length > 1 && (
                <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => copy(Object.entries(urls).map(([k, u]) => `${SIZE_LABEL[k] ?? k}: ${u}`).join('\n'), 'Đã copy URL tất cả kích thước')}>
                  <Link2 /> Copy tất cả kích thước
                </Button>
              )}
            </div>
          </Field>

          {/* Hành động */}
          <div className="grid grid-cols-2 gap-1.5">
            {can('media.write') && !trashed && isRasterImage(media) && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Crop /> Chỉnh ảnh
              </Button>
            )}
            {can('media.write') && !trashed && (
              <Button size="sm" variant="outline" onClick={() => replaceRef.current?.click()} disabled={replace.isPending}>
                {replace.isPending ? <Loader2 className="animate-spin" /> : <Replace />} Thay file
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void downloadMedia(media)}>
              <Download /> Tải xuống
            </Button>
            <input
              ref={replaceRef}
              type="file"
              hidden
              accept={isImage(media) ? 'image/*' : media.mimeType.startsWith('video/') ? 'video/*' : undefined}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) replace.mutate(f);
                e.target.value = '';
              }}
            />
          </div>

          <Collapsible open={usageOpen} onOpenChange={setUsageOpen}>
            <CollapsibleTrigger asChild>
              <button type="button" className="flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted">
                <span>
                  Đang dùng ở{usage.data ? ` (${usage.data.length})` : ''}
                </span>
                {usage.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronDown className={cn('size-3.5 transition-transform', usageOpen && 'rotate-180')} />}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              {usage.isError ? <p className="text-xs text-destructive">{errorMessage(usage.error)}</p> : usage.data ? <UsageList items={usage.data} compact /> : null}
            </CollapsibleContent>
          </Collapsible>

          <div className="flex gap-2">
            {!trashed ? (
              <>
                {can('media.write') && (
                  <Button size="sm" className="flex-1" onClick={() => save.mutate()} disabled={save.isPending}>
                    {save.isPending && <Loader2 className="animate-spin" />} Lưu
                  </Button>
                )}
                {can('media.delete') && onTrash && (
                  <Button size="sm" variant="destructive" onClick={() => onTrash(media)} title="Chuyển vào thùng rác">
                    <Trash2 />
                  </Button>
                )}
              </>
            ) : (
              <>
                {can('media.write') && onRestore && (
                  <Button size="sm" className="flex-1" onClick={() => onRestore(media)}>
                    <ArchiveRestore /> Khôi phục
                  </Button>
                )}
                {can('media.delete') && onDestroy && (
                  <Button size="sm" variant="destructive" onClick={() => onDestroy(media)}>
                    <Trash2 /> Xoá vĩnh viễn
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </ScrollArea>
      {isRasterImage(media) && <ImageEditorDialog open={editing} onOpenChange={setEditing} media={media} onSaved={onChanged} />}
    </aside>
  );
}
