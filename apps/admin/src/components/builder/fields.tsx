'use client';

import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, Copy, GripVertical, Plus, Search, Trash2, X } from 'lucide-react';
// STOREFRONT_SLOTS: danh sách "vùng chức năng" của block storefront-slot — khai báo một nơi ở @cmsnt/blocks;
// frontend riêng tự render từng vùng qua ctx.renderSlot, admin chỉ dùng để hiện ô chọn
import { BLOCK_ICONS, BlockIcon, getPath, STOREFRONT_SLOTS, type FieldDef } from '@cmsnt/blocks';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Field } from '@/components/common/field';
// nạp động trình soạn thảo để không kéo TipTap vào bundle chung
import { LazyRichTextEditor } from '@/components/editor/lazy-rich-text-editor';
import { GalleryField, ImageField } from '@/components/media/media-picker';
import { toMediaRef } from '@/components/media/use-upload';
import { api, type Paginated } from '@/lib/api';
import { pickTr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import { useBuilderEnv } from './builder-context';

type Data = Record<string, any>;

interface FieldsProps {
  fields: FieldDef[];
  data: Data;
  onChange: (path: string, value: unknown) => void;
  locale: string;
  /** tiền tố đường dẫn khi nằm trong repeater: "items.0." */
  prefix?: string;
}

const NONE = '__none__';

function visible(f: FieldDef, data: Data) {
  if (!f.showIf) return true;
  const v = getPath(data, f.showIf.field);
  return Array.isArray(f.showIf.equals) ? f.showIf.equals.includes(v) : v === f.showIf.equals;
}

/** Sinh form chỉnh sửa tự động từ FieldDef[] của block */
export function BlockFields({ fields, data, onChange, locale, prefix = '' }: FieldsProps) {
  return (
    <div className="space-y-4">
      {fields.filter((f) => visible(f, data)).map((f) => (
        <FieldControl key={f.name} field={f} value={data?.[f.name]} data={data} onChange={(v) => onChange(`${prefix}${f.name}`, v)} onChangePath={onChange} prefix={`${prefix}${f.name}.`} locale={locale} />
      ))}
    </div>
  );
}

function FieldControl({ field: f, value, data, onChange, onChangePath, prefix, locale }: { field: FieldDef; value: any; data: Data; onChange: (v: unknown) => void; onChangePath: (path: string, v: unknown) => void; prefix: string; locale: string }) {
  switch (f.type) {
    case 'text':
    case 'url':
      return (
        <Field label={f.label} help={f.help}>
          <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder ?? (f.type === 'url' ? '/duong-dan hoặc https://...' : undefined)} />
        </Field>
      );
    case 'textarea':
      return (
        <Field label={f.label} help={f.help}>
          <Textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={f.placeholder} />
        </Field>
      );
    case 'code':
      return (
        <Field label={f.label} help={f.help}>
          <Textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} rows={8} className="font-mono text-xs" spellCheck={false} />
        </Field>
      );
    case 'richtext':
      return (
        <Field label={f.label} help={f.help}>
          <LazyRichTextEditor value={value ?? ''} onChange={onChange} compact minHeight={160} />
        </Field>
      );
    case 'number':
      return (
        <Field label={f.label} help={f.help}>
          <Input type="number" value={value ?? ''} min={f.min} max={f.max} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
        </Field>
      );
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{f.label}</span>
          <Switch checked={!!value} onCheckedChange={onChange} />
        </div>
      );
    case 'select':
      return (
        <Field label={f.label} help={f.help}>
          <Select value={value == null ? '' : String(value)} onValueChange={(v) => onChange(typeof f.default === 'number' || /^\d+$/.test(v) && f.options?.every((o) => /^\d+$/.test(o.value)) ? Number(v) : v)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Chọn..." />
            </SelectTrigger>
            <SelectContent>
              {f.options?.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      );
    case 'color':
      return (
        <Field label={f.label} help={f.help}>
          <ColorInput value={value} onChange={onChange} />
        </Field>
      );
    case 'image':
      return (
        <Field label={f.label} help={f.help}>
          <ImageField value={value} onChange={(m) => onChange(m ? toMediaRef(m, locale) : null)} />
          {value?.url && <Input className="mt-2 h-8 text-xs" value={value.alt ?? ''} placeholder="Văn bản thay thế (alt)" onChange={(e) => onChange({ ...value, alt: e.target.value })} />}
        </Field>
      );
    case 'images':
      return (
        <Field label={f.label} help={f.help}>
          <GalleryField value={Array.isArray(value) ? value.filter((v: any) => v?.id) : []} onChange={onChange} mapMedia={(m) => toMediaRef(m, locale) as any} />
        </Field>
      );
    case 'icon':
      return (
        <Field label={f.label}>
          <IconPicker value={value} onChange={onChange} />
        </Field>
      );
    case 'repeater':
      return <Repeater field={f} value={Array.isArray(value) ? value : []} onChange={onChange} onChangePath={onChangePath} prefix={prefix} locale={locale} />;
    case 'products':
      return (
        <Field label={f.label} help={f.help}>
          <ProductPicker value={Array.isArray(value) ? value : []} onChange={onChange} locale={locale} />
        </Field>
      );
    case 'product-category':
    case 'product-categories':
    case 'post-category':
      return (
        <Field label={f.label} help={f.help}>
          <TermSelect endpoint={f.type === 'post-category' ? '/admin/posts/categories' : '/admin/products/categories'} multiple={f.type === 'product-categories'} value={value} onChange={onChange} locale={locale} />
        </Field>
      );
    case 'global-block':
      return (
        <Field label={f.label} help={f.help ?? 'Quản lý tại mục Block dùng chung'}>
          <RemoteSelect queryKey="blocks-select" endpoint="/admin/blocks" valueKey="key" labelOf={(r) => `${r.name} (${r.key})`} value={value} onChange={onChange} />
        </Field>
      );
    case 'content-type':
      return (
        <Field label={f.label} help={f.help}>
          <ContentTypeSelect value={value} onChange={onChange} locale={locale} />
        </Field>
      );
    case 'taxonomy':
      return (
        <Field label={f.label} help={f.help}>
          <TaxonomySelect value={value} onChange={onChange} locale={locale} contentType={typeof data?.contentType === 'string' ? data.contentType : undefined} />
        </Field>
      );
    case 'terms': {
      // taxonomy lấy từ field anh em (mặc định field "taxonomy")
      const tax = data?.[f.taxonomyField ?? 'taxonomy'];
      return (
        <Field label={f.label} help={f.help}>
          {typeof tax === 'string' && tax ? (
            <TermSelect endpoint={`/admin/taxonomies/${encodeURIComponent(tax)}/terms`} multiple value={Array.isArray(value) ? value : []} onChange={onChange} locale={locale} />
          ) : (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">Chọn phân loại trước để chọn mục.</p>
          )}
        </Field>
      );
    }
    case 'custom-field-key':
      return (
        <Field label={f.label} help={f.help ?? 'Mã trường tuỳ chỉnh (gõ để xem gợi ý)'}>
          <CustomFieldKeyInput value={value ?? ''} onChange={onChange} contentType={typeof data?.contentType === 'string' ? data.contentType : undefined} placeholder={f.placeholder} />
        </Field>
      );
    case 'storefront-slot':
      return (
        <Field label={f.label} help={f.help ?? 'Khu vực chức năng có sẵn của giao diện website'}>
          <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Chọn..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>— Không chọn —</SelectItem>
              {STOREFRONT_SLOTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      );
    default:
      return null;
  }
}

interface ContentTypeRow {
  key: string;
  labels: Record<string, { singular: string; plural: string }>;
  taxonomies?: string[];
}

interface TaxonomyRow {
  key: string;
  labels: Record<string, { singular: string; plural: string }>;
  contentTypes?: string[];
}

/** Nhãn theo locale, lùi về locale bất kỳ rồi key */
const typeLabel = (labels: ContentTypeRow['labels'] | undefined, locale: string, key: string) => labels?.[locale]?.plural || Object.values(labels ?? {})[0]?.plural || key;

/** Danh sách loại nội dung tuỳ biến (dùng chung cache cho các field) — 403 thì coi như rỗng */
export function useContentTypeOptions() {
  return useQuery({ queryKey: ['content-types-select'], queryFn: () => api.get<ContentTypeRow[]>('/admin/content-types').catch(() => [] as ContentTypeRow[]), staleTime: 60_000 });
}

/** Chọn loại nội dung: bài viết, sản phẩm + các loại nội dung tuỳ biến (giá trị = key) */
export function ContentTypeSelect({ value, onChange, locale, includeCore = true }: { value: any; onChange: (v: string) => void; locale: string; includeCore?: boolean }) {
  const { data } = useContentTypeOptions();
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Chọn..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>— Không chọn —</SelectItem>
        {includeCore && <SelectItem value="post">Bài viết</SelectItem>}
        {includeCore && <SelectItem value="product">Sản phẩm</SelectItem>}
        {data?.map((t) => (
          <SelectItem key={t.key} value={t.key}>
            {typeLabel(t.labels, locale, t.key)} <span className="font-mono text-xs text-muted-foreground">({t.key})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Chọn taxonomy (giá trị = key); có contentType thì ưu tiên các taxonomy gắn với loại đó */
function TaxonomySelect({ value, onChange, locale, contentType }: { value: any; onChange: (v: string) => void; locale: string; contentType?: string }) {
  const { data } = useQuery({ queryKey: ['taxonomies-select'], queryFn: () => api.get<TaxonomyRow[]>('/admin/taxonomies').catch(() => [] as TaxonomyRow[]), staleTime: 60_000 });
  const list = (data ?? []).filter((t) => !contentType || ['post', 'product'].includes(contentType) || !t.contentTypes?.length || t.contentTypes.includes(contentType) || t.key === value);
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Chọn..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>— Không chọn —</SelectItem>
        {list.map((t) => (
          <SelectItem key={t.key} value={t.key}>
            {typeLabel(t.labels, locale, t.key)} <span className="font-mono text-xs text-muted-foreground">({t.key})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface FieldGroupRow {
  key: string;
  name: string;
  rules?: { contentTypes?: string[] };
  fields: { key: string; label: string; type: string }[];
}

/** Entity nhóm trường tuỳ chỉnh tương ứng với target / loại nội dung */
function cfEntityOf(contentType?: string, target?: string): string | null {
  const t = contentType || target || '';
  if (t === 'post' || t === 'product' || t === 'page') return t;
  if (t === 'post_category' || t === 'product_category') return t;
  if (t.startsWith('term:')) return 'term';
  if (t && t !== '*') return 'entry';
  return null;
}

/** Ô nhập mã trường tuỳ chỉnh + gợi ý từ các nhóm trường đang bật (theo loại nội dung nếu biết) */
function CustomFieldKeyInput({ value, onChange, contentType, placeholder }: { value: string; onChange: (v: string) => void; contentType?: string; placeholder?: string }) {
  const { context } = useBuilderEnv();
  const entity = cfEntityOf(contentType, context?.target);
  const typeKey = contentType && !['post', 'product', 'page'].includes(contentType) ? contentType : context?.target.startsWith('entry:') ? context.target.slice(6) : undefined;
  const entities = entity ? [entity] : ['entry', 'post', 'product', 'page'];
  const { data } = useQuery({
    queryKey: ['cf-key-suggest', entities.join(',')],
    queryFn: async () => (await Promise.all(entities.map((e) => api.get<FieldGroupRow[]>('/admin/custom-fields/active', { entity: e }).catch(() => [] as FieldGroupRow[])))).flat(),
    staleTime: 60_000,
  });
  const listId = useId();
  const options = (data ?? [])
    .filter((g) => !typeKey || !g.rules?.contentTypes?.length || g.rules.contentTypes.includes(typeKey))
    .flatMap((g) => g.fields.map((fd) => ({ key: fd.key, label: `${fd.label} — ${g.name}` })));
  const seen = new Set<string>();
  return (
    <>
      <Input value={value} onChange={(e) => onChange(e.target.value.trim())} list={listId} placeholder={placeholder ?? 'vd: gia, dien_tich'} className="font-mono" />
      <datalist id={listId}>
        {options.filter((o) => !seen.has(o.key) && seen.add(o.key)).map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </datalist>
    </>
  );
}

export function ColorInput({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input type="color" value={value || '#ffffff'} onChange={(e) => onChange(e.target.value)} className="size-8 cursor-pointer rounded border bg-transparent p-0.5" />
      <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="#ffffff hoặc trống" className="h-8 flex-1" />
      {value && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange('')} title="Xoá màu">
          <X />
        </Button>
      )}
    </div>
  );
}

function IconPicker({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start">
          <BlockIcon name={value} className="size-4" /> {value || 'Chọn icon'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2">
        <div className="grid grid-cols-6 gap-1">
          {Object.keys(BLOCK_ICONS).map((name) => (
            <button
              key={name}
              type="button"
              title={name}
              onClick={() => {
                onChange(name);
                setOpen(false);
              }}
              className={cn('flex aspect-square items-center justify-center rounded-md hover:bg-muted', value === name && 'bg-primary/10 text-primary')}
            >
              <BlockIcon name={name} className="size-4" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RepeaterItem({ id, title, open, onToggle, onRemove, onDuplicate, children }: { id: string; title: string; open: boolean; onToggle: () => void; onRemove: () => void; onDuplicate: () => void; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('rounded-lg border bg-background', isDragging && 'z-10 shadow-lg')}>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button type="button" className="cursor-grab p-1 text-muted-foreground" {...attributes} {...listeners}>
          <GripVertical className="size-3.5" />
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm">
          {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <span className="truncate">{title}</span>
        </button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onDuplicate} title="Nhân bản">
          <Copy />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove} title="Xoá" className="text-destructive">
          <Trash2 />
        </Button>
      </div>
      {open && <div className="border-t p-3">{children}</div>}
    </div>
  );
}

function Repeater({ field: f, value, onChange, onChangePath, prefix, locale }: { field: FieldDef; value: Data[]; onChange: (v: unknown) => void; onChangePath: (path: string, v: unknown) => void; prefix: string; locale: string }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = value.map((_, i) => `${prefix}${i}`);
  const empty = () => Object.fromEntries((f.fields ?? []).map((sf) => [sf.name, sf.default ?? (sf.type === 'number' ? 0 : sf.type === 'boolean' ? false : sf.type === 'images' ? [] : sf.type === 'image' ? null : '')]));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onChange(arrayMove(value, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
    setOpenIdx(null);
  };
  return (
    <Field label={`${f.label} (${value.length})`} help={f.help}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {value.map((item, i) => (
              <RepeaterItem
                key={ids[i]}
                id={ids[i]}
                title={String((f.itemLabelField && item?.[f.itemLabelField]) || `Mục ${i + 1}`)}
                open={openIdx === i}
                onToggle={() => setOpenIdx(openIdx === i ? null : i)}
                onRemove={() => onChange(value.filter((_, j) => j !== i))}
                onDuplicate={() => onChange([...value.slice(0, i + 1), structuredClone(item), ...value.slice(i + 1)])}
              >
                <BlockFields fields={f.fields ?? []} data={item} onChange={onChangePath} prefix={`${prefix}${i}.`} locale={locale} />
              </RepeaterItem>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 w-full"
        onClick={() => {
          onChange([...value, empty()]);
          setOpenIdx(value.length);
        }}
      >
        <Plus /> Thêm mục
      </Button>
    </Field>
  );
}

interface TermRow {
  id: string;
  parentId?: string | null;
  translations: { locale: string; name: string }[];
}

export function TermSelect({ endpoint, multiple, value, onChange, locale }: { endpoint: string; multiple?: boolean; value: any; onChange: (v: unknown) => void; locale: string }) {
  const { data } = useQuery({ queryKey: ['term-select', endpoint], queryFn: () => api.get<TermRow[]>(endpoint) });
  const name = (r: TermRow) => pickTr(r.translations, locale)?.name ?? r.id;
  if (multiple) {
    const list: string[] = Array.isArray(value) ? value : [];
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {list.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1">
              {data?.find((d) => d.id === id) ? name(data.find((d) => d.id === id)!) : id.slice(0, 6)}
              <button type="button" onClick={() => onChange(list.filter((x) => x !== id))}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <Select value="" onValueChange={(v) => onChange([...list, v])}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Thêm danh mục..." />
          </SelectTrigger>
          <SelectContent>
            {data?.filter((d) => !list.includes(d.id)).map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.parentId ? '— ' : ''}
                {name(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Chọn..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>— Không chọn —</SelectItem>
        {data?.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.parentId ? '— ' : ''}
            {name(d)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RemoteSelect({ queryKey, endpoint, valueKey, labelOf, value, onChange }: { queryKey: string; endpoint: string; valueKey: string; labelOf: (r: any) => string; value: any; onChange: (v: unknown) => void }) {
  const { data } = useQuery({ queryKey: [queryKey], queryFn: () => api.get<Paginated<any>>(endpoint, { limit: 100 }) });
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Chọn..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>— Không chọn —</SelectItem>
        {data?.data.map((r) => (
          <SelectItem key={r[valueKey]} value={r[valueKey]}>
            {labelOf(r)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface ProductRow {
  id: string;
  sku: string | null;
  featuredImage: { urls: Record<string, string>; url: string } | null;
  translations: { locale: string; name: string }[];
}

export function ProductPicker({ value, onChange, locale }: { value: string[]; onChange: (v: string[]) => void; locale: string }) {
  const [q, setQ] = useState('');
  const debounced = useDebounce(q, 300);
  const search = useQuery({ queryKey: ['product-picker', debounced], queryFn: () => api.get<Paginated<ProductRow>>('/admin/products', { search: debounced, limit: 10 }) });
  const [known, setKnown] = useState<Record<string, ProductRow>>({});
  const chosen = useQuery({
    queryKey: ['product-picker-chosen', value.filter((id) => !known[id]).join(',')],
    queryFn: async () => Promise.all(value.filter((id) => !known[id]).map((id) => api.get<ProductRow>(`/admin/products/${id}`).catch(() => null))),
    enabled: value.some((id) => !known[id]),
  });
  const lookup = (id: string) => known[id] ?? chosen.data?.find((p) => p?.id === id) ?? search.data?.data.find((p) => p.id === id);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => e.over && e.active.id !== e.over.id && onChange(arrayMove(value, value.indexOf(String(e.active.id)), value.indexOf(String(e.over.id))))}>
        <SortableContext items={value} strategy={verticalListSortingStrategy}>
          <div className="space-y-1">
            {value.map((id) => (
              <ChosenProduct key={id} id={id} product={lookup(id)} locale={locale} onRemove={() => onChange(value.filter((x) => x !== id))} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm sản phẩm để thêm..." className="pl-8" />
      </div>
      <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-1">
        {search.data?.data
          .filter((p) => !value.includes(p.id))
          .map((p) => (
            <button
              key={p.id}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => {
                setKnown((k) => ({ ...k, [p.id]: p }));
                onChange([...value, p.id]);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.featuredImage ? <img src={p.featuredImage.urls.thumb ?? p.featuredImage.url} alt="" className="size-7 rounded object-cover" /> : <span className="size-7 rounded bg-muted" />}
              <span className="line-clamp-1 flex-1">{pickTr(p.translations, locale)?.name}</span>
              <Plus className="size-3.5 text-muted-foreground" />
            </button>
          ))}
      </div>
    </div>
  );
}

function ChosenProduct({ id, product, locale, onRemove }: { id: string; product?: ProductRow | null; locale: string; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className="flex items-center gap-2 rounded-md border bg-background px-1.5 py-1 text-sm">
      <button type="button" className="cursor-grab text-muted-foreground" {...attributes} {...listeners}>
        <GripVertical className="size-3.5" />
      </button>
      <span className="line-clamp-1 flex-1">{product ? pickTr(product.translations, locale)?.name : 'Đang tải...'}</span>
      <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove}>
        <X />
      </Button>
    </div>
  );
}
