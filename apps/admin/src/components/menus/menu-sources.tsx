'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, Boxes, FileText, FolderTree, Home, Link2, Loader2, Newspaper, Package, Plus, Tags, type LucideIcon } from 'lucide-react';
import type { ContentTypeView, MenuItemNode, TaxonomyView } from '@cmsnt/shared';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError, errorMessage, type Paginated } from '@/lib/api';
import type { I18nText } from '@/lib/types';
import { useDebounce } from '@/hooks/use-debounce';
import { useLanguages } from '@/hooks/use-languages';
import { cn } from '@/lib/utils';

/**
 * Loại mục menu. Ngoài các loại lõi trong @cmsnt/shared, giai đoạn 6 thêm:
 * - `entry`: bài của loại nội dung tuỳ biến (refId = id bài)
 * - `term`: mục phân loại tuỳ biến (refId = id term)
 * - `content_type_archive`: trang lưu trữ của loại nội dung (refId = key loại)
 * (khai báo cục bộ vì MenuItemNode['type'] ở shared chưa có các loại này)
 */
export type MenuItemType = MenuItemNode['type'];

/** Tạo mục menu với loại mở rộng (ép kiểu về MenuItemNode để lưu chung cấu trúc) */
const node = (n: Omit<MenuItemNode, 'type'> & { type: MenuItemType }) => n as unknown as MenuItemNode;

interface SourceItem {
  id: string;
  label: I18nText;
  depth?: number;
  note?: string;
}

type Tr = { locale: string; title?: string; name?: string };
const toLabel = (trs: Tr[]): I18nText => Object.fromEntries(trs.map((t) => [t.locale, t.title ?? t.name ?? '']));

interface SourceDef {
  type: MenuItemType;
  label: string;
  icon: LucideIcon;
  /** true = API trả toàn bộ, lọc phía client */
  local?: boolean;
  /** phân biệt cache khi nhiều nguồn cùng `type` (vd entry của từng loại nội dung) */
  cacheKey?: string;
  fetch: (search: string, defaultLocale: string) => Promise<SourceItem[]>;
}

type Cat = { id: string; parentId: string | null; translations: Tr[] };
/** Sắp danh mục theo cây để hiển thị thụt lề */
function treeOrder(cats: Cat[]): SourceItem[] {
  const out: SourceItem[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const c of cats.filter((x) => (x.parentId ?? null) === parentId)) {
      out.push({ id: c.id, label: toLabel(c.translations), depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  // danh mục mồ côi (cha không tồn tại)
  for (const c of cats) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, label: toLabel(c.translations) });
  return out;
}

const STATUS_NOTE: Record<string, string> = { DRAFT: 'nháp', ARCHIVED: 'lưu trữ', SCHEDULED: 'hẹn giờ' };

export const SOURCES: SourceDef[] = [
  {
    type: 'page',
    label: 'Trang',
    icon: FileText,
    fetch: (search) =>
      api.get<Paginated<{ id: string; status: string; translations: Tr[] }>>('/admin/pages', { search, limit: 50 }).then((r) => r.data.map((p) => ({ id: p.id, label: toLabel(p.translations), note: STATUS_NOTE[p.status] }))),
  },
  {
    type: 'post',
    label: 'Bài viết',
    icon: Newspaper,
    fetch: (search) =>
      api.get<Paginated<{ id: string; status: string; translations: Tr[] }>>('/admin/posts', { search, limit: 50 }).then((r) => r.data.map((p) => ({ id: p.id, label: toLabel(p.translations), note: STATUS_NOTE[p.status] }))),
  },
  { type: 'post_category', label: 'Chuyên mục bài viết', icon: Tags, local: true, fetch: () => api.get<Cat[]>('/admin/posts/categories').then(treeOrder) },
  {
    type: 'product',
    label: 'Sản phẩm',
    icon: Package,
    fetch: (search) =>
      api.get<Paginated<{ id: string; status: string; translations: Tr[] }>>('/admin/products', { search, limit: 50 }).then((r) => r.data.map((p) => ({ id: p.id, label: toLabel(p.translations), note: STATUS_NOTE[p.status] }))),
  },
  { type: 'product_category', label: 'Danh mục sản phẩm', icon: FolderTree, local: true, fetch: () => api.get<Cat[]>('/admin/products/categories').then(treeOrder) },
];

export const TYPE_LABELS: Record<MenuItemType, string> = {
  custom: 'Liên kết',
  home: 'Trang chủ',
  page: 'Trang',
  post: 'Bài viết',
  post_category: 'Chuyên mục',
  product: 'Sản phẩm',
  product_category: 'Danh mục SP',
  entry: 'Nội dung',
  term: 'Phân loại',
  content_type_archive: 'Trang lưu trữ',
};

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function SourcePanel({ source, onAdd }: { source: SourceDef; onAdd: (items: MenuItemNode[]) => void }) {
  const { defaultLocale } = useLanguages();
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const debounced = useDebounce(search, 300);
  const q = useQuery({
    queryKey: ['menu-source', source.type, source.cacheKey ?? '', source.local ? '' : debounced],
    queryFn: () => source.fetch(source.local ? '' : debounced, defaultLocale),
    staleTime: 60_000,
    // thiếu quyền (403) thì không thử lại
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 1,
  });
  const name = (i: SourceItem) => i.label[defaultLocale] || Object.values(i.label).find(Boolean) || '(không tên)';
  const items = (q.data ?? []).filter((i) => !source.local || !debounced || name(i).toLowerCase().includes(debounced.toLowerCase()));
  const allChecked = items.length > 0 && items.every((i) => checked.includes(i.id));

  const add = () => {
    const picked = (q.data ?? []).filter((i) => checked.includes(i.id));
    onAdd(picked.map((i) => node({ id: newId(), type: source.type, refId: i.id, label: i.label, target: '_self', children: [] })));
    setChecked([]);
  };

  return (
    <div className="space-y-2">
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Tìm ${source.label.toLowerCase()}...`} className="h-8" />
      <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
        {q.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : q.isError ? (
          <p className="py-3 text-center text-xs text-muted-foreground">{q.error instanceof ApiError && q.error.status === 403 ? 'Không có quyền xem' : errorMessage(q.error)}</p>
        ) : items.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">Không có kết quả</p>
        ) : (
          items.map((i) => (
            <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted" style={{ paddingLeft: 6 + (i.depth ?? 0) * 14 }}>
              <Checkbox checked={checked.includes(i.id)} onCheckedChange={(v) => setChecked((c) => (v ? [...c, i.id] : c.filter((x) => x !== i.id)))} />
              <span className="min-w-0 flex-1 truncate">{name(i)}</span>
              {i.note && <span className="text-[10px] text-muted-foreground">({i.note})</span>}
            </label>
          ))
        )}
      </div>
      <div className="flex items-center justify-between">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={allChecked} onCheckedChange={(v) => setChecked(v ? items.map((i) => i.id) : [])} disabled={!items.length} />
          Chọn tất cả
        </label>
        <Button type="button" size="sm" variant="outline" disabled={!checked.length} onClick={add}>
          <Plus /> Thêm vào menu{checked.length ? ` (${checked.length})` : ''}
        </Button>
      </div>
    </div>
  );
}

/** Nhãn đa ngôn ngữ của loại nội dung / taxonomy (số nhiều) */
const pluralLabel = (labels: Record<string, { singular: string; plural: string }>): I18nText => Object.fromEntries(Object.entries(labels ?? {}).map(([loc, l]) => [loc, l.plural || l.singular]));

const labelIn = (labels: Record<string, { singular: string; plural: string }> | undefined, locale: string, fallback: string) => labels?.[locale]?.plural || Object.values(labels ?? {})[0]?.plural || fallback;

function useContentTypes() {
  return useQuery({ queryKey: ['menu-content-types'], queryFn: () => api.get<ContentTypeView[]>('/admin/content-types'), staleTime: 60_000, retry: false });
}

/** Bài của loại nội dung tuỳ biến: chọn loại rồi chọn bài (tìm qua /admin/entries/lookup) */
function EntrySourcePanel({ onAdd }: { onAdd: (items: MenuItemNode[]) => void }) {
  const { defaultLocale } = useLanguages();
  const types = useContentTypes();
  const list = (types.data ?? []).filter((t) => t.isPublic && t.isActive !== false);
  const [type, setType] = useState<string | null>(null);
  const active = type ?? list[0]?.key ?? null;
  if (types.isLoading) return <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />;
  if (!list.length) return <p className="py-2 text-xs text-muted-foreground">{types.isError ? 'Không có quyền xem loại nội dung' : 'Chưa có loại nội dung tuỳ biến công khai.'}</p>;
  const src: SourceDef = {
    type: 'entry',
    label: 'bài',
    icon: Boxes,
    cacheKey: active ?? '',
    fetch: (search, loc) =>
      api.get<{ id: string; title: string; status: string }[]>('/admin/entries/lookup', { type: active!, search }).then((rows) => rows.map((r) => ({ id: r.id, label: { [loc]: r.title }, note: STATUS_NOTE[r.status.toUpperCase()] }))),
  };
  return (
    <div className="space-y-2">
      <Select value={active ?? undefined} onValueChange={setType}>
        <SelectTrigger className="h-8 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {list.map((t) => (
            <SelectItem key={t.key} value={t.key}>
              {labelIn(t.labels, defaultLocale, t.key)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active && <SourcePanel key={active} source={src} onAdd={onAdd} />}
    </div>
  );
}

/** Mục phân loại tuỳ biến: chọn taxonomy rồi chọn term */
function TermSourcePanel({ onAdd }: { onAdd: (items: MenuItemNode[]) => void }) {
  const { defaultLocale } = useLanguages();
  const taxes = useQuery({ queryKey: ['menu-taxonomies'], queryFn: () => api.get<TaxonomyView[]>('/admin/taxonomies'), staleTime: 60_000, retry: false });
  const list = (taxes.data ?? []).filter((t) => t.isPublic);
  const [tax, setTax] = useState<string | null>(null);
  const active = tax ?? list[0]?.key ?? null;
  if (taxes.isLoading) return <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />;
  if (!list.length) return <p className="py-2 text-xs text-muted-foreground">{taxes.isError ? 'Không có quyền xem phân loại' : 'Chưa có phân loại tuỳ biến công khai.'}</p>;
  const src: SourceDef = {
    type: 'term',
    label: 'mục',
    icon: Tags,
    local: true,
    cacheKey: active ?? '',
    fetch: () => api.get<Cat[]>(`/admin/taxonomies/${encodeURIComponent(active!)}/terms`).then(treeOrder),
  };
  return (
    <div className="space-y-2">
      <Select value={active ?? undefined} onValueChange={setTax}>
        <SelectTrigger className="h-8 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {list.map((t) => (
            <SelectItem key={t.key} value={t.key}>
              {labelIn(t.labels, defaultLocale, t.key)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active && <SourcePanel key={active} source={src} onAdd={onAdd} />}
    </div>
  );
}

/** Trang lưu trữ của loại nội dung (vd /du-an) — refId = key loại */
const ARCHIVE_SOURCE: SourceDef = {
  type: 'content_type_archive',
  label: 'Trang lưu trữ',
  icon: Archive,
  local: true,
  fetch: () =>
    api.get<ContentTypeView[]>('/admin/content-types').then((rows) => rows.filter((t) => t.isPublic && t.hasArchive && t.isActive !== false).map((t) => ({ id: t.key, label: pluralLabel(t.labels), note: t.key }))),
};

function CustomLinkPanel({ onAdd }: { onAdd: (items: MenuItemNode[]) => void }) {
  const { defaultLocale } = useLanguages();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const submit = () => {
    if (!url.trim() || !label.trim()) return;
    onAdd([{ id: newId(), type: 'custom', url: url.trim(), label: { [defaultLocale]: label.trim() }, target: /^https?:\/\//.test(url.trim()) ? '_blank' : '_self', children: [] }]);
    setUrl('');
    setLabel('');
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="space-y-1">
        <Label className="text-xs">URL</Label>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https:// hoặc /duong-dan" className="h-8 font-mono text-xs" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Nhãn hiển thị</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="vd: Khuyến mãi" className="h-8" />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="outline" disabled={!url.trim() || !label.trim()}>
          <Plus /> Thêm vào menu
        </Button>
      </div>
    </form>
  );
}

/**
 * Bảng “Thêm mục menu” kiểu WordPress.
 * AccordionContent dùng `h-auto`: nội dung tải sau khi mở (danh sách, ô chọn loại) không bị cắt bởi chiều cao đo lúc mở.
 */
export function MenuSources({ onAdd, disabled }: { onAdd: (items: MenuItemNode[]) => void; disabled?: boolean }) {
  const { languages } = useLanguages();
  return (
    <section className={cn('rounded-xl border bg-card', disabled && 'pointer-events-none opacity-50')}>
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Thêm mục menu</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Nhãn được lấy tự động theo {languages.length > 1 ? 'từng ngôn ngữ' : 'tên nội dung'}</p>
      </div>
      <div className="px-4">
        <div className="flex items-center justify-between border-b py-2.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Home className="size-4 text-muted-foreground" /> Trang chủ
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onAdd([{ id: newId(), type: 'home', label: Object.fromEntries(languages.map((l) => [l.code, l.code === 'vi' ? 'Trang chủ' : 'Home'])), target: '_self', children: [] }])}
          >
            <Plus /> Thêm
          </Button>
        </div>
        <Accordion type="single" collapsible defaultValue="page">
          {SOURCES.map((s) => (
            <AccordionItem key={s.type} value={s.type}>
              <AccordionTrigger className="hover:no-underline">
                <span className="flex items-center gap-2">
                  <s.icon className="size-4 text-muted-foreground" /> {s.label}
                </span>
              </AccordionTrigger>
              <AccordionContent className="h-auto">
                <SourcePanel source={s} onAdd={onAdd} />
              </AccordionContent>
            </AccordionItem>
          ))}
          {/* Loại nội dung tuỳ biến (Custom Post Type) + phân loại + trang lưu trữ */}
          <AccordionItem value="entry">
            <AccordionTrigger className="hover:no-underline">
              <span className="flex items-center gap-2">
                <Boxes className="size-4 text-muted-foreground" /> Nội dung tuỳ biến
              </span>
            </AccordionTrigger>
            <AccordionContent className="h-auto">
              <EntrySourcePanel onAdd={onAdd} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="term">
            <AccordionTrigger className="hover:no-underline">
              <span className="flex items-center gap-2">
                <Tags className="size-4 text-muted-foreground" /> Phân loại
              </span>
            </AccordionTrigger>
            <AccordionContent className="h-auto">
              <TermSourcePanel onAdd={onAdd} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="content_type_archive">
            <AccordionTrigger className="hover:no-underline">
              <span className="flex items-center gap-2">
                <Archive className="size-4 text-muted-foreground" /> Trang lưu trữ loại nội dung
              </span>
            </AccordionTrigger>
            <AccordionContent className="h-auto">
              <SourcePanel source={ARCHIVE_SOURCE} onAdd={onAdd} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="custom">
            <AccordionTrigger className="hover:no-underline">
              <span className="flex items-center gap-2">
                <Link2 className="size-4 text-muted-foreground" /> Liên kết tuỳ chỉnh
              </span>
            </AccordionTrigger>
            <AccordionContent className="h-auto">
              <CustomLinkPanel onAdd={onAdd} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </section>
  );
}
