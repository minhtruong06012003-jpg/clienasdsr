'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, Eye, Loader2, Lock, Save, Trash2, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_ENTITY_LABELS, toCustomFieldKey, type CustomFieldEntity, type FieldGroupDef, type FieldGroupRules } from '@cmsnt/shared';
import { PageBody, PageHeader } from '@/components/common/page-header';
import { Field, Section } from '@/components/common/field';
import { useConfirm } from '@/components/common/confirm-dialog';
import { LocaleTabs } from '@/components/common/locale-tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TermSelect } from '@/components/builder/fields';
import { FieldBuilder, fromBuilderFields, toBuilderFields, type BuilderField } from '@/components/custom-fields/field-builder';
import { CustomFieldsForm } from '@/components/custom-fields/field-input';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLanguages } from '@/hooks/use-languages';
import { useUnsavedGuard } from '@/hooks/use-unsaved';
import type { RoleOption } from '@/components/users/types';
import { typeLabel, useContentTypes, useTaxonomies } from '@/hooks/use-content-types';

type Group = FieldGroupDef & { id: string };

interface FormState {
  name: string;
  key: string;
  keyLocked: boolean;
  description: string;
  entity: CustomFieldEntity;
  placement: 'main' | 'sidebar';
  isActive: boolean;
  rules: FieldGroupRules;
  fields: BuilderField[];
}

const PAGE_TEMPLATES = [
  { value: 'default', label: 'Mặc định' },
  { value: 'landing', label: 'Landing page' },
];
const PRODUCT_TYPES = [
  { value: 'SIMPLE', label: 'Sản phẩm đơn' },
  { value: 'VARIABLE', label: 'Có biến thể' },
  { value: 'DIGITAL', label: 'Sản phẩm số' },
];

export default function FieldGroupEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isNew = id === 'new';
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { languages, defaultLocale } = useLanguages();
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [previewLocale, setPreviewLocale] = useState<string | null>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>({});
  // nhóm khai báo trong mã nguồn (id dạng `<nguồn>:<key>`, vd dữ liệu cũ `plugin:...`) chỉ xem, không sửa trong admin
  const fromCode = id.includes(':');
  const readOnly = !can('fields.manage') || fromCode;

  const group = useQuery({ queryKey: ['field-group', id], queryFn: () => api.get<Group>(`/admin/custom-fields/groups/${id}`), enabled: !isNew });
  // loại nội dung / taxonomy để đặt điều kiện cho nhóm entity entry / term
  const contentTypes = useContentTypes(form?.entity === 'entry' || form?.entity === 'term');
  const taxonomies = useTaxonomies(form?.entity === 'term');
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleOption[]>('/admin/roles'), enabled: form?.entity === 'user' });

  useEffect(() => {
    if (form) return;
    if (isNew) setForm({ name: '', key: '', keyLocked: false, description: '', entity: 'product', placement: 'main', isActive: true, rules: {}, fields: [] });
    else if (group.data) {
      const g = group.data;
      setForm({ name: g.name, key: g.key, keyLocked: true, description: g.description ?? '', entity: g.entity, placement: g.placement ?? 'main', isActive: g.isActive !== false, rules: g.rules ?? {}, fields: toBuilderFields(g.fields) });
    }
  }, [isNew, group.data, form]);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  };
  const setRule = <K extends keyof FieldGroupRules>(k: K, v: FieldGroupRules[K]) => update({ rules: { ...form!.rules, [k]: v && v.length ? v : undefined } });

  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Chưa sẵn sàng');
      if (!form.name.trim()) throw new Error('Vui lòng nhập tên nhóm');
      if (!form.fields.length) throw new Error('Nhóm cần ít nhất một trường');
      for (const f of form.fields) if (!f.label.trim() || !f.key) throw new Error('Mỗi trường cần có nhãn và mã trường');
      const noTax = [...form.fields, ...form.fields.flatMap((f) => f.fields ?? [])].find((f) => f.type === 'terms' && !f.taxonomy);
      if (noTax) throw new Error(`Trường “${noTax.label}” cần chọn taxonomy`);
      const body = { name: form.name.trim(), key: form.key || undefined, description: form.description || null, entity: form.entity, placement: form.placement, isActive: form.isActive, rules: form.rules, fields: fromBuilderFields(form.fields) };
      return isNew ? api.post<Group>('/admin/custom-fields/groups', body) : api.patch<Group>(`/admin/custom-fields/groups/${id}`, body);
    },
    onSuccess: (data) => {
      toast.success('Đã lưu nhóm trường');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['field-groups'] });
      void qc.invalidateQueries({ queryKey: ['custom-field-groups'] });
      qc.setQueryData(['field-group', data.id], data);
      if (isNew) router.replace(`/custom-fields/${data.id}`);
      else setForm((f) => (f ? { ...f, key: data.key, fields: toBuilderFields(data.fields) } : f));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  useUnsavedGuard(dirty, () => !save.isPending && save.mutate());

  const previewFields = useMemo(() => (form ? fromBuilderFields(form.fields.filter((f) => f.key && f.label)) : []), [form]);

  if (!form || (!isNew && group.isLoading)) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={isNew ? 'Tạo nhóm trường' : form.name || 'Nhóm trường'}
        breadcrumbs={[{ label: 'Trường tuỳ chỉnh', href: '/custom-fields' }, { label: isNew ? 'Mới' : 'Chỉnh sửa' }]}
        actions={
          !readOnly && (
            <>
              {!isNew && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={async () => {
                    if (!(await confirm({ title: `Xoá nhóm "${form.name}"?`, description: 'Giá trị đã nhập vẫn nằm trong dữ liệu bản ghi nhưng không còn hiển thị.', destructive: true, confirmText: 'Xoá' }))) return;
                    try {
                      await api.delete(`/admin/custom-fields/groups/${id}`);
                      toast.success('Đã xoá nhóm');
                      setDirty(false);
                      void qc.invalidateQueries({ queryKey: ['field-groups'] });
                      router.push('/custom-fields');
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  <Trash2 /> Xoá
                </Button>
              )}
              <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Lưu
              </Button>
            </>
          )
        }
      />
      <PageBody>
        {fromCode && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <Code2 className="size-4" /> Nhóm này được khai báo trong mã nguồn (<b>{group.data?.source}</b>) — chỉ xem, không sửa được tại đây.
          </div>
        )}
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-6">
            <Section title="Thông tin nhóm">
              <fieldset disabled={readOnly} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Tên nhóm" required help="Hiện làm tiêu đề khối trong trang soạn thảo">
                    <Input value={form.name} autoFocus={isNew} onChange={(e) => update({ name: e.target.value, ...(form.keyLocked ? {} : { key: toCustomFieldKey(e.target.value) }) })} placeholder="VD: Thông tin khoá học" />
                  </Field>
                  <Field
                    label="Mã nhóm (key)"
                    help="Dùng trong API public và theme"
                    action={
                      !readOnly && (
                        <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => update({ keyLocked: !form.keyLocked, ...(form.keyLocked ? { key: toCustomFieldKey(form.name) } : {}) })}>
                          {form.keyLocked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                          {form.keyLocked ? 'Nhập tay' : 'Tự sinh'}
                        </button>
                      )
                    }
                  >
                    <Input value={form.key} className="font-mono text-xs" onChange={(e) => update({ key: toCustomFieldKey(e.target.value.replace(/\s/g, '_')) || e.target.value.toLowerCase(), keyLocked: true })} placeholder="thong_tin_khoa_hoc" />
                  </Field>
                </div>
                <Field label="Mô tả" help="Hiện dưới tiêu đề khối để hướng dẫn người nhập">
                  <Textarea value={form.description} rows={2} onChange={(e) => update({ description: e.target.value })} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Gắn vào loại nội dung" required>
                    <Select value={form.entity} onValueChange={(v) => update({ entity: v as CustomFieldEntity, rules: {} })} disabled={!isNew}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CUSTOM_FIELD_ENTITIES.map((e) => (
                          <SelectItem key={e} value={e}>
                            {CUSTOM_FIELD_ENTITY_LABELS[e]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Vị trí trong trang soạn thảo">
                    <Select value={form.placement} onValueChange={(v) => update({ placement: v as 'main' | 'sidebar' })}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="main">Cột nội dung chính (rộng)</SelectItem>
                        <SelectItem value="sidebar">Cột phải (hẹp, cạnh Xuất bản)</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              </fieldset>
            </Section>

            <Section title="Các trường" description="Kéo để sắp xếp. Bấm vào trường để sửa thuộc tính.">
              {readOnly ? (
                <div className="pointer-events-none opacity-80">
                  <FieldBuilder value={form.fields} onChange={() => undefined} />
                </div>
              ) : (
                <FieldBuilder value={form.fields} onChange={(fields) => update({ fields })} />
              )}
            </Section>
          </div>

          <div className="space-y-6">
            <Section title="Hiển thị" actions={<Badge variant={form.isActive ? 'default' : 'secondary'}>{form.isActive ? 'Đang dùng' : 'Tắt'}</Badge>}>
              <fieldset disabled={readOnly} className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Bật nhóm này</Label>
                  <Switch checked={form.isActive} onCheckedChange={(v) => update({ isActive: v })} />
                </div>
                <p className="text-xs text-muted-foreground">Điều kiện hiển thị (bỏ trống = luôn hiện với mọi {CUSTOM_FIELD_ENTITY_LABELS[form.entity].toLowerCase()}):</p>
                {form.entity === 'page' && (
                  <Field label="Chỉ với bố cục">
                    <div className="space-y-1.5">
                      {PAGE_TEMPLATES.map((t) => (
                        <label key={t.value} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={!!form.rules.templates?.includes(t.value)} onCheckedChange={(c) => setRule('templates', c ? [...(form.rules.templates ?? []), t.value] : (form.rules.templates ?? []).filter((x) => x !== t.value))} />
                          {t.label}
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
                {form.entity === 'product' && (
                  <Field label="Chỉ với loại sản phẩm">
                    <div className="space-y-1.5">
                      {PRODUCT_TYPES.map((t) => (
                        <label key={t.value} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={!!form.rules.productTypes?.includes(t.value)} onCheckedChange={(c) => setRule('productTypes', c ? [...(form.rules.productTypes ?? []), t.value] : (form.rules.productTypes ?? []).filter((x) => x !== t.value))} />
                          {t.label}
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
                {(form.entity === 'product' || form.entity === 'post') && (
                  <Field label={form.entity === 'product' ? 'Chỉ với sản phẩm thuộc danh mục' : 'Chỉ với bài viết thuộc chuyên mục'}>
                    <TermSelect endpoint={form.entity === 'product' ? '/admin/products/categories' : '/admin/posts/categories'} multiple value={form.rules.categoryIds ?? []} onChange={(v) => setRule('categoryIds', v as string[])} locale={defaultLocale} />
                  </Field>
                )}
                {form.entity === 'entry' && (
                  <Field label="Chỉ với loại nội dung" help="Nên chọn — bỏ trống = hiện ở mọi loại nội dung">
                    <div className="space-y-1.5">
                      {!contentTypes.data?.length && <p className="text-xs text-muted-foreground">Chưa có loại nội dung nào</p>}
                      {contentTypes.data?.map((t) => (
                        <label key={t.key} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={!!form.rules.contentTypes?.includes(t.key)} onCheckedChange={(c) => setRule('contentTypes', c ? [...(form.rules.contentTypes ?? []), t.key] : (form.rules.contentTypes ?? []).filter((x) => x !== t.key))} />
                          {typeLabel(t.labels, defaultLocale, 'plural', t.key)}
                          <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
                {form.entity === 'term' && (
                  <Field label="Chỉ với taxonomy" help="Bỏ trống = hiện ở mọi taxonomy">
                    <div className="space-y-1.5">
                      {(taxonomies.data?.length
                        ? taxonomies.data.map((t) => ({ key: t.key, label: typeLabel(t.labels, defaultLocale, 'plural', t.key) }))
                        : [...new Set((contentTypes.data ?? []).flatMap((t) => t.taxonomies))].map((k) => ({ key: k, label: k }))
                      ).map((t) => (
                        <label key={t.key} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={!!form.rules.taxonomies?.includes(t.key)} onCheckedChange={(c) => setRule('taxonomies', c ? [...(form.rules.taxonomies ?? []), t.key] : (form.rules.taxonomies ?? []).filter((x) => x !== t.key))} />
                          {t.label}
                          <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
                {form.entity === 'user' && (
                  <Field label="Chỉ với vai trò">
                    <div className="space-y-1.5">
                      {roles.data?.map((r) => (
                        <label key={r.id} className="flex items-center gap-2 text-sm">
                          <Checkbox checked={!!form.rules.roleSlugs?.includes(r.slug)} onCheckedChange={(c) => setRule('roleSlugs', c ? [...(form.rules.roleSlugs ?? []), r.slug] : (form.rules.roleSlugs ?? []).filter((x) => x !== r.slug))} />
                          {r.name}
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
              </fieldset>
            </Section>

            <Section
              title={
                <span className="flex items-center gap-1.5">
                  <Eye className="size-4" /> Xem trước form
                </span>
              }
              description="Giao diện người nhập sẽ thấy trong trang soạn thảo"
              actions={languages.length > 1 && <LocaleTabs languages={languages} value={previewLocale ?? defaultLocale} onChange={setPreviewLocale} />}
            >
              {previewFields.length ? (
                <CustomFieldsForm fields={previewFields} values={previewValues} onChange={(k, v) => setPreviewValues((p) => ({ ...p, [k]: v }))} locale={previewLocale ?? defaultLocale} defaultLocale={defaultLocale} compact={form.placement === 'sidebar'} />
              ) : (
                <p className="text-sm text-muted-foreground">Thêm trường để xem trước.</p>
              )}
            </Section>

            <Section title="Dùng trong theme / API">
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>
                  API public trả về <code className="rounded bg-muted px-1">customFields.&lt;key&gt;</code> trên bản ghi (đã chọn ngôn ngữ, ảnh thành object) và <code className="rounded bg-muted px-1">customFieldGroups</code> để render nhãn.
                </p>
                <p>
                  Lọc danh sách: <code className="rounded bg-muted px-1">/api/public/products?cf[{form.fields[0]?.key || 'key'}]=giá_trị</code>
                </p>
                <p>Trang Page Builder có block “Trường tuỳ chỉnh” để hiển thị nhóm của chính trang đó.</p>
              </div>
            </Section>
          </div>
        </div>
      </PageBody>
    </>
  );
}
