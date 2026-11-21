'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Activity, ExternalLink, History } from 'lucide-react';
import { Section } from '@/components/common/field';
import { EmptyState } from '@/components/common/empty-state';
import { describe, ENTITY } from '@/components/activity/activity-labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type Paginated } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ActivityRow {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

/** Dòng thời gian nhật ký: chấm màu theo loại hành động + nhãn + thời gian */
function Timeline({ rows, loading, showActor, emptyTitle, emptyDescription }: { rows: ActivityRow[]; loading: boolean; showActor?: boolean; emptyTitle: string; emptyDescription: string }) {
  if (loading)
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  if (!rows.length) return <EmptyState icon={History} title={emptyTitle} description={emptyDescription} />;
  return (
    <ol className="relative space-y-0 border-l pl-5">
      {rows.map((r) => {
        const d = describe(r.action);
        const e = r.entityType ? ENTITY[r.entityType] : undefined;
        const href = e?.href && r.entityId ? e.href(r.entityId) : null;
        return (
          <li key={r.id} className="relative pb-5 last:pb-0">
            {/* chấm trên trục thời gian */}
            <span className={cn('absolute -left-[25px] top-1.5 size-2.5 rounded-full ring-4 ring-card', d.verb.className.split(' ').find((c) => c.startsWith('bg-')) ?? 'bg-muted')} />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge className={cn('border-transparent font-medium', d.verb.className)}>{d.verb.label}</Badge>
              {/* vd. auth.login -> "Đăng nhập" / "Đăng nhập": không lặp lại tên đối tượng */}
              {d.entity !== d.verb.label && <span className="font-medium">{d.entity}</span>}
              {href ? (
                <Link href={href} className="font-mono text-xs text-primary hover:underline">
                  {r.entityId?.slice(0, 8)}…
                </Link>
              ) : (
                r.entityId && <span className="font-mono text-xs text-muted-foreground">{r.entityId.slice(0, 8)}…</span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground" title={formatDate(r.createdAt)}>
              {timeAgo(r.createdAt)}
              {showActor && r.user && ` · bởi ${r.user.name}`}
              {r.ip && (
                <>
                  {' · '}
                  <span className="font-mono">{r.ip}</span>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Tab "Hoạt động" trên trang chi tiết thành viên, gồm 2 dòng thời gian:
 * - thao tác do chính thành viên thực hiện (đăng nhập, sửa nội dung…);
 * - thay đổi mà quản trị viên đã làm trên tài khoản này (sửa thông tin, đặt lại 2FA…).
 */
export function UserActivityPanel({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const byUser = useQuery({
    queryKey: ['user-activity', userId, page],
    queryFn: () => api.get<Paginated<ActivityRow>>('/admin/activity', { userId, page, limit: 15 }),
  });
  const onUser = useQuery({
    queryKey: ['user-activity-on', userId],
    queryFn: () => api.get<Paginated<ActivityRow>>('/admin/activity', { entityType: 'user', entityId: userId, limit: 15 }),
  });
  const meta = byUser.data?.meta;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
      <Section
        title={
          <span className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" /> Thao tác của thành viên
          </span>
        }
        description="Những việc thành viên này đã làm trong hệ thống (lưu 180 ngày gần nhất)"
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link href={`/system-logs/activity?userId=${userId}`}>
              <ExternalLink /> Xem đầy đủ
            </Link>
          </Button>
        }
      >
        <Timeline rows={byUser.data?.data ?? []} loading={byUser.isLoading} emptyTitle="Chưa có hoạt động nào" emptyDescription="Thành viên chưa thực hiện thao tác nào được ghi nhật ký." />
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
            <span>
              Trang {meta.page} / {meta.totalPages} · {meta.total} mục
            </span>
            <div className="flex gap-1">
              <Button size="xs" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Trước
              </Button>
              <Button size="xs" variant="outline" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>
                Sau
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title={
          <span className="flex items-center gap-2">
            <History className="size-4 text-muted-foreground" /> Lịch sử tài khoản
          </span>
        }
        description="Thay đổi quản trị viên đã thực hiện trên tài khoản này"
      >
        <Timeline rows={onUser.data?.data ?? []} loading={onUser.isLoading} showActor emptyTitle="Chưa có thay đổi nào" emptyDescription="Tài khoản chưa bị quản trị viên chỉnh sửa." />
      </Section>
    </div>
  );
}
