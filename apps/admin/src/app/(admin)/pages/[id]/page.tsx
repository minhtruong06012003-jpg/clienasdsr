'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, History, Home, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { BlockNode } from '@cmsnt/blocks';
import { PageBuilder } from '@/components/builder/page-builder';
import { CustomFieldsPanel, useHasFieldGroups } from '@/components/custom-fields/custom-fields-panel';
import { blocksToText, useBuilder, useBuilderSession } from '@/components/builder/store';
import { RevisionsDialog } from '@/components/common/revisions-dialog';
import { PreviewButton } from '@/components/common/preview-button';
import { AutosaveToggle } from '@/components/common/autosave-toggle';
import { Field } from '@/components/common/field';
import { AsyncCombobox, COMBOBOX_LIMIT } from '@/components/common/async-combobox';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { SlugInput } from '@/components/common/slug-input';
import { TranslationGate } from '@/components/common/translation-gate';
import { StatusBadge } from '@/components/common/status-badge';
import { SeoPanel } from '@/components/seo/seo-panel';
import { ImageIdField } from '@/components/media/media-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage, type Paginated } from '@/lib/api';
import { formatDate, pickTr } from '@/lib/format';
import { effectiveStatus, isFutureDate } from '@/lib/publish';
import { siteUrl } from '@/lib/site';
import { useAuth } from '@/lib/auth';
import type { ContentStatus, SeoFields } from '@/lib/types';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useEditLock } from '@/hooks/use-edit-lock';
import { EditLockBanner } from '@/components/common/edit-lock-banner';
import { useAutosave } from '@/hooks/use-autosave';

interface PageTranslation extends SeoFields {
  locale: string;
  title: string;
  slug: string;
  excerpt: string | null;
  blocks: BlockNode[];
}

/** Trang dùng làm lựa chọn "Trang cha" (chỉ cần id + tiêu đề các ngôn ngữ) */
interface ParentOption {
  id: string;
  translations: { locale: string; title: string }[];
}

interface PageDetail {
  id: string;
  status: ContentStatus;
  template: string;
  parentId: string | null;
  featuredImageId: string | null;
  featuredImage: { id: string; url: string; urls: Record<string, string> } | null;
  publishedAt: string | null;
  isHomepage: boolean;
  customFields?: Record<string, unknown>;
  translations: PageTranslation[];
}

interface PageRevisionDetail {
  id: string;
  locale: string;
  title: string;
  blocks: BlockNode[];
  createdAt: string;
}

interface Meta {
  status: ContentStatus;
  template: string;
  parentId: string | null;
  featuredImageId: string | null;
  publishedAt: string;
  customFields: Record<string, unknown>;
}

const emptyTr = (locale: string): PageTranslation => ({ locale, title: '', slug: '', excerpt: '', blocks: [], seoTitle: '', seoDescription: '', seoKeywords: '', canonicalUrl: '', noindex: false, nofollow: false, ogImageId: null, schemaJson: null });
const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const stripResolved = (blocks: BlockNode[]) => blocks.map(({ resolved: _r, ...b }) => b);
/** Bản dịch hoàn toàn trống (tạo ra nhưng chưa nhập gì) */
const isBlankTr = (t: PageTranslation) =>
  !t.title.trim() && !t.slug.trim() && !(t.excerpt ?? '').trim() && !t.blocks.length && !(t.seoTitle ?? '').trim() && !(t.seoDescription ?? '').trim() && !(t.seoKeywords ?? '').trim() && !(t.canonicalUrl ?? '').trim() && !t.ogImageId && !t.schemaJson;

function SeoTab({ tr, onChange, url, hasImage }: { tr: PageTranslation; onChange: (p: Partial<PageTranslation>) => void; url: string; hasImage: boolean }) {
  const blocks = useBuilder((s) => s.blocks);
  return <SeoPanel value={tr} onChange={onChange} title={tr.title} slug={tr.slug} content={blocksToText(blocks)} url={url} hasImage={hasImage} />;
}

export default function PageEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';
  // khoá chỉnh sửa đồng thời: người khác đang sửa -> chỉ đọc
  const lock = useEditLock('page', isNew ? null : id);
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { languages, defaultLocale } = useLanguages();
  const [locale, setLocale] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [translations, setTranslations] = useState<Record<string, PageTranslation>>({});
  const [dirty, setDirty] = useState(false);
  const loadedRef = useRef<string | null>(null);
  /** đếm số lần sửa ngoài canvas để biết có thay đổi trong lúc đang lưu không */
  const editsRef = useRef(0);
  const version = useBuilder((s) => s.version);
  const active = locale ?? defaultLocale;
  useBuilderSession();
  // có nhóm trường tuỳ chỉnh nào áp dụng cho trang (theo bố cục) không -> hiện tab "Trường"
  const hasFieldGroups = useHasFieldGroups('page', { template: meta?.template ?? 'default' });

  const page = useQuery({ queryKey: ['page', id], queryFn: () => api.get<PageDetail>(`/admin/pages/${id}`), enabled: !isNew });

  // nạp dữ liệu ban đầu
  useEffect(() => {
    if (meta) return;
    if (isNew && languages.length) {
      setMeta({ status: 'DRAFT', template: 'default', parentId: null, featuredImageId: null, publishedAt: '', customFields: {} });
      setTranslations({ [defaultLocale]: { ...emptyTr(defaultLocale), title: 'Trang mới' } });
      useBuilder.getState().load([]);
      loadedRef.current = defaultLocale;
    } else if (page.data && languages.length) {
      const p = page.data;
      setMeta({ status: p.status, template: p.template, parentId: p.parentId, featuredImageId: p.featuredImageId, publishedAt: toLocalInput(p.publishedAt), customFields: p.customFields ?? {} });
      const trs = Object.fromEntries(p.translations.map((t) => [t.locale, { ...emptyTr(t.locale), ...t, blocks: Array.isArray(t.blocks) ? t.blocks : [] }]));
      setTranslations(trs);
      const first = trs[active] ? active : Object.keys(trs)[0];
      if (first !== active) setLocale(first);
      useBuilder.getState().load(trs[first]?.blocks ?? []);
      loadedRef.current = first;
    }
  }, [isNew, languages.length, page.data, defaultLocale, meta, active]);

  // đổi ngôn ngữ: cất block của ngôn ngữ cũ, nạp block ngôn ngữ mới
  const switchLocale = (code: string) => {
    const prev = loadedRef.current;
    const current = useBuilder.getState().blocks;
    setTranslations((t) => (prev && t[prev] ? { ...t, [prev]: { ...t[prev], blocks: current } } : t));
    if (useBuilder.getState().version > 0) {
      editsRef.current++;
      setDirty(true);
    }
    useBuilder.getState().load(translations[code]?.blocks ?? []);
    loadedRef.current = code;
    setLocale(code);
  };

  useEffect(() => {
    if (version > 0) setDirty(true);
  }, [version]);

  const tr = translations[active];
  const langName = (code: string) => languages.find((l) => l.code === code)?.name ?? code;
  const updateTr = (patch: Partial<PageTranslation>) => {
    setTranslations((t) => ({ ...t, [active]: { ...t[active], ...patch } }));
    editsRef.current++;
    setDirty(true);
  };
  const updateMeta = (patch: Partial<Meta>) => {
    setMeta((m) => (m ? { ...m, ...patch } : m));
    editsRef.current++;
    setDirty(true);
  };

  const save = useMutation({
    // chụp lại "phiên bản" lúc bắt đầu lưu -> chỉ xoá cờ chưa lưu nếu không có thay đổi mới trong lúc lưu
    onMutate: () => ({ edits: editsRef.current, version: useBuilder.getState().version }),
    mutationFn: async ({ status, auto }: { status?: ContentStatus; auto?: boolean }) => {
      if (!meta) throw new Error('Chưa sẵn sàng');
      lock.assertWritable();
      const all = { ...translations };
      if (loadedRef.current && all[loadedRef.current]) all[loadedRef.current] = { ...all[loadedRef.current], blocks: useBuilder.getState().blocks };
      // bản dịch thiếu tiêu đề: chặn lưu (trừ bản hoàn toàn trống chưa nhập gì -> bỏ qua và báo rõ)
      const skipped: string[] = [];
      const list: PageTranslation[] = [];
      for (const t of Object.values(all)) {
        if (t.title.trim()) list.push(t);
        else if (isBlankTr(t)) skipped.push(t.locale);
        else throw new Error(`Bản ${langName(t.locale)} thiếu tiêu đề`);
      }
      if (!list.length) throw new Error('Vui lòng nhập tiêu đề trang');
      if (skipped.length && !auto) toast.info(`Bỏ qua bản ${skipped.map(langName).join(', ')} vì còn trống`);
      const body = {
        // tự lưu: giữ nguyên trạng thái nháp; chọn Xuất bản mà ngày đăng ở tương lai -> hẹn giờ
        status: auto ? 'DRAFT' : effectiveStatus(status ?? meta.status, meta.publishedAt),
        template: meta.template,
        parentId: meta.parentId,
        featuredImageId: meta.featuredImageId,
        customFields: meta.customFields,
        // để trống -> không gửi, API tự đặt ngày khi xuất bản
        publishedAt: meta.publishedAt ? new Date(meta.publishedAt).toISOString() : undefined,
        translations: list.map((t) => ({ ...t, blocks: stripResolved(t.blocks), excerpt: t.excerpt || null })),
      };
      return isNew ? api.post<PageDetail>('/admin/pages', body) : api.patch<PageDetail>(`/admin/pages/${id}`, body);
    },
    onSuccess: (data, vars, snap) => {
      if (vars.auto) {
        autosave.markSaved();
        toast.info(`Đã tự lưu lúc ${formatDate(new Date(), 'HH:mm')}`, { id: 'autosave', duration: 2500 });
      } else toast.success('Đã lưu trang');
      const unchanged = !!snap && snap.edits === editsRef.current && snap.version === useBuilder.getState().version;
      if (unchanged) setDirty(false);
      void qc.invalidateQueries({ queryKey: ['pages'] });
      void qc.invalidateQueries({ queryKey: ['pages-revisions', data.id] });
      qc.setQueryData(['page', data.id], data);
      if (isNew) {
        router.replace(`/pages/${data.id}`);
      } else {
        setMeta((m) => (m ? { ...m, status: data.status, publishedAt: m.publishedAt || toLocalInput(data.publishedAt) } : m));
        setTranslations((t) => {
          const next = { ...t };
          for (const d of data.translations) if (next[d.locale]) next[d.locale] = { ...next[d.locale], slug: d.slug };
          return next;
        });
        if (unchanged) useBuilder.setState({ version: 0 });
      }
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

  // Tự động lưu bản nháp (đã có id, đang DRAFT) sau 30 giây không thao tác (cả block trên canvas lẫn cài đặt)
  const autosaveSignal = useMemo(() => ({ translations, meta, version }), [translations, meta, version]);
  const autosave = useAutosave({
    active: !isNew && meta?.status === 'DRAFT' && can('pages.write') && !lock.readOnly,
    dirty,
    signal: autosaveSignal,
    onSave: () => {
      if (!save.isPending) save.mutate({ auto: true });
    },
  });

  if (!meta || (!isNew && page.isLoading)) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isHomepage = !!page.data?.isHomepage;
  const publicUrl = tr?.slug ? (isHomepage ? siteUrl('home', null, active, defaultLocale) : siteUrl('page', tr.slug, active, defaultLocale)) : '';
  const scheduled = (meta.status === 'PUBLISHED' || meta.status === 'SCHEDULED') && isFutureDate(meta.publishedAt);
  /** Lưu nháp để lấy id (xem trước trang mới) */
  const ensureId = async () => {
    if (!isNew) return id;
    const data = await save.mutateAsync({ status: 'DRAFT' });
    return data.id;
  };
  /** Sau khi khôi phục phiên bản ở server: nạp block mới vào state + canvas (không mất chỉnh sửa ở ngôn ngữ khác) */
  const onRestored = (data: PageDetail) => {
    qc.setQueryData(['page', id], data);
    setTranslations((t) => {
      const next = { ...t };
      for (const d of data.translations) if (next[d.locale]) next[d.locale] = { ...next[d.locale], blocks: Array.isArray(d.blocks) ? d.blocks : [] };
      return next;
    });
    const current = data.translations.find((d) => d.locale === loadedRef.current);
    if (current) useBuilder.getState().load(Array.isArray(current.blocks) ? current.blocks : []);
  };
  const createTranslation = (copy: boolean) => {
    const srcLocale = translations[defaultLocale] ? defaultLocale : Object.keys(translations)[0];
    const src = srcLocale === loadedRef.current ? { ...translations[srcLocale], blocks: useBuilder.getState().blocks } : translations[srcLocale];
    const next: PageTranslation = copy && src ? { ...structuredClone(src), locale: active, slug: '' } : emptyTr(active);
    setTranslations((t) => ({ ...t, [active]: next }));
    useBuilder.getState().load(next.blocks);
    loadedRef.current = active;
    editsRef.current++;
    setDirty(true);
  };

  const settingsPanel = tr && (
    <div className="space-y-4">
      <Field label="Tiêu đề trang" required>
        <Input value={tr.title} onChange={(e) => updateTr({ title: e.target.value })} />
      </Field>
      <Field label="Đường dẫn" help={isHomepage ? 'Trang chủ hiển thị tại /' : 'Để trống sẽ tự tạo từ tiêu đề'}>
        <SlugInput value={tr.slug} onChange={(slug) => updateTr({ slug })} source={tr.title} prefix={`/${active !== defaultLocale ? `${active}/` : ''}`} />
      </Field>
      <Field label="Trạng thái" help={scheduled ? `Sẽ tự xuất bản lúc ${formatDate(new Date(meta.publishedAt))}` : undefined}>
        <Select value={meta.status === 'SCHEDULED' ? 'PUBLISHED' : meta.status} onValueChange={(v) => updateMeta({ status: v as ContentStatus })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DRAFT">Bản nháp</SelectItem>
            {can('pages.publish') && <SelectItem value="PUBLISHED">{scheduled ? 'Hẹn giờ xuất bản' : 'Đã xuất bản'}</SelectItem>}
            <SelectItem value="ARCHIVED">Lưu trữ</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Ngày xuất bản"
        help="Đặt ngày tương lai để hẹn giờ"
        action={
          meta.publishedAt ? (
            <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => updateMeta({ publishedAt: '' })}>
              Xoá ngày
            </button>
          ) : undefined
        }
      >
        <Input type="datetime-local" value={meta.publishedAt} onChange={(e) => updateMeta({ publishedAt: e.target.value })} />
      </Field>
      {!isNew && can('pages.write') && <AutosaveToggle enabled={autosave.enabled} onChange={autosave.setEnabled} lastSavedAt={autosave.lastSavedAt} />}
      <Field label="Bố cục" help="Landing: ẩn header/footer của website">
        <Select value={meta.template} onValueChange={(v) => updateMeta({ template: v })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Mặc định (có header/footer)</SelectItem>
            <SelectItem value="landing">Landing page (không header/footer)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Trang cha">
        {/* tìm trang cha phía server (không giới hạn 200 trang như ô chọn nạp sẵn) */}
        <AsyncCombobox<ParentOption>
          value={meta.parentId}
          onChange={(parentId) => updateMeta({ parentId })}
          queryKey={['pages', 'parent-options']}
          fetchOptions={(search) => api.get<Paginated<ParentOption>>('/admin/pages', { search: search || undefined, limit: COMBOBOX_LIMIT }).then((r) => r.data)}
          fetchSelected={(pid) => api.get<ParentOption>(`/admin/pages/${pid}`)}
          getValue={(p) => p.id}
          getLabel={(p) => pickTr(p.translations, active)?.title || '(không tiêu đề)'}
          filterOption={(p) => p.id !== id}
          noneLabel="— Không có —"
          searchPlaceholder="Tìm trang theo tiêu đề, slug…"
        />
      </Field>
      <Field label="Mô tả ngắn">
        <Textarea value={tr.excerpt ?? ''} onChange={(e) => updateTr({ excerpt: e.target.value })} rows={3} />
      </Field>
      <Field label="Ảnh đại diện" help="Dùng cho chia sẻ mạng xã hội khi chưa đặt ảnh OG">
        <ImageIdField value={meta.featuredImageId} initial={page.data?.featuredImage} onChange={(fid) => updateMeta({ featuredImageId: fid })} />
      </Field>
      {!isNew && !isHomepage && can(['pages.publish', 'settings.manage']) && (
        <Button
          variant="outline"
          className="w-full"
          onClick={async () => {
            try {
              await api.post(`/admin/pages/${id}/set-homepage`);
              toast.success('Đã đặt làm trang chủ');
              void qc.invalidateQueries({ queryKey: ['page', id] });
              void qc.invalidateQueries({ queryKey: ['pages'] });
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        >
          <Home /> Đặt làm trang chủ
        </Button>
      )}
    </div>
  );

  return (
    <PageBuilder
      locale={active}
      header={
        <>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href="/pages" title="Quay lại danh sách">
              <ArrowLeft />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{tr?.title || 'Trang mới'}</span>
              <StatusBadge status={scheduled ? 'SCHEDULED' : meta.status} />
              {isHomepage && <Badge variant="secondary">Trang chủ</Badge>}
              {dirty && <span className="size-2 rounded-full bg-amber-500" title="Có thay đổi chưa lưu" />}
            </div>
          </div>
          <LocaleTabs languages={languages} value={active} onChange={switchLocale} has={(c) => !!translations[c]} className="ml-2" />
        </>
      }
      actions={
        <>
          <EditLockBanner lock={lock} variant="inline" />
          {!isNew && (
            <RevisionsDialog<PageRevisionDetail, PageDetail>
              resource="pages"
              id={id}
              locale={active}
              canRestore={can('pages.write')}
              onRestored={onRestored}
              renderPreview={(d) => <RevisionPreview d={d} />}
              trigger={
                <Button variant="ghost" size="icon-sm" title="Lịch sử phiên bản">
                  <History />
                </Button>
              }
            />
          )}
          <PreviewButton type="page" id={isNew ? null : id} locale={active} ensureId={can('pages.write') ? ensureId : undefined} variant="ghost" />
          {publicUrl && meta.status === 'PUBLISHED' && (
            <Button variant="ghost" size="sm" asChild>
              <a href={publicUrl} target="_blank" rel="noreferrer">
                <ExternalLink /> Xem
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => save.mutate({ status: 'DRAFT' })} disabled={save.isPending}>
            Lưu nháp
          </Button>
          {can('pages.publish') && (
            <Button size="sm" onClick={() => save.mutate({ status: 'PUBLISHED' })} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
              {scheduled ? 'Hẹn giờ đăng' : meta.status === 'PUBLISHED' ? 'Cập nhật' : 'Xuất bản'}
            </Button>
          )}
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
              { key: 'page', label: 'Trang', content: settingsPanel },
              { key: 'seo', label: 'SEO', content: <SeoTab tr={tr} onChange={updateTr} url={publicUrl || `/${tr.slug}`} hasImage={!!meta.featuredImageId} /> },
              // tab Trường tuỳ chỉnh chỉ hiện khi có nhóm áp dụng cho bố cục này
              ...(hasFieldGroups
                ? [
                    {
                      key: 'fields',
                      label: 'Trường',
                      content: (
                        <div className="space-y-6">
                          <CustomFieldsPanel entity="page" variant="plain" value={meta.customFields} onChange={(customFields) => updateMeta({ customFields })} context={{ template: meta.template }} locale={active} />
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

/** Tóm tắt block của một phiên bản trang trong hộp thoại lịch sử */
function RevisionPreview({ d }: { d: PageRevisionDetail }) {
  const blocks = Array.isArray(d.blocks) ? d.blocks : [];
  const count = (list: BlockNode[]): number => list.reduce((n, b) => n + 1 + count(((b as { children?: BlockNode[] }).children ?? []) as BlockNode[]), 0);
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs uppercase text-muted-foreground">Tiêu đề</p>
        <p className="font-semibold">{d.title}</p>
      </div>
      <div>
        <p className="text-xs uppercase text-muted-foreground">
          Block ({blocks.length} cấp 1 · {count(blocks)} tổng)
        </p>
        <ol className="mt-1 max-h-72 space-y-1 overflow-y-auto text-sm">
          {blocks.map((b, i) => (
            <li key={b.id ?? i} className="flex items-center gap-2 rounded-md border px-2 py-1">
              <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="font-mono text-xs">{b.type}</span>
              <span className="truncate text-xs text-muted-foreground">{blocksToText([b]).slice(0, 80)}</span>
            </li>
          ))}
          {blocks.length === 0 && <li className="text-sm text-muted-foreground">Trang trống (không có block)</li>}
        </ol>
      </div>
    </div>
  );
}
