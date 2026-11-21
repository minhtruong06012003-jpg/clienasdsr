'use client';

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, Check, Eraser, File, FileText, Film, Folder, LayoutGrid, List, Loader2, Search, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import type { Media } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/components/common/confirm-dialog';
import { isImage, useMediaUpload } from './use-upload';
import { FolderTree } from './folder-tree';
import { MediaDetails } from './media-details';
import { UsageConflictDialog } from './media-usage';
import { destroyMedia, DND_MEDIA_TYPE, emptyTrash, fileKind, flattenFolders, folderPath, MediaInUseError, moveMedia, restoreMedia, SORT_OPTIONS, trashMedia, type MediaFolder, type MediaItem, type MediaUsage, type SortValue } from './media-api';

interface MediaLibraryProps {
  /** picker = đang chọn file cho field; page = trang quản lý media */
  mode?: 'page' | 'picker';
  multiple?: boolean;
  accept?: 'image' | 'all';
  selected?: Media[];
  onSelectedChange?: (items: Media[]) => void;
  className?: string;
}

interface MediaStats {
  count: number;
  trash?: { count: number; size: number };
}

type Conflict = { list: MediaItem[]; usage: Record<string, MediaUsage[]>; names: Record<string, string> };

export function MediaLibrary({ mode = 'page', multiple = false, accept = 'all', selected = [], onSelectedChange, className }: MediaLibraryProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canUpload = can('media.write') || (mode === 'picker' && (can('settings.general') || can('settings.seo') || can('settings.popup')));
  const [folderId, setFolderId] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<string>(accept === 'image' ? 'image' : 'all');
  const [sortValue, setSortValue] = useState<SortValue>('newest');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeFallback, setActiveFallback] = useState<MediaItem | null>(null);
  const [checked, setChecked] = useState<MediaItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounce(search);
  const { upload, uploading } = useMediaUpload();
  const trashed = folderId === 'trash';
  const sortOpt = SORT_OPTIONS.find((s) => s.value === sortValue) ?? SORT_OPTIONS[0];

  const folders = useQuery({ queryKey: ['media', 'folders'], queryFn: () => api.get<MediaFolder[]>('/admin/media/folders') });
  const stats = useQuery({ queryKey: ['media', 'stats'], queryFn: () => api.get<MediaStats>('/admin/media/stats'), enabled: mode === 'page' });
  const query = useInfiniteQuery({
    queryKey: ['media', 'list', folderId, debounced, type, sortOpt.sort, sortOpt.order],
    queryFn: ({ pageParam }) =>
      api.get<Paginated<MediaItem>>('/admin/media', {
        page: pageParam,
        limit: 40,
        search: debounced,
        folderId: folderId === 'all' || trashed ? undefined : folderId,
        type: type === 'all' ? undefined : type,
        sort: sortOpt.sort,
        order: sortOpt.order,
        trashed: trashed ? 1 : undefined,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  const total = query.data?.pages[0]?.meta.total ?? 0;
  // item đang mở panel: ưu tiên bản mới nhất trong danh sách (sau khi refetch), fallback bản vừa trả về từ API
  const active = useMemo(() => (activeId ? (items.find((i) => i.id === activeId) ?? (activeFallback?.id === activeId ? activeFallback : null)) : null), [activeId, items, activeFallback]);
  const openDetails = (m: MediaItem | null) => {
    setActiveId(m?.id ?? null);
    setActiveFallback(m);
  };
  const refreshAll = () => qc.invalidateQueries({ queryKey: ['media'] });

  const selection = mode === 'picker' ? selected : checked;
  const isSelected = (m: Media) => selection.some((s) => s.id === m.id);
  const isChecked = (m: Media) => checked.some((x) => x.id === m.id);
  const toggleCheck = (m: MediaItem) => setChecked((c) => (c.some((x) => x.id === m.id) ? c.filter((x) => x.id !== m.id) : [...c, m]));
  const toggle = (m: MediaItem) => {
    openDetails(m);
    if (mode === 'picker') {
      if (accept === 'image' && !isImage(m)) return toast.error('Vui lòng chọn file ảnh');
      onSelectedChange?.(multiple ? (isSelected(m) ? selected.filter((s) => s.id !== m.id) : [...selected, m]) : [m]);
    }
  };
  const changeFolder = (id: string) => {
    setFolderId(id);
    setChecked([]);
    openDetails(null);
  };

  // ---- upload ----
  const doUpload = async (files: FileList | File[]) => {
    const uploaded = await upload(files, folderId !== 'all' && folderId !== 'root' && !trashed ? folderId : null);
    if (uploaded.length && mode === 'picker') {
      const usable = accept === 'image' ? uploaded.filter(isImage) : uploaded;
      onSelectedChange?.(multiple ? [...selected, ...usable] : usable.slice(0, 1));
    }
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e) || !canUpload) return;
    e.preventDefault();
    setDragging(false);
    if (trashed) return toast.error('Không thể tải lên trong thùng rác');
    if (e.dataTransfer.files?.length) void doUpload(e.dataTransfer.files);
  };

  // ---- kéo file media thả vào thư mục ----
  const onItemDragStart = (e: DragEvent, m: MediaItem) => {
    const ids = isChecked(m) ? checked.map((c) => c.id) : [m.id];
    e.dataTransfer.setData(DND_MEDIA_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  };
  const run = async (fn: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      setChecked([]);
      void refreshAll();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const moveTo = (ids: string[], target: string | null) => {
    if (!ids.length) return;
    const name = target ? (folders.data?.find((f) => f.id === target)?.name ?? 'thư mục') : 'Chưa phân loại';
    void run(() => moveMedia(ids, target), `Đã chuyển ${ids.length} file tới “${name}”`);
  };

  // ---- thùng rác ----
  const trash = async (list: MediaItem[], force = false) => {
    if (!list.length || busy) return;
    setBusy(true);
    try {
      const res = await trashMedia(list.map((m) => m.id), force);
      toast.success(`Đã chuyển ${res.deleted} file vào thùng rác`);
      setConflict(null);
      setChecked((c) => c.filter((x) => !list.some((m) => m.id === x.id)));
      if (active && list.some((m) => m.id === active.id)) openDetails(null);
      void refreshAll();
    } catch (e) {
      if (e instanceof MediaInUseError) {
        setConflict({ list, usage: e.usage, names: Object.fromEntries(list.map((m) => [m.id, m.originalName])) });
      } else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = (list: MediaItem[]) => {
    if (active && list.some((m) => m.id === active.id)) openDetails(null);
    void run(() => restoreMedia(list.map((m) => m.id)), `Đã khôi phục ${list.length} file`);
  };
  const destroy = async (list: MediaItem[]) => {
    if (!list.length) return;
    const ok = await confirm({
      title: list.length === 1 ? `Xoá vĩnh viễn “${list[0].originalName}”?` : `Xoá vĩnh viễn ${list.length} file?`,
      description: 'File và các kích thước đã tạo sẽ bị xoá khỏi máy chủ, không thể khôi phục. Nội dung đang dùng file sẽ mất ảnh.',
      destructive: true,
      confirmText: 'Xoá vĩnh viễn',
    });
    if (!ok) return;
    if (active && list.some((m) => m.id === active.id)) openDetails(null);
    void run(() => destroyMedia(list.map((m) => m.id)), `Đã xoá vĩnh viễn ${list.length} file`);
  };
  const clearTrash = async () => {
    const n = stats.data?.trash?.count ?? total;
    const ok = await confirm({ title: 'Dọn sạch thùng rác?', description: `${n} file sẽ bị xoá vĩnh viễn khỏi máy chủ, không thể khôi phục.`, destructive: true, confirmText: 'Dọn thùng rác' });
    if (!ok) return;
    openDetails(null);
    void run(() => emptyTrash(), 'Đã dọn thùng rác');
  };

  const folderOptions = useMemo(() => flattenFolders(folders.data), [folders.data]);
  const rootCount = useMemo(() => (stats.data && folders.data ? Math.max(0, stats.data.count - folders.data.reduce((s, f) => s + f._count.media, 0)) : undefined), [stats.data, folders.data]);
  const allChecked = items.length > 0 && items.every(isChecked);

  const thumb = (m: MediaItem, cls = 'size-10') =>
    isImage(m) ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img key={m.path} src={m.urls?.thumb ?? m.url} alt={m.alt?.vi ?? m.originalName} loading="lazy" className={cn(cls, 'object-cover')} />
    ) : m.mimeType.startsWith('video/') ? (
      <Film className="size-6 text-muted-foreground" />
    ) : m.mimeType === 'application/pdf' ? (
      <FileText className="size-6 text-red-500" />
    ) : (
      <File className="size-6 text-muted-foreground" />
    );

  return (
    <div
      className={cn('flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card', className)}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <FolderTree folders={folders.data} value={folderId} onChange={changeFolder} showTrash={mode === 'page'} trashCount={stats.data?.trash?.count ?? 0} totalCount={stats.data?.count} rootCount={rootCount} onDropMedia={mode === 'page' ? moveTo : undefined} />

      {/* Danh sách file */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm file..." className="h-8 w-44 pl-7" />
          </div>
          {accept !== 'image' && (
            <Select value={type} onValueChange={setType}>
              <SelectTrigger size="sm" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả loại</SelectItem>
                <SelectItem value="image">Ảnh</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="document">Tài liệu</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Select value={sortValue} onValueChange={(v) => setSortValue(v as SortValue)}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToggleGroup type="single" variant="outline" size="sm" value={layout} onValueChange={(v) => v && setLayout(v as 'grid' | 'list')}>
            <ToggleGroupItem value="grid" aria-label="Dạng lưới" title="Lưới">
              <LayoutGrid />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="Dạng danh sách" title="Danh sách">
              <List />
            </ToggleGroupItem>
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">
            {total} file{trashed && ' trong thùng rác'}
            {query.isFetching && !query.isFetchingNextPage && <Loader2 className="ml-1 inline size-3 animate-spin" />}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {mode === 'page' && checked.length > 0 && (
              <>
                <span className="text-xs font-medium">Đã chọn {checked.length}</span>
                <Button size="sm" variant="ghost" onClick={() => setChecked([])}>
                  <X /> Bỏ chọn
                </Button>
                {!trashed ? (
                  <>
                    {can('media.write') && (
                      <Select value="" onValueChange={(v) => moveTo(checked.map((c) => c.id), v === 'root' ? null : v)} disabled={busy}>
                        <SelectTrigger size="sm" className="w-40">
                          <SelectValue placeholder="Chuyển tới..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="root">Chưa phân loại</SelectItem>
                          {folderOptions.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              <span style={{ paddingLeft: f.depth * 10 }}>{f.name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {can('media.delete') && (
                      <Button size="sm" variant="destructive" onClick={() => void trash(checked)} disabled={busy}>
                        <Trash2 /> Thùng rác ({checked.length})
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    {can('media.write') && (
                      <Button size="sm" variant="outline" onClick={() => restore(checked)} disabled={busy}>
                        <ArchiveRestore /> Khôi phục ({checked.length})
                      </Button>
                    )}
                    {can('media.delete') && (
                      <Button size="sm" variant="destructive" onClick={() => void destroy(checked)} disabled={busy}>
                        <Trash2 /> Xoá vĩnh viễn ({checked.length})
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
            {trashed && checked.length === 0 && can('media.delete') && total > 0 && (
              <Button size="sm" variant="outline" onClick={() => void clearTrash()} disabled={busy}>
                <Eraser /> Dọn thùng rác
              </Button>
            )}
            {!trashed && canUpload && (
              <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="animate-spin" /> : <Upload />} Tải lên
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept={accept === 'image' ? 'image/*' : undefined}
              onChange={(e) => {
                if (e.target.files) void doUpload(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {layout === 'grid' ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3 p-3">
              {items.map((m) => (
                <div
                  key={m.id}
                  draggable={mode === 'page' && !trashed && can('media.write')}
                  onDragStart={(e) => onItemDragStart(e, m)}
                  className={cn('group relative overflow-hidden rounded-lg border bg-muted/40 text-left transition', isSelected(m) ? 'ring-2 ring-primary' : 'hover:ring-2 hover:ring-primary/40', active?.id === m.id && mode === 'page' && 'ring-2 ring-primary/60')}
                >
                  <button type="button" onClick={() => toggle(m)} onDoubleClick={() => mode === 'page' && toggleCheck(m)} className="block w-full">
                    <div className="flex aspect-square items-center justify-center overflow-hidden bg-[repeating-conic-gradient(#f1f5f9_0_25%,#fff_0_50%)] bg-[length:16px_16px] dark:bg-[repeating-conic-gradient(#27272a_0_25%,#18181b_0_50%)]">{thumb(m, 'h-full w-full')}</div>
                    <div className="truncate px-2 py-1.5 text-xs" title={m.originalName}>
                      {m.originalName}
                    </div>
                  </button>
                  {mode === 'page' ? (
                    <button type="button" onClick={() => toggleCheck(m)} className={cn('absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded border bg-background/90 transition', isChecked(m) ? 'border-primary bg-primary text-primary-foreground' : 'opacity-0 group-hover:opacity-100')} aria-label="Chọn">
                      <Check className="size-3" />
                    </button>
                  ) : (
                    isSelected(m) && (
                      <span className="absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-3" />
                      </span>
                    )
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {mode === 'page' && (
                    <TableHead className="w-8">
                      <Checkbox checked={allChecked ? true : checked.length ? 'indeterminate' : false} onCheckedChange={(v) => setChecked(v === true ? items : [])} aria-label="Chọn tất cả" />
                    </TableHead>
                  )}
                  <TableHead className="w-14">Ảnh</TableHead>
                  <TableHead>Tên</TableHead>
                  <TableHead className="w-24">Loại</TableHead>
                  <TableHead className="w-28">Kích thước</TableHead>
                  <TableHead className="w-24">Dung lượng</TableHead>
                  <TableHead className="w-36">{trashed ? 'Ngày xoá' : 'Ngày tải'}</TableHead>
                  {!trashed && <TableHead className="w-40">Thư mục</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((m) => (
                  <TableRow key={m.id} draggable={mode === 'page' && !trashed && can('media.write')} onDragStart={(e) => onItemDragStart(e, m)} onClick={() => toggle(m)} className={cn('cursor-pointer', (isSelected(m) || active?.id === m.id) && 'bg-primary/5')}>
                    {mode === 'page' && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={isChecked(m)} onCheckedChange={() => toggleCheck(m)} aria-label="Chọn" />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex size-10 items-center justify-center overflow-hidden rounded border bg-muted/40">{thumb(m)}</div>
                    </TableCell>
                    <TableCell className="max-w-0">
                      <div className="truncate font-medium" title={m.originalName}>
                        {m.originalName}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{m.filename}</div>
                    </TableCell>
                    <TableCell className="text-xs">{fileKind(m)}</TableCell>
                    <TableCell className="text-xs tabular-nums">{m.width ? `${m.width} × ${m.height}` : '—'}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatBytes(m.size)}</TableCell>
                    <TableCell className="text-xs">{formatDate(trashed ? m.deletedAt : m.createdAt)}</TableCell>
                    {!trashed && (
                      <TableCell className="max-w-0 truncate text-xs text-muted-foreground">
                        {m.folderId ? (
                          <span className="inline-flex items-center gap-1">
                            <Folder className="size-3" /> {folderPath(folders.data, m.folderId)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {!query.isLoading && items.length === 0 && (
            <div className="flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
              {trashed ? (
                <>
                  <Trash2 className="size-8" /> Thùng rác trống
                </>
              ) : (
                <>
                  <Upload className="size-8" /> Kéo thả file vào đây hoặc bấm “Tải lên”
                </>
              )}
            </div>
          )}
          {query.hasNextPage && (
            <div className="p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage && <Loader2 className="animate-spin" />} Tải thêm
              </Button>
            </div>
          )}
        </ScrollArea>
        {(dragging || uploading) && !trashed && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
            <div className="rounded-xl border-2 border-dashed border-primary bg-background px-6 py-4 text-sm font-medium text-primary">{uploading ? 'Đang tải lên...' : 'Thả file để tải lên'}</div>
          </div>
        )}
      </div>

      {/* Chi tiết */}
      {active && mode === 'page' && (
        <MediaDetails
          media={active}
          folders={folders.data}
          onClose={() => openDetails(null)}
          onChanged={(m) => setActiveFallback(m)}
          onTrash={(m) => void trash([m])}
          onRestore={(m) => restore([m])}
          onDestroy={(m) => void destroy([m])}
        />
      )}

      {conflict && (
        <UsageConflictDialog
          open
          onOpenChange={(o) => !o && setConflict(null)}
          usage={conflict.usage}
          names={conflict.names}
          pending={busy}
          onForce={() => void trash(conflict.list, true)}
        />
      )}
    </div>
  );
}
