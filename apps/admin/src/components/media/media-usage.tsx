'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { USAGE_LABEL, type MediaUsage } from './media-api';

export function useMediaUsage(id: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: ['media', 'usage', id], queryFn: () => api.get<MediaUsage[]>(`/admin/media/${id}/usage`), enabled: !!id && enabled, staleTime: 30_000 });
}

/** Danh sách nơi đang dùng file, mỗi dòng là link tới trang quản trị tương ứng */
export function UsageList({ items, compact }: { items: MediaUsage[]; compact?: boolean }) {
  if (!items.length) return <p className="text-xs text-muted-foreground">Chưa có nội dung nào dùng file này.</p>;
  return (
    <ul className={compact ? 'space-y-1' : 'divide-y rounded-lg border'}>
      {items.map((u) => (
        <li key={`${u.type}:${u.id}`}>
          <Link href={u.href} target="_blank" className={compact ? 'flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted' : 'flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted'}>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {USAGE_LABEL[u.type] ?? u.type}
            </Badge>
            <span className="truncate">{u.title}</span>
            <ExternalLink className="ml-auto size-3 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Dialog cảnh báo khi xoá file đang được dùng (API trả 409). usage: { [mediaId]: MediaUsage[] }
 */
export function UsageConflictDialog({ open, onOpenChange, usage, names, onForce, pending }: { open: boolean; onOpenChange: (o: boolean) => void; usage: Record<string, MediaUsage[]>; names: Record<string, string>; onForce: () => void; pending?: boolean }) {
  const entries = Object.entries(usage);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600 dark:text-amber-400" /> File đang được sử dụng
          </DialogTitle>
          <DialogDescription>
            {entries.length === 1 ? 'File này' : `${entries.length} file`} đang được dùng trong nội dung bên dưới. Nếu vẫn chuyển vào thùng rác, nội dung đó vẫn hiển thị ảnh cho tới khi bạn xoá vĩnh viễn.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-3 overflow-auto">
          {entries.map(([id, list]) => (
            <div key={id}>
              {entries.length > 1 && <div className="mb-1 truncate text-xs font-medium">{names[id] ?? id}</div>}
              <UsageList items={list} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Huỷ
          </Button>
          <Button variant="destructive" onClick={onForce} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Vẫn chuyển vào thùng rác
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
