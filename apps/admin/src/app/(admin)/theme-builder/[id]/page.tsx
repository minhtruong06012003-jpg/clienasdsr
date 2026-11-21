'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Database, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { BlockNode } from '@cmsnt/blocks';
import { TEMPLATE_KINDS, TEMPLATE_KIND_LABELS, type TemplateConditions, type TemplateKind, type TemplateListing, type TemplateRecord, type ThemeTemplateView } from '@cmsnt/shared';
import { PageBuilder } from '@/components/builder/page-builder';
import type { BuilderEnv } from '@/components/builder/builder-context';
import { useBuilder, useBuilderSession } from '@/components/builder/store';
import { Field } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { TranslationGate } from '@/components/common/translation-gate';
import { RecordPicker } from '@/components/theme-builder/record-picker';
import { targetHasRecords } from '@/components/theme-builder/records';
import { ConditionsEditor, TargetSelect, targetLabel, useTemplateTargets } from '@/components/theme-builder/template-settings';
import { TEMPLATE_KIND_HINTS } from '@/components/theme-builder/create-template-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, errorMessage } from '@/lib/api';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useEditLock } from '@/hooks/use-edit-lock';
import { EditLockBanner } from '@/components/common/edit-lock-banner';

interface Meta {
  name: string;
  kind: TemplateKind;
  target: string;
  conditions: TemplateConditions;
  priority: number;
  isActive: boolean;
}

/**
 * Trang lưu trữ blog / cửa hàng không có "bản ghi" để chọn — xem trước dùng danh sách hiện tại.
 * Mẫu áp "Toàn website" (header/footer) cho chọn đối tượng mẫu để xem block động.
 */
const previewNeedsRecord = (kind: TemplateKind, target: string) => targetHasRecords(target) && !(kind === 'archive' && (target === 'post' || target === 'product'));

/** Trình soạn mẫu Theme Builder: Page Builder đa ngôn ngữ + dữ liệu mẫu cho block động */
export default function ThemeTemplateEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // khoá chỉnh sửa đồng thời: người khác đang sửa -> chỉ đọc
  const lock = useEditLock('theme_template', id === 'new' ? null : id);
  const router = useRouter();
  const qc = useQueryClient();
  const { languages, defaultLocale } = useLanguages();
  const [locale, setLocale] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [byLocale, setByLocale] = useState<Record<string, BlockNode[]>>({});
  const [dirty, setDirty] = useState(false);
  /** dữ liệu xem trước: target mẫu (khi mẫu áp "*") + id bản ghi (null = mới nhất) */
  const [previewTarget, setPreviewTarget] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const loadedRef = useRef<string | null>(null);
  const editsRef = useRef(0);
  const version = useBuilder((s) => s.version);
  const active = locale ?? defaultLocale;
  useBuilderSession();

  // "new" không dùng ở đây: tạo mẫu qua hộp thoại ở danh sách
  useEffect(() => {
    if (id === 'new') router.replace('/theme-builder');
  }, [id, router]);

  const tpl = useQuery({ queryKey: ['theme-template', id], queryFn: () => api.get<ThemeTemplateView>(`/admin/theme-templates/${id}`), enabled: id !== 'new' });
  const allTargets = useTemplateTargets(null);

  useEffect(() => {
    if (meta || !tpl.data || !languages.length) return;
    const t = tpl.data;
    setMeta({ name: t.name, kind: t.kind, target: t.target, conditions: t.conditions ?? {}, priority: t.priority, isActive: t.isActive });
    const map = Object.fromEntries((t.translations ?? []).map((x) => [x.locale, Array.isArray(x.blocks) ? x.blocks : []]));
    // mẫu chưa có bản dịch nào -> tạo sẵn ngôn ngữ mặc định
    if (!Object.keys(map).length) map[defaultLocale] = [];
    setByLocale(map);
    const first = map[active] ? active : (Object.keys(map)[0] ?? defaultLocale);
    if (first !== active) setLocale(first);
    useBuilder.getState().load(map[first] ?? []);
    loadedRef.current = first;
  }, [tpl.data, languages.length, defaultLocale, meta, active]);

  useEffect(() => {
    if (version > 0) setDirty(true);
  }, [version]);

  const markDirty = () => {
    editsRef.current++;
    setDirty(true);
  };

  const patchMeta = (patch: Partial<Meta>) => {
    setMeta((m) => (m ? { ...m, ...patch } : m));
    markDirty();
  };

  const switchLocale = (code: string) => {
    const prev = loadedRef.current;
    const current = useBuilder.getState().blocks;
    if (useBuilder.getState().version > 0) markDirty();
    setByLocale((m) => (prev && m[prev] ? { ...m, [prev]: current } : m));
    useBuilder.getState().load(byLocale[code] ?? []);
    loadedRef.current = byLocale[code] ? code : null;
    setLocale(code);
  };

  // ---- dữ liệu xem trước ----
  const effTarget = meta ? (meta.target === '*' ? previewTarget : meta.target) : null;
  const needsRecord = !!meta && !!effTarget && previewNeedsRecord(meta.kind === 'header' || meta.kind === 'footer' ? 'single' : meta.kind, effTarget);
  const preview = useQuery({
    queryKey: ['theme-template-preview', effTarget, previewId, active],
    queryFn: () => api.post<{ record: TemplateRecord | null; listing: TemplateListing | null }>('/admin/theme-templates/preview-context', { target: effTarget, ...(previewId ? { id: previewId } : {}), locale: active }),
    enabled: !!effTarget,
    staleTime: 60_000,
    retry: false,
  });
  // không chọn bản ghi cụ thể -> API tự lấy bản ghi mới nhất của target (giống preview-context)
  const ctxId = previewId ?? undefined;
  const env = useMemo<BuilderEnv>(() => ({ isTemplate: true, context: effTarget ? { target: effTarget, id: ctxId } : undefined }), [effTarget, ctxId]);
  const previewInfo = preview.data?.record?.title ?? preview.data?.listing?.title ?? null;

  const save = useMutation({
    onMutate: () => ({ edits: editsRef.current, version: useBuilder.getState().version }),
    mutationFn: async () => {
      if (!meta) throw new Error('Chưa sẵn sàng');
      lock.assertWritable();
      if (!meta.name.trim()) throw new Error('Vui lòng nhập tên mẫu');
      const all = { ...byLocale };
      if (loadedRef.current) all[loadedRef.current] = useBuilder.getState().blocks;
      return api.put<ThemeTemplateView>(`/admin/theme-templates/${id}`, {
        ...meta,
        name: meta.name.trim(),
        translations: Object.entries(all).map(([loc, blocks]) => ({ locale: loc, blocks: blocks.map(({ resolved: _r, ...b }) => b) })),
      });
    },
    onSuccess: (data, _v, snap) => {
      toast.success('Đã lưu mẫu');
      if (snap && snap.edits === editsRef.current && snap.version === useBuilder.getState().version) {
        setDirty(false);
        useBuilder.setState({ version: 0 });
      }
      if (data?.id) qc.setQueryData(['theme-template', id], data);
      void qc.invalidateQueries({ queryKey: ['theme-templates'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate();
  }, [save]);
  useUnsavedGuard(dirty, doSave);

  if (tpl.isError) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Không tải được mẫu: {errorMessage(tpl.error)}</p>
        <Button variant="outline" size="sm" asChild>
          <Link href="/theme-builder">Về danh sách mẫu</Link>
        </Button>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasLocale = !!byLocale[active];

  return (
    <PageBuilder
      locale={active}
      env={env}
      header={
        <>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href="/theme-builder" title="Quay lại">
              <ArrowLeft />
            </Link>
          </Button>
          <span className="truncate text-sm font-semibold">{meta.name}</span>
          <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
            {TEMPLATE_KIND_LABELS[meta.kind]} · {targetLabel(allTargets.data, meta.target)}
          </Badge>
          {dirty && <span className="size-2 shrink-0 rounded-full bg-amber-500" title="Có thay đổi chưa lưu" />}
          <LocaleTabs languages={languages} value={active} onChange={switchLocale} has={(c) => !!byLocale[c]} className="ml-2" />
        </>
      }
      actions={
        <>
          <EditLockBanner lock={lock} variant="inline" />
          {/* Xem trước với dữ liệu: chọn bản ghi mẫu cho block động */}
          <div className="hidden items-center gap-1.5 xl:flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Database className="size-3.5" /> Dữ liệu:
                </span>
              </TooltipTrigger>
              <TooltipContent>{previewInfo ? `Đang xem trước với: ${previewInfo}` : 'Chọn bản ghi mẫu để xem block động hiển thị thế nào'}</TooltipContent>
            </Tooltip>
            {meta.target === '*' && (
              <Select
                value={previewTarget ?? undefined}
                onValueChange={(v) => {
                  setPreviewTarget(v);
                  setPreviewId(null);
                }}
              >
                <SelectTrigger size="sm" className="max-w-44">
                  <SelectValue placeholder="Chọn đối tượng mẫu" />
                </SelectTrigger>
                <SelectContent>
                  {allTargets.data
                    ?.filter((t) => t.value !== '*')
                    .map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
            {effTarget && needsRecord ? (
              <RecordPicker source={{ target: effTarget }} value={previewId} onChange={setPreviewId} locale={active} emptyLabel={preview.data?.record ? `Mới nhất: ${preview.data.record.title}` : 'Bản ghi mới nhất'} />
            ) : effTarget ? (
              <span className="max-w-48 truncate text-xs">{previewInfo ?? (preview.isLoading ? 'Đang tải...' : 'Danh sách hiện tại')}</span>
            ) : null}
          </div>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
          </Button>
        </>
      }
      overlay={
        !hasLocale ? (
          <div className="flex h-full items-center justify-center p-6">
            <TranslationGate
              language={languages.find((l) => l.code === active)}
              sourceLanguage={languages.find((l) => l.code !== active && byLocale[l.code])}
              onCreate={(copy) => {
                const src = Object.keys(byLocale).find((k) => k !== active);
                const srcBlocks = src ? (src === loadedRef.current ? useBuilder.getState().blocks : byLocale[src]) : [];
                const next = copy ? structuredClone(srcBlocks) : [];
                setByLocale((m) => ({ ...m, [active]: next }));
                useBuilder.getState().load(next);
                loadedRef.current = active;
                markDirty();
              }}
            />
          </div>
        ) : undefined
      }
      panels={[
        {
          key: 'settings',
          label: 'Cài đặt mẫu',
          content: (
            <div className="space-y-4">
              <Field label="Tên mẫu" required>
                <Input value={meta.name} onChange={(e) => patchMeta({ name: e.target.value })} />
              </Field>
              <Field label="Loại mẫu" help={TEMPLATE_KIND_HINTS[meta.kind]}>
                <Select value={meta.kind} onValueChange={(v) => patchMeta({ kind: v as TemplateKind, target: '', conditions: {} })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {TEMPLATE_KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Áp dụng cho" required>
                <TargetSelect
                  kind={meta.kind}
                  value={meta.target}
                  onChange={(target) => {
                    patchMeta({ target, conditions: {} });
                    setPreviewId(null);
                  }}
                />
              </Field>
              {meta.target && <ConditionsEditor kind={meta.kind} target={meta.target} value={meta.conditions} onChange={(conditions) => patchMeta({ conditions })} locale={active} />}
              <Field label="Ưu tiên" help="Nhiều mẫu cùng khớp: số lớn hơn được dùng">
                <Input type="number" value={meta.priority} onChange={(e) => patchMeta({ priority: Math.trunc(Number(e.target.value) || 0) })} className="max-w-32" />
              </Field>
              <div className="flex items-center justify-between">
                <Label>Đang bật</Label>
                <Switch checked={meta.isActive} onCheckedChange={(isActive) => patchMeta({ isActive })} />
              </div>
              {/* Xem trước trên màn hình nhỏ: thanh trên ẩn ô chọn dữ liệu */}
              {effTarget && needsRecord && (
                <Field label="Xem trước với dữ liệu" className="xl:hidden">
                  <RecordPicker source={{ target: effTarget }} value={previewId} onChange={setPreviewId} locale={active} className="w-full max-w-none" />
                </Field>
              )}
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                Dùng nhóm block <b>Dữ liệu động</b> (tiêu đề, nội dung, ảnh, trường tuỳ chỉnh, vòng lặp truy vấn...) để hiển thị dữ liệu của bản ghi đang xem. Canvas dùng bản ghi mẫu chọn ở
                thanh trên.
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}
