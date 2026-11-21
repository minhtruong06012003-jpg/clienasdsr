'use client';

import Link from 'next/link';
import { Suspense, use, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Copy, ExternalLink, FolderTree, MoreHorizontal, Pencil, Plus, RotateCcw, Settings2, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { TermAdminView } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { StatusBadge } from '@/components/common/status-badge';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ContentDateCell } from '@/components/common/date-cell';
import { ContentIcon } from '@/components/content/content-icon';
import { entryUrl, formatFieldValue } from '@/components/content/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { pickTr } from '@/lib/format';
import { contentStatusTabs, type StatusCounts } from '@/lib/publish';
import { useAuth } from '@/lib/auth';
import { useListLocale } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';
import { flattenTerms, taxonomyLabel, termName, typeLabel, useContentType, useTaxonomies } from '@/hooks/use-content-types';
import { useFieldGroups } from '@/components/custom-fields/custom-fields-panel';

/** Term gắn với bài: API có thể trả dạng phẳng hoặc bọc { term } (như chuyên mục bài viết) */
type RowTerm = { id: string; taxonomy?: string; taxonomyKey?: string; translations?: { locale: string; name: string }[]; name?: string };

interface EntryRow {
  id: string;
  type: string;
  status: string;
  isFeatured: boolean;
  publishedAt: string | null;
  updatedAt: string;
  parentId?: string | null;
  featuredImage: { url: string; urls: Record<string, string> } | null;
  author: { id: string; name: string } | null;
  translations: { locale: string; title: string; slug: string }[];
  terms?: (RowTerm | { term: RowTerm })[];
  customFields?: Record<string, unknown>;
}

type EntriesResponse = Paginated<EntryRow> & { meta: Paginated<EntryRow>['meta'] & { counts?: StatusCounts }; statusCounts?: StatusCounts };

const unwrapTerm = (t: RowTerm | { term: RowTerm }): RowTerm => ('term' in t ? t.term : t);

function EntriesList({ typeKey }: { typeKey: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can, isDeveloper } = useAuth();
  const { locale, setLocale, languages, defaultLocale } = useListLocale();
  const { type, isLoading: typeLoading, isError: typeError } = useContentType(typeKey);
  const taxonomies = useTaxonomies();
  const fieldGroups = useFieldGroups('entry');
  const { params, set, page, limit } = useListParams({ status: '', search: '', termId: '', trashed: '', sort: '', order: 'desc' });
  const [selected, setSelected] = useState<string[]>([]);
  const trashed = params.trashed === '1';

  const list = useQuery({
    // giữ dữ liệu trang cũ khi đổi trang/bộ lọc để bảng không nháy về trạng thái tải
    placeholderData: keepPreviousData,
    queryKey: ['entries', typeKey, params, locale],
    // sort trống -> API dùng thứ tự mặc định của loại nội dung (vd sắp xếp thủ công)
    queryFn: () => api.get<EntriesResponse>('/admin/entries', { ...params, sort: params.sort || undefined, order: params.sort ? params.order : undefined, type: typeKey, locale, page, limit }),
    enabled: !!type,
  });
  // term của từng taxonomy gắn với loại (bộ lọc + tên term trong bảng)
  const termQueries = useQueries({
    queries: (type?.taxonomies ?? []).map((tax) => ({ queryKey: ['taxonomy-terms', tax], queryFn: () => api.get<TermAdminView[]>(`/admin/taxonomies/${tax}/terms`), staleTime: 30_000 })),
  });
  const termsByTax = useMemo(() => (type?.taxonomies ?? []).map((tax, i) => ({ tax, terms: flattenTerms(termQueries[i]?.data ?? []) })), [type?.taxonomies, termQueries]);
  const termById = useMemo(() => {
    const m = new Map<string, TermAdminView & { tax: string }>();
    for (const g of termsByTax) for (const t of g.terms) m.set(t.id, { ...t, tax: g.tax });
    return m;
  }, [termsByTax]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['entries'] });
    void qc.invalidateQueries({ queryKey: ['content-types'] });
  };

  const bulk = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: string }) => api.post('/admin/entries/bulk', { ids, action }),
    onSuccess: () => {
      toast.success('Đã cập nhật');
      setSelected([]);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.post<{ id: string }>(`/admin/entries/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Đã nhân bản (bản sao ở trạng thái nháp)');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const singular = type ? typeLabel(type.labels, locale, 'singular', typeKey) : typeKey;
  const plural = type ? typeLabel(type.labels, locale, 'plural', typeKey) : typeKey;
  const lower = singular.toLowerCase();

  const runBulk = async (ids: string[], action: string) => {
    if (action === 'delete' && !(await confirm({ title: `Xoá vĩnh viễn ${ids.length} ${lower}?`, description: 'Không thể khôi phục sau khi xoá.', destructive: true, confirmText: 'Xoá vĩnh viễn' }))) return;
    if (action === 'trash' && ids.length > 1 && !(await confirm({ title: `Chuyển ${ids.length} ${lower} vào thùng rác?`, description: 'Có thể khôi phục từ tab Thùng rác.', destructive: true }))) return;
    bulk.mutate({ ids, action });
  };

  /** Cột trường tuỳ chỉnh do loại nội dung khai báo (listColumns) — nhãn lấy từ nhóm trường */
  const fieldColumns: Column<EntryRow>[] = (type?.listColumns ?? []).map((key) => {
    const def = (fieldGroups.data ?? []).flatMap((g) => g.fields).find((f) => f.key === key);
    return { key: `cf_${key}`, header: def?.label ?? key, cell: (r) => <span className="text-sm">{formatFieldValue(r.customFields?.[key], locale)}</span> };
  });

  const columns: Column<EntryRow>[] = [
    {
      key: 'title',
      header: 'Tiêu đề',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        return (
          <div className="flex items-center gap-3">
            {type?.supports.includes('featuredImage') &&
              (r.featuredImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.featuredImage.urls?.thumb ?? r.featuredImage.url} alt="" className="size-11 rounded-md object-cover" />
              ) : (
                <div className="size-11 rounded-md bg-muted" />
              ))}
            <div className="min-w-0">
              <Link href={`/content/${typeKey}/${r.id}`} className="line-clamp-1 font-medium hover:text-primary">
                {r.isFeatured && <Star className="mr-1 inline size-3.5 fill-amber-400 text-amber-400" />}
                {r.parentId && <span className="text-muted-foreground">— </span>}
                {tr?.title ?? '(chưa có tiêu đề)'}
                {tr && tr.locale !== locale && <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">[{tr.locale}]</span>}
              </Link>
              {languages.length > 1 && (
                <div className="flex gap-1 text-xs text-muted-foreground">
                  {languages.map((l) => (
                    <span key={l.code} className={r.translations.some((t) => t.locale === l.code) ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-40'} title={l.name}>
                      {l.code.toUpperCase()}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    ...(type?.taxonomies.length
      ? [
          {
            key: 'terms',
            header: 'Phân loại',
            cell: (r: EntryRow) => {
              const names = (r.terms ?? []).map(unwrapTerm).map((t) => (t.translations ? pickTr(t.translations, locale)?.name : t.name) ?? termName(termById.get(t.id), locale));
              return <span className="text-sm text-muted-foreground">{names.filter(Boolean).join(', ') || '—'}</span>;
            },
          },
        ]
      : []),
    ...fieldColumns,
    ...(type?.supports.includes('author') ? [{ key: 'author', header: 'Tác giả', cell: (r: EntryRow) => <span className="text-sm">{r.author?.name ?? '—'}</span> }] : []),
    { key: 'status', header: 'Trạng thái', cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'publishedAt', header: 'Ngày', sortable: true, cell: (r) => <ContentDateCell status={r.status} publishedAt={r.publishedAt} fallback={r.updatedAt} fallbackLabel="Sửa" /> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (r) => {
        const tr = pickTr(r.translations, locale);
        const url = tr && r.status === 'PUBLISHED' ? entryUrl(type, tr.slug, tr.locale, defaultLocale) : '';
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {trashed ? (
                can('entries.delete') ? (
                  <>
                    <DropdownMenuItem onClick={() => runBulk([r.id], 'restore')}>
                      <RotateCcw /> Khôi phục
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => runBulk([r.id], 'delete')}>
                      <Trash2 /> Xoá vĩnh viễn
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem disabled>Cần quyền xoá</DropdownMenuItem>
                )
              ) : (
                <>
                  <DropdownMenuItem asChild>
                    <Link href={`/content/${typeKey}/${r.id}`}>
                      <Pencil /> Chỉnh sửa
                    </Link>
                  </DropdownMenuItem>
                  {url && (
                    <DropdownMenuItem asChild>
                      <a href={url} target="_blank" rel="noreferrer">
                        <ExternalLink /> Xem trên web
                      </a>
                    </DropdownMenuItem>
                  )}
                  {can('entries.write') && (
                    <DropdownMenuItem onClick={() => duplicate.mutate(r.id)}>
                      <Copy /> Nhân bản
                    </DropdownMenuItem>
                  )}
                  {can('entries.delete') && (
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

  if (typeLoading) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96" />
      </PageBody>
    );
  }
  if (!type) {
    return (
      <PageBody>
        <EmptyState icon={Boxes} title={typeError ? 'Không tải được loại nội dung' : `Không tìm thấy loại nội dung “${typeKey}”`} description="Loại nội dung có thể đã bị xoá hoặc bạn chưa có quyền xem." action={(isDeveloper && can('content_types.manage')) ? <Button asChild variant="outline"><Link href="/content-types">Quản lý loại nội dung</Link></Button> : undefined} />
      </PageBody>
    );
  }

  const counts = list.data?.meta?.counts ?? list.data?.statusCounts;
  const newHref = `/content/${typeKey}/new`;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <ContentIcon name={type.icon} className="size-5 text-primary" /> {plural}
          </span>
        }
        description={type.description ?? `Quản lý ${plural.toLowerCase()}`}
        breadcrumbs={[{ label: plural, href: `/content/${typeKey}` }]}
        actions={
          <>
            <LocaleTabs languages={languages} value={locale} onChange={setLocale} />
            {can('entries.taxonomy') &&
              type.taxonomies.map((tax) => (
                <Button key={tax} variant="outline" size="sm" asChild>
                  <Link href={`/content/${typeKey}/terms/${tax}`}>
                    <FolderTree /> {taxonomyLabel(taxonomies.data, tax, locale)}
                  </Link>
                </Button>
              ))}
            {(isDeveloper && can('content_types.manage')) && (
              <Button variant="ghost" size="icon-sm" asChild title="Cài đặt loại nội dung">
                <Link href={`/content-types/${type.id}`}>
                  <Settings2 />
                </Link>
              </Button>
            )}
            {can('entries.write') && (
              <Button asChild>
                <Link href={newHref}>
                  <Plus /> Thêm {lower}
                </Link>
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        {!type.isActive && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">Loại nội dung này đang tắt — bài không hiển thị trên website.</div>}
        <StatusTabs value={trashed ? 'trash' : params.status} onChange={(v) => (v === 'trash' ? set({ trashed: '1', status: '' }) : set({ status: v, trashed: '' }))} options={contentStatusTabs(counts)} />
        <ListToolbar
          search={params.search}
          onSearchChange={(v) => set({ search: v })}
          placeholder="Tìm theo tiêu đề..."
          selectedCount={selected.length}
          onClearSelection={() => setSelected([])}
          filters={
            termsByTax.some((g) => g.terms.length) ? (
              <Select value={params.termId || 'all'} onValueChange={(v) => set({ termId: v === 'all' ? '' : v })}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder="Phân loại" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả phân loại</SelectItem>
                  {termsByTax
                    .filter((g) => g.terms.length)
                    .map((g) => (
                      <SelectGroup key={g.tax}>
                        <SelectLabel>{taxonomyLabel(taxonomies.data, g.tax, locale)}</SelectLabel>
                        {g.terms.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            <span style={{ paddingLeft: t.depth * 12 }}>{termName(t, locale) || '(chưa có tên)'}</span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                </SelectContent>
              </Select>
            ) : undefined
          }
          bulkActions={
            trashed ? (
              can('entries.delete') && (
                <>
                  <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'restore')}>
                    Khôi phục
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => runBulk(selected, 'delete')}>
                    Xoá vĩnh viễn
                  </Button>
                </>
              )
            ) : (
              <>
                {can('entries.publish') && (
                  <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'publish')}>
                    Xuất bản
                  </Button>
                )}
                {can('entries.publish') && (
                  <Button size="sm" variant="outline" onClick={() => runBulk(selected, 'draft')}>
                    Chuyển nháp
                  </Button>
                )}
                {can('entries.delete') && (
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
          emptyTitle={trashed ? 'Thùng rác trống' : list.isError ? `Không tải được danh sách: ${errorMessage(list.error)}` : `Chưa có ${lower} nào`}
          emptyAction={
            !trashed && can('entries.write') ? (
              <Button asChild size="sm">
                <Link href={newHref}>
                  <Plus /> Thêm {lower} đầu tiên
                </Link>
              </Button>
            ) : undefined
          }
        />
      </PageBody>
    </>
  );
}

export default function ContentEntriesPage({ params }: { params: Promise<{ type: string }> }) {
  const { type } = use(params);
  return (
    <Suspense>
      <EntriesList typeKey={type} />
    </Suspense>
  );
}
