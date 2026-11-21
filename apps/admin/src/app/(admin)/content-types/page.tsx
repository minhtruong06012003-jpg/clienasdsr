'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, FolderTree, MoreHorizontal, Pencil, Plus, Power, PowerOff, Sparkles, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ContentTypeView, TaxonomyView } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ContentIcon } from '@/components/content/content-icon';
import { ContentPresetsDialog } from '@/components/content/presets-dialog';
import { TaxonomySheet } from '@/components/content/taxonomy-sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLanguages } from '@/hooks/use-languages';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';
import { taxonomyLabel, typeLabel, useContentTypes, useTaxonomies } from '@/hooks/use-content-types';

/** Nhãn nguồn tạo (core / preset / import; nguồn lạ từ dữ liệu cũ hiện nguyên văn) */
function SourceBadge({ source }: { source: string }) {
  // 'code' = khai báo trong apps/api/src/config/content-types.config.ts (chỉ xem, không sửa ở admin)
  const label = source === 'code' ? 'Mã nguồn' : source === 'db' || source === 'admin' || source === 'core' ? 'Tự tạo' : source.startsWith('preset') ? 'Mẫu có sẵn' : source;
  return (
    <Badge variant="outline" className="font-normal">
      {label}
    </Badge>
  );
}

/** Body PUT từ bản ghi hiện có (bỏ trường chỉ đọc) — dùng cho bật/tắt nhanh */
function typeBody(t: ContentTypeView) {
  const { id: _id, key: _key, source: _s, entryCount: _c, ...rest } = t;
  return rest;
}

function ContentTypesList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { defaultLocale } = useLanguages();
  const { params, set } = useListParams({ tab: 'types' });
  const tab = params.tab === 'taxonomies' ? 'taxonomies' : 'types';
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [editingTax, setEditingTax] = useState<TaxonomyView | 'new' | null>(null);
  const types = useContentTypes();
  const taxonomies = useTaxonomies();
  const canManage = can('content_types.manage');
  // id các dòng đang tích chọn (dùng chung cho 2 tab; đổi tab thì bỏ chọn)
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['content-types'] });
    void qc.invalidateQueries({ queryKey: ['taxonomies'] });
  };

  const toggle = useMutation({
    mutationFn: (t: ContentTypeView) => api.put(`/admin/content-types/${t.id}`, { ...typeBody(t), isActive: !t.isActive }),
    onSuccess: (_d, t) => {
      toast.success(t.isActive ? 'Đã tắt loại nội dung' : 'Đã bật loại nội dung');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const removeType = async (t: ContentTypeView) => {
    const name = typeLabel(t.labels, defaultLocale, 'plural', t.key);
    if (!(await confirm({ title: `Xoá loại nội dung “${name}”?`, description: (t.entryCount ?? 0) > 0 ? `Loại này còn ${t.entryCount} bài — API sẽ từ chối xoá. Hãy xoá hoặc chuyển các bài trước, hoặc chỉ tắt loại nội dung.` : 'Menu, trang lưu trữ và đường dẫn của loại này sẽ không còn. Taxonomy gắn kèm vẫn được giữ.', destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/content-types/${t.id}`);
      toast.success('Đã xoá loại nội dung');
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const removeTax = async (t: TaxonomyView) => {
    const name = typeLabel(t.labels, defaultLocale, 'plural', t.key);
    if (!(await confirm({ title: `Xoá taxonomy “${name}”?`, description: `Toàn bộ ${t.termCount ?? 0} phân loại (term) bên trong và liên kết với bài sẽ bị xoá. Không thể khôi phục.`, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/taxonomies/${t.id}`);
      toast.success('Đã xoá taxonomy');
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** Bật/tắt hàng loạt loại nội dung: PUT từng loại với body đầy đủ (API chưa có endpoint /bulk), bỏ qua loại đã đúng trạng thái */
  const setTypesActive = async (isActive: boolean) => {
    const rows = (types.data ?? []).filter((t) => selected.includes(t.id) && t.isActive !== isActive);
    if (!rows.length) {
      toast.info(isActive ? 'Các loại đã chọn đều đang bật' : 'Các loại đã chọn đều đang tắt');
      return;
    }
    const byId = new Map(rows.map((t) => [t.id, t]));
    await bulk.run({
      ids: rows.map((t) => t.id),
      action: (id) => api.put(`/admin/content-types/${id}`, { ...typeBody(byId.get(id)!), isActive }),
      doneLabel: isActive ? 'Đã bật' : 'Đã tắt',
      onDone: () => {
        setSelected([]);
        invalidate();
      },
    });
  };

  /** Xoá hàng loạt loại nội dung hoặc taxonomy (theo tab đang mở) — gọi endpoint xoá đơn lẻ cho từng mục */
  const removeSelected = async () => {
    const n = selected.length;
    const ask =
      tab === 'types'
        ? {
            title: `Xoá ${n} loại nội dung?`,
            // API từ chối xoá loại còn bài — báo trước để người dùng không bất ngờ khi có mục lỗi
            description: (types.data ?? []).some((t) => selected.includes(t.id) && (t.entryCount ?? 0) > 0) ? 'Một số loại còn bài — API sẽ từ chối xoá các loại đó. Các loại còn lại sẽ bị xoá cùng menu, trang lưu trữ và đường dẫn.' : 'Menu, trang lưu trữ và đường dẫn của các loại này sẽ không còn. Taxonomy gắn kèm vẫn được giữ.',
          }
        : { title: `Xoá ${n} taxonomy?`, description: 'Toàn bộ phân loại (term) bên trong và liên kết với bài sẽ bị xoá. Không thể khôi phục.' };
    if (!(await confirm({ ...ask, destructive: true, confirmText: 'Xoá' }))) return;
    const base = tab === 'types' ? '/admin/content-types' : '/admin/taxonomies';
    await bulk.run({
      ids: selected,
      action: (id) => api.delete(`${base}/${id}`),
      doneLabel: 'Đã xoá',
      onDone: () => {
        setSelected([]);
        invalidate();
      },
    });
  };

  /** Thanh thao tác hàng loạt — chỉ hiện khi có quyền quản lý và đang chọn ít nhất 1 dòng */
  const bulkToolbar = canManage && selected.length > 0 && (
    <ListToolbar
      selectedCount={selected.length}
      onClearSelection={() => setSelected([])}
      bulkActions={
        <>
          {tab === 'types' && (
            <>
              <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => void setTypesActive(true)}>
                <Power /> Bật
              </Button>
              <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => void setTypesActive(false)}>
                <PowerOff /> Tắt
              </Button>
            </>
          )}
          <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={() => void removeSelected()}>
            <Trash2 /> Xoá
          </Button>
        </>
      }
    />
  );

  const typeColumns: Column<ContentTypeView>[] = [
    {
      key: 'name',
      header: 'Loại nội dung',
      cell: (t) => (
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ContentIcon name={t.icon} className="size-4" />
          </span>
          <div className="min-w-0">
            <Link href={canManage ? `/content-types/${t.id}` : `/content/${t.key}`} className="font-medium hover:text-primary">
              {typeLabel(t.labels, defaultLocale, 'plural', t.key)}
            </Link>
            {t.description && <p className="line-clamp-1 text-xs text-muted-foreground">{t.description}</p>}
          </div>
        </div>
      ),
    },
    { key: 'key', header: 'Mã', cell: (t) => <span className="font-mono text-xs">{t.key}</span> },
    {
      key: 'slug',
      header: 'Đường dẫn',
      cell: (t) => (
        <div className="space-y-0.5 font-mono text-xs text-muted-foreground">
          {Object.entries(t.slugs ?? {}).map(([loc, s]) => (
            <div key={loc}>
              {loc !== defaultLocale ? `/${loc}` : ''}/{s}
              {!t.isPublic && loc === defaultLocale && <span className="ml-1 font-sans text-amber-600 dark:text-amber-400">(không công khai)</span>}
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'taxonomies',
      header: 'Phân loại',
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          {t.taxonomies.length ? t.taxonomies.map((k) => <Badge key={k} variant="secondary" className="font-normal">{taxonomyLabel(taxonomies.data, k, defaultLocale)}</Badge>) : <span className="text-xs text-muted-foreground">—</span>}
        </div>
      ),
    },
    {
      key: 'entryCount',
      header: 'Số bài',
      className: 'text-center',
      headClassName: 'text-center',
      cell: (t) => (
        <Link href={`/content/${t.key}`} className="tabular-nums hover:text-primary">
          {t.entryCount ?? 0}
        </Link>
      ),
    },
    { key: 'source', header: 'Nguồn', cell: (t) => <SourceBadge source={t.source} /> },
    { key: 'isActive', header: 'Bật', cell: (t) => <Switch checked={t.isActive} disabled={!canManage || toggle.isPending} onCheckedChange={() => toggle.mutate(t)} aria-label="Bật / tắt loại nội dung" /> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (t) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/content/${t.key}`}>
                <Boxes /> Xem danh sách bài
              </Link>
            </DropdownMenuItem>
            {canManage && (
              <>
                <DropdownMenuItem asChild>
                  <Link href={`/content-types/${t.id}`}>
                    <Pencil /> Chỉnh sửa
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => removeType(t)}>
                  <Trash2 /> Xoá
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const typeName = (key: string) => {
    const t = types.data?.find((x) => x.key === key);
    return t ? typeLabel(t.labels, defaultLocale, 'plural', key) : key;
  };

  const taxColumns: Column<TaxonomyView>[] = [
    {
      key: 'name',
      header: 'Taxonomy',
      cell: (t) => (
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{t.hierarchical ? <FolderTree className="size-4" /> : <Tags className="size-4" />}</span>
          <div className="min-w-0">
            <button type="button" className="font-medium hover:text-primary" onClick={() => canManage && setEditingTax(t)}>
              {typeLabel(t.labels, defaultLocale, 'plural', t.key)}
            </button>
            <p className="text-xs text-muted-foreground">{t.hierarchical ? 'Dạng cây' : 'Dạng thẻ'}{t.showInFilter ? ' · hiện trong bộ lọc' : ''}</p>
          </div>
        </div>
      ),
    },
    { key: 'key', header: 'Mã', cell: (t) => <span className="font-mono text-xs">{t.key}</span> },
    {
      key: 'slug',
      header: 'Đường dẫn',
      cell: (t) => (
        <div className="space-y-0.5 font-mono text-xs text-muted-foreground">
          {t.isPublic ? Object.entries(t.slugs ?? {}).map(([loc, s]) => <div key={loc}>{loc !== defaultLocale ? `/${loc}` : ''}/{s}/…</div>) : <span className="font-sans">Không công khai</span>}
        </div>
      ),
    },
    {
      key: 'contentTypes',
      header: 'Dùng cho',
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          {t.contentTypes.length ? t.contentTypes.map((k) => <Badge key={k} variant="secondary" className="font-normal">{typeName(k)}</Badge>) : <span className="text-xs text-muted-foreground">—</span>}
        </div>
      ),
    },
    {
      key: 'termCount',
      header: 'Số phân loại',
      className: 'text-center',
      headClassName: 'text-center',
      cell: (t) => {
        const first = t.contentTypes[0];
        return first ? (
          <Link href={`/content/${first}/terms/${t.key}`} className="tabular-nums hover:text-primary">
            {t.termCount ?? 0}
          </Link>
        ) : (
          <span className="tabular-nums">{t.termCount ?? 0}</span>
        );
      },
    },
    { key: 'source', header: 'Nguồn', cell: (t) => <SourceBadge source={t.source} /> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (t) =>
        canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditingTax(t)}>
                <Pencil /> Chỉnh sửa
              </DropdownMenuItem>
              {t.contentTypes[0] && (
                <DropdownMenuItem asChild>
                  <Link href={`/content/${t.contentTypes[0]}/terms/${t.key}`}>
                    <FolderTree /> Quản lý phân loại
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => removeTax(t)}>
                <Trash2 /> Xoá
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  const typeList = types.data ?? [];
  return (
    <>
      <PageHeader
        title="Loại nội dung"
        description="Tạo các loại nội dung riêng (Dự án, Dịch vụ, Tuyển dụng, Khoá học...) kèm phân loại — mỗi loại có menu, trang danh sách và trang chi tiết riêng"
        actions={
          canManage && (
            <>
              <Button variant="outline" size="sm" onClick={() => setPresetsOpen(true)}>
                <Sparkles /> Cài mẫu có sẵn
              </Button>
              {tab === 'taxonomies' ? (
                <Button size="sm" onClick={() => setEditingTax('new')}>
                  <Plus /> Thêm taxonomy
                </Button>
              ) : (
                <Button size="sm" asChild>
                  <Link href="/content-types/new">
                    <Plus /> Thêm loại nội dung
                  </Link>
                </Button>
              )}
            </>
          )
        }
      />
      <PageBody className="space-y-4">
        <StatusTabs
          value={tab}
          onChange={(v) => {
            // đổi tab: bỏ chọn vì id của loại nội dung và taxonomy khác nhau
            setSelected([]);
            set({ tab: v });
          }}
          options={[
            { value: 'types', label: 'Loại nội dung', count: types.data?.length },
            { value: 'taxonomies', label: 'Taxonomy (phân loại)', count: taxonomies.data?.length },
          ]}
        />
        {tab === 'types' ? (
          types.data && !typeList.length ? (
            <EmptyState
              icon={Boxes}
              title="Chưa có loại nội dung nào"
              description="Cài một mẫu có sẵn (Dự án, Dịch vụ, Tuyển dụng, Khoá học, Bất động sản...) hoặc tự tạo loại nội dung mới."
              action={
                canManage && (
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setPresetsOpen(true)}>
                      <Sparkles /> Cài mẫu có sẵn
                    </Button>
                    <Button asChild>
                      <Link href="/content-types/new">
                        <Plus /> Thêm loại nội dung
                      </Link>
                    </Button>
                  </div>
                )
              }
            />
          ) : (
            <>
              {bulkToolbar}
              <DataTable columns={typeColumns} data={typeList} loading={types.isLoading} error={types.error} onRetry={() => void types.refetch()} selectable={canManage} selected={selected} onSelectedChange={setSelected} />
            </>
          )
        ) : taxonomies.data && !taxonomies.data.length ? (
          <EmptyState icon={FolderTree} title="Chưa có taxonomy nào" description="Taxonomy giúp phân loại bài của loại nội dung, vd Lĩnh vực, Địa điểm, Ngành nghề." action={canManage && <Button onClick={() => setEditingTax('new')}><Plus /> Thêm taxonomy</Button>} />
        ) : (
          <>
            {bulkToolbar}
            <DataTable columns={taxColumns} data={taxonomies.data} loading={taxonomies.isLoading} error={taxonomies.error} onRetry={() => void taxonomies.refetch()} selectable={canManage} selected={selected} onSelectedChange={setSelected} emptyTitle={taxonomies.isError ? 'Không tải được danh sách taxonomy' : undefined} />
          </>
        )}
      </PageBody>
      <ContentPresetsDialog open={presetsOpen} onOpenChange={setPresetsOpen} installed={typeList} />
      <TaxonomySheet editing={editingTax} onClose={() => setEditingTax(null)} contentTypes={typeList} />
    </>
  );
}

export default function ContentTypesPage() {
  return (
    <Suspense>
      <ContentTypesList />
    </Suspense>
  );
}
