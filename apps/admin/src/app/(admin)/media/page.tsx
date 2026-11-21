'use client';

import { useQuery } from '@tanstack/react-query';
import { File, Film, FolderOpen, HardDrive, Image as ImageIcon, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { MediaLibrary } from '@/components/media/media-library';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';

interface MediaStats {
  count: number;
  totalSize: number;
  folders?: number;
  trash?: { count: number; size: number };
  byType?: Record<'image' | 'video' | 'document', { count: number; size: number }>;
}

function StatChip({ icon: Icon, label, value, sub, tone = 'primary' }: { icon: React.ElementType; label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'primary' | 'destructive' }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5">
      <div className={tone === 'destructive' ? 'flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive' : 'flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-semibold">
          {value}
          {sub && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{sub}</span>}
        </div>
      </div>
    </div>
  );
}

export default function MediaPage() {
  const stats = useQuery({ queryKey: ['media', 'stats'], queryFn: () => api.get<MediaStats>('/admin/media/stats') });
  const s = stats.data;
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('vi-VN');

  return (
    <div className="flex h-svh flex-col">
      <PageHeader title="Thư viện media" description="Quản lý ảnh, video và tài liệu. Kéo thả file vào khung bên dưới để tải lên, kéo file vào thư mục để di chuyển." />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-6">
        <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {!s ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[58px] rounded-xl" />)
          ) : (
            <>
              <StatChip icon={HardDrive} label="Tổng dung lượng" value={formatBytes(s.totalSize)} sub={`${n(s.count)} file`} />
              <StatChip icon={ImageIcon} label="Ảnh" value={n(s.byType?.image.count)} sub={formatBytes(s.byType?.image.size ?? 0)} />
              <StatChip icon={Film} label="Video" value={n(s.byType?.video.count)} sub={formatBytes(s.byType?.video.size ?? 0)} />
              <StatChip icon={File} label="Tài liệu & khác" value={n(s.byType?.document.count)} sub={formatBytes(s.byType?.document.size ?? 0)} />
              <StatChip icon={FolderOpen} label="Thư mục" value={n(s.folders)} />
              <StatChip icon={Trash2} label="Thùng rác" value={n(s.trash?.count)} sub={s.trash?.size ? formatBytes(s.trash.size) : 'tự dọn sau 30 ngày'} tone={s.trash?.count ? 'destructive' : 'primary'} />
            </>
          )}
        </div>
        <MediaLibrary mode="page" className="min-h-[420px]" />
      </div>
    </div>
  );
}
