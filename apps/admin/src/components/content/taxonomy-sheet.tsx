'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { CONTENT_KEY_RE, RESERVED_SLUGS, type ContentTypeView, type TaxonomyView, type TypeLabels } from '@cmsnt/shared';
import { Field } from '@/components/common/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api, errorMessage } from '@/lib/api';
import { useLanguages } from '@/hooks/use-languages';
import { typeLabel } from '@/hooks/use-content-types';
import { LabelsSlugsEditor, cleanLabels, validateLabels } from './labels-editor';

interface FormState {
  key: string;
  labels: TypeLabels;
  slugs: Record<string, string>;
  description: string;
  hierarchical: boolean;
  contentTypes: string[];
  isPublic: boolean;
  showInFilter: boolean;
  sortOrder: number;
}

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

/**
 * Sheet tạo / sửa taxonomy (phân loại tuỳ biến): nhãn + slug theo ngôn ngữ, dạng cây, gắn loại nội dung,
 * công khai (có trang lưu trữ /{slug}/{term}), hiện trong bộ lọc của website/frontend. Key không đổi sau khi tạo.
 */
export function TaxonomySheet({ editing, onClose, contentTypes, presetType, onSaved }: { editing: TaxonomyView | 'new' | null; onClose: () => void; contentTypes: ContentTypeView[]; presetType?: string; onSaved?: (t: TaxonomyView) => void }) {
  const qc = useQueryClient();
  const { languages, defaultLocale } = useLanguages();
  const [form, setForm] = useState<FormState | null>(null);
  const [keyTouched, setKeyTouched] = useState(false);
  const isNew = editing === 'new';

  useEffect(() => {
    if (!editing) return setForm(null);
    setKeyTouched(false);
    if (editing === 'new') setForm({ key: '', labels: {}, slugs: {}, description: '', hierarchical: true, contentTypes: presetType ? [presetType] : [], isPublic: true, showInFilter: true, sortOrder: 0 });
    else setForm({ key: editing.key, labels: editing.labels ?? {}, slugs: editing.slugs ?? {}, description: editing.description ?? '', hierarchical: editing.hierarchical, contentTypes: editing.contentTypes ?? [], isPublic: editing.isPublic, showInFilter: editing.showInFilter, sortOrder: editing.sortOrder ?? 0 });
  }, [editing, presetType]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      if (isNew && !CONTENT_KEY_RE.test(form.key)) throw new Error('Mã taxonomy chỉ gồm a-z, 0-9, _ ; bắt đầu bằng chữ, 2–40 ký tự');
      const err = validateLabels(form.labels, form.slugs, defaultLocale);
      if (err) throw new Error(err);
      const { labels, slugs } = cleanLabels(form.labels, form.slugs);
      const reserved = Object.values(slugs).find((s) => (RESERVED_SLUGS as readonly string[]).includes(s));
      if (reserved) throw new Error(`Slug "${reserved}" trùng đường dẫn hệ thống, hãy chọn slug khác`);
      const body = { labels, slugs, description: form.description.trim() || null, hierarchical: form.hierarchical, contentTypes: form.contentTypes, isPublic: form.isPublic, showInFilter: form.showInFilter, sortOrder: form.sortOrder };
      return isNew ? api.post<TaxonomyView>('/admin/taxonomies', { key: form.key, ...body }) : api.put<TaxonomyView>(`/admin/taxonomies/${(editing as TaxonomyView).id}`, body);
    },
    onSuccess: (data) => {
      toast.success(isNew ? 'Đã tạo taxonomy' : 'Đã lưu taxonomy');
      onSaved?.(data);
      void qc.invalidateQueries({ queryKey: ['taxonomies'] });
      void qc.invalidateQueries({ queryKey: ['content-types'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const update = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <Sheet open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>{isNew ? 'Thêm taxonomy' : 'Sửa taxonomy'}</SheetTitle>
          <SheetDescription>Phân loại cho nội dung tuỳ biến, vd “Lĩnh vực” cho Dự án, “Ngành nghề” cho Tuyển dụng.</SheetDescription>
        </SheetHeader>
        {form && (
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <Field label="Tên & đường dẫn theo ngôn ngữ" required>
              <LabelsSlugsEditor
                languages={languages}
                defaultLocale={defaultLocale}
                labels={form.labels}
                slugs={form.slugs}
                slugHint={(slug, locale) => `${locale !== defaultLocale ? `/${locale}` : ''}/${slug}/ten-phan-loai`}
                onChange={({ labels, slugs }) => {
                  // tạo mới: key tự sinh từ tên số ít của ngôn ngữ mặc định cho tới khi người dùng tự sửa
                  const auto = isNew && !keyTouched ? toKey(labels[defaultLocale]?.singular || labels[defaultLocale]?.plural || '') : form.key;
                  update({ labels, slugs, key: auto });
                }}
              />
            </Field>
            <Field label="Mã (key)" required help={isNew ? 'Dùng trong API / theme. Không đổi được sau khi tạo.' : 'Không đổi được sau khi tạo.'}>
              <Input
                value={form.key}
                disabled={!isNew}
                className="font-mono text-xs"
                placeholder="linh_vuc"
                onChange={(e) => {
                  setKeyTouched(true);
                  update({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') });
                }}
              />
            </Field>
            <Field label="Mô tả">
              <Textarea value={form.description} rows={2} onChange={(e) => update({ description: e.target.value })} />
            </Field>
            <Field label="Dùng cho loại nội dung">
              <div className="space-y-1.5 rounded-lg border p-3">
                {!contentTypes.length && <p className="text-xs text-muted-foreground">Chưa có loại nội dung nào</p>}
                {contentTypes.map((t) => (
                  <label key={t.key} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={form.contentTypes.includes(t.key)} onCheckedChange={(c) => update({ contentTypes: c ? [...form.contentTypes, t.key] : form.contentTypes.filter((x) => x !== t.key) })} />
                    {typeLabel(t.labels, defaultLocale, 'plural', t.key)}
                    <span className="font-mono text-[11px] text-muted-foreground">{t.key}</span>
                  </label>
                ))}
              </div>
            </Field>
            <div className="space-y-2">
              <ToggleRow label="Dạng cây (có mục cha / con)" help="Như chuyên mục. Tắt = dạng thẻ (tag) phẳng." checked={form.hierarchical} onChange={(v) => update({ hierarchical: v })} />
              <ToggleRow label="Công khai" help="Có trang lưu trữ trên website: /{slug taxonomy}/{slug phân loại}" checked={form.isPublic} onChange={(v) => update({ isPublic: v })} />
              <ToggleRow label="Hiện trong bộ lọc" help="Website/frontend hiện bộ lọc theo taxonomy này ở trang danh sách" checked={form.showInFilter} onChange={(v) => update({ showInFilter: v })} />
            </div>
            <Field label="Thứ tự">
              <Input type="number" className="w-32" value={form.sortOrder} onChange={(e) => update({ sortOrder: Number(e.target.value) || 0 })} />
            </Field>
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

/** Một dòng bật/tắt có mô tả */
export function ToggleRow({ label, help, checked, onChange, disabled }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {help && <span className="block text-xs text-muted-foreground">{help}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}
