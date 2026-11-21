'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { slugify } from '@cmsnt/shared';
import type { BlockNode } from '@cmsnt/blocks';
import { PageBuilder } from '@/components/builder/page-builder';
import { useBuilder, useBuilderSession } from '@/components/builder/store';
import { Field } from '@/components/common/field';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { TranslationGate } from '@/components/common/translation-gate';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import { useEditLock } from '@/hooks/use-edit-lock';
import { EditLockBanner } from '@/components/common/edit-lock-banner';

interface GlobalBlockDetail {
  id: string;
  name: string;
  key: string;
  type: string;
  isActive: boolean;
  translations: { locale: string; blocks: BlockNode[] }[];
}

export default function GlobalBlockEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';
  // khoá chỉnh sửa đồng thời: người khác đang sửa -> chỉ đọc
  const lock = useEditLock('global_block', isNew ? null : id);
  const router = useRouter();
  const qc = useQueryClient();
  const { languages, defaultLocale } = useLanguages();
  const [locale, setLocale] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ name: string; key: string; isActive: boolean } | null>(null);
  const [byLocale, setByLocale] = useState<Record<string, BlockNode[]>>({});
  const [dirty, setDirty] = useState(false);
  const loadedRef = useRef<string | null>(null);
  /** đếm số lần sửa ngoài canvas (tên, key...) để biết có thay đổi trong lúc đang lưu không */
  const editsRef = useRef(0);
  const version = useBuilder((s) => s.version);
  const active = locale ?? defaultLocale;
  useBuilderSession();

  const block = useQuery({ queryKey: ['global-block', id], queryFn: () => api.get<GlobalBlockDetail>(`/admin/blocks/${id}`), enabled: !isNew });

  useEffect(() => {
    if (meta) return;
    if (isNew && languages.length) {
      setMeta({ name: 'Block mới', key: '', isActive: true });
      setByLocale({ [defaultLocale]: [] });
      useBuilder.getState().load([]);
      loadedRef.current = defaultLocale;
    } else if (block.data && languages.length) {
      const b = block.data;
      setMeta({ name: b.name, key: b.key, isActive: b.isActive });
      const map = Object.fromEntries(b.translations.map((t) => [t.locale, Array.isArray(t.blocks) ? t.blocks : []]));
      setByLocale(map);
      const first = map[active] ? active : (Object.keys(map)[0] ?? defaultLocale);
      if (first !== active) setLocale(first);
      useBuilder.getState().load(map[first] ?? []);
      loadedRef.current = first;
    }
  }, [isNew, languages.length, block.data, defaultLocale, meta, active]);

  useEffect(() => {
    if (version > 0) setDirty(true);
  }, [version]);

  const switchLocale = (code: string) => {
    const prev = loadedRef.current;
    const current = useBuilder.getState().blocks;
    if (useBuilder.getState().version > 0) {
      editsRef.current++;
      setDirty(true);
    }
    setByLocale((m) => (prev && m[prev] ? { ...m, [prev]: current } : m));
    useBuilder.getState().load(byLocale[code] ?? []);
    loadedRef.current = byLocale[code] ? code : null;
    setLocale(code);
  };

  const markDirty = () => {
    editsRef.current++;
    setDirty(true);
  };

  const save = useMutation({
    // chụp lại "phiên bản" lúc bắt đầu lưu -> chỉ xoá cờ chưa lưu nếu không có thay đổi mới trong lúc lưu
    onMutate: () => ({ edits: editsRef.current, version: useBuilder.getState().version }),
    mutationFn: async () => {
      if (!meta) throw new Error('Chưa sẵn sàng');
      lock.assertWritable();
      const all = { ...byLocale };
      if (loadedRef.current) all[loadedRef.current] = useBuilder.getState().blocks;
      const body = {
        name: meta.name,
        key: meta.key || slugify(meta.name),
        isActive: meta.isActive,
        type: 'section',
        translations: Object.entries(all).map(([loc, blocks]) => ({ locale: loc, blocks: blocks.map(({ resolved: _r, ...b }) => b) })),
      };
      return isNew ? api.post<GlobalBlockDetail>('/admin/blocks', body) : api.patch<GlobalBlockDetail>(`/admin/blocks/${id}`, body);
    },
    onSuccess: (data, _vars, snap) => {
      toast.success('Đã lưu block');
      if (snap && snap.edits === editsRef.current && snap.version === useBuilder.getState().version) {
        setDirty(false);
        useBuilder.setState({ version: 0 });
      }
      // cập nhật cache để mở lại editor không thấy bản cũ (và không ghi đè bằng bản cũ)
      qc.setQueryData(['global-block', data.id], data);
      void qc.invalidateQueries({ queryKey: ['global-blocks'] });
      setMeta((m) => (m ? { ...m, key: data.key } : m));
      if (isNew) router.replace(`/blocks/${data.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const doSave = useCallback(() => {
    if (!save.isPending) save.mutate();
  }, [save]);
  useUnsavedGuard(dirty, doSave);

  if (!meta || (!isNew && block.isLoading)) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasLocale = !!byLocale[active];
  // global block của vùng widget (key "area-<vùng>"): quay về trang Vùng widget và đổi tiêu đề
  const isArea = (block.data?.key ?? meta.key).startsWith('area-');

  return (
    <PageBuilder
      locale={active}
      header={
        <>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href={isArea ? '/widget-areas' : '/blocks'} title={isArea ? 'Về Vùng widget' : 'Quay lại'}>
              <ArrowLeft />
            </Link>
          </Button>
          <span className="truncate text-sm font-semibold">{isArea && !/^vùng widget/i.test(meta.name) ? `Vùng widget: ${meta.name}` : meta.name}</span>
          <code className="hidden rounded bg-muted px-1.5 py-0.5 text-xs sm:inline">{meta.key || 'chưa có key'}</code>
          {dirty && <span className="size-2 rounded-full bg-amber-500" title="Có thay đổi chưa lưu" />}
          <LocaleTabs languages={languages} value={active} onChange={switchLocale} has={(c) => !!byLocale[c]} className="ml-2" />
        </>
      }
      actions={
        <>
          <EditLockBanner lock={lock} variant="inline" />
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
          label: 'Cài đặt',
          content: (
            <div className="space-y-4">
              <Field label="Tên block" required>
                <Input
                  value={meta.name}
                  onChange={(e) => {
                    setMeta({ ...meta, name: e.target.value, key: isNew && !meta.key ? '' : meta.key });
                    markDirty();
                  }}
                />
              </Field>
              <Field label="Key" help="Dùng để nhúng block (chữ thường, số, dấu -). Vd: site-footer">
                <Input
                  value={meta.key}
                  placeholder={slugify(meta.name)}
                  onChange={(e) => {
                    setMeta({ ...meta, key: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '') });
                    markDirty();
                  }}
                  className="font-mono"
                />
              </Field>
              <div className="flex items-center justify-between">
                <Label>Đang sử dụng</Label>
                <Switch
                  checked={meta.isActive}
                  onCheckedChange={(v) => {
                    setMeta({ ...meta, isActive: v });
                    markDirty();
                  }}
                />
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}
