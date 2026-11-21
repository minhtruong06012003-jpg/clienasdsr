'use client';

import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Info, LayoutDashboard, Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Một vùng widget (GET /admin/widget-areas) */
interface WidgetAreaRow {
  key: string;
  label: string;
  description?: string | null;
  /** core | theme */
  source?: string | null;
  /** global block chứa nội dung vùng; null = chưa soạn */
  blockId: string | null;
}

/** Nhãn nguồn khai báo vùng (nguồn lạ từ dữ liệu cũ hiện nguyên văn) */
function sourceLabel(source?: string | null) {
  if (!source || source === 'core') return 'Lõi';
  if (source === 'theme') return 'Giao diện';
  return source;
}

/** Vùng widget: mỗi vùng là một global block (key `area-<vùng>`) soạn bằng Page Builder */
function WidgetAreasContent() {
  const router = useRouter();
  const { can } = useAuth();
  const canManage = can('templates.manage');
  const [opening, setOpening] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['widget-areas'], queryFn: () => api.get<WidgetAreaRow[]>('/admin/widget-areas'), enabled: canManage });

  /** Tạo global block cho vùng (nếu chưa có) rồi mở trình soạn block dùng chung */
  const edit = async (area: WidgetAreaRow) => {
    if (area.blockId) {
      router.push(`/blocks/${area.blockId}`);
      return;
    }
    setOpening(area.key);
    try {
      const res = await api.post<{ id: string }>(`/admin/widget-areas/${encodeURIComponent(area.key)}/ensure`);
      router.push(`/blocks/${res.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setOpening(null);
    }
  };

  if (!canManage) {
    return (
      <PageBody>
        <EmptyState icon={LayoutDashboard} title="Không có quyền" description="Bạn cần quyền quản lý mẫu giao diện để soạn vùng widget." />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader title="Vùng widget" description="Khu vực cố định trên giao diện (cột phải, dưới nút mua, chân trang...) — soạn nội dung bằng Page Builder" />
      <PageBody>
        <div className="space-y-4">
          <div className="flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/30">
            <Info className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />
            <div className="space-y-1 text-muted-foreground">
              <p>
                Mỗi vùng được lưu thành một <b className="text-foreground">block dùng chung</b> có key <code className="rounded bg-muted px-1 text-xs">area-&lt;mã vùng&gt;</code>. Vùng trống thì
                website không hiển thị gì.
              </p>
              <p>
                Frontend riêng của dự án có thể khai báo thêm vùng qua <code className="rounded bg-muted px-1 text-xs">GET /api/capabilities</code> (mục{' '}
                <code className="rounded bg-muted px-1 text-xs">theme.widgetAreas</code>) — vùng mới sẽ tự hiện ở đây.
              </p>
            </div>
          </div>

          {list.isLoading ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : list.isError ? (
            <EmptyState icon={LayoutDashboard} title="Không tải được danh sách vùng" description={errorMessage(list.error)} />
          ) : !list.data?.length ? (
            <EmptyState icon={LayoutDashboard} title="Chưa có vùng widget" description="Giao diện hiện tại chưa khai báo vùng widget nào." />
          ) : (
            <section className="divide-y rounded-xl border bg-card">
              {list.data.map((a) => (
                <div key={a.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.label}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{a.key}</code>
                      <Badge variant="outline" className="text-[10px]">
                        {sourceLabel(a.source)}
                      </Badge>
                    </div>
                    {a.description && <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>}
                  </div>
                  {a.blockId ? (
                    <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Đã có nội dung</Badge>
                  ) : (
                    <Badge variant="secondary">Trống</Badge>
                  )}
                  <Button size="sm" variant={a.blockId ? 'outline' : 'default'} onClick={() => void edit(a)} disabled={opening === a.key}>
                    {opening === a.key ? <Loader2 className="animate-spin" /> : a.blockId ? <Pencil /> : <Plus />} Soạn nội dung
                  </Button>
                </div>
              ))}
            </section>
          )}
        </div>
      </PageBody>
    </>
  );
}

export default function WidgetAreasPage() {
  return (
    <Suspense>
      <WidgetAreasContent />
    </Suspense>
  );
}
