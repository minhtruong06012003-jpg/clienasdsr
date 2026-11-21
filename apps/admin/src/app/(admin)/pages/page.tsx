'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Home, MoreHorizontal, Pencil, Plus, RotateCcw, SquarePen, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { StatusBadge } from '@/components/common/status-badge';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ContentDateCell } from '@/components/common/date-cell';
import { QuickEditDialog, type QuickEditBase } from '@/components/common/quick-edit-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, pickTr } from '@/lib/format';
import { contentStatusTabs, fromLocalInput, toLocalInput, type StatusCounts } from '@/lib/publish';
import { HAS_WEB_URL, siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import type { ContentStatus } from '@/lib/types';
import { useListLocale } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';

interface PageRow {
  id: string;
  status: string;
  template: string;
  isHomepage: boolean;
  updatedAt: string;
  publishedAt: string | null;
  author: { name: string } | null;
  translations: { locale: string; title: string; slug: string; seoTitle: string | null; seoDescription: string | null; noindex: boolean }[];
}

interface QuickEditPage extends QuickEditBase {
  id: string;
  locale: string;
}

type PageAction = 'trash' | 'restore' | 'destroy' | 'duplicate' | 'homepage' | 'publish' | 'draft';

function PagesList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { locale, setLocale, languages, defaultLocale } = useListLocale();
  const { params, set, page, limit } = useListParams({ status: '', search: '', trashed: '', sort: 'updatedAt', order: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [quick, setQuick] = useState<QuickEditPage | null>(null);
  const trashed = params.trashed === '1';

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['pages', params], queryFn: () => api.get<Paginated<PageRow> & { statusCounts?: StatusCounts }>('/admin/pages', { ...params, page, limit }),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['pages'] });

  const action = useMutation({
    mutationFn: async ({ ids, kind }: { ids: string[]; kind: PageAction }) => {
      // nhân bản / đặt trang chủ là thao tác đơn lẻ; còn lại dùng endpoint hàng loạt
      if (kind === 'duplicate' || kind === 'homepage') {
        for (const id of ids) await api.post(`/admin/pages/${id}/${kind === 'homepage' ? 'set-homepage' : 'duplicate'}`);
        return;
      }
      await api.post('/admin/pages/bulk', { ids, action: kind });
    },
    onSuccess: (_, v) => {
      toast.success(v.kind === 'duplicate' ? 'Đã nhân bản trang' : v.kind === 'homepage' ? 'Đã đặt làm trang chủ' : 'Đã cập nhật');
      setSelected([]);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const run = async (ids: string[], kind: PageAction) => {
    if (kind === 'destroy' && !(await confirm({ title: `Xoá vĩnh viễn ${ids.length} trang?`, description: 'Toàn bộ bản dịch và lịch sử chỉnh sửa sẽ bị xoá, không thể khôi phục.', destructive: true, confirmText: 'Xoá vĩnh viễn' }))) return;
    action.mutate({ ids, kind });
  };

  const openQuickEdit = (r: PageRow) => {
    const tr = pickTr(r.translations, locale);
    if (!tr) return;
    setQuick({ id: r.id, locale: tr.locale, title: tr.title, slug: tr.slug, status: r.status as ContentStatus, publishedAt: toLocalInput(r.publishedAt) });
  };
  const saveQuick = async (f: QuickEditPage) => {
    await api.patch(`/admin/pages/${f.id}`, { status: f.status, publishedAt: f.publishedAt ? fromLocalInput(f.publishedAt) : undefined, translations: [{ locale: f.locale, title: f.title, slug: f.slug }] });
    toast.success('Đã cập nhật trang');
    refresh();
    void qc.invalidateQueries({ queryKey: ['page', f.id] });
  };

  const columns: Column<PageRow>[] = [
    {
      key: 'title',
      header: 'Tiêu đề',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/pages/${r.id}`} className="line-clamp-1 font-medium hover:text-primary">
                {tr?.title ?? '(chưa có tiêu đề)'}
              </Link>
              {r.isHomepage && (
                <Badge variant="secondary" className="gap-1">
                  <Home className="size-3" /> Trang chủ
                </Badge>
              )}
              {tr?.noindex && <Badge variant="outline">noindex</Badge>}
            </div>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <span>/{tr?.slug}</span>
              <span className="flex gap-1">
                {languages.map((l) => (
                  <span key={l.code} className={r.translations.some((t) => t.locale === l.code) ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-40'}>
                    {l.code.toUpperCase()}
                  </span>
                ))}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      key: 'seo',
      header: 'SEO',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        const ok = !!tr?.seoDescription;
        return <span className={`text-xs ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>{ok ? '✓ Có mô tả' : 'Thiếu mô tả'}</span>;
      },
    },
    { key: 'author', header: 'Tác giả', cell: (r) => <span className="text-sm">{r.author?.name ?? '—'}</span> },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'publishedAt', header: 'Ngày', sortable: true, cell: (r) => <ContentDateCell status={r.status} publishedAt={r.publishedAt} /> },
    { key: 'updatedAt', header: 'Cập nhật', sortable: true, cell: (r) => <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(r.updatedAt)}</span> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {trashed ? (
                can('pages.delete') ? (
                  <>
                    <DropdownMenuItem onClick={() => run([r.id], 'restore')}>
                      <RotateCcw /> Khôi phục
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => run([r.id], 'destroy')}>
                      <Trash2 /> Xoá vĩnh viễn
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem disabled>Cần quyền xoá trang</DropdownMenuItem>
                )
              ) : (
                <>
                  <DropdownMenuItem asChild>
                    <Link href={`/pages/${r.id}`}>
                      <Pencil /> Mở trình dựng trang
                    </Link>
                  </DropdownMenuItem>
                  {can('pages.write') && tr && (
                    <DropdownMenuItem onClick={() => openQuickEdit(r)}>
                      <SquarePen /> Sửa nhanh
                    </DropdownMenuItem>
                  )}
                  {HAS_WEB_URL && tr && r.status === 'PUBLISHED' && (
                    <DropdownMenuItem asChild>
                      <a href={r.isHomepage ? siteUrl('home', null, tr.locale, defaultLocale) : siteUrl('page', tr.slug, tr.locale, defaultLocale)} target="_blank" rel="noreferrer">
                        <ExternalLink /> Xem trên web
                      </a>
                    </DropdownMenuItem>
                  )}
                  {can('pages.write') && (
                    <DropdownMenuItem onClick={() => run([r.id], 'duplicate')}>
                      <Copy /> Nhân bản
                    </DropdownMenuItem>
                  )}
                  {!r.isHomepage && can(['pages.publish', 'settings.manage']) && (
                    <DropdownMenuItem onClick={() => run([r.id], 'homepage')}>
                      <Home /> Đặt làm trang chủ
                    </DropdownMenuItem>
                  )}
                  {can('pages.delete') && !r.isHomepage && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => run([r.id], 'trash')}>
                        <Trash2 /> Chuyển vào thùng rác
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Trang"
        description="Tạo trang bằng trình dựng kéo thả block"
        actions={
          <>
            <LocaleTabs languages={languages} value={locale} onChange={setLocale} />
            {can('pages.write') && (
              <Button asChild>
                <Link href="/pages/new">
                  <Plus /> Tạo trang
                </Link>
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        <StatusTabs
          value={trashed ? 'trash' : params.status}
          onChange={(v) => (v === 'trash' ? set({ trashed: '1', status: '' }) : set({ status: v, trashed: '' }))}
          options={contentStatusTabs(list.data?.statusCounts)}
        />
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo tiêu đề, đường dẫn..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          bulkActions={
            trashed ? (
              can('pages.delete') && (
                <>
                  <Button size="sm" variant="outline" onClick={() => run(selected, 'restore')}>
                    Khôi phục
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => run(selected, 'destroy')}>
                    Xoá vĩnh viễn
                  </Button>
                </>
              )
            ) : (
              <>
                {can('pages.publish') && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => run(selected, 'publish')}>
                      Xuất bản
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => run(selected, 'draft')}>
                      Chuyển nháp
                    </Button>
                  </>
                )}
                {can('pages.delete') && (
                  <Button size="sm" variant="destructive" onClick={() => run(selected, 'trash')}>
                    Thùng rác
                  </Button>
                )}
              </>
            )
          }
        />
        <DataTable
          columns={columns}
          data={list.data?.data}
          meta={list.data?.meta}
          loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          onPageChange={(p) => set({ page: p })}
          onLimitChange={(l) => set({ limit: l })}
          sort={{ key: params.sort, order: params.order as 'asc' | 'desc' }}
          onSortChange={(s) => set({ sort: s.key, order: s.order })}
          emptyTitle={trashed ? 'Thùng rác trống' : 'Chưa có trang nào'}
        />
      </PageBody>
      <QuickEditDialog
        initial={quick}
        onClose={() => setQuick(null)}
        onSave={saveQuick}
        heading="Sửa nhanh trang"
        localeLabel={languages.find((l) => l.code === quick?.locale)?.name}
        slugPrefix={quick ? `/${quick.locale !== defaultLocale ? `${quick.locale}/` : ''}` : undefined}
        canPublish={can('pages.publish')}
      />
    </>
  );
}

export default function PagesPage() {
  return (
    <Suspense>
      <PagesList />
    </Suspense>
  );
}
