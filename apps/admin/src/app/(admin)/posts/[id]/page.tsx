'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, MessageSquare, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeForEditor } from '@cmsnt/blocks/sanitize';
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
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { SeoPanel } from '@/components/seo/seo-panel';
import { CustomFieldsPanel } from '@/components/custom-fields/custom-fields-panel';
import { ImageIdField } from '@/components/media/media-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, pickTr } from '@/lib/format';
import { effectiveStatus, isFutureDate, toLocalInput } from '@/lib/publish';
import { siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import type { ContentStatus, SeoFields } from '@/lib/types';
import { useLanguages } from '@/hooks/use-languages';
import { useDebounce } from '@/hooks/use-debounce';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useEditLock } from '@/hooks/use-edit-lock';
import { EditLockBanner } from '@/components/common/edit-lock-banner';
import { useAutosave } from '@/hooks/use-autosave';

interface PostTranslation extends SeoFields {
  locale: string;
  title: string;
  slug: string;
  excerpt: string | null;
  content: string;
}

interface PostDetail {
  id: string;
  status: ContentStatus;
  isFeatured: boolean;
  allowComments: boolean;
  publishedAt: string | null;
  updatedAt: string;
  featuredImageId: string | null;
  featuredImage: { id: string; url: string; urls: Record<string, string> } | null;
  authorId: string | null;
  author: { id: string; name: string } | null;
  commentCount?: number;
  categoryIds: string[];
  tagIds: string[];
  tags: { id: string; translations: { locale: string; name: string }[] }[];
  /** giá trị trường tuỳ chỉnh { key: value } */
  customFields?: Record<string, unknown>;
  translations: PostTranslation[];
}

interface FormState {
  status: ContentStatus;
  isFeatured: boolean;
  allowComments: boolean;
  publishedAt: string;
  featuredImageId: string | null;
  authorId: string | null;
  categoryIds: string[];
  tags: { id?: string; name: string }[];
  customFields: Record<string, unknown>;
  translations: Record<string, PostTranslation>;
}

interface PostRevisionDetail {
  id: string;
  locale: string;
  title: string;
  excerpt: string | null;
  content: string;
  createdAt: string;
}

const emptyTr = (locale: string): PostTranslation => ({ locale, title: '', slug: '', excerpt: '', content: '', seoTitle: '', seoDescription: '', seoKeywords: '', canonicalUrl: '', noindex: false, nofollow: false, ogImageId: null, schemaJson: null });

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
/** Bản dịch hoàn toàn trống (tạo ra nhưng chưa nhập gì) */
const isBlankTr = (t: PostTranslation) =>
  !t.title.trim() && !t.slug.trim() && !(t.excerpt ?? '').trim() && !stripHtml(t.content ?? '') && !/<img|<iframe|<video/i.test(t.content ?? '') && !(t.seoTitle ?? '').trim() && !(t.seoDescription ?? '').trim() && !(t.seoKeywords ?? '').trim() && !(t.canonicalUrl ?? '').trim() && !t.ogImageId && !t.schemaJson;

const fromDetail = (p: PostDetail, defaultLocale: string): FormState => ({
  status: p.status,
  isFeatured: p.isFeatured,
  allowComments: p.allowComments,
  publishedAt: toLocalInput(p.publishedAt),
  featuredImageId: p.featuredImageId,
  authorId: p.authorId ?? p.author?.id ?? null,
  categoryIds: p.categoryIds,
  tags: p.tags.map((t) => ({ id: t.id, name: pickTr(t.translations, defaultLocale)?.name ?? '' })),
  customFields: p.customFields ?? {},
  translations: Object.fromEntries(p.translations.map((t) => [t.locale, { ...emptyTr(t.locale), ...t }])),
});

export default function PostEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';
  // khoá chỉnh sửa đồng thời: người khác đang sửa -> chỉ đọc
  const lock = useEditLock('post', isNew ? null : id);
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { languages, defaultLocale } = useLanguages();
  const [locale, setLocale] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  /** đếm số lần sửa để biết có thay đổi trong lúc đang lưu không */
  const editsRef = useRef(0);
  const active = locale ?? defaultLocale;
  const canPublish = can('posts.publish');
  const langName = (code: string) => languages.find((l) => l.code === code)?.name ?? code;

  const post = useQuery({ queryKey: ['post', id], queryFn: () => api.get<PostDetail>(`/admin/posts/${id}`), enabled: !isNew });
  const categories = useQuery({ queryKey: ['post-categories'], queryFn: () => api.get<{ id: string; parentId: string | null; translations: { locale: string; name: string }[] }[]>('/admin/posts/categories') });
  // danh sách nhân sự để chọn tác giả (cần users.read; lỗi -> ẩn ô chọn)
  const staff = useQuery({ queryKey: ['users-staff'], queryFn: () => api.get<Paginated<{ id: string; name: string }>>('/admin/users', { type: 'staff', limit: 100 }), enabled: canPublish, retry: false, staleTime: 5 * 60_000 });

  // khởi tạo form
  useEffect(() => {
    if (form) return;
    if (isNew && languages.length) {
      setForm({ status: 'DRAFT', isFeatured: false, allowComments: true, publishedAt: '', featuredImageId: null, authorId: null, categoryIds: [], tags: [], customFields: {}, translations: { [defaultLocale]: emptyTr(defaultLocale) } });
    } else if (post.data) {
      setForm(fromDetail(post.data, defaultLocale));
    }
  }, [isNew, languages.length, post.data, defaultLocale, form]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    editsRef.current++;
    setDirty(true);
  };
  const updateTr = (patch: Partial<PostTranslation>) => {
    setForm((f) => (f ? { ...f, translations: { ...f.translations, [active]: { ...f.translations[active], ...patch } } } : f));
    editsRef.current++;
    setDirty(true);
  };

  const save = useMutation({
    // chụp lại "phiên bản" lúc bắt đầu lưu -> chỉ xoá cờ chưa lưu nếu không có thay đổi mới trong lúc lưu
    onMutate: () => ({ edits: editsRef.current }),
    mutationFn: async ({ status, auto }: { status?: ContentStatus; auto?: boolean }) => {
      if (!form) throw new Error('Chưa sẵn sàng');
      lock.assertWritable();
      // bản dịch thiếu tiêu đề: chặn lưu (trừ bản hoàn toàn trống chưa nhập gì -> bỏ qua và báo rõ)
      const skipped: string[] = [];
      const translations: PostTranslation[] = [];
      for (const t of Object.values(form.translations)) {
        if (t.title.trim()) translations.push(t);
        else if (isBlankTr(t)) skipped.push(t.locale);
        else throw new Error(`Bản ${langName(t.locale)} thiếu tiêu đề`);
      }
      if (!translations.length) throw new Error('Vui lòng nhập tiêu đề');
      if (skipped.length && !auto) toast.info(`Bỏ qua bản ${skipped.map(langName).join(', ')} vì còn trống`);
      const body = {
        // tự lưu: giữ nguyên trạng thái nháp; chọn Xuất bản mà ngày đăng ở tương lai -> hẹn giờ
        status: auto ? 'DRAFT' : effectiveStatus(status ?? form.status, form.publishedAt),
        isFeatured: form.isFeatured,
        allowComments: form.allowComments,
        // để trống -> không gửi, API tự đặt ngày khi xuất bản
        publishedAt: form.publishedAt ? new Date(form.publishedAt).toISOString() : undefined,
        featuredImageId: form.featuredImageId,
        // chỉ người có quyền xuất bản mới đổi được tác giả (API cũng kiểm tra)
        authorId: canPublish && form.authorId ? form.authorId : undefined,
        categoryIds: form.categoryIds,
        tagIds: form.tags.filter((t) => t.id).map((t) => t.id),
        newTags: form.tags.filter((t) => !t.id).map((t) => t.name),
        customFields: form.customFields,
        translations: translations.map((t) => ({ ...t, excerpt: t.excerpt || null })),
      };
      return isNew ? api.post<PostDetail>('/admin/posts', body) : api.patch<PostDetail>(`/admin/posts/${id}`, body);
    },
    onSuccess: (data, vars, snap) => {
      if (vars.auto) {
        autosave.markSaved();
        toast.info(`Đã tự lưu lúc ${formatDate(new Date(), 'HH:mm')}`, { id: 'autosave', duration: 2500 });
      } else toast.success('Đã lưu bài viết');
      if (snap && snap.edits === editsRef.current) setDirty(false);
      void qc.invalidateQueries({ queryKey: ['posts'] });
      void qc.invalidateQueries({ queryKey: ['posts-revisions', data.id] });
      qc.setQueryData(['post', data.id], data);
      if (isNew) {
        router.replace(`/posts/${data.id}`);
        return;
      }
      // chỉ cập nhật các trường do server chuẩn hoá (slug, trạng thái, ngày đăng, id thẻ mới) -> không mất chữ đang gõ
      setForm((f) => {
        if (!f) return f;
        const translations = { ...f.translations };
        for (const d of data.translations) if (translations[d.locale]) translations[d.locale] = { ...translations[d.locale], slug: d.slug };
        const savedTags = data.tags.map((t) => ({ id: t.id, name: pickTr(t.translations, defaultLocale)?.name ?? '' }));
        const tags = f.tags.map((t) => (t.id ? t : (savedTags.find((x) => x.name.trim().toLowerCase() === t.name.trim().toLowerCase()) ?? t)));
        return { ...f, status: data.status, publishedAt: f.publishedAt || toLocalInput(data.publishedAt), tags, translations };
      });
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

  // Tự động lưu bản nháp (chỉ bản ghi đã có id, đang DRAFT) sau 30 giây không gõ
  const autosave = useAutosave({
    active: !isNew && form?.status === 'DRAFT' && can('posts.write') && !lock.readOnly,
    dirty,
    signal: form,
    onSave: () => {
      if (!save.isPending) save.mutate({ auto: true });
    },
  });

  const tr = form?.translations[active];
  const [tagInput, setTagInput] = useState('');
  // gợi ý thẻ: tìm phía server theo từ khoá đang gõ (debounce) thay vì nạp sẵn 200 thẻ rồi lọc tại trình duyệt
  const tagTerm = useDebounce(tagInput.trim(), 300);
  const tagSearch = useQuery({
    queryKey: ['post-tags', 'suggest', tagTerm],
    queryFn: () => api.get<Paginated<{ id: string; translations: { locale: string; name: string }[] }>>('/admin/posts/tags', { search: tagTerm, limit: 20 }),
    enabled: !!tagTerm,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const tagSuggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    if (!q) return [];
    return (tagSearch.data?.data ?? [])
      .map((t) => ({ id: t.id, name: pickTr(t.translations, defaultLocale)?.name ?? '' }))
      .filter((t) => t.name.toLowerCase().includes(q) && !form?.tags.some((x) => x.id === t.id))
      .slice(0, 6);
  }, [tagInput, tagSearch.data, form?.tags, defaultLocale]);

  if (!form || (!isNew && post.isLoading)) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const publicUrl = tr?.slug ? siteUrl('post', tr.slug, active, defaultLocale) : '';
  const scheduled = (form.status === 'PUBLISHED' || form.status === 'SCHEDULED') && isFutureDate(form.publishedAt);
  const createTranslation = (copy: boolean) => {
    const src = form.translations[defaultLocale] ?? Object.values(form.translations)[0];
    updateTr(copy && src ? { ...src, locale: active, slug: '' } : emptyTr(active));
  };
  /** Lưu nháp để lấy id (xem trước bản ghi mới) */
  const ensureId = async () => {
    if (!isNew) return id;
    const data = await save.mutateAsync({ status: 'DRAFT' });
    return data.id;
  };
  /** Sau khi khôi phục phiên bản ở server: nạp lại form từ dữ liệu mới */
  const onRestored = (data: PostDetail) => {
    qc.setQueryData(['post', id], data);
    setForm(fromDetail(data, defaultLocale));
    setDirty(false);
  };
  const authorOptions = (() => {
    const list = staff.data?.data ?? [];
    const current = post.data?.author;
    return current && !list.some((u) => u.id === current.id) ? [current, ...list] : list;
  })();

  return (
    <>
      <PageHeader
        title={isNew ? 'Viết bài mới' : (pickTr(Object.values(form.translations), active)?.title || 'Chỉnh sửa bài viết')}
        breadcrumbs={[{ label: 'Bài viết', href: '/posts' }, { label: isNew ? 'Mới' : 'Chỉnh sửa' }]}
        actions={
          <>
            <LocaleTabs languages={languages} value={active} onChange={setLocale} has={(c) => !!form.translations[c]?.title} />
            {!isNew && <RevisionsDialog<PostRevisionDetail, PostDetail> resource="posts" id={id} locale={active} canRestore={can('posts.write')} onRestored={onRestored} renderPreview={(d) => <RevisionPreview d={d} />} />}
            {can('posts.read') && <PreviewButton type="post" id={isNew ? null : id} locale={active} ensureId={can('posts.write') ? ensureId : undefined} />}
            {!isNew && publicUrl && form.status === 'PUBLISHED' && (
              <Button variant="outline" size="sm" asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Xem
                </a>
              </Button>
            )}
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
                    <Input value={tr.title} onChange={(e) => updateTr({ title: e.target.value })} placeholder="Nhập tiêu đề bài viết" className="h-11 text-lg font-medium" autoFocus={isNew} />
                  </Field>
                  <Field label="Đường dẫn (slug)" help="Để trống sẽ tự tạo từ tiêu đề">
                    <SlugInput value={tr.slug} onChange={(slug) => updateTr({ slug })} source={tr.title} prefix={`/${active !== defaultLocale ? `${active}/` : ''}blog/`} />
                  </Field>
                  <Field label="Nội dung">
                    <RichTextEditor value={tr.content} onChange={(content) => updateTr({ content })} minHeight={420} />
                  </Field>
                  <Field label="Tóm tắt" help="Hiển thị ở danh sách bài viết. Để trống sẽ tự lấy từ nội dung.">
                    <Textarea value={tr.excerpt ?? ''} onChange={(e) => updateTr({ excerpt: e.target.value })} rows={3} />
                  </Field>
                </Section>
                {/* Trường tuỳ chỉnh (nhóm ở cột chính) — tự ẩn khi không có nhóm áp dụng */}
                <CustomFieldsPanel entity="post" placement="main" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ categoryIds: form.categoryIds }} locale={active} />
                <Section title="Tối ưu SEO" description={`Cho bản ${languages.find((l) => l.code === active)?.name ?? active}`}>
                  <SeoPanel value={tr} onChange={updateTr} title={tr.title} slug={tr.slug} content={tr.content} url={publicUrl || `.../blog/${tr.slug}`} hasImage={!!form.featuredImageId} />
                </Section>
              </>
            )}
          </div>

          <div className="space-y-6">
            <Section title="Xuất bản" actions={<StatusBadge status={scheduled ? 'SCHEDULED' : form.status} />}>
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
              {canPublish && (staff.data || post.data?.author) && (
                <Field label="Tác giả">
                  <Select value={form.authorId ?? '__none__'} onValueChange={(v) => update({ authorId: v === '__none__' ? null : v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Chọn tác giả" />
                    </SelectTrigger>
                    <SelectContent>
                      {!form.authorId && <SelectItem value="__none__">{isNew ? 'Tôi (người tạo)' : '— Chưa gán —'}</SelectItem>}
                      {authorOptions.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {!canPublish && post.data?.author && <p className="text-xs text-muted-foreground">Tác giả: {post.data.author.name}</p>}
              <div className="flex items-center justify-between">
                <Label>Bài viết nổi bật</Label>
                <Switch checked={form.isFeatured} onCheckedChange={(v) => update({ isFeatured: v })} />
              </div>
              <div className="flex items-center justify-between">
                <Label>Cho phép bình luận</Label>
                <Switch checked={form.allowComments} onCheckedChange={(v) => update({ allowComments: v })} />
              </div>
              {!isNew && post.data?.commentCount != null && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Số bình luận đã duyệt (chỉ đọc)">
                  <MessageSquare className="size-3.5" /> {post.data.commentCount.toLocaleString('vi-VN')} bình luận
                </p>
              )}
              {!isNew && <AutosaveToggle enabled={autosave.enabled} onChange={autosave.setEnabled} lastSavedAt={autosave.lastSavedAt} />}
              {!isNew && can('posts.delete') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-destructive"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Chuyển bài viết vào thùng rác?', description: 'Có thể khôi phục từ tab Thùng rác trong danh sách bài viết.', destructive: true }))) return;
                    try {
                      await api.post(`/admin/posts/${id}/trash`);
                      toast.success('Đã chuyển bài viết vào thùng rác');
                      setDirty(false);
                      void qc.invalidateQueries({ queryKey: ['posts'] });
                      router.push('/posts');
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  <Trash2 /> Chuyển vào thùng rác
                </Button>
              )}
            </Section>

            <Section title="Ảnh đại diện">
              <ImageIdField value={form.featuredImageId} initial={post.data?.featuredImage} onChange={(fid) => update({ featuredImageId: fid })} />
            </Section>

            <Section title="Chuyên mục" actions={<Link href="/posts/categories" className="text-xs text-primary">Quản lý</Link>}>
              <div className="max-h-56 space-y-2 overflow-y-auto">
                {categories.data?.length === 0 && <p className="text-sm text-muted-foreground">Chưa có chuyên mục</p>}
                {categories.data?.map((c) => (
                  <label key={c.id} className={`flex items-center gap-2 text-sm ${c.parentId ? 'pl-5' : ''}`}>
                    <Checkbox
                      checked={form.categoryIds.includes(c.id)}
                      onCheckedChange={(v) => update({ categoryIds: v ? [...form.categoryIds, c.id] : form.categoryIds.filter((x) => x !== c.id) })}
                    />
                    {pickTr(c.translations, defaultLocale)?.name}
                  </label>
                ))}
              </div>
            </Section>

            <Section title="Thẻ (tags)">
              <div className="flex flex-wrap gap-1.5">
                {form.tags.map((t, i) => (
                  <Badge key={t.id ?? t.name} variant="secondary" className="gap-1">
                    {t.name}
                    <button type="button" onClick={() => update({ tags: form.tags.filter((_, j) => j !== i) })} aria-label="Gỡ thẻ">
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="relative">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="Nhập thẻ rồi Enter"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && tagInput.trim()) {
                      e.preventDefault();
                      const exist = tagSuggestions.find((s) => s.name.toLowerCase() === tagInput.trim().toLowerCase());
                      update({ tags: [...form.tags, exist ?? { name: tagInput.trim() }] });
                      setTagInput('');
                    }
                  }}
                />
                {tagSuggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
                    {tagSuggestions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          update({ tags: [...form.tags, s] });
                          setTagInput('');
                        }}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Section>
            {/* Trường tuỳ chỉnh (nhóm ở cột phải) */}
            <CustomFieldsPanel entity="post" placement="sidebar" value={form.customFields} onChange={(customFields) => update({ customFields })} context={{ categoryIds: form.categoryIds }} locale={active} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

/** Nội dung một phiên bản cũ trong hộp thoại lịch sử */
function RevisionPreview({ d }: { d: PostRevisionDetail }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs uppercase text-muted-foreground">Tiêu đề</p>
        <p className="font-semibold">{d.title}</p>
      </div>
      {d.excerpt && (
        <div>
          <p className="text-xs uppercase text-muted-foreground">Tóm tắt</p>
          <p className="text-sm">{d.excerpt}</p>
        </div>
      )}
      <div>
        <p className="text-xs uppercase text-muted-foreground">Nội dung</p>
        {/* nội dung phiên bản cũ có thể chứa HTML chưa lọc -> làm sạch (DOMPurify) trước khi chèn vào trang quản trị */}
        <div className="prose prose-sm max-w-none rounded-md border bg-background p-3 dark:prose-invert" dangerouslySetInnerHTML={{ __html: sanitizeForEditor(d.content) }} />
      </div>
    </div>
  );
}
