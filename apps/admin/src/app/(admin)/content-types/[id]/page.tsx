'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, ExternalLink, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  CONTENT_KEY_RE,
  CONTENT_TYPE_ORDERS,
  CONTENT_TYPE_SUPPORTS,
  CONTENT_TYPE_SUPPORT_LABELS,
  RESERVED_SLUGS,
  type ContentTypeOrder,
  type ContentTypeSupport,
  type ContentTypeView,
  type TaxonomyView,
  type TypeLabels,
} from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ContentIcon, isIconName, normalizeIconName } from '@/components/content/content-icon';
import { LabelsSlugsEditor, cleanLabels, validateLabels } from '@/components/content/labels-editor';
import { TaxonomySheet, ToggleRow } from '@/components/content/taxonomy-sheet';
import { useFieldGroups } from '@/components/custom-fields/custom-fields-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { typeLabel, useContentTypes, useTaxonomies } from '@/hooks/use-content-types';

interface FormState {
  key: string;
  labels: TypeLabels;
  slugs: Record<string, string>;
  description: string;
  icon: string;
  supports: ContentTypeSupport[];
  isPublic: boolean;
  hasArchive: boolean;
  searchable: boolean;
  perPage: number;
  orderBy: ContentTypeOrder;
  listColumns: string[];
  isActive: boolean;
  sortOrder: number;
  taxonomies: string[];
}

const ORDER_LABELS: Record<ContentTypeOrder, string> = {
  publishedAt_desc: 'Mới đăng trước',
  publishedAt_asc: 'Cũ trước',
  title_asc: 'Theo tên A → Z',
  sortOrder_asc: 'Thứ tự thủ công',
};

/** Gợi ý icon lucide hay dùng cho loại nội dung */
const ICON_SUGGESTIONS = ['briefcase', 'building-2', 'house', 'graduation-cap', 'users', 'calendar', 'wrench', 'hammer', 'image', 'book-open', 'file-text', 'map-pin', 'award', 'star', 'message-square-quote', 'circle-help', 'folder-open', 'layers', 'camera', 'download'];

const toKey = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);

const fromView = (t: ContentTypeView): FormState => ({
  key: t.key,
  labels: t.labels ?? {},
  slugs: t.slugs ?? {},
  description: t.description ?? '',
  icon: t.icon ?? '',
  supports: t.supports ?? [],
  isPublic: t.isPublic,
  hasArchive: t.hasArchive,
  searchable: t.searchable,
  perPage: t.perPage || 12,
  orderBy: t.orderBy ?? 'publishedAt_desc',
  listColumns: t.listColumns ?? [],
  isActive: t.isActive,
  sortOrder: t.sortOrder ?? 0,
  taxonomies: t.taxonomies ?? [],
});

export default function ContentTypeEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { languages, defaultLocale } = useLanguages();
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);
  const [extraCol, setExtraCol] = useState('');
  const [taxSheet, setTaxSheet] = useState<TaxonomyView | 'new' | null>(null);
  const canManage = can('content_types.manage');

  const detail = useQuery({ queryKey: ['content-type', id], queryFn: () => api.get<ContentTypeView>(`/admin/content-types/${id}`), enabled: !isNew });
  const allTypes = useContentTypes();
  const taxonomies = useTaxonomies();
  const fieldGroups = useFieldGroups('entry');

  useEffect(() => {
    if (form) return;
    if (isNew) setForm({ key: '', labels: {}, slugs: {}, description: '', icon: 'file-text', supports: ['editor', 'excerpt', 'featuredImage', 'revisions'], isPublic: true, hasArchive: true, searchable: true, perPage: 12, orderBy: 'publishedAt_desc', listColumns: [], isActive: true, sortOrder: 0, taxonomies: [] });
    else if (detail.data) setForm(fromView(detail.data));
  }, [isNew, detail.data, form]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };

  /** Trường tuỳ chỉnh có thể làm cột danh sách: nhóm entity entry áp cho loại này (hoặc mọi loại) */
  const formKey = form?.key;
  const fieldOptions = useMemo(() => {
    const out: { key: string; label: string; group: string }[] = [];
    for (const g of fieldGroups.data ?? []) {
      const types = g.rules?.contentTypes ?? [];
      if (types.length && formKey && !types.includes(formKey)) continue;
      for (const f of g.fields) if (f.type !== 'repeater' && f.type !== 'json' && f.type !== 'richtext' && !out.some((x) => x.key === f.key)) out.push({ key: f.key, label: f.label, group: g.name });
    }
    return out;
  }, [fieldGroups.data, formKey]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      if (isNew && !CONTENT_KEY_RE.test(form.key)) throw new Error('Mã loại nội dung chỉ gồm a-z, 0-9, _ ; bắt đầu bằng chữ, 2–40 ký tự');
      const err = validateLabels(form.labels, form.slugs, defaultLocale);
      if (err) throw new Error(err);
      const { labels, slugs } = cleanLabels(form.labels, form.slugs);
      const reserved = Object.values(slugs).find((s) => (RESERVED_SLUGS as readonly string[]).includes(s));
      if (reserved) throw new Error(`Slug "${reserved}" trùng đường dẫn hệ thống, hãy chọn slug khác`);
      const body = {
        labels,
        slugs,
        description: form.description.trim() || null,
        icon: normalizeIconName(form.icon) || 'file-text',
        supports: form.supports,
        isPublic: form.isPublic,
        hasArchive: form.hasArchive,
        searchable: form.searchable,
        perPage: Math.min(100, Math.max(1, form.perPage || 12)),
        orderBy: form.orderBy,
        listColumns: form.listColumns,
        isActive: form.isActive,
        sortOrder: form.sortOrder,
        taxonomies: form.taxonomies,
      };
      return isNew ? api.post<ContentTypeView>('/admin/content-types', { key: form.key, ...body }) : api.put<ContentTypeView>(`/admin/content-types/${id}`, body);
    },
    onSuccess: (data) => {
      toast.success('Đã lưu loại nội dung');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['content-types'] });
      void qc.invalidateQueries({ queryKey: ['taxonomies'] });
      qc.setQueryData(['content-type', data.id], data);
      if (isNew) router.replace(`/content-types/${data.id}`);
      else setForm(fromView(data));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  useUnsavedGuard(dirty, () => !save.isPending && save.mutate());

  if (!form || (!isNew && detail.isLoading)) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const name = typeLabel(form.labels, defaultLocale, 'plural', '');
  const toggleSupport = (s: ContentTypeSupport, on: boolean) => update({ supports: on ? [...form.supports, s] : form.supports.filter((x) => x !== s) });
  const iconOk = isIconName(form.icon);
  // loại khai báo trong apps/api/src/config/content-types.config.ts: chỉ xem (API cũng từ chối sửa / xoá)
  const fromCode = detail.data?.source === 'code';
  const readOnly = !canManage || fromCode;

  return (
    <>
      <PageHeader
        title={isNew ? 'Thêm loại nội dung' : name || 'Loại nội dung'}
        breadcrumbs={[{ label: 'Loại nội dung', href: '/content-types' }, { label: isNew ? 'Mới' : 'Chỉnh sửa' }]}
        actions={
          <>
            {!isNew && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/content/${form.key}`}>
                  <ExternalLink /> Danh sách bài
                </Link>
              </Button>
            )}
            {!isNew && canManage && !fromCode && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={async () => {
                  const count = detail.data?.entryCount ?? allTypes.data?.find((t) => t.id === id)?.entryCount ?? 0;
                  if (!(await confirm({ title: `Xoá loại nội dung “${name}”?`, description: count > 0 ? `Loại này còn ${count} bài — API sẽ từ chối xoá.` : 'Không thể khôi phục.', destructive: true, confirmText: 'Xoá' }))) return;
                  try {
                    await api.delete(`/admin/content-types/${id}`);
                    toast.success('Đã xoá loại nội dung');
                    setDirty(false);
                    void qc.invalidateQueries({ queryKey: ['content-types'] });
                    router.push('/content-types');
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                }}
              >
                <Trash2 /> Xoá
              </Button>
            )}
            {canManage && !fromCode && (
              <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        {fromCode && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <Code2 className="mt-0.5 size-4 shrink-0" />
            <span>
              Loại nội dung này được khai báo trong mã nguồn (<code>apps/api/src/config/content-types.config.ts</code>) — chỉ xem tại đây. Muốn đổi thì sửa file đó rồi khởi động lại API.
            </span>
          </div>
        )}
        <fieldset disabled={readOnly} className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <div className="min-w-0 space-y-6">
            <Section title="Tên & đường dẫn" description="Tên hiển thị trong menu admin / website và đường dẫn trang lưu trữ theo từng ngôn ngữ">
              <LabelsSlugsEditor
                languages={languages}
                defaultLocale={defaultLocale}
                labels={form.labels}
                slugs={form.slugs}
                slugHint={(slug, locale) => `${locale !== defaultLocale ? `/${locale}` : ''}/${slug}  ·  /${slug}/ten-bai-viet`}
                onChange={({ labels, slugs }) => {
                  const key = isNew && !keyTouched ? toKey(labels[defaultLocale]?.singular || labels[defaultLocale]?.plural || '') : form.key;
                  update({ labels, slugs, key });
                }}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Mã (key)" required help={isNew ? 'a-z, 0-9, _ — dùng trong API, theme, Theme Builder. Không đổi được sau khi tạo.' : 'Không đổi được sau khi tạo.'}>
                  <Input
                    value={form.key}
                    disabled={!isNew || readOnly}
                    className="font-mono text-xs"
                    placeholder="du_an"
                    onChange={(e) => {
                      setKeyTouched(true);
                      update({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') });
                    }}
                  />
                </Field>
                <Field label="Icon" help="Tên icon Lucide (lucide.dev/icons), vd briefcase, building-2">
                  <div className="flex items-center gap-2">
                    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border', iconOk ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                      <ContentIcon name={form.icon} className="size-4" />
                    </span>
                    <Input value={form.icon} className="font-mono text-xs" onChange={(e) => update({ icon: e.target.value })} placeholder="briefcase" />
                  </div>
                  {!iconOk && form.icon && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Không tìm thấy icon “{form.icon}” — sẽ dùng icon mặc định</p>}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {ICON_SUGGESTIONS.map((n) => (
                      <button key={n} type="button" title={n} onClick={() => update({ icon: n })} className={cn('flex size-7 items-center justify-center rounded-md border hover:bg-muted', normalizeIconName(form.icon) === n && 'border-primary bg-primary/10 text-primary')}>
                        <ContentIcon name={n} className="size-3.5" />
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
              <Field label="Mô tả" help="Hiện ở trang lưu trữ (nếu theme hỗ trợ) và trong admin">
                <Textarea value={form.description} rows={2} onChange={(e) => update({ description: e.target.value })} />
              </Field>
            </Section>

            <Section title="Tính năng soạn thảo" description="Các khu vực hiện trong trang soạn bài của loại này">
              <div className="grid gap-2 sm:grid-cols-2">
                {CONTENT_TYPE_SUPPORTS.map((s) => (
                  <label key={s} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                    <Checkbox checked={form.supports.includes(s)} onCheckedChange={(c) => toggleSupport(s, !!c)} />
                    {CONTENT_TYPE_SUPPORT_LABELS[s]}
                  </label>
                ))}
              </div>
              {form.supports.includes('editor') && form.supports.includes('blocks') && <p className="text-xs text-muted-foreground">Bật cả hai: trang soạn bài có nút chuyển giữa trình soạn thảo và Page Builder.</p>}
            </Section>

            <Section title="Cột trong danh sách bài" description="Hiện giá trị trường tuỳ chỉnh thành cột ở trang danh sách bài (vd giá, địa điểm)">
              {fieldOptions.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {fieldOptions.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                      <Checkbox checked={form.listColumns.includes(f.key)} onCheckedChange={(c) => update({ listColumns: c ? [...form.listColumns, f.key] : form.listColumns.filter((x) => x !== f.key) })} />
                      <span className="min-w-0 flex-1 truncate">{f.label}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{f.key}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Chưa có nhóm trường tuỳ chỉnh cho loại này.{' '}
                  {can('fields.manage') && (
                    <Link href="/custom-fields/new" className="text-primary hover:underline">
                      Tạo nhóm trường
                    </Link>
                  )}
                </p>
              )}
              {form.listColumns.filter((k) => !fieldOptions.some((f) => f.key === k)).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {form.listColumns
                    .filter((k) => !fieldOptions.some((f) => f.key === k))
                    .map((k) => (
                      <Badge key={k} variant="secondary" className="gap-1 font-mono">
                        {k}
                        <button type="button" onClick={() => update({ listColumns: form.listColumns.filter((x) => x !== k) })} aria-label="Gỡ">
                          ×
                        </button>
                      </Badge>
                    ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input value={extraCol} onChange={(e) => setExtraCol(e.target.value)} placeholder="Thêm mã trường khác..." className="max-w-60 font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!extraCol.trim()}
                  onClick={() => {
                    const k = extraCol.trim();
                    if (k && !form.listColumns.includes(k)) update({ listColumns: [...form.listColumns, k] });
                    setExtraCol('');
                  }}
                >
                  <Plus /> Thêm
                </Button>
              </div>
            </Section>
          </div>

          <div className="space-y-6">
            <Section title="Hiển thị">
              <ToggleRow label="Bật loại nội dung" help="Tắt = ẩn khỏi menu admin và website, dữ liệu vẫn giữ" checked={form.isActive} onChange={(v) => update({ isActive: v })} disabled={readOnly} />
              <ToggleRow label="Công khai trên website" help="Tắt = chỉ dùng nội bộ / hiển thị qua block (vd Cảm nhận khách hàng, Hỏi đáp)" checked={form.isPublic} onChange={(v) => update({ isPublic: v })} disabled={readOnly} />
              <ToggleRow label="Có trang lưu trữ" help="Trang danh sách tại /{slug}" checked={form.hasArchive} onChange={(v) => update({ hasArchive: v })} disabled={readOnly || !form.isPublic} />
              <ToggleRow label="Cho phép tìm kiếm" help="Bài xuất hiện trong kết quả tìm kiếm website" checked={form.searchable} onChange={(v) => update({ searchable: v })} disabled={readOnly || !form.isPublic} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Số bài mỗi trang">
                  <Input type="number" min={1} max={100} value={form.perPage} onChange={(e) => update({ perPage: Number(e.target.value) || 0 })} />
                </Field>
                <Field label="Thứ tự menu">
                  <Input type="number" value={form.sortOrder} onChange={(e) => update({ sortOrder: Number(e.target.value) || 0 })} />
                </Field>
              </div>
              <Field label="Sắp xếp mặc định">
                <Select value={form.orderBy} onValueChange={(v) => update({ orderBy: v as ContentTypeOrder })} disabled={readOnly}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTENT_TYPE_ORDERS.map((o) => (
                      <SelectItem key={o} value={o}>
                        {ORDER_LABELS[o]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </Section>

            <Section
              title="Phân loại (taxonomy)"
              actions={
                canManage && !isNew ? (
                  <button type="button" className="text-xs text-primary" onClick={() => setTaxSheet('new')}>
                    + Tạo mới
                  </button>
                ) : undefined
              }
            >
              <div className="space-y-1.5">
                {!taxonomies.data?.length && <p className="text-sm text-muted-foreground">Chưa có taxonomy nào{isNew ? ' — lưu loại nội dung trước rồi tạo taxonomy.' : ''}</p>}
                {taxonomies.data?.map((t) => (
                  <label key={t.key} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={form.taxonomies.includes(t.key)} onCheckedChange={(c) => update({ taxonomies: c ? [...form.taxonomies, t.key] : form.taxonomies.filter((x) => x !== t.key) })} />
                    <span className="flex-1">{typeLabel(t.labels, defaultLocale, 'plural', t.key)}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
                  </label>
                ))}
              </div>
            </Section>
          </div>
        </fieldset>
      </PageBody>
      <TaxonomySheet editing={taxSheet} onClose={() => setTaxSheet(null)} contentTypes={allTypes.data ?? []} presetType={form.key} onSaved={(t) => !form.taxonomies.includes(t.key) && t.contentTypes?.includes(form.key) && setForm((f) => (f ? { ...f, taxonomies: [...f.taxonomies, t.key] } : f))} />
    </>
  );
}
