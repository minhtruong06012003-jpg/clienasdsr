'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, FolderTree, Loader2, MoreHorizontal, Pencil, Plus, Save, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { slugify, type ContentTypeView, type TaxonomyView, type TermAdminView } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { Field } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { SlugInput } from '@/components/common/slug-input';
import { useConfirm } from '@/components/common/confirm-dialog';
import { ImageIdField } from '@/components/media/media-picker';
import { CustomFieldsPanel } from '@/components/custom-fields/custom-fields-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useLanguages, useListLocale } from '@/hooks/use-languages';
import { flattenTerms, termName, typeLabel, useTaxonomyTerms } from '@/hooks/use-content-types';
import { termUrl } from './utils';

type TermTr = TermAdminView['translations'][number];
type FlatTerm = TermAdminView & { depth: number };
const NONE = '__none__';

const emptyTr = (locale: string): TermTr => ({ locale, name: '', slug: '', description: '', seoTitle: '', seoDescription: '' });

/**
 * Quản lý term của một taxonomy (Lĩnh vực, Địa điểm...): cây phẳng thụt lề theo cấp, sắp xếp lên/xuống trong cùng cấp,
 * sheet sửa đa ngôn ngữ (tên, slug, mô tả, SEO), ảnh, mục cha và trường tuỳ chỉnh entity `term`.
 * API: GET|POST /admin/taxonomies/:key/terms, PUT|DELETE /admin/terms/:id, POST /admin/taxonomies/:key/terms/reorder.
 */
export function TermManager({ type, taxonomyKey, taxonomy }: { type: ContentTypeView; taxonomyKey: string; taxonomy: TaxonomyView | null | undefined }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { locale, setLocale, languages, defaultLocale } = useListLocale();
  const terms = useTaxonomyTerms(taxonomyKey);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<TermAdminView | 'new' | null>(null);
  const flat = useMemo(() => flattenTerms(terms.data ?? []), [terms.data]);
  const hierarchical = taxonomy ? taxonomy.hierarchical : flat.some((t) => t.parentId);
  const canEdit = can('entries.taxonomy');
  const label = taxonomy ? typeLabel(taxonomy.labels, locale, 'plural', taxonomyKey) : taxonomyKey;
  const singular = (taxonomy ? typeLabel(taxonomy.labels, locale, 'singular', taxonomyKey) : 'phân loại').toLowerCase();
  const typePlural = typeLabel(type.labels, locale, 'plural', type.key);
  const name = (t: TermAdminView) => termName(t, locale) || '(chưa có tên)';

  const q = search.trim().toLowerCase();
  const rows = q ? flat.filter((t) => t.translations.some((x) => x.name.toLowerCase().includes(q) || x.slug.includes(q))) : flat;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['taxonomy-terms', taxonomyKey] });
    void qc.invalidateQueries({ queryKey: ['taxonomies'] });
  };

  const reorder = useMutation({
    mutationFn: (items: { id: string; parentId: string | null; sortOrder: number }[]) => api.post(`/admin/taxonomies/${taxonomyKey}/terms/reorder`, { items }),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  /** Đổi chỗ với mục cùng cấp liền trước / sau rồi gửi lại thứ tự cả nhóm anh em */
  const move = (t: FlatTerm, dir: -1 | 1) => {
    const siblings = flat.filter((x) => (x.parentId ?? null) === (t.parentId ?? null));
    const i = siblings.findIndex((x) => x.id === t.id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const next = [...siblings];
    [next[i], next[j]] = [next[j], next[i]];
    reorder.mutate(next.map((x, k) => ({ id: x.id, parentId: x.parentId ?? null, sortOrder: k })));
  };

  const remove = async (t: TermAdminView) => {
    const children = flat.filter((x) => x.parentId === t.id).length;
    if (!(await confirm({ title: `Xoá “${name(t)}”?`, description: `${t.entryCount ? `${t.entryCount} bài đang gắn sẽ bị gỡ khỏi ${singular} này. ` : ''}${children ? `${children} mục con sẽ lên cấp trên. ` : ''}Không thể khôi phục.`, destructive: true, confirmText: 'Xoá' }))) return;
    try {
      await api.delete(`/admin/terms/${t.id}`);
      toast.success('Đã xoá');
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title={label}
        description={taxonomy?.description ?? `Phân loại ${typePlural.toLowerCase()}`}
        breadcrumbs={[{ label: typePlural, href: `/content/${type.key}` }, { label }]}
        actions={
          <>
            <LocaleTabs languages={languages} value={locale} onChange={setLocale} />
            {canEdit && (
              <Button onClick={() => setEditing('new')}>
                <Plus /> Thêm {singular}
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Tìm ${singular}...`} className="pl-8" />
        </div>
        {terms.isLoading ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : !flat.length ? (
          <EmptyState icon={FolderTree} title={terms.isError ? `Không tải được: ${errorMessage(terms.error)}` : `Chưa có ${singular} nào`} action={canEdit && !terms.isError ? <Button onClick={() => setEditing('new')}><Plus /> Thêm {singular} đầu tiên</Button> : undefined} />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
              <span>Tên</span>
              <span className="w-20 text-center">Số bài</span>
              <span className="w-24" />
            </div>
            {rows.map((t) => {
              const tr = t.translations.find((x) => x.locale === locale);
              const url = tr ? termUrl(taxonomy?.slugs, taxonomy?.isPublic, tr.slug, locale, defaultLocale) : '';
              const siblings = flat.filter((x) => (x.parentId ?? null) === (t.parentId ?? null));
              const idx = siblings.findIndex((x) => x.id === t.id);
              return (
                <div key={t.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b px-4 py-2 last:border-0 hover:bg-muted/30">
                  <div className="flex min-w-0 items-center gap-3" style={{ paddingLeft: q ? 0 : t.depth * 24 }}>
                    {t.depth > 0 && !q && <span className="text-muted-foreground">└</span>}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {t.image ? <img src={(t.image as { urls?: Record<string, string> }).urls?.thumb ?? t.image.url} alt="" className="size-9 rounded-md object-cover" /> : null}
                    <div className="min-w-0">
                      <button type="button" className="block truncate text-left font-medium hover:text-primary" onClick={() => canEdit && setEditing(t)}>
                        {tr?.name ?? <span className="text-muted-foreground">{name(t)} <span className="text-xs text-amber-600 dark:text-amber-400">[chưa dịch]</span></span>}
                      </button>
                      <div className="flex gap-2 font-mono text-[11px] text-muted-foreground">
                        <span className="truncate">{tr?.slug ?? t.translations[0]?.slug}</span>
                        {languages.length > 1 &&
                          languages.map((l) => (
                            <span key={l.code} className={cn('font-sans', t.translations.some((x) => x.locale === l.code) ? 'text-emerald-600 dark:text-emerald-400' : 'opacity-40')}>
                              {l.code.toUpperCase()}
                            </span>
                          ))}
                      </div>
                    </div>
                  </div>
                  <span className="w-20 text-center">
                    <Badge variant="secondary" asChild>
                      <Link href={`/content/${type.key}?termId=${t.id}`}>{t.entryCount ?? 0}</Link>
                    </Badge>
                  </span>
                  <div className="flex w-24 items-center justify-end gap-0.5">
                    {canEdit && !q && (
                      <>
                        <Button variant="ghost" size="icon-xs" disabled={idx <= 0 || reorder.isPending} onClick={() => move(t, -1)} title="Lên trên">
                          <ArrowUp />
                        </Button>
                        <Button variant="ghost" size="icon-xs" disabled={idx >= siblings.length - 1 || reorder.isPending} onClick={() => move(t, 1)} title="Xuống dưới">
                          <ArrowDown />
                        </Button>
                      </>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canEdit && (
                          <DropdownMenuItem onClick={() => setEditing(t)}>
                            <Pencil /> Chỉnh sửa
                          </DropdownMenuItem>
                        )}
                        {url && (
                          <DropdownMenuItem asChild>
                            <a href={url} target="_blank" rel="noreferrer">
                              <ExternalLink /> Xem trên web
                            </a>
                          </DropdownMenuItem>
                        )}
                        {canEdit && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => remove(t)}>
                              <Trash2 /> Xoá
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
            {!rows.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Không có kết quả</p>}
          </div>
        )}
      </PageBody>
      <TermSheet
        editing={editing}
        onClose={() => setEditing(null)}
        all={flat}
        taxonomyKey={taxonomyKey}
        taxonomy={taxonomy}
        hierarchical={hierarchical}
        singular={singular}
        onSaved={invalidate}
        initialLocale={locale}
        defaultLocale={defaultLocale}
      />
    </>
  );
}

/** Sheet tạo / sửa một term (đa ngôn ngữ) */
function TermSheet({
  editing,
  onClose,
  all,
  taxonomyKey,
  taxonomy,
  hierarchical,
  singular,
  onSaved,
  initialLocale,
  defaultLocale,
}: {
  editing: TermAdminView | 'new' | null;
  onClose: () => void;
  all: FlatTerm[];
  taxonomyKey: string;
  taxonomy: TaxonomyView | null | undefined;
  hierarchical: boolean;
  singular: string;
  onSaved: () => void;
  initialLocale: string;
  defaultLocale: string;
}) {
  const { languages } = useLanguages();
  const isNew = editing === 'new';
  const term = editing && editing !== 'new' ? editing : null;
  const [active, setActive] = useState(initialLocale);
  const [form, setForm] = useState<{ parentId: string | null; imageId: string | null; sortOrder: number; customFields: Record<string, unknown>; translations: Record<string, TermTr> } | null>(null);

  useEffect(() => {
    if (!editing) return setForm(null);
    setActive(initialLocale);
    if (editing === 'new') setForm({ parentId: null, imageId: null, sortOrder: 0, customFields: {}, translations: { [initialLocale]: emptyTr(initialLocale) } });
    else setForm({ parentId: editing.parentId, imageId: editing.imageId, sortOrder: editing.sortOrder ?? 0, customFields: editing.customFields ?? {}, translations: Object.fromEntries(editing.translations.map((t) => [t.locale, { ...emptyTr(t.locale), ...t }])) });
  }, [editing, initialLocale]);

  // không cho chọn chính nó / con cháu làm mục cha
  const blocked = useMemo(() => {
    const out = new Set<string>();
    if (!term) return out;
    out.add(term.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of all) {
        if (t.parentId && out.has(t.parentId) && !out.has(t.id)) {
          out.add(t.id);
          grew = true;
        }
      }
    }
    return out;
  }, [term, all]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      const translations = Object.values(form.translations)
        .filter((t) => t.name.trim())
        .map((t) => ({ ...t, name: t.name.trim(), slug: t.slug.trim() || slugify(t.name), description: t.description || null, seoTitle: t.seoTitle || null, seoDescription: t.seoDescription || null }));
      if (!translations.length) throw new Error('Vui lòng nhập tên');
      const body = { parentId: hierarchical ? form.parentId : null, imageId: form.imageId, sortOrder: form.sortOrder, customFields: form.customFields, translations };
      return isNew ? api.post(`/admin/taxonomies/${taxonomyKey}/terms`, body) : api.put(`/admin/terms/${term!.id}`, body);
    },
    onSuccess: () => {
      toast.success('Đã lưu');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const tr = form?.translations[active];
  const setTr = (patch: Partial<TermTr>) => setForm((f) => (f ? { ...f, translations: { ...f.translations, [active]: { ...(f.translations[active] ?? emptyTr(active)), ...patch } } } : f));
  const prefix = `${active !== defaultLocale ? `/${active}` : ''}/${taxonomy?.slugs?.[active] ?? taxonomy?.slugs?.[defaultLocale] ?? taxonomyKey}/`;

  return (
    <Sheet open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{isNew ? `Thêm ${singular}` : `Sửa ${singular}`}</SheetTitle>
          <SheetDescription className="flex items-center justify-between gap-2">
            <span>Nhập theo từng ngôn ngữ</span>
            {languages.length > 1 && <LocaleTabs languages={languages} value={active} onChange={setActive} has={(c) => !!form?.translations[c]?.name} />}
          </SheetDescription>
        </SheetHeader>
        {form && (
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <Field label="Tên" required>
              <Input value={tr?.name ?? ''} autoFocus onChange={(e) => setTr({ name: e.target.value })} />
            </Field>
            <Field label="Đường dẫn (slug)" help="Để trống sẽ tự tạo từ tên">
              <SlugInput value={tr?.slug ?? ''} onChange={(slug) => setTr({ slug })} source={tr?.name ?? ''} prefix={prefix} />
            </Field>
            <Field label="Mô tả">
              <Textarea value={tr?.description ?? ''} rows={3} onChange={(e) => setTr({ description: e.target.value })} />
            </Field>
            {hierarchical && (
              <Field label="Mục cha">
                <Select value={form.parentId ?? NONE} onValueChange={(v) => setForm({ ...form, parentId: v === NONE ? null : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>— Không có (cấp gốc) —</SelectItem>
                    {all
                      .filter((t) => !blocked.has(t.id))
                      .map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <span style={{ paddingLeft: t.depth * 12 }}>{termName(t, active) || termName(t, defaultLocale)}</span>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Ảnh">
              <ImageIdField value={form.imageId} initial={term?.image} onChange={(imageId) => setForm({ ...form, imageId })} aspect="aspect-video" />
            </Field>
            <Field label="Thứ tự">
              <Input type="number" className="w-32" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) || 0 })} />
            </Field>
            <div className="space-y-3 rounded-lg border p-3">
              <p className="text-sm font-medium">SEO ({active.toUpperCase()})</p>
              <Field label="Tiêu đề SEO">
                <Input value={tr?.seoTitle ?? ''} onChange={(e) => setTr({ seoTitle: e.target.value })} placeholder={tr?.name} />
              </Field>
              <Field label="Mô tả SEO">
                <Textarea value={tr?.seoDescription ?? ''} rows={2} onChange={(e) => setTr({ seoDescription: e.target.value })} />
              </Field>
            </div>
            <CustomFieldsPanel entity="term" variant="plain" value={form.customFields} onChange={(customFields) => setForm({ ...form, customFields })} context={{ taxonomy: taxonomyKey }} locale={active} />
          </div>
        )}
        <SheetFooter className="border-t">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !form}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
