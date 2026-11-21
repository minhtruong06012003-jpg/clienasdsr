'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar } from '@/components/common/list-toolbar';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';
import { useAuth } from '@/lib/auth';

interface GlobalBlockRow {
  id: string;
  name: string;
  key: string;
  type: string;
  isActive: boolean;
  updatedAt: string;
  translations: { locale: string }[];
}

function BlocksList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { params, set, page, limit } = useListParams({ search: '' });
  const { can } = useAuth();
  // id các block đang tích chọn để thao tác hàng loạt
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();
  const canManage = can('blocks.manage');
  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['global-blocks', params], queryFn: () => api.get<Paginated<GlobalBlockRow>>('/admin/blocks', { ...params, page, limit }),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post(`/admin/blocks/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Đã nhân bản');
      void qc.invalidateQueries({ queryKey: ['global-blocks'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = async (row: GlobalBlockRow) => {
    if (!(await confirm({ title: `Xoá block "${row.name}"?`, description: `Các trang đang nhúng block "${row.key}" sẽ không hiển thị phần này nữa.`, destructive: true }))) return;
    await api.delete(`/admin/blocks/${row.id}`).catch((e) => toast.error(errorMessage(e)));
    void qc.invalidateQueries({ queryKey: ['global-blocks'] });
  };

  /** Xoá hàng loạt: gọi DELETE /admin/blocks/:id cho từng block đã chọn (API chưa có endpoint /bulk) */
  const removeSelected = async () => {
    const n = selected.length;
    if (!(await confirm({ title: `Xoá ${n} block?`, description: 'Các trang đang nhúng những block này sẽ không hiển thị phần đó nữa. Không thể khôi phục.', destructive: true, confirmText: 'Xoá' }))) return;
    await bulk.run({
      ids: selected,
      action: (id) => api.delete(`/admin/blocks/${id}`),
      doneLabel: 'Đã xoá',
      onDone: () => {
        setSelected([]);
        void qc.invalidateQueries({ queryKey: ['global-blocks'] });
      },
    });
  };

  const columns: Column<GlobalBlockRow>[] = [
    {
      key: 'name',
      header: 'Tên block',
      cell: (r) => (
        <div>
          <Link href={`/blocks/${r.id}`} className="font-medium hover:text-primary">
            {r.name}
          </Link>
          <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            {r.key}
            {/* block nội dung của vùng widget (Giao diện › Vùng widget) */}
            {r.key.startsWith('area-') && (
              <Link href="/widget-areas" className="rounded bg-blue-50 px-1.5 py-0.5 font-sans text-[10px] text-blue-700 hover:underline dark:bg-blue-950/30 dark:text-blue-300">
                Vùng widget
              </Link>
            )}
          </div>
        </div>
      ),
    },
    { key: 'locales', header: 'Ngôn ngữ', cell: (r) => <span className="text-xs uppercase text-muted-foreground">{r.translations.map((t) => t.locale).join(', ') || '—'}</span> },
    { key: 'active', header: 'Trạng thái', cell: (r) => (r.isActive ? <Badge className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">Đang dùng</Badge> : <Badge variant="secondary">Tắt</Badge>) },
    { key: 'updatedAt', header: 'Cập nhật', cell: (r) => <span className="text-xs text-muted-foreground">{formatDate(r.updatedAt)}</span> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (r) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/blocks/${r.id}`}>
                <Pencil /> Chỉnh sửa
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => duplicate.mutate(r.id)}>
              <Copy /> Nhân bản
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => remove(r)}>
              <Trash2 /> Xoá
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Block dùng chung"
        description="Thiết kế 1 lần, dùng ở nhiều trang (header, footer, CTA, banner khuyến mãi...). Sửa ở đây sẽ cập nhật mọi nơi."
        actions={
          <Button asChild>
            <Link href="/blocks/new">
              <Plus /> Tạo block
            </Link>
          </Button>
        }
      />
      <PageBody className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4 text-sm">
          <Blocks className="mt-0.5 size-5 text-primary" />
          <div className="text-muted-foreground">
            Chèn vào trang bằng block <b className="text-foreground">“Block dùng chung”</b> trong trình dựng trang, hoặc gọi trong theme qua API <code className="rounded bg-background px-1">/api/public/blocks/&lt;key&gt;</code>. Block có key trùng với cài đặt Giao diện (header/footer) sẽ hiển thị toàn site.
          </div>
        </div>
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo tên hoặc key..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={() => void removeSelected()}>
              <Trash2 /> Xoá
            </Button>
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          onPageChange={(p) => set({ page: p })}
          // chỉ cho tích chọn khi có quyền quản lý block (thao tác hàng loạt duy nhất là xoá)
          selectable={canManage}
          selected={selected}
          onSelectedChange={setSelected}
          emptyTitle="Chưa có block dùng chung"
          emptyAction={
            <Button asChild size="sm">
              <Link href="/blocks/new">
                <Plus /> Tạo block đầu tiên
              </Link>
            </Button>
          }
        />
      </PageBody>
    </>
  );
}

export default function BlocksPage() {
  return (
    <Suspense>
      <BlocksList />
    </Suspense>
  );
}
