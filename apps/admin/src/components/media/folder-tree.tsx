'use client';

import { useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, Images, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/components/common/confirm-dialog';
import { FolderNameDialog } from './folder-dialog';
import { buildFolderTree, DND_MEDIA_TYPE, type MediaFolder, type MediaFolderNode } from './media-api';

interface FolderTreeProps {
  folders: MediaFolder[] | undefined;
  /** 'all' | 'root' | 'trash' | folderId */
  value: string;
  onChange: (id: string) => void;
  trashCount?: number;
  showTrash?: boolean;
  /** Thả file (ids) vào thư mục -> di chuyển */
  onDropMedia?: (ids: string[], folderId: string | null) => void;
  totalCount?: number;
  rootCount?: number;
}

type DialogState = { mode: 'create'; parentId: string | null } | { mode: 'rename'; folder: MediaFolder } | null;

/** Sidebar cây thư mục media: mở/thu, tạo thư mục con, đổi tên, di chuyển, xoá, nhận kéo-thả file */
export function FolderTree({ folders, value, onChange, trashCount = 0, showTrash = true, onDropMedia, totalCount, rootCount }: FolderTreeProps) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const tree = folders ? buildFolderTree(folders) : [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['media'] });

  const submitDialog = async (name: string) => {
    if (!dialog) return;
    try {
      if (dialog.mode === 'create') {
        await api.post('/admin/media/folders', { name, parentId: dialog.parentId });
        if (dialog.parentId) setExpanded((e) => ({ ...e, [dialog.parentId!]: true }));
        toast.success('Đã tạo thư mục');
      } else {
        await api.patch(`/admin/media/folders/${dialog.folder.id}`, { name });
        toast.success('Đã đổi tên thư mục');
      }
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };

  const moveFolder = async (f: MediaFolder, parentId: string | null) => {
    try {
      await api.patch(`/admin/media/folders/${f.id}`, { parentId: parentId ?? 'root' });
      if (parentId) setExpanded((e) => ({ ...e, [parentId]: true }));
      toast.success(`Đã chuyển “${f.name}”`);
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const deleteFolder = async (f: MediaFolder) => {
    const ok = await confirm({
      title: `Xoá thư mục "${f.name}"?`,
      description: 'File và thư mục con bên trong sẽ được chuyển lên thư mục cha (không bị xoá).',
      destructive: true,
      confirmText: 'Xoá thư mục',
    });
    if (!ok) return;
    try {
      await api.delete(`/admin/media/folders/${f.id}`);
      toast.success('Đã xoá thư mục');
      if (value === f.id) onChange(f.parentId ?? 'all');
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // ---- kéo thả file vào thư mục ----
  const hasMedia = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DND_MEDIA_TYPE);
  const dragProps = (target: string | null, key: string) =>
    onDropMedia && can('media.write')
      ? {
          onDragOver: (e: DragEvent) => {
            if (!hasMedia(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (dropTarget !== key) setDropTarget(key);
          },
          onDragLeave: () => dropTarget === key && setDropTarget(null),
          onDrop: (e: DragEvent) => {
            if (!hasMedia(e)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            try {
              const ids = JSON.parse(e.dataTransfer.getData(DND_MEDIA_TYPE)) as string[];
              if (ids.length) onDropMedia(ids, target);
            } catch {
              /* bỏ qua dữ liệu kéo không hợp lệ */
            }
          },
        }
      : {};

  const isDescendant = (node: MediaFolderNode, id: string): boolean => node.id === id || node.children.some((c) => isDescendant(c, id));

  /** Menu con "Chuyển tới" liệt kê mọi thư mục (trừ chính nó và con cháu) */
  const renderMoveTargets = (f: MediaFolder, nodes: MediaFolderNode[]): React.ReactNode =>
    nodes
      .filter((n) => !isDescendant(n, f.id))
      .map((n) => (
        <div key={n.id}>
          <DropdownMenuItem disabled={n.id === f.parentId} onClick={() => moveFolder(f, n.id)} style={{ paddingLeft: 8 + n.depth * 12 }}>
            <Folder /> {n.name}
          </DropdownMenuItem>
          {renderMoveTargets(f, n.children)}
        </div>
      ));

  const renderNode = (n: MediaFolderNode) => {
    const open = expanded[n.id] ?? n.depth === 0;
    const hasChildren = n.children.length > 0;
    const activeNode = value === n.id;
    return (
      <div key={n.id}>
        <div className={cn('group flex items-center rounded-md', activeNode ? 'bg-primary/10 text-primary' : 'hover:bg-muted', dropTarget === n.id && 'ring-2 ring-primary ring-inset bg-primary/5')} style={{ paddingLeft: n.depth * 12 }} {...dragProps(n.id, n.id)}>
          <button type="button" className={cn('flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted', !hasChildren && 'invisible')} onClick={() => setExpanded((e) => ({ ...e, [n.id]: !open }))} aria-label={open ? 'Thu gọn' : 'Mở rộng'}>
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          <button type="button" onClick={() => onChange(n.id)} onDoubleClick={() => hasChildren && setExpanded((e) => ({ ...e, [n.id]: !open }))} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left" title={n.name}>
            {activeNode || (open && hasChildren) ? <FolderOpen className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
            <span className="truncate">{n.name}</span>
            <span className="ml-auto pl-1 text-xs tabular-nums text-muted-foreground">{n._count.media || ''}</span>
          </button>
          {can('media.write') && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-xs" variant="ghost" className="mr-0.5 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Tuỳ chọn thư mục">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setDialog({ mode: 'create', parentId: n.id })}>
                  <FolderPlus /> Tạo thư mục con
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog({ mode: 'rename', folder: n })}>
                  <Pencil /> Đổi tên
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <FolderInput /> Chuyển tới
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-72 w-52 overflow-auto">
                    <DropdownMenuItem disabled={n.parentId === null} onClick={() => moveFolder(n, null)}>
                      <Images /> Gốc thư viện
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {renderMoveTargets(n, tree)}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {can('media.delete') && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => deleteFolder(n)}>
                      <Trash2 /> Xoá thư mục
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {open && hasChildren && <div>{n.children.map(renderNode)}</div>}
      </div>
    );
  };

  const fixed = [
    { id: 'all', name: 'Tất cả file', icon: Images, count: totalCount, drop: undefined },
    { id: 'root', name: 'Chưa phân loại', icon: Folder, count: rootCount, drop: null },
  ] as const;

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r md:flex">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Thư mục</span>
        {can('media.write') && (
          <Button size="icon-xs" variant="ghost" onClick={() => setDialog({ mode: 'create', parentId: value !== 'all' && value !== 'root' && value !== 'trash' ? value : null })} title="Tạo thư mục">
            <FolderPlus />
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-0.5 p-2 text-sm">
          {fixed.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onChange(f.id)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', value === f.id ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted', f.drop !== undefined && dropTarget === f.id && 'ring-2 ring-primary ring-inset bg-primary/5')}
              {...(f.drop !== undefined ? dragProps(f.drop, f.id) : {})}
            >
              <f.icon className="size-4" /> {f.name}
              {f.count !== undefined && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{f.count || ''}</span>}
            </button>
          ))}
          {tree.length > 0 && <div className="my-1 border-t" />}
          {tree.map(renderNode)}
          {folders && tree.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">Chưa có thư mục. Bấm + để tạo.</p>}
          {showTrash && (
            <>
              <div className="my-1 border-t" />
              <button type="button" onClick={() => onChange('trash')} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', value === 'trash' ? 'bg-destructive/10 font-medium text-destructive' : 'hover:bg-muted')}>
                <Trash2 className="size-4" /> Thùng rác
                {trashCount > 0 && <span className={cn('ml-auto rounded-full px-1.5 text-[11px] tabular-nums', value === 'trash' ? 'bg-destructive/15' : 'bg-muted text-muted-foreground')}>{trashCount}</span>}
              </button>
            </>
          )}
        </div>
      </ScrollArea>
      <FolderNameDialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog?.mode === 'rename' ? 'Đổi tên thư mục' : 'Tạo thư mục mới'}
        description={dialog?.mode === 'create' && dialog.parentId ? `Thư mục con của “${folders?.find((f) => f.id === dialog.parentId)?.name ?? ''}”` : undefined}
        initial={dialog?.mode === 'rename' ? dialog.folder.name : ''}
        submitText={dialog?.mode === 'rename' ? 'Đổi tên' : 'Tạo'}
        onSubmit={submitDialog}
      />
    </aside>
  );
}
