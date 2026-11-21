'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Laptop, Loader2, LogOut, Monitor, Smartphone, Tablet, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';

export interface SessionItem {
  id: string;
  ip: string | null;
  userAgent: string | null;
  browser: string;
  os: string;
  device: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  current: boolean;
}

const DEVICE_ICON: Record<SessionItem['device'], LucideIcon> = { desktop: Monitor, mobile: Smartphone, tablet: Tablet, unknown: Laptop };

/**
 * Danh sách phiên đăng nhập (thiết bị) + nút thu hồi.
 * - Của chính mình: `listPath="/auth/sessions"`, `revokePath=(id) => /auth/sessions/:id`, có nút "Đăng xuất thiết bị khác".
 * - Admin xem thành viên: `/admin/users/:id/sessions`.
 */
export function SessionsList({
  listPath,
  revokePath,
  revokeOthersPath,
  canRevoke = true,
  queryKey,
  pageSize = 10,
}: {
  listPath: string;
  revokePath: (id: string) => string;
  /** DELETE thu hồi mọi phiên khác (chỉ cho phiên của chính mình) */
  revokeOthersPath?: string;
  canRevoke?: boolean;
  queryKey: unknown[];
  /** Số phiên mỗi trang (API trả toàn bộ, phân trang phía client) */
  pageSize?: number;
}) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const confirm = useConfirm();
  const q = useQuery({ queryKey, queryFn: () => api.get<SessionItem[]>(listPath) });
  const refresh = () => qc.invalidateQueries({ queryKey });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(revokePath(id)),
    onSuccess: () => {
      toast.success('Đã thu hồi phiên đăng nhập');
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.delete<{ revoked: number }>(revokeOthersPath!),
    onSuccess: (r) => {
      toast.success(r.revoked ? `Đã đăng xuất ${r.revoked} thiết bị khác` : 'Không có thiết bị nào khác');
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    );
  }
  const items = q.data ?? [];
  const others = items.filter((s) => !s.current);
  // phân trang phía client; nếu thu hồi làm trang hiện tại rỗng thì lùi về trang cuối
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = items.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Không có phiên đăng nhập nào đang hoạt động.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {pageItems.map((s) => {
            const Icon = DEVICE_ICON[s.device] ?? Laptop;
            return (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                    <span className="font-medium">
                      {s.browser} · {s.os}
                    </span>
                    {s.current && (
                      <Badge variant="secondary" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-400">
                        Thiết bị này
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground" title={s.userAgent ?? undefined}>
                    {s.ip && <span className="font-mono">{s.ip}</span>}
                    {s.ip && ' · '}
                    Đăng nhập {formatDate(s.createdAt)}
                    {s.lastUsedAt && ` · Hoạt động ${timeAgo(s.lastUsedAt)}`}
                  </div>
                </div>
                {canRevoke && !s.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      if (await confirm({ title: 'Thu hồi phiên đăng nhập này?', description: `${s.browser} trên ${s.os} sẽ bị đăng xuất ngay lập tức.`, confirmText: 'Thu hồi', destructive: true })) revoke.mutate(s.id);
                    }}
                  >
                    {revoke.isPending && revoke.variables === s.id ? <Loader2 className="animate-spin" /> : <LogOut />} Thu hồi
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            Hiển thị {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, items.length)} / {items.length} thiết bị
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Trang trước">
              <ChevronLeft />
            </Button>
            <span className="min-w-14 text-center tabular-nums">
              {safePage} / {totalPages}
            </span>
            <Button variant="outline" size="icon-sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} aria-label="Trang sau">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
      {canRevoke && revokeOthersPath && others.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          disabled={revokeOthers.isPending}
          onClick={async () => {
            if (await confirm({ title: `Đăng xuất ${others.length} thiết bị khác?`, description: 'Mọi phiên đăng nhập trừ thiết bị hiện tại sẽ bị thu hồi.', confirmText: 'Đăng xuất', destructive: true })) revokeOthers.mutate();
          }}
        >
          {revokeOthers.isPending ? <Loader2 className="animate-spin" /> : <LogOut />} Đăng xuất tất cả thiết bị khác
        </Button>
      )}
    </div>
  );
}
