'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Boxes, ExternalLink, History, LayoutTemplate, Loader2, Save, Trash2, Type } from 'lucide-react';
import { toast } from 'sonner';
import type { BlockNode } from '@cmsnt/blocks';
import { sanitizeForEditor } from '@cmsnt/blocks/sanitize';
import type { ContentTypeView } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { SlugInput } from '@/components/common/slug-input';
import { TranslationGate } from '@/components/common/translation-gate';
import { useConfirm } from '@/components/common/confirm-dialog';
import { PreviewButton } from '@/components/common/preview-button';
import { RevisionsDialog } from '@/components/common/revisions-dialog';
import { AutosaveToggle } from '@/components/common/autosave-toggle';
import { StatusBadge } from '@/components/common/status-badge';
import { EmptyState } from '@/components/common/empty-state';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { SeoPanel } from '@/components/seo/seo-panel';
import { CustomFieldsPanel, useHasFieldGroups } from '@/components/custom-fields/custom-fields-panel';
import { PageBuilder } from '@/components/builder/page-builder';
import { blocksToText, useBuilder, useBuilderSession } from '@/components/builder/store';
import { ImageIdField } from '@/components/media/media-picker';
import { TermPicker } from '@/components/content/term-picker';
import { entrySlugPrefix, entryUrl } from '@/components/content/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, pickTr } from '@/lib/format';
import { effectiveStatus, isFutureDate, toLocalInput } from '@/lib/publish';
import { useAuth } from '@/lib/auth';
import type { ContentStatus, SeoFields } from '@/lib/types';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useEditLock } from '@/hooks/use-edit-lock';
import { EditLockBanner } from '@/components/common/edit-lock-banner';
import { useAutosave } from '@/hooks/use-autosave';
import { typeLabel, useContentType, useTaxonomies } from '@/hooks/use-content-types';

interface EntryTranslation extends SeoFields {
  locale: string;
  title: string;
  slug: string;
  excerpt: string | null;
  content: string;
  blocks: BlockNode[];
}

interface EntryDetail {
  id: string;
  type: string;
  status: ContentStatus;
  publishedAt: string | null;
  updatedAt: string;
  parentId: string | null;
  authorId: string | null;
  author: { id: string; name: string } | null;
  featuredImageId: string | null;
  featuredImage: { id: string; url: string; urls: Record<string, string> } | null;
  isFeatured: boolean;
  sortOrder: number;
  termIds?: string[];
  /** API có thể trả term dạng object thay vì termIds */
  terms?: ({ id: string } | { term: { id: string } } | { termId: string })[];
  customFields?: Record<string, unknown>;
  translations: EntryTranslation[];
}

interface FormState {
  status: ContentStatus;
  publishedAt: string;
  parentId: string | null;
  authorId: string | null;
  featuredImageId: string | null;
  isFeatured: boolean;
  sortOrder: number;
  termIds: string[];
  customFields: Record<string, unknown>;
  translations: Record<string, EntryTranslation>;
}

interface EntryRevisionDetail {
  id: string;
  locale: string;
  title: string;
  excerpt?: string | null;
  content?: string | null;
  blocks?: BlockNode[] | null;
  createdAt: string;
}

type Mode = 'classic' | 'builder';
const NONE = '__none__';

const emptyTr = (locale: string): EntryTranslation => ({ locale, title: '', slug: '', excerpt: '', content: '', blocks: [], seoTitle: '', seoDescription: '', seoKeywords: '', canonicalUrl: '', noindex: false, nofollow: false, ogImageId: null, schemaJson: null });
const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
const stripResolved = (blocks: BlockNode[]) => blocks.map(({ resolved: _r, ...b }) => b);
/** Bản dịch hoàn toàn trống (tạo ra nhưng chưa nhập gì) */
const isBlankTr = (t: EntryTranslation) =>
  !t.title.trim() && !t.slug.trim() && !(t.excerpt ?? '').trim() && !stripHtml(t.content ?? '') && !/<img|<iframe|<video/i.test(t.content ?? '') && !t.blocks?.length && !(t.seoTitle ?? '').trim() && !(t.seoDescription ?? '').trim() && !t.ogImageId;

/** termIds từ chi tiết (chấp nhận nhiều dạng API trả về) */
const termIdsOf = (d: EntryDetail): string[] => d.termIds ?? (d.terms ?? []).map((t) => ('termId' in t ? t.termId : 'term' in t ? t.term.id : t.id));

const fromDetail = (d: EntryDetail): FormState => ({
  status: d.status,
  publishedAt: toLocalInput(d.publishedAt),
  parentId: d.parentId,
  authorId: d.authorId ?? d.author?.id ?? null,
  featuredImageId: d.featuredImageId,
  isFeatured: d.isFeatured,
  sortOrder: d.sortOrder ?? 0,
  termIds: termIdsOf(d),
  customFields: d.customFields ?? {},
  translations: Object.fromEntries(d.translations.map((t) => [t.locale, { ...emptyTr(t.locale), ...t, content: t.content ?? '', blocks: Array.isArray(t.blocks) ? t.blocks : [] }])),
});

export default function EntryEditorPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type: typeKey, id } = use(params);
  const { type, isLoading, isError } = useContentType(typeKey);
  const { can, isDeveloper } = useAuth();
  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!type) {
    return (
      <PageBody>
        <EmptyState icon={Boxes} title={isError ? 'Không tải được loại nội dung' : `Không tìm thấy loại nội dung “${typeKey}”`} action={(isDeveloper && can('content_types.manage')) ? <Button asChild variant="outline"><Link href="/content-types">Quản lý loại nội dung</Link></Button> : undefined} />
      </PageBody>
    );
  }
  return <EntryEditor key={id} type={type} id={id} />;
}

function EntryEditor({ type, id }: { type: ContentTypeView; id: string }) {
  const isNew = id === 'new';
  // khoá chỉnh sửa đồng thời: người khác đang sửa -> chỉ đọc
  const lock = useEditLock('entry', isNew ? null : id);
  const typeKey = type.key;
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { languages, defaultLocale } = useLanguages();
  const taxonomies = useTaxonomies();
  const [locale, setLocale] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>('classic');
  /** đếm số lần sửa (ngoài canvas) để biết có thay đổi trong lúc đang lưu không */
  const editsRef = useRef(0);
  /** ngôn ngữ đang nạp trong store Page Builder (null = builder không dùng) */
  const loadedRef = useRef<string | null>(null);
  const version = useBuilder((s) => s.version);
  useBuilderSession();

  const active = locale ?? defaultLocale;
  const supports = (s: ContentTypeView['supports'][number]) => type.supports.includes(s);
  const hasEditor = supports('editor');
  const hasBlocks = supports('blocks');
  const canPublish = can('entries.publish');
  const singular = typeLabel(type.labels, defaultLocale, 'singular', typeKey);
  const plural = typeLabel(type.labels, defaultLocale, 'plural', typeKey);
  const langName = (code: string) => languages.find((l) => l.code === code)?.name ?? code;
  const listHref = `/content/${typeKey}`;

  const entry = useQuery({ queryKey: ['entry', id], queryFn: () => api.get<EntryDetail>(`/admin/entries/${id}`), enabled: !isNew });
  // nhân sự để chọn tác giả (cần users.read; lỗi -> ẩn ô chọn)
  const staff = useQuery({ queryKey: ['users-staff'], queryFn: () => api.get<Paginated<{ id: string; name: string }>>('/admin/users', { type: 'staff', limit: 100 }), enabled: canPublish && supports('author'), retry: false, staleTime: 5 * 60_000 });
  // bài cha (loại dạng cây)
  const parents = useQuery({ queryKey: ['entries-lookup', typeKey, 'parents'], queryFn: () => api.get<{ id: string; title: string; status: string }[]>('/admin/entries/lookup', { type: typeKey, limit: 100 }), enabled: supports('hierarchical'), staleTime: 30_000 });

  // khởi tạo form + chọn chế độ soạn (Page Builder khi chỉ hỗ trợ blocks, hoặc bài đã có block)
  useEffect(() => {
    if (form) return;
    let next: FormState | null = null;
    if (isNew && languages.length) next = { status: 'DRAFT', publishedAt: '', parentId: null, authorId: null, featuredImageId: null, isFeatured: false, sortOrder: 0, termIds: [], customFields: {}, translations: { [defaultLocale]: emptyTr(defaultLocale) } };
    else if (entry.data && languages.length) next = fromDetail(entry.data);
    if (!next) return;
    const first = next.translations[active] ? active : (Object.keys(next.translations)[0] ?? active);
    const useBuilderMode = hasBlocks && (!hasEditor || Object.values(next.translations).some((t) => t.blocks.length > 0));
    setForm(next);
    if (first !== active) setLocale(first);
    if (useBuilderMode) {
      useBuilder.getState().load(next.translations[first]?.blocks ?? []);
      loadedRef.current = first;
      setMode('builder');
    }
  }, [isNew, languages.length, entry.data, defaultLocale, form, active, hasBlocks, hasEditor]);

  useEffect(() => {
    if (version > 0) setDirty(true);
  }, [version]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    editsRef.current++;
    setDirty(true);
  };
  const updateTr = (patch: Partial<EntryTranslation>) => {
    setForm((f) => (f ? { ...f, translations: { ...f.translations, [active]: { ...f.translations[active], ...patch } } } : f));
    editsRef.current++;
    setDirty(true);
  };

  /** Bản dịch kèm block mới nhất từ canvas (nếu đang dùng Page Builder) */
  const withCanvasBlocks = (trs: Record<string, EntryTranslation>) => {
    const loaded = loadedRef.current;
    if (!loaded || !trs[loaded]) return trs;
    return { ...trs, [loaded]: { ...trs[loaded], blocks: useBuilder.getState().blocks } };
  };

  /** Đổi ngôn ngữ: cất block ngôn ngữ cũ, nạp block ngôn ngữ mới vào canvas */
  const switchLocale = (code: string) => {
    if (mode === 'builder' && form) {
      const trs = withCanvasBlocks(form.translations);
      if (useBuilder.getState().version > 0) {
        editsRef.current++;
        setDirty(true);
      }
      setForm({ ...form, translations: trs });
      useBuilder.getState().load(trs[code]?.blocks ?? []);
      loadedRef.current = code;
    }
    setLocale(code);
  };

  /** Chuyển giữa trình soạn thảo và Page Builder (khi loại hỗ trợ cả hai) */
  const switchMode = (m: Mode) => {
    if (!form || m === mode) return;
    if (m === 'builder') {
      useBuilder.getState().load(form.translations[active]?.blocks ?? []);
      loadedRef.current = active;
    } else {
      const trs = withCanvasBlocks(form.translations);
      if (useBuilder.getState().version > 0) editsRef.current++;
      setForm({ ...form, translations: trs });
      loadedRef.current = null;
    }
    setMode(m);
  };

  const save = useMutation({
    // chụp "phiên bản" lúc bắt đầu lưu -> chỉ xoá cờ chưa lưu nếu không có thay đổi mới trong lúc lưu
    onMutate: () => ({ edits: editsRef.current, version: useBuilder.getState().version }),
    mutationFn: async ({ status, auto }: { status?: ContentStatus; auto?: boolean }) => {
      if (!form) throw new Error('Chưa sẵn sàng');
      lock.assertWritable();
      const all = withCanvasBlocks(form.translations);
      const skipped: string[] = [];
      const list: EntryTranslation[] = [];
      for (const t of Object.values(all)) {
        if (t.title.trim()) list.push(t);
        else if (isBlankTr(t)) skipped.push(t.locale);
        else throw new Error(`Bản ${langName(t.locale)} thiếu tiêu đề`);
      }
      if (!list.length) throw new Error('Vui lòng nhập tiêu đề');
      if (skipped.length && !auto) toast.info(`Bỏ qua bản ${skipped.map(langName).join(', ')} vì còn trống`);
      const body = {
        type: typeKey,
        // tự lưu: giữ nháp; chọn Xuất bản mà ngày ở tương lai -> hẹn giờ
        status: auto ? 'DRAFT' : effectiveStatus(status ?? form.status, form.publishedAt),
        publishedAt: form.publishedAt ? new Date(form.publishedAt).toISOString() : undefined,
        parentId: supports('hierarchical') ? form.parentId : undefined,
        authorId: canPublish && supports('author') && form.authorId ? form.authorId : undefined,
        featuredImageId: form.featuredImageId,
        isFeatured: form.isFeatured,
        sortOrder: form.sortOrder,
        termIds: form.termIds,
        customFields: form.customFields,
        translations: list.map((t) => ({ ...t, excerpt: t.excerpt || null, blocks: stripResolved(t.blocks ?? []) })),
      };
      return isNew ? api.post<EntryDetail>('/admin/entries', body) : api.put<EntryDetail>(`/admin/entries/${id}`, body);
    },
    onSuccess: (data, vars, snap) => {
      if (vars.auto) {
        autosave.markSaved();
        toast.info(`Đã tự lưu lúc ${formatDate(new Date(), 'HH:mm')}`, { id: 'autosave', duration: 2500 });
      } else toast.success(`Đã lưu ${singular.toLowerCase()}`);
      const unchanged = !!snap && snap.edits === editsRef.current && snap.version === useBuilder.getState().version;
      if (unchanged) setDirty(false);
      void qc.invalidateQueries({ queryKey: ['entries'] });
      void qc.invalidateQueries({ queryKey: ['content-types'] });
      void qc.invalidateQueries({ queryKey: ['entries-revisions', data.id] });
      qc.setQueryData(['entry', data.id], data);
      if (isNew) {
        router.replace(`/content/${typeKey}/${data.id}`);
        return;
      }
      // chỉ cập nhật trường server chuẩn hoá (slug, trạng thái, ngày đăng) -> không mất chữ đang gõ
      setForm((f) => {
        if (!f) return f;
        const translations = { ...f.translations };
        for (const d of data.translations ?? []) if (translations[d.locale]) translations[d.locale] = { ...translations[d.locale], slug: d.slug };
        return { ...f, status: data.status ?? f.status, publishedAt: f.publishedAt || toLocalInput(data.publishedAt), translations };
      });
      if (unchanged && loadedRef.current) useBuilder.setState({ version: 0 });
    },
    onError: (e, vars) => {
      if (vars.auto) toast.error(`Tự lưu thất bại: ${errorMessage(e)}`, { id: 'autosave' });
      else toast.error(errorMessage(e));
    },
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate({});
  }, [save]);
  useUnsavedGuard(dirty, doSave);

  const autosaveSignal = useMemo(() => ({ form, version }), [form, version]);
  const autosave = useAutosave({
    active: !isNew && form?.status === 'DRAFT' && can('entries.write') && !lock.readOnly,
    dirty,
    signal: autosaveSignal,
    onSave: () => {
      if (!save.isPending) save.mutate({ auto: true });
    },
  });

  const hasFieldGroups = useHasFieldGroups('entry', { contentType: typeKey });

  if (!form || (!isNew && entry.isLoading)) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tr = form.translations[active];
  const publicUrl = tr?.slug ? entryUrl(type, tr.slug, active, defaultLocale) : '';
  const scheduled = (form.status === 'PUBLISHED' || form.status === 'SCHEDULED') && isFutureDate(form.publishedAt);
  const slugPrefix = entrySlugPrefix(type, active, defaultLocale);

  const createTranslation = (copy: boolean) => {
    const trs = withCanvasBlocks(form.translations);
    const src = trs[defaultLocale] ?? Object.values(trs)[0];
    const next: EntryTranslation = copy && src ? { ...structuredClone(src), locale: active, slug: '' } : emptyTr(active);
    setForm({ ...form, translations: { ...trs, [active]: next } });
    if (mode === 'builder') {
      useBuilder.getState().load(next.blocks);
      loadedRef.current = active;
    }
    editsRef.current++;
    setDirty(true);
  };
  /** Lưu nháp để lấy id (xem trước bản ghi mới) */
  const ensureId = async () => {
    if (!isNew) return id;
    const data = await save.mutateAsync({ status: 'DRAFT' });
    return data.id;
  };
  /** Khôi phục phiên bản ở server: nạp lại form (và canvas) */
  const onRestored = (data: EntryDetail) => {
    qc.setQueryData(['entry', id], data);
    const next = fromDetail(data);
    setForm(next);
    if (loadedRef.current) useBuilder.getState().load(next.translations[loadedRef.current]?.blocks ?? []);
    setDirty(false);
  };
  const trash = async () => {
    if (!(await confirm({ title: `Chuyển ${singular.toLowerCase()} vào thùng rác?`, description: 'Có thể khôi phục từ tab Thùng rác trong danh sách.', destructive: true }))) return;
    try {
      await api.post(`/admin/entries/${id}/trash`);
      toast.success('Đã chuyển vào thùng rác');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['entries'] });
      router.push(listHref);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const authorOptions = (() => {
    const list = staff.data?.data ?? [];
    const current = entry.data?.author;
    return current && !list.some((u) => u.id === current.id) ? [current, ...list] : list;
  })();

  // ---------------------------------------------------------------- các khối dùng chung 2 bố cục

  const publishFields = (
    <>
      <Field label="Trạng thái" help={scheduled ? `Sẽ tự đăng lúc ${formatDate(new Date(form.publishedAt))}` : undefined}>
        <Select value={form.status === 'SCHEDULED' ? 'PUBLISHED' : form.status} onValueChange={(v) => update({ status: v as ContentStatus })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DRAFT">Bản nháp</SelectItem>
            {canPublish && <SelectItem value="PUBLISHED">{scheduled ? 'Hẹn giờ đăng' : 'Đã xuất bản'}</SelectItem>}
            <SelectItem value="ARCHIVED">Lưu trữ</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Ngày đăng"
        help="Đặt ngày trong tương lai để hẹn giờ đăng"
        action={
          form.publishedAt ? (
            <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => update({ publishedAt: '' })}>
              Xoá ngày
            </button>
          ) : undefined
        }
      >
        <Input type="datetime-local" value={form.publishedAt} onChange={(e) => update({ publishedAt: e.target.value })} />
      </Field>
      {supports('author') && canPublish && (staff.data || entry.data?.author) && (
        <Field label="Tác giả">
          <Select value={form.authorId ?? NONE} onValueChange={(v) => update({ authorId: v === NONE ? null : v })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Chọn tác giả" />
            </SelectTrigger>
            <SelectContent>
              {!form.authorId && <SelectItem value={NONE}>{isNew ? 'Tôi (người tạo)' : '— Chưa gán —'}</SelectItem>}
              {authorOptions.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {supports('author') && !canPublish && entry.data?.author && <p className="text-xs text-muted-foreground">Tác giả: {entry.data.author.name}</p>}
      {supports('hierarchical') && (
        <Field label={`${singular} cha`}>
          <Select value={form.parentId ?? NONE} onValueChange={(v) => update({ parentId: v === NONE ? null : v })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>— Không có —</SelectItem>
              {(parents.data ?? [])
                .filter((p) => p.id !== id)
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title || '(chưa có tiêu đề)'}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {supports('order') && (
        <Field label="Thứ tự" help="Số nhỏ hiện trước khi loại sắp xếp thủ công">
          <Input type="number" value={form.sortOrder} onChange={(e) => update({ sortOrder: Number(e.target.value) || 0 })} className="w-32" />
        </Field>
      )}
      {supports('featured') && (
        <div className="flex items-center justify-between">
          <Label>Đánh dấu nổi bật</Label>
          <Switch checked={form.isFeatured} onCheckedChange={(v) => update({ isFeatured: v })} />
        </div>
      )}
      {!isNew && can('entries.write') && <AutosaveToggle enabled={autosave.enabled} onChange={autosave.setEnabled} lastSavedAt={autosave.lastSavedAt} />}
      {!isNew && can('entries.delete') && (
        <Button variant="ghost" size="sm" className="w-full text-destructive" onClick={trash}>
          <Trash2 /> Chuyển vào thùng rác
        </Button>
      )}
    </>
  );

  const termPickers = (variant: 'section' | 'plain') =>
    type.taxonomies.map((tax) => (
      <TermPicker
        key={tax}
        taxonomyKey={tax}
        taxonomy={taxonomies.data?.find((t) => t.key === tax)}
        typeKey={typeKey}
        value={form.termIds}
        onChange={(termIds) => update({ termIds })}
        locale={active}
        defaultLocale={defaultLocale}
        variant={variant}
      />
    ));

  const revisions = (trigger?: React.ReactNode) =>
    !isNew && supports('revisions') ? (
      <RevisionsDialog<EntryRevisionDetail, EntryDetail>
        // API entries dùng chung khuôn revisions của posts (/admin/entries/:id/revisions ...)
        resource="entries"
        id={id}
        locale={active}
        canRestore={can('entries.write')}
        onRestored={onRestored}
        renderPreview={(d) => <RevisionPreview d={d} />}
        trigger={trigger}
      />
    ) : null;

  const preview = (variant: 'outline' | 'ghost') =>
    type.isPublic && can('entries.read') ? <PreviewButton type="entry" id={isNew ? null : id} locale={active} ensureId={can('entries.write') ? ensureId : undefined} variant={variant} /> : null;

  const saveButtons = (
    <>
      <Button variant="outline" size="sm" onClick={() => save.mutate({ status: 'DRAFT' })} disabled={save.isPending}>
        Lưu nháp
      </Button>
      {canPublish && (
        <Button size="sm" onClick={() => save.mutate({ status: 'PUBLISHED' })} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          {scheduled ? 'Hẹn giờ đăng' : form.status === 'PUBLISHED' ? 'Cập nhật' : 'Xuất bản'}
        </Button>
      )}
    </>
  );

  // ---------------------------------------------------------------- bố cục Page Builder

  if (mode === 'builder') {
    const settingsPanel = tr && (
      <div className="space-y-4">
        <Field label="Tiêu đề" required>
          <Input value={tr.title} onChange={(e) => updateTr({ title: e.target.value })} />
        </Field>
        <Field label="Đường dẫn (slug)" help="Để trống sẽ tự tạo từ tiêu đề">
          <SlugInput value={tr.slug} onChange={(slug) => updateTr({ slug })} source={tr.title} prefix={slugPrefix} />
        </Field>
        {publishFields}
        {supports('excerpt') && (
          <Field label="Mô tả ngắn">
            <Textarea value={tr.excerpt ?? ''} onChange={(e) => updateTr({ excerpt: e.target.value })} rows={3} />
          </Field>
        )}
        {supports('featuredImage') && (
          <Field label="Ảnh đại diện">
            <ImageIdField value={form.featuredImageId} initial={entry.data?.featuredImage} onChange={(fid) => update({ featuredImageId: fid })} />
          </Field>
        )}
        {termPickers('plain')}
      </div>
    );
    return (
      <PageBuilder
        locale={active}
        header={
          <>
            <Button variant="ghost" size="icon-sm" asChild>
              <Link href={listHref} title="Quay lại danh sách">
                <ArrowLeft />
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{tr?.title || `${singular} mới`}</span>
                <StatusBadge status={scheduled ? 'SCHEDULED' : form.status} />
                {dirty && <span className="size-2 rounded-full bg-amber-500" title="Có thay đổi chưa lưu" />}
              </div>
            </div>
            <LocaleTabs languages={languages} value={active} onChange={switchLocale} has={(c) => !!form.translations[c]} className="ml-2" />
          </>
        }
        actions={
          <>
            <EditLockBanner lock={lock} variant="inline" />
            {hasEditor && (
              <Button variant="ghost" size="sm" onClick={() => switchMode('classic')} title="Chuyển sang trình soạn thảo văn bản">
                <Type /> Trình soạn thảo
              </Button>
            )}
            {revisions(
              <Button variant="ghost" size="icon-sm" title="Lịch sử phiên bản">
                <History />
              </Button>,
            )}
            {preview('ghost')}
            {publicUrl && form.status === 'PUBLISHED' && (
              <Button variant="ghost" size="sm" asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Xem
                </a>
              </Button>
            )}
            {saveButtons}
          </>
        }
        overlay={
          !tr ? (
            <div className="flex h-full items-center justify-center p-6">
              <TranslationGate language={languages.find((l) => l.code === active)} sourceLanguage={languages.find((l) => l.code === defaultLocale && l.code !== active)} onCreate={createTranslation} />
            </div>
          ) : undefined
        }
        panels={
          tr
            ? [
                { key: 'entry', label: singular, content: settingsPanel },
                { key: 'seo', label: 'SEO', content: <BuilderSeo tr={tr} onChange={updateTr} url={publicUrl || `${slugPrefix}${tr.slug}`} hasImage={!!form.featuredImageId} /> },
                ...(hasFieldGroups
                  ? [
                      {
                        key: 'fields',
                        label: 'Trường',
                        content: (
                          <div className="space-y-6">
                            <CustomFieldsPanel entity="entry" variant="plain" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ contentType: typeKey }} locale={active} />
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]
            : []
        }
      />
    );
  }

  // ---------------------------------------------------------------- bố cục soạn thảo thường (giống Bài viết)

  return (
    <>
      <PageHeader
        title={isNew ? `Thêm ${singular.toLowerCase()}` : pickTr(Object.values(form.translations), active)?.title || `Chỉnh sửa ${singular.toLowerCase()}`}
        breadcrumbs={[{ label: plural, href: listHref }, { label: isNew ? 'Mới' : 'Chỉnh sửa' }]}
        actions={
          <>
            <LocaleTabs languages={languages} value={active} onChange={switchLocale} has={(c) => !!form.translations[c]?.title} />
            {hasBlocks && (
              <Button variant="outline" size="sm" onClick={() => switchMode('builder')} title="Dựng nội dung bằng Page Builder">
                <LayoutTemplate /> Page Builder
              </Button>
            )}
            {revisions()}
            {preview('outline')}
            {!isNew && publicUrl && form.status === 'PUBLISHED' && (
              <Button variant="outline" size="sm" asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Xem
                </a>
              </Button>
            )}
            {saveButtons}
          </>
        }
      />
      <PageBody>
        <EditLockBanner lock={lock} />
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          <div className="min-w-0 space-y-6">
            {!tr ? (
              <TranslationGate language={languages.find((l) => l.code === active)} sourceLanguage={languages.find((l) => l.code === defaultLocale && l.code !== active)} onCreate={createTranslation} />
            ) : (
              <>
                <Section>
                  <Field label="Tiêu đề" required>
                    <Input value={tr.title} onChange={(e) => updateTr({ title: e.target.value })} placeholder={`Nhập tiêu đề ${singular.toLowerCase()}`} className="h-11 text-lg font-medium" autoFocus={isNew} />
                  </Field>
                  <Field label="Đường dẫn (slug)" help="Để trống sẽ tự tạo từ tiêu đề">
                    <SlugInput value={tr.slug} onChange={(slug) => updateTr({ slug })} source={tr.title} prefix={slugPrefix} />
                  </Field>
                  {hasEditor && (
                    <Field label="Nội dung">
                      <RichTextEditor value={tr.content} onChange={(content) => updateTr({ content })} minHeight={420} />
                    </Field>
                  )}
                  {!hasEditor && hasBlocks && (
                    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      Nội dung của {singular.toLowerCase()} được dựng bằng Page Builder.{' '}
                      <button type="button" className="text-primary hover:underline" onClick={() => switchMode('builder')}>
                        Mở Page Builder
                      </button>
                    </p>
                  )}
                  {hasEditor && hasBlocks && tr.blocks.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">Bản này đã có {tr.blocks.length} block Page Builder — website ưu tiên hiển thị block.</p>}
                  {supports('excerpt') && (
                    <Field label="Mô tả ngắn" help="Hiện ở danh sách. Để trống sẽ tự lấy từ nội dung.">
                      <Textarea value={tr.excerpt ?? ''} onChange={(e) => updateTr({ excerpt: e.target.value })} rows={3} />
                    </Field>
                  )}
                </Section>
                <CustomFieldsPanel entity="entry" placement="main" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ contentType: typeKey }} locale={active} />
                <Section title="Tối ưu SEO" description={`Cho bản ${langName(active)}`}>
                  <SeoPanel value={tr} onChange={updateTr} title={tr.title} slug={tr.slug} content={tr.content || blocksToText(tr.blocks)} url={publicUrl || `${slugPrefix}${tr.slug}`} hasImage={!!form.featuredImageId} />
                </Section>
              </>
            )}
          </div>

          <div className="space-y-6">
            <Section title="Xuất bản" actions={<StatusBadge status={scheduled ? 'SCHEDULED' : form.status} />}>
              {publishFields}
            </Section>
            {supports('featuredImage') && (
              <Section title="Ảnh đại diện">
                <ImageIdField value={form.featuredImageId} initial={entry.data?.featuredImage} onChange={(fid) => update({ featuredImageId: fid })} />
              </Section>
            )}
            {termPickers('section')}
            <CustomFieldsPanel entity="entry" placement="sidebar" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ contentType: typeKey }} locale={active} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

/** Tab SEO trong Page Builder: phân tích theo chữ trong block đang dựng */
function BuilderSeo({ tr, onChange, url, hasImage }: { tr: EntryTranslation; onChange: (p: Partial<EntryTranslation>) => void; url: string; hasImage: boolean }) {
  const blocks = useBuilder((s) => s.blocks);
  return <SeoPanel value={tr} onChange={onChange} title={tr.title} slug={tr.slug} content={blocksToText(blocks)} url={url} hasImage={hasImage} />;
}

/** Nội dung một phiên bản cũ trong hộp thoại lịch sử */
function RevisionPreview({ d }: { d: EntryRevisionDetail }) {
  const blocks = Array.isArray(d.blocks) ? d.blocks : [];
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs uppercase text-muted-foreground">Tiêu đề</p>
        <p className="font-semibold">{d.title}</p>
      </div>
      {d.excerpt && (
        <div>
          <p className="text-xs uppercase text-muted-foreground">Mô tả ngắn</p>
          <p className="text-sm">{d.excerpt}</p>
        </div>
      )}
      {d.content && (
        <div>
          <p className="text-xs uppercase text-muted-foreground">Nội dung</p>
          {/* nội dung phiên bản cũ có thể chứa HTML chưa lọc -> làm sạch (DOMPurify) trước khi chèn vào trang quản trị */}
          <div className="prose prose-sm max-w-none rounded-md border bg-background p-3 dark:prose-invert" dangerouslySetInnerHTML={{ __html: sanitizeForEditor(d.content) }} />
        </div>
      )}
      {blocks.length > 0 && (
        <div>
          <p className="text-xs uppercase text-muted-foreground">Block ({blocks.length})</p>
          <ol className="mt-1 max-h-60 space-y-1 overflow-y-auto text-sm">
            {blocks.map((b, i) => (
              <li key={b.id ?? i} className="flex items-center gap-2 rounded-md border px-2 py-1">
                <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="font-mono text-xs">{b.type}</span>
                <span className="truncate text-xs text-muted-foreground">{blocksToText([b]).slice(0, 80)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
