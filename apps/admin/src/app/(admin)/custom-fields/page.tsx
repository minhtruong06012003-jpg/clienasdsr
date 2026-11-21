'use client';

import Link from 'next/link';
import { Suspense, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Code2, Power, PowerOff, Contact, Copy, Download, GraduationCap, KeyRound, LayoutTemplate, MoreHorizontal, Newspaper, PackageCheck, Pencil, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, type LucideIcon, Gamepad2, CreditCard } from 'lucide-react';
import { toast } from 'sonner';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_ENTITY_LABELS, type CustomFieldEntity, type FieldGroupDef } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { DataTable, type Column } from '@/components/common/data-table';
import { ListToolbar, StatusTabs } from '@/components/common/list-toolbar';
import { EmptyState } from '@/components/common/empty-state';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useListParams } from '@/hooks/use-list-params';
import { useBulkAction } from '@/hooks/use-bulk-action';
import { cn } from '@/lib/utils';

type Row = FieldGroupDef & { id: string; updatedAt?: string };

interface Preset {
  key: string;
  name: string;
  description: string;
  icon: string;
  installed: boolean;
  groups: { key: string; name: string; entity: CustomFieldEntity; fieldCount: number; installed: boolean }[];
}

/** Icon của mẫu có sẵn (khớp `icon` trong custom-fields.presets.ts của API) */
const PRESET_ICONS: Record<string, LucideIcon> = { 'graduation-cap': GraduationCap, 'key-round': KeyRound, 'package-check': PackageCheck, newspaper: Newspaper, contact: Contact, 'gamepad-2': Gamepad2, 'credit-card': CreditCard };

/** Tải file JSON về máy */
function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function FieldGroupsList() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { params, set } = useListParams({ entity: '' });
  const entity = params.entity as CustomFieldEntity | '';
  const [presetsOpen, setPresetsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // id các nhóm trường đang tích chọn để thao tác hàng loạt
  const [selected, setSelected] = useState<string[]>([]);
  const bulk = useBulkAction();
  const list = useQuery({ queryKey: ['field-groups', entity], queryFn: () => api.get<{ data: Row[] }>('/admin/custom-fields/groups', entity ? { entity } : {}) });
  const all = useQuery({ queryKey: ['field-groups', ''], queryFn: () => api.get<{ data: Row[] }>('/admin/custom-fields/groups') });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['field-groups'] });
    void qc.invalidateQueries({ queryKey: ['custom-field-groups'] });
  };

  const toggle = useMutation({
    mutationFn: (r: Row) => api.patch(`/admin/custom-fields/groups/${r.id}`, { ...stripRow(r), isActive: !r.isActive }),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.post(`/admin/custom-fields/groups/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Đã nhân bản (nhóm mới đang tắt)');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = async (r: Row) => {
    if (!(await confirm({ title: `Xoá nhóm "${r.name}"?`, description: 'Giá trị đã nhập ở các bản ghi vẫn được giữ trong dữ liệu nhưng không còn hiển thị trong admin và API public.', destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/custom-fields/groups/${r.id}`);
      toast.success('Đã xoá nhóm');
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const exportAll = async (ids?: string[]) => {
    try {
      const data = await api.post<unknown>('/admin/custom-fields/export', { ids });
      downloadJson(`cmsnt-field-groups-${new Date().toISOString().slice(0, 10)}.json`, data);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { groups?: unknown[] } | unknown[];
      const groups = Array.isArray(parsed) ? parsed : (parsed.groups ?? []);
      if (!groups.length) throw new Error('File không có nhóm trường nào');
      const overwrite = await confirm({ title: `Nhập ${groups.length} nhóm trường?`, description: 'Nhóm trùng mã (key) sẽ bị ghi đè nếu bạn chọn “Ghi đè”; chọn Huỷ để bỏ qua nhóm trùng.', confirmText: 'Ghi đè', cancelText: 'Bỏ qua nhóm trùng' });
      const res = await api.post<{ created: string[]; updated: string[]; skipped: string[] }>('/admin/custom-fields/import', { groups, overwrite: !!overwrite });
      toast.success(`Đã nhập: ${res.created.length} mới, ${res.updated.length} cập nhật, ${res.skipped.length} bỏ qua`);
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  /** Bật/tắt hàng loạt: PATCH từng nhóm với body đầy đủ (API chưa có endpoint /bulk), bỏ qua nhóm đã đúng trạng thái */
  const setSelectedActive = async (isActive: boolean) => {
    const rows = (list.data?.data ?? []).filter((r) => selected.includes(r.id) && (r.isActive !== false) !== isActive);
    if (!rows.length) {
      toast.info(isActive ? 'Các nhóm đã chọn đều đang bật' : 'Các nhóm đã chọn đều đang tắt');
      return;
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    await bulk.run({
      ids: rows.map((r) => r.id),
      action: (id) => api.patch(`/admin/custom-fields/groups/${id}`, { ...stripRow(byId.get(id)!), isActive }),
      doneLabel: isActive ? 'Đã bật' : 'Đã tắt',
      onDone: () => {
        setSelected([]);
        invalidate();
      },
    });
  };
  /** Xoá hàng loạt: DELETE từng nhóm đã chọn */
  const removeSelected = async () => {
    const n = selected.length;
    if (!(await confirm({ title: `Xoá ${n} nhóm trường?`, description: 'Giá trị đã nhập ở các bản ghi vẫn được giữ trong dữ liệu nhưng không còn hiển thị trong admin và API public.', destructive: true, confirmText: 'Xoá' }))) return;
    await bulk.run({
      ids: selected,
      action: (id) => api.delete(`/admin/custom-fields/groups/${id}`),
      doneLabel: 'Đã xoá',
      onDone: () => {
        setSelected([]);
        invalidate();
      },
    });
  };

  const counts = new Map<string, number>();
  for (const r of all.data?.data ?? []) counts.set(r.entity, (counts.get(r.entity) ?? 0) + 1);
  const canManage = can('fields.manage');
  // chỉ nhóm tạo trong admin (source = 'db') mới sửa/xoá được; nhóm khai báo bằng mã nguồn không cho tích chọn
  const editableIds = new Set((list.data?.data ?? []).filter((r) => r.source === 'db').map((r) => r.id));

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Nhóm trường',
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/custom-fields/${r.id}`} className="font-medium hover:text-primary">
            {r.name}
          </Link>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{r.key}</span>
            {r.source && r.source !== 'db' && (
              <Badge variant="outline" className="h-4 gap-1 px-1 text-[10px]">
                <Code2 className="size-2.5" /> {r.source}
              </Badge>
            )}
          </div>
          {r.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{r.description}</p>}
        </div>
      ),
    },
    { key: 'entity', header: 'Gắn vào', cell: (r) => <Badge variant="secondary">{CUSTOM_FIELD_ENTITY_LABELS[r.entity] ?? r.entity}</Badge> },
    { key: 'fields', header: 'Số trường', className: 'text-center', headClassName: 'text-center', cell: (r) => <span className="tabular-nums">{r.fields.length}</span> },
    { key: 'placement', header: 'Vị trí', cell: (r) => <span className="text-xs text-muted-foreground">{r.placement === 'sidebar' ? 'Cột phải' : 'Nội dung chính'}</span> },
    {
      key: 'rules',
      header: 'Điều kiện',
      cell: (r) => {
        const rules = r.rules ?? {};
        const parts = [rules.templates?.length && `bố cục: ${rules.templates.join(', ')}`, rules.categoryIds?.length && `${rules.categoryIds.length} danh mục`, rules.productTypes?.length && `loại: ${rules.productTypes.join(', ')}`, rules.roleSlugs?.length && `vai trò: ${rules.roleSlugs.join(', ')}`, rules.contentTypes?.length && `loại nội dung: ${rules.contentTypes.join(', ')}`, rules.taxonomies?.length && `taxonomy: ${rules.taxonomies.join(', ')}`].filter(Boolean);
        return <span className="text-xs text-muted-foreground">{parts.length ? parts.join(' · ') : 'Luôn hiện'}</span>;
      },
    },
    {
      key: 'active',
      header: 'Trạng thái',
      cell: (r) =>
        r.isActive !== false ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Đang dùng</Badge> : <Badge variant="secondary">Tắt</Badge>,
    },
    { key: 'updatedAt', header: 'Cập nhật', cell: (r) => <span className="text-xs text-muted-foreground">{r.updatedAt ? formatDate(r.updatedAt) : '—'}</span> },
    {
      key: 'actions',
      header: '',
      className: 'w-10',
      cell: (r) =>
        r.source === 'db' && canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/custom-fields/${r.id}`}>
                  <Pencil /> Chỉnh sửa
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => toggle.mutate(r)}>
                <Check /> {r.isActive !== false ? 'Tắt nhóm' : 'Bật nhóm'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => duplicate.mutate(r.id)}>
                <Copy /> Nhân bản
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportAll([r.id])}>
                <Download /> Xuất JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => remove(r)}>
                <Trash2 /> Xoá
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Trường tuỳ chỉnh"
        description="Thêm trường dữ liệu riêng cho trang, bài viết, sản phẩm, danh mục, thành viên, nội dung tuỳ biến — không cần sửa mã nguồn"
        actions={
          canManage && (
            <>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0]).finally(() => (e.target.value = ''))} />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload /> Nhập JSON
              </Button>
              <Button variant="outline" size="sm" onClick={() => exportAll()} disabled={!all.data?.data.some((r) => r.source === 'db')}>
                <Download /> Xuất tất cả
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPresetsOpen(true)}>
                <Sparkles /> Mẫu có sẵn
              </Button>
              <Button size="sm" asChild>
                <Link href="/custom-fields/new">
                  <Plus /> Tạo nhóm
                </Link>
              </Button>
            </>
          )
        }
      />
      <PageBody>
        <div className="space-y-4">
          <StatusTabs
            value={entity}
            onChange={(v) => {
              // đổi bộ lọc đối tượng: bỏ chọn các nhóm không còn hiện trên bảng
              setSelected([]);
              set({ entity: v });
            }}
            options={[{ value: '', label: 'Tất cả', count: all.data?.data.length }, ...CUSTOM_FIELD_ENTITIES.map((e) => ({ value: e, label: CUSTOM_FIELD_ENTITY_LABELS[e], count: counts.get(e) ?? 0 }))]} />
          {list.data && !list.data.data.length ? (
            <EmptyState
              icon={SlidersHorizontal}
              title="Chưa có nhóm trường nào"
              description="Tạo nhóm trường mới hoặc cài một mẫu có sẵn (khoá học, tài khoản số, phần mềm bản quyền...) để bắt đầu."
              action={
                canManage && (
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setPresetsOpen(true)}>
                      <Sparkles /> Mẫu có sẵn
                    </Button>
                    <Button asChild>
                      <Link href="/custom-fields/new">
                        <Plus /> Tạo nhóm
                      </Link>
                    </Button>
                  </div>
                )
              }
            />
          ) : (
            <>
              {canManage && selected.length > 0 && (
                <ListToolbar
                  selectedCount={selected.length}
                  onClearSelection={() => setSelected([])}
                  bulkActions={
                    <>
                      <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => void setSelectedActive(true)}>
                        <Power /> Bật
                      </Button>
                      <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => void setSelectedActive(false)}>
                        <PowerOff /> Tắt
                      </Button>
                      {/* endpoint export nhận sẵn danh sách id nên xuất 1 file JSON cho cả nhóm đã chọn */}
                      <Button size="sm" variant="outline" disabled={bulk.pending} onClick={() => void exportAll(selected)}>
                        <Download /> Xuất JSON
                      </Button>
                      <Button size="sm" variant="destructive" disabled={bulk.pending} onClick={() => void removeSelected()}>
                        <Trash2 /> Xoá
                      </Button>
                    </>
                  }
                />
              )}
              <DataTable
                columns={columns}
                data={list.data?.data}
                loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
                selectable={canManage && editableIds.size > 0}
                selected={selected}
                // lọc bỏ nhóm không sửa được (kể cả khi bấm "chọn tất cả")
                onSelectedChange={(ids) => setSelected(ids.filter((id) => editableIds.has(id)))}
                // nhóm khai báo bằng mã nguồn không sửa/xoá được → khoá ô chọn
                isRowSelectable={(r) => r.source === 'db'}
              />
            </>
          )}
        </div>
      </PageBody>
      <PresetsDialog open={presetsOpen} onOpenChange={setPresetsOpen} onApplied={invalidate} />
    </>
  );
}

/** Bỏ các trường chỉ đọc trước khi PATCH */
function stripRow(r: Row) {
  const { id: _i, updatedAt: _u, source: _s, ...rest } = r as Row & { createdAt?: string };
  delete (rest as { createdAt?: string }).createdAt;
  return rest;
}

/** Hộp thoại cài mẫu nhóm trường có sẵn */
function PresetsDialog({ open, onOpenChange, onApplied }: { open: boolean; onOpenChange: (o: boolean) => void; onApplied: () => void }) {
  const confirm = useConfirm();
  const presets = useQuery({ queryKey: ['field-group-presets'], queryFn: () => api.get<Preset[]>('/admin/custom-fields/presets'), enabled: open });
  const apply = useMutation({
    mutationFn: ({ preset, overwrite }: { preset: string; overwrite: boolean }) => api.post<{ created: string[]; updated: string[]; skipped: string[] }>('/admin/custom-fields/presets/apply', { preset, overwrite }),
    onSuccess: (res) => {
      toast.success(`Đã cài mẫu: ${res.created.length} nhóm mới${res.updated.length ? `, ${res.updated.length} cập nhật` : ''}${res.skipped.length ? `, ${res.skipped.length} giữ nguyên` : ''}`);
      void presets.refetch();
      onApplied();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const install = async (p: Preset) => {
    let overwrite = false;
    if (p.groups.some((g) => g.installed)) {
      overwrite = !!(await confirm({ title: `Cài lại mẫu "${p.name}"?`, description: 'Một số nhóm của mẫu đã tồn tại. Ghi đè sẽ thay định nghĩa trường bằng bản gốc của mẫu (giá trị đã nhập ở bản ghi vẫn giữ). Huỷ để chỉ cài nhóm còn thiếu.', confirmText: 'Ghi đè' }));
    }
    apply.mutate({ preset: p.key, overwrite });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mẫu nhóm trường có sẵn</DialogTitle>
          <DialogDescription>Cài một chạm để dựng nhanh website bán khoá học, tài khoản số, phần mềm... Sau khi cài có thể sửa lại tuỳ ý.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {presets.data?.map((p) => (
            <div key={p.key} className={cn('flex gap-3 rounded-lg border p-3', p.installed && 'bg-muted/40')}>
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {(() => {
                  const Icon = PRESET_ICONS[p.icon] ?? Sparkles;
                  return <Icon className="size-5" />;
                })()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.description}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {p.groups.map((g) => (
                    <Badge key={g.key} variant={g.installed ? 'default' : 'outline'} className="h-5 gap-1 text-[10px] font-normal">
                      <LayoutTemplate className="size-2.5" /> {g.name} · {CUSTOM_FIELD_ENTITY_LABELS[g.entity]} · {g.fieldCount} trường
                    </Badge>
                  ))}
                </div>
              </div>
              <Button size="sm" variant={p.installed ? 'outline' : 'default'} className="shrink-0 self-center" disabled={apply.isPending} onClick={() => install(p)}>
                {p.installed ? 'Cài lại' : 'Cài mẫu'}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function CustomFieldsPage() {
  return (
    <Suspense>
      <FieldGroupsList />
    </Suspense>
  );
}
