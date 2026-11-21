'use client';

import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, Copy, FileIcon, GripVertical, Plus, Search, Trash2, X } from 'lucide-react';
import { customFieldVisible, emptyCustomFieldValue, type CustomFieldDef } from '@cmsnt/shared';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Field } from '@/components/common/field';
// nạp động trình soạn thảo để không kéo TipTap vào bundle chung
import { LazyRichTextEditor } from '@/components/editor/lazy-rich-text-editor';
import { GalleryField, ImageIdField, MediaPickerDialog, useMediaById } from '@/components/media/media-picker';
import { ColorInput, ProductPicker, TermSelect } from '@/components/builder/fields';
import { api, type Paginated } from '@/lib/api';
import { pickTr } from '@/lib/format';
import type { Media } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import { flattenTerms, termName, useTaxonomyTerms } from '@/hooks/use-content-types';

type Values = Record<string, unknown>;
const NONE = '__none__';

/** Sinh key ổn định cho mục repeater (React key + giữ focus khi kéo thả) */
const uid = () => Math.random().toString(36).slice(2, 10);

interface InputProps {
  field: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  /** ngôn ngữ đang soạn (ô i18n hiển thị bản này) */
  locale: string;
  defaultLocale: string;
  disabled?: boolean;
}

/**
 * Form các trường tuỳ chỉnh của MỘT nhóm: tự xếp lưới (width half/full), ẩn theo showIf.
 * `values` là object { key: value } của nhóm (hoặc của mục repeater).
 */
export function CustomFieldsForm({ fields, values, onChange, locale, defaultLocale, disabled, compact }: { fields: CustomFieldDef[]; values: Values; onChange: (key: string, v: unknown) => void; locale: string; defaultLocale: string; disabled?: boolean; compact?: boolean }) {
  const visible = fields.filter((f) => customFieldVisible(f, values));
  return (
    <div className={cn('grid gap-4', !compact && 'sm:grid-cols-2')}>
      {visible.map((f) => (
        <div key={f.key} className={cn(!compact && f.width !== 'half' && 'sm:col-span-2')}>
          <CustomFieldInput field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} locale={locale} defaultLocale={defaultLocale} disabled={disabled} />
        </div>
      ))}
    </div>
  );
}

/** Ô nhập cho một trường tuỳ chỉnh theo loại */
export function CustomFieldInput({ field: f, value, onChange, locale, defaultLocale, disabled }: InputProps) {
  // chưa có giá trị -> hiển thị mặc định của trường (API cũng dùng mặc định khi trả public)
  const v = value === undefined ? (f.default !== undefined ? f.default : emptyCustomFieldValue(f)) : value;
  const label = (
    <span className="inline-flex items-center gap-1.5">
      {f.label}
      {f.i18n && (
        <Badge variant="outline" className="h-4 px-1 text-[10px] font-semibold uppercase" title="Giá trị theo ngôn ngữ đang soạn">
          {locale}
        </Badge>
      )}
    </span>
  );
  /** đọc / ghi chuỗi i18n theo ngôn ngữ đang soạn */
  const i18nVal = (x: unknown) => (x && typeof x === 'object' ? ((x as Record<string, string>)[locale] ?? '') : locale === defaultLocale ? String(x ?? '') : '');
  const setI18n = (x: unknown, next: string) => onChange({ ...(x && typeof x === 'object' ? (x as Record<string, string>) : typeof x === 'string' && x ? { [defaultLocale]: x } : {}), [locale]: next });
  const wrap = (children: React.ReactNode, extra?: { help?: string }) => (
    <Field label={label} help={extra?.help ?? f.help} required={f.required}>
      {children}
    </Field>
  );

  switch (f.type) {
    case 'text':
    case 'url':
    case 'email':
      return wrap(
        f.i18n ? (
          <Input value={i18nVal(v)} onChange={(e) => setI18n(v, e.target.value)} placeholder={f.placeholder} disabled={disabled} maxLength={f.max} />
        ) : (
          <Input type={f.type === 'email' ? 'email' : 'text'} value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder ?? (f.type === 'url' ? 'https://... hoặc /duong-dan' : undefined)} disabled={disabled} maxLength={f.max} />
        ),
      );
    case 'textarea':
      return wrap(f.i18n ? <Textarea value={i18nVal(v)} onChange={(e) => setI18n(v, e.target.value)} rows={f.rows ?? 3} placeholder={f.placeholder} disabled={disabled} /> : <Textarea value={String(v ?? '')} onChange={(e) => onChange(e.target.value)} rows={f.rows ?? 3} placeholder={f.placeholder} disabled={disabled} />);
    case 'richtext':
      return wrap(<LazyRichTextEditor value={f.i18n ? i18nVal(v) : String(v ?? '')} onChange={(html) => (f.i18n ? setI18n(v, html) : onChange(html))} compact minHeight={Math.max(120, (f.rows ?? 6) * 24)} />);
    case 'number':
      return wrap(<Input type="number" value={v == null || v === '' ? '' : String(v)} min={f.min} max={f.max} step={f.step ?? 'any'} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} placeholder={f.placeholder} disabled={disabled} />);
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{f.label}</p>
            {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
          </div>
          <Switch checked={!!v} onCheckedChange={onChange} disabled={disabled} />
        </div>
      );
    case 'select':
      return wrap(
        <Select value={v == null || v === '' ? NONE : String(v)} onValueChange={(x) => onChange(x === NONE ? null : x)} disabled={disabled}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Chọn..." />
          </SelectTrigger>
          <SelectContent>
            {!f.required && <SelectItem value={NONE}>— Không chọn —</SelectItem>}
            {f.options?.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>,
      );
    case 'multiselect': {
      const list: string[] = Array.isArray(v) ? v.map(String) : [];
      return wrap(
        <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border p-3">
          {f.options?.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <Checkbox checked={list.includes(o.value)} disabled={disabled} onCheckedChange={(c) => onChange(c ? [...list, o.value] : list.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>,
      );
    }
    case 'date':
      return wrap(<Input type="date" value={String(v ?? '')} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} />);
    case 'datetime':
      return wrap(<Input type="datetime-local" value={toLocalInput(v)} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} disabled={disabled} />);
    case 'color':
      return wrap(<ColorInput value={String(v ?? '')} onChange={onChange} />);
    case 'image':
      return wrap(<ImageIdField value={typeof v === 'string' ? v : null} onChange={(id) => onChange(id)} aspect="aspect-video" />);
    case 'file':
      return wrap(<FileIdField value={typeof v === 'string' ? v : null} onChange={onChange} disabled={disabled} />);
    case 'gallery':
      return wrap(<GalleryIdsField value={Array.isArray(v) ? v.map(String) : []} onChange={onChange} />);
    case 'link': {
      const o = (v && typeof v === 'object' ? v : { label: f.i18n ? {} : '', url: '', target: '_self' }) as { label?: unknown; url?: string; target?: string };
      return wrap(
        <div className="space-y-2 rounded-lg border p-3">
          {f.i18n ? <Input value={i18nVal(o.label)} onChange={(e) => onChange({ ...o, label: { ...(o.label && typeof o.label === 'object' ? (o.label as object) : {}), [locale]: e.target.value } })} placeholder="Nhãn hiển thị" disabled={disabled} /> : <Input value={String(o.label ?? '')} onChange={(e) => onChange({ ...o, label: e.target.value })} placeholder="Nhãn hiển thị" disabled={disabled} />}
          <Input value={o.url ?? ''} onChange={(e) => onChange({ ...o, url: e.target.value })} placeholder="https://... hoặc /duong-dan" disabled={disabled} />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={o.target === '_blank'} onCheckedChange={(c) => onChange({ ...o, target: c ? '_blank' : '_self' })} disabled={disabled} /> Mở trong tab mới
          </label>
        </div>,
      );
    }
    case 'products':
      return wrap(<ProductPicker value={Array.isArray(v) ? v.map(String) : []} onChange={onChange} locale={locale} />);
    case 'posts':
      return wrap(<EntityPicker endpoint="/admin/posts" value={Array.isArray(v) ? v.map(String) : []} onChange={onChange} locale={locale} placeholder="Tìm bài viết..." />);
    case 'pages':
      return wrap(<EntityPicker endpoint="/admin/pages" value={Array.isArray(v) ? v.map(String) : []} onChange={onChange} locale={locale} placeholder="Tìm trang..." />);
    case 'post_category':
      return wrap(<TermSelect endpoint="/admin/posts/categories" value={v ?? ''} onChange={(x) => onChange(x || null)} locale={locale} />);
    case 'product_category':
      return wrap(<TermSelect endpoint="/admin/products/categories" value={v ?? ''} onChange={(x) => onChange(x || null)} locale={locale} />);
    case 'entries':
      return wrap(<EntryLookupPicker contentType={f.contentType} value={Array.isArray(v) ? v.map(String) : []} onChange={onChange} disabled={disabled} />);
    case 'terms':
      return wrap(<TermsInput taxonomy={f.taxonomy} value={Array.isArray(v) ? v.map(String) : []} onChange={onChange} locale={locale} defaultLocale={defaultLocale} disabled={disabled} />);
    case 'repeater':
      return <RepeaterInput field={f} value={Array.isArray(v) ? (v as Values[]) : []} onChange={onChange} locale={locale} defaultLocale={defaultLocale} disabled={disabled} label={label} />;
    case 'json':
      return wrap(<JsonInput value={v} onChange={onChange} disabled={disabled} />);
    default:
      return null;
  }
}

function toLocalInput(iso: unknown) {
  if (!iso || typeof iso !== 'string') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Chọn 1 file bất kỳ (pdf, zip...) theo id media */
function FileIdField({ value, onChange, disabled }: { value: string | null; onChange: (id: string | null) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Media | null>(null);
  const fetched = useMediaById(value && picked?.id !== value ? value : null);
  const current = value ? (picked?.id === value ? picked : fetched.data) : null;
  return (
    <div className="flex items-center gap-2 rounded-lg border p-2">
      <FileIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 text-sm">
        {current ? (
          <a href={current.url} target="_blank" rel="noreferrer" className="block truncate font-medium hover:text-primary">
            {current.originalName || current.filename}
          </a>
        ) : value ? (
          <span className="text-muted-foreground">Đang tải...</span>
        ) : (
          <span className="text-muted-foreground">Chưa chọn file</span>
        )}
        {current && <p className="text-xs text-muted-foreground">{(current.size / 1024).toFixed(0)} KB · {current.mimeType}</p>}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
        {value ? 'Đổi' : 'Chọn file'}
      </Button>
      {value && (
        <Button type="button" size="icon-sm" variant="ghost" onClick={() => onChange(null)} disabled={disabled} title="Gỡ">
          <X />
        </Button>
      )}
      <MediaPickerDialog
        open={open}
        onOpenChange={setOpen}
        accept="all"
        onSelect={(items) => {
          setPicked(items[0] ?? null);
          onChange(items[0]?.id ?? null);
        }}
      />
    </div>
  );
}

/** Bộ sưu tập ảnh lưu dạng id[] — tự tải object media để hiển thị thumb */
function GalleryIdsField({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [known, setKnown] = useState<Record<string, Media>>({});
  const queries = useQueries({
    queries: value.filter((id) => !known[id]).map((id) => ({ queryKey: ['media', 'item', id], queryFn: () => api.get<Media>(`/admin/media/${id}`), staleTime: 5 * 60_000 })),
  });
  const items = useMemo(() => {
    const byId: Record<string, Media> = { ...known };
    for (const q of queries) if (q.data) byId[q.data.id] = q.data;
    // ảnh chưa tải xong hiển thị ô trống (url rỗng) để giữ đúng thứ tự / kéo thả
    return value.map((id) => byId[id] ?? { id, url: '', urls: {} }) as { id: string; url: string; urls?: Record<string, string> }[];
  }, [value, known, queries]);
  return (
    <GalleryField
      value={items}
      onChange={(list) => onChange(list.map((m) => m.id))}
      mapMedia={(m) => {
        setKnown((k) => ({ ...k, [m.id]: m }));
        return m;
      }}
    />
  );
}

/** Chọn nhiều bài viết / trang (tìm theo tiêu đề) */
function EntityPicker({ endpoint, value, onChange, locale, placeholder }: { endpoint: string; value: string[]; onChange: (ids: string[]) => void; locale: string; placeholder: string }) {
  type Row = { id: string; translations: { locale: string; title: string }[] };
  const [q, setQ] = useState('');
  const debounced = useDebounce(q, 300);
  const search = useQuery({ queryKey: ['entity-picker', endpoint, debounced], queryFn: () => api.get<Paginated<Row>>(endpoint, { search: debounced, limit: 10 }) });
  const [known, setKnown] = useState<Record<string, Row>>({});
  const chosen = useQueries({ queries: value.filter((id) => !known[id]).map((id) => ({ queryKey: ['entity-picker-item', endpoint, id], queryFn: () => api.get<Row>(`${endpoint}/${id}`), staleTime: 5 * 60_000 })) });
  const lookup = (id: string) => known[id] ?? chosen.find((c) => c.data?.id === id)?.data ?? search.data?.data.find((p) => p.id === id);
  const title = (r?: Row) => (r ? (pickTr(r.translations, locale)?.title ?? r.translations[0]?.title ?? '') : '');
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1">
              {title(lookup(id)) || id.slice(0, 8)}
              <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Gỡ">
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="pl-8" />
      </div>
      {q && (
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
                  setQ('');
                }}
              >
                <span className="line-clamp-1 flex-1">{title(p)}</span>
                <Plus className="size-3.5 text-muted-foreground" />
              </button>
            ))}
          {search.data && !search.data.data.length && <p className="px-2 py-1 text-xs text-muted-foreground">Không có kết quả</p>}
        </div>
      )}
    </div>
  );
}

type LookupRow = { id: string; title: string; type: string; status: string };
/** API lookup có thể trả mảng hoặc { data } */
const lookupRows = (r: LookupRow[] | { data: LookupRow[] } | null | undefined): LookupRow[] => (Array.isArray(r) ? r : (r?.data ?? []));

/**
 * Chọn nhiều bài của loại nội dung tuỳ biến (trường `entries`) — tìm qua GET /admin/entries/lookup?type=&search=,
 * tên các bài đã chọn tải qua ?ids=.
 */
function EntryLookupPicker({ contentType, value, onChange, disabled }: { contentType?: string; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const debounced = useDebounce(q, 300);
  const [known, setKnown] = useState<Record<string, LookupRow>>({});
  const search = useQuery({
    queryKey: ['entries-lookup', contentType ?? '', debounced],
    queryFn: async () => lookupRows(await api.get<LookupRow[] | { data: LookupRow[] }>('/admin/entries/lookup', { type: contentType, search: debounced, limit: 10 })),
    enabled: !!q,
  });
  const missing = value.filter((id) => !known[id]);
  const chosen = useQuery({
    queryKey: ['entries-lookup-ids', missing.join(',')],
    queryFn: async () => lookupRows(await api.get<LookupRow[] | { data: LookupRow[] }>('/admin/entries/lookup', { ids: missing.join(',') })),
    enabled: missing.length > 0,
    staleTime: 5 * 60_000,
  });
  const lookup = (id: string) => known[id] ?? chosen.data?.find((r) => r.id === id);
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <Badge key={id} variant="secondary" className="gap-1">
              {lookup(id)?.title || id.slice(0, 8)}
              {!disabled && (
                <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Gỡ">
                  <X className="size-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm bài..." className="pl-8" disabled={disabled} />
      </div>
      {q && (
        <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-1">
          {search.data
            ?.filter((r) => !value.includes(r.id))
            .map((r) => (
              <button
                key={r.id}
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setKnown((k) => ({ ...k, [r.id]: r }));
                  onChange([...value, r.id]);
                  setQ('');
                }}
              >
                <span className="line-clamp-1 flex-1">{r.title || '(chưa có tiêu đề)'}</span>
                {!contentType && <span className="font-mono text-[10px] text-muted-foreground">{r.type}</span>}
                {r.status !== 'PUBLISHED' && <span className="text-[10px] text-muted-foreground">nháp</span>}
                <Plus className="size-3.5 text-muted-foreground" />
              </button>
            ))}
          {search.data && !search.data.length && <p className="px-2 py-1 text-xs text-muted-foreground">Không có kết quả</p>}
        </div>
      )}
    </div>
  );
}

/** Chọn nhiều term của một taxonomy (trường `terms`) — danh sách checkbox thụt lề theo cấp */
function TermsInput({ taxonomy, value, onChange, locale, defaultLocale, disabled }: { taxonomy?: string; value: string[]; onChange: (ids: string[]) => void; locale: string; defaultLocale: string; disabled?: boolean }) {
  const terms = useTaxonomyTerms(taxonomy);
  const flat = useMemo(() => flattenTerms(terms.data ?? []), [terms.data]);
  if (!taxonomy) return <p className="text-xs text-muted-foreground">Trường chưa chọn taxonomy (sửa trong Trường tuỳ chỉnh).</p>;
  return (
    <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border p-3">
      {terms.isLoading && <p className="text-xs text-muted-foreground">Đang tải...</p>}
      {!terms.isLoading && !flat.length && <p className="text-xs text-muted-foreground">Chưa có phân loại nào</p>}
      {flat.map((t) => (
        <label key={t.id} className="flex items-center gap-2 text-sm" style={{ paddingLeft: t.depth * 16 }}>
          <Checkbox checked={value.includes(t.id)} disabled={disabled} onCheckedChange={(c) => onChange(c ? [...value, t.id] : value.filter((x) => x !== t.id))} />
          {termName(t, locale) || termName(t, defaultLocale)}
        </label>
      ))}
    </div>
  );
}

function JsonInput({ value, onChange, disabled }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = useState(() => (value == null ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Textarea
        value={text}
        rows={6}
        className={cn('font-mono text-xs', error && 'border-destructive')}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setError(null);
            onChange(null);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setError(null);
          } catch {
            setError('JSON không hợp lệ — sẽ không được lưu cho tới khi sửa đúng');
          }
        }}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ---------------- repeater ----------------

function RepeaterRow({ id, title, open, onToggle, onRemove, onDuplicate, children, disabled }: { id: string; title: string; open: boolean; onToggle: () => void; onRemove: () => void; onDuplicate: () => void; children: React.ReactNode; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('rounded-lg border bg-background', isDragging && 'z-10 shadow-lg')}>
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button type="button" className="cursor-grab p-1 text-muted-foreground" {...attributes} {...listeners} aria-label="Kéo để sắp xếp">
          <GripVertical className="size-3.5" />
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm">
          {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <span className="truncate">{title}</span>
        </button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onDuplicate} title="Nhân bản" disabled={disabled}>
          <Copy />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove} title="Xoá" className="text-destructive" disabled={disabled}>
          <Trash2 />
        </Button>
      </div>
      {open && <div className="border-t p-3">{children}</div>}
    </div>
  );
}

function RepeaterInput({ field: f, value, onChange, locale, defaultLocale, disabled, label }: { field: CustomFieldDef; value: Values[]; onChange: (v: Values[]) => void; locale: string; defaultLocale: string; disabled?: boolean; label: React.ReactNode }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // đảm bảo mỗi mục có _key ổn định
  const items = useMemo(() => value.map((it) => (typeof it._key === 'string' ? it : { ...it, _key: uid() })), [value]);
  const ids = items.map((it) => String(it._key));
  const itemTitle = (it: Values, i: number) => {
    const raw = f.itemLabelField ? it[f.itemLabelField] : undefined;
    const s = raw && typeof raw === 'object' ? ((raw as Record<string, string>)[locale] ?? (raw as Record<string, string>)[defaultLocale] ?? Object.values(raw as Record<string, string>)[0]) : raw;
    return (typeof s === 'string' && s.trim()) || `Mục ${i + 1}`;
  };
  const max = f.max && f.max > 0 ? f.max : Infinity;
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onChange(arrayMove(items, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
    setOpenIdx(null);
  };
  return (
    <Field label={<span>{label} <span className="font-normal text-muted-foreground">({items.length})</span></span>} help={f.help} required={f.required}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-1.5">
            {items.map((it, i) => (
              <RepeaterRow
                key={ids[i]}
                id={ids[i]}
                title={itemTitle(it, i)}
                open={openIdx === i}
                disabled={disabled}
                onToggle={() => setOpenIdx(openIdx === i ? null : i)}
                onRemove={() => onChange(items.filter((_, j) => j !== i))}
                onDuplicate={() => onChange([...items.slice(0, i + 1), { ...structuredClone(it), _key: uid() }, ...items.slice(i + 1)])}
              >
                <CustomFieldsForm fields={f.fields ?? []} values={it} onChange={(k, v) => onChange(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)))} locale={locale} defaultLocale={defaultLocale} disabled={disabled} />
              </RepeaterRow>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {items.length < max && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          disabled={disabled}
          onClick={() => {
            onChange([...items, { _key: uid(), ...Object.fromEntries((f.fields ?? []).map((sf) => [sf.key, emptyCustomFieldValue(sf)])) }]);
            setOpenIdx(items.length);
          }}
        >
          <Plus /> Thêm mục
        </Button>
      )}
    </Field>
  );
}
