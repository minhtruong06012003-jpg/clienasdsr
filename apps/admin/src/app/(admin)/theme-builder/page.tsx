'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, LayoutTemplate, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { TEMPLATE_KINDS, TEMPLATE_KIND_LABELS, type TemplateKind, type ThemeTemplateView } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { CreateTemplateDialog, TEMPLATE_KIND_HINTS } from '@/components/theme-builder/create-template-dialog';
import { conditionsSummary, targetLabel, useTemplateTargets } from '@/components/theme-builder/template-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/format';

/** Danh sách mẫu Theme Builder nhóm theo loại mẫu */
function ThemeBuilderList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canManage = can('templates.manage');
  const [creating, setCreating] = useState<TemplateKind | null | false>(false);
  const list = useQuery({ queryKey: ['theme-templates'], queryFn: () => api.get<ThemeTemplateView[]>('/admin/theme-templates'), enabled: canManage });
  // tra nhãn đối tượng áp dụng cho mọi loại mẫu
  const targets = useTemplateTargets(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['theme-templates'] });

  const toggle = useMutation({
    mutationFn: (t: ThemeTemplateView) => api.put(`/admin/theme-templates/${t.id}`, { name: t.name, kind: t.kind, target: t.target, conditions: t.conditions ?? {}, priority: t.priority, isActive: !t.isActive }),
    // cập nhật lạc quan để công tắc phản hồi ngay
    onMutate: (t) => qc.setQueryData<ThemeTemplateView[]>(['theme-templates'], (old) => old?.map((x) => (x.id === t.id ? { ...x, isActive: !t.isActive } : x))),
    onSuccess: (_d, t) => toast.success(t.isActive ? 'Đã tắt mẫu' : 'Đã bật mẫu'),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: invalidate,
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post(`/admin/theme-templates/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Đã nhân bản mẫu (đang tắt)');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = async (t: ThemeTemplateView) => {
    if (!(await confirm({ title: `Xoá mẫu "${t.name}"?`, description: 'Các trang đang dùng mẫu này sẽ quay về bố cục mặc định của giao diện.', destructive: true, confirmText: 'Xoá mẫu' }))) return;
    try {
      await api.delete(`/admin/theme-templates/${t.id}`);
      toast.success('Đã xoá mẫu');
    } catch (e) {
      toast.error(errorMessage(e));
    }
    invalidate();
  };

  const byKind = (k: TemplateKind) => (list.data ?? []).filter((t) => t.kind === k).sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  if (!canManage) {
    return (
      <PageBody>
        <EmptyState icon={LayoutTemplate} title="Không có quyền" description="Bạn cần quyền quản lý mẫu giao diện để dùng Theme Builder." />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        title="Theme Builder"
        description="Dựng bố cục trang chi tiết, trang danh sách, header, footer... bằng Page Builder với dữ liệu động"
        actions={
          <Button onClick={() => setCreating(null)}>
            <Plus /> Tạo mẫu
          </Button>
        }
      />
      <PageBody>
        {list.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        ) : list.isError ? (
          <EmptyState icon={LayoutTemplate} title="Không tải được danh sách mẫu" description={errorMessage(list.error)} />
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              Website chọn mẫu theo thứ tự: cùng loại mẫu → đối tượng khớp (mẫu “Toàn website” thấp nhất) → điều kiện cụ thể hơn (bản ghi &gt; phân loại) → ưu tiên cao hơn. Không có mẫu
              phù hợp thì dùng bố cục mặc định của giao diện.
            </p>
            {TEMPLATE_KINDS.map((k) => {
              const rows = byKind(k);
              return (
                <section key={k} className="rounded-xl border bg-card">
                  <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">
                        {TEMPLATE_KIND_LABELS[k]} <span className="font-normal text-muted-foreground">({rows.length})</span>
                      </h3>
                      <p className="truncate text-xs text-muted-foreground">{TEMPLATE_KIND_HINTS[k]}</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setCreating(k)}>
                      <Plus /> Thêm
                    </Button>
                  </div>
                  {rows.length === 0 ? (
                    <p className="px-4 py-5 text-center text-sm text-muted-foreground">Chưa có mẫu — website dùng bố cục mặc định.</p>
                  ) : (
                    <div className="divide-y">
                      {rows.map((t) => {
                        const cond = conditionsSummary(t.conditions);
                        return (
                          <div key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                            <div className="min-w-0 flex-1">
                              <Link href={`/theme-builder/${t.id}`} className="font-medium hover:text-primary">
                                {t.name}
                              </Link>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                <Badge variant="secondary" className="text-[11px]">
                                  {targetLabel(targets.data, t.target)}
                                </Badge>
                                {cond && <span>{cond}</span>}
                                {t.source && t.source !== 'db' && t.source !== 'admin' && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{t.source}</span>}
                                <span>· cập nhật {formatDate(t.updatedAt)}</span>
                              </div>
                            </div>
                            <span className="text-xs text-muted-foreground" title="Độ ưu tiên">
                              Ưu tiên <span className="font-medium text-foreground">{t.priority}</span>
                            </span>
                            <Switch checked={t.isActive} onCheckedChange={() => toggle.mutate(t)} title={t.isActive ? 'Đang bật' : 'Đang tắt'} />
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm">
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                  <Link href={`/theme-builder/${t.id}`}>
                                    <Pencil /> Soạn mẫu
                                  </Link>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => duplicate.mutate(t.id)}>
                                  <Copy /> Nhân bản
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => void remove(t)}>
                                  <Trash2 /> Xoá
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </PageBody>
      <CreateTemplateDialog open={creating !== false} onOpenChange={(o) => !o && setCreating(false)} initialKind={creating || null} />
    </>
  );
}

export default function ThemeBuilderPage() {
  return (
    <Suspense>
      <ThemeBuilderList />
    </Suspense>
  );
}
