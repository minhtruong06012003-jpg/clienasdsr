'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, MoreHorizontal, Pencil, Plus, RotateCcw, SquarePen, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { StatusBadge } from '@/components/common/status-badge';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ContentDateCell } from '@/components/common/date-cell';
import { QuickEditDialog, type QuickEditBase } from '@/components/common/quick-edit-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { pickTr } from '@/lib/format';
import { contentStatusTabs, fromLocalInput, toLocalInput, type StatusCounts } from '@/lib/publish';
import { HAS_WEB_URL, siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import type { ContentStatus } from '@/lib/types';
import { useListLocale } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';

interface PostRow {
  id: string;
  status: string;
  isFeatured: boolean;
  viewCount: number;
  publishedAt: string | null;
  updatedAt: string;
  featuredImage: { url: string; urls: Record<string, string> } | null;
  author: { id: string; name: string } | null;
  translations: { locale: string; title: string; slug: string }[];
  categories: { category: { id: string; translations: { locale: string; name: string }[] } }[];
}

interface Category {
  id: string;
  parentId?: string | null;
  translations: { locale: string; name: string }[];
}

interface QuickEditPost extends QuickEditBase {
  id: string;
  locale: string;
  isFeatured: boolean;
  categoryIds: string[];
}

function PostsList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { locale, setLocale, languages, defaultLocale } = useListLocale();
  const { params, set, page, limit } = useListParams({ status: '', search: '', categoryId: '', trashed: '', sort: 'createdAt', order: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const [quick, setQuick] = useState<QuickEditPost | null>(null);
  const trashed = params.trashed === '1';

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['posts', params],
    queryFn: () => api.get<Paginated<PostRow> & { statusCounts?: StatusCounts }>('/admin/posts', { ...params, page, limit }),
  });
  const categories = useQuery({ queryKey: ['post-categories'], queryFn: () => api.get<Category[]>('/admin/posts/categories') });

  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: string }) => api.post('/admin/posts/bulk', { ids, action }),
    onSuccess: () => {
      toast.success('Đã cập nhật');
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ['posts'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<{ id: string }>(`/admin/posts/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Đã nhân bản bài viết');
      void qc.invalidateQueries({ queryKey: ['posts'] });
    },
  });

  const runBulk = async (ids: string[], action: string) => {
    if (action === 'destroy' && !(await confirm({ title: `Xoá vĩnh viễn ${ids.length} bài viết?`, description: 'Không thể khôi phục sau khi xoá.', destructive: true, confirmText: 'Xoá vĩnh viễn' }))) return;
    bulk.mutate({ ids, action });
  };

  /** Sửa nhanh: mở dialog với dữ liệu của bản dịch đang xem (hoặc bản đầu tiên nếu chưa có) */
  const openQuickEdit = (r: PostRow) => {
    const tr = pickTr(r.translations, locale);
    if (!tr) return;
    setQuick({ id: r.id, locale: tr.locale, title: tr.title, slug: tr.slug, status: r.status as ContentStatus, publishedAt: toLocalInput(r.publishedAt), isFeatured: r.isFeatured, categoryIds: r.categories.map((c) => c.category.id) });
  };
  const saveQuick = async (f: QuickEditPost) => {
    await api.patch(`/admin/posts/${f.id}`, {
      status: f.status,
      publishedAt: f.publishedAt ? fromLocalInput(f.publishedAt) : undefined,
      isFeatured: f.isFeatured,
      categoryIds: f.categoryIds,
      translations: [{ locale: f.locale, title: f.title, slug: f.slug }],
    });
    toast.success('Đã cập nhật bài viết');
    void qc.invalidateQueries({ queryKey: ['posts'] });
    void qc.invalidateQueries({ queryKey: ['post', f.id] });
  };

  const columns: Column<PostRow>[] = [
    {
      key: 'title',
      header: 'Tiêu đề',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        return (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {r.featuredImage ? <img src={r.featuredImage.urls.thumb ?? r.featuredImage.url} alt="" className="size-11 rounded-md object-cover" /> : <div className="size-11 rounded-md bg-muted" />}
            <div className="min-w-0">
              <Link href={`/posts/${r.id}`} className="line-clamp-1 font-medium hover:text-primary">
                {r.isFeatured && <Star className="mr-1 inline size-3.5 fill-amber-400 text-amber-400" />}
                {tr?.title ?? '(chưa có tiêu đề)'}
                {tr && tr.locale !== locale && <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">[{tr.locale}]</span>}
              </Link>
              <div className="flex gap-1 text-xs text-muted-foreground">
                {languages.map((l) => (
                  <span key={l.code} className={r.translations.some((t) => t.locale === l.code) ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-40'} title={l.name}>
                    {l.code.toUpperCase()}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: 'categories',
      header: 'Chuyên mục',
      cell: (r) => <span className="text-sm text-muted-foreground">{r.categories.map((c) => pickTr(c.category.translations, locale)?.name).join(', ') || '—'}</span>,
    },
    { key: 'author', header: 'Tác giả', cell: (r) => <span className="text-sm">{r.author?.name ?? '—'}</span> },
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'viewCount', header: 'Lượt xem', sortable: true, cell: (r) => <span className="tabular-nums">{r.viewCount}</span> },
    { key: 'publishedAt', header: 'Ngày', sortable: true, cell: (r) => <ContentDateCell status={r.status} publishedAt={r.publishedAt} fallback={r.updatedAt} fallbackLabel="Sửa" /> },
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
                can('posts.delete') ? (
                  <>
                    <DropdownMenuItem onClick={() => runBulk([r.id], 'restore')}>
                      <RotateCcw /> Khôi phục
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => runBulk([r.id], 'destroy')}>
                      <Trash2 /> Xoá vĩnh viễn
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem disabled>Cần quyền xoá bài viết</DropdownMenuItem>
                )
              ) : (
                <>
                  <DropdownMenuItem asChild>
                    <Link href={`/posts/${r.id}`}>
                      <Pencil /> Chỉnh sửa
                    </Link>
                  </DropdownMenuItem>
                  {can('posts.write') && tr && (
                    <DropdownMenuItem onClick={() => openQuickEdit(r)}>
                      <SquarePen /> Sửa nhanh
                    </DropdownMenuItem>
                  )}
                  {HAS_WEB_URL && tr && r.status === 'PUBLISHED' && (
                    <DropdownMenuItem asChild>
                      <a href={siteUrl('post', tr.slug, tr.locale, defaultLocale)} target="_blank" rel="noreferrer">
                        <ExternalLink /> Xem trên web
                      </a>
                    </DropdownMenuItem>
                  )}
                  {can('posts.write') && (
                    <DropdownMenuItem onClick={() => duplicate.mutate(r.id)}>
                      <Copy /> Nhân bản
                    </DropdownMenuItem>
                  )}
                  {can('posts.delete') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => runBulk([r.id], 'trash')}>
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
        title="Bài viết"
        description="Quản lý blog / tin tức"
        actions={
          <>
            <LocaleTabs languages={languages} value={locale} onChange={setLocale} />
            {can('posts.write') && (
              <Button asChild>
                <Link href="/posts/new">
                  <Plus /> Viết bài mới
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
          placeholder="Tìm theo tiêu đề..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          filters={
            <Select value={params.categoryId || 'all'} onValueChange={(v) => set({ categoryId: v === 'all' ? '' : v })}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Chuyên mục" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả chuyên mục</SelectItem>
                {categories.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {pickTr(c.translations, locale)?.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
          bulkActions={
            trashed ? (
              can('posts.delete') && (
                <>
                  <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'restore')}>
                    Khôi phục
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => runBulk(selected, 'destroy')}>
                    Xoá vĩnh viễn
                  </Button>
                </>
              )
            ) : (
              <>
                {can('posts.publish') && (
                  <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'publish')}>
                    Xuất bản
                  </Button>
                )}
                {can('posts.publish') && (
                  <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'draft')}>
                    Chuyển nháp
                  </Button>
                )}
                {can('posts.delete') && (
                  <Button size="sm" variant="destructive" onClick={() => runBulk(selected, 'trash')}>
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
          emptyTitle={trashed ? 'Thùng rác trống' : 'Chưa có bài viết'}
          emptyAction={
            !trashed && can('posts.write') ? (
              <Button asChild size="sm">
                <Link href="/posts/new">
                  <Plus /> Viết bài đầu tiên
                </Link>
              </Button>
            ) : undefined
          }
        />
      </PageBody>
      <QuickEditDialog
        initial={quick}
        onClose={() => setQuick(null)}
        onSave={saveQuick}
        heading="Sửa nhanh bài viết"
        localeLabel={languages.find((l) => l.code === quick?.locale)?.name}
        slugPrefix={quick ? `/${quick.locale !== defaultLocale ? `${quick.locale}/` : ''}blog/` : undefined}
        canPublish={can('posts.publish')}
        extra={(f, set) => (
          <>
            <div className="space-y-1.5">
              <Label className="text-sm">Chuyên mục</Label>
              <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-lg border p-2">
                {categories.data?.length === 0 && <p className="text-xs text-muted-foreground">Chưa có chuyên mục</p>}
                {categories.data?.map((c) => (
                  <label key={c.id} className={`flex items-center gap-2 text-sm ${c.parentId ? 'pl-5' : ''}`}>
                    <Checkbox checked={f.categoryIds.includes(c.id)} onCheckedChange={(v) => set({ categoryIds: v ? [...f.categoryIds, c.id] : f.categoryIds.filter((x) => x !== c.id) })} />
                    {pickTr(c.translations, locale)?.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Bài viết nổi bật</Label>
              <Switch checked={f.isFeatured} onCheckedChange={(v) => set({ isFeatured: v })} />
            </div>
          </>
        )}
      />
    </>
  );
}

export default function PostsPage() {
  return (
    <Suspense>
      <PostsList />
    </Suspense>
  );
}
