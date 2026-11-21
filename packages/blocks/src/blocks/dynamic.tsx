import type { ReactNode } from 'react';
import type { BlockDefinition, BlockNode, FieldDef, RenderContext } from '../types';
import { EntryCard, PostCard, ProductCard, parseFieldKeys, plainFieldValue, type EntryCardData, type PostCardData, type ProductCardData } from '../cards';
import { CustomFieldValue, hasCustomValue, type PublicCustomField } from '../custom-fields';
import { Html, Txt } from '../text';
import { SectionTitle } from './content';
import { cn, gridCols } from '../utils';

/**
 * Block dữ liệu động (Theme Builder + trang thường).
 * Dữ liệu do API gắn vào `block.resolved` (ThemeTemplatesService / BlockResolverService):
 *  - dynamic-title | dynamic-content | dynamic-meta | dynamic-image | storefront-slot: `resolved.record` (TemplateRecord | null)
 *  - dynamic-field: `resolved.{ record, value, field }`
 *  - query-loop: `resolved.{ items, itemKind, page, totalPages, basePath }`
 *  - breadcrumbs: `resolved.items` ; term-list: `resolved.terms` ; entry-list: `resolved.items`
 * Ở Page Builder (mode 'edit') khi chưa có dữ liệu -> hiện ô giữ chỗ để người soạn biết block đặt ở đâu.
 */

/* ---------------- Kiểu dữ liệu resolved (khai báo cục bộ, khớp TemplateRecord / PublicTerm của @cmsnt/shared) ---------------- */

type Media = { url: string; urls?: Record<string, string>; alt?: Record<string, string> | string; width?: number | null; height?: number | null };

interface RecordLike {
  entity?: string;
  target?: string;
  id: string;
  title: string;
  slug?: string;
  path?: string | null;
  excerpt?: string | null;
  content?: string | null;
  featuredImage?: Media | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  author?: { name: string; avatar?: string | null } | null;
  terms?: Record<string, { name: string; slug?: string; path?: string | null }[]>;
  customFields?: Record<string, unknown>;
  price?: number | null;
  salePrice?: number | null;
}

interface TermLike {
  id: string;
  taxonomy?: string;
  parentId?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  image?: Media | null;
  path?: string | null;
  count?: number;
}

const ALIGN = [
  { value: 'left', label: 'Trái' },
  { value: 'center', label: 'Giữa' },
  { value: 'right', label: 'Phải' },
];
const alignText = (a?: string) => (a === 'center' ? 'text-center justify-center' : a === 'right' ? 'text-right justify-end' : '');

/** Ô giữ chỗ trong Page Builder */
function Placeholder({ ctx, children, className }: { ctx: RenderContext; children: string; className?: string }) {
  if (ctx.mode !== 'edit') return null;
  return <div className={cn('rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-400', className)}>{children}</div>;
}

const getRecord = (resolved: Record<string, any>): RecordLike | null => (resolved?.record && typeof resolved.record === 'object' ? (resolved.record as RecordLike) : null);

function fmtDate(iso: string | null | undefined, locale: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : locale, { dateStyle: 'medium', timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

const COLUMN_OPTIONS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} cột` }));
const ORDER_OPTIONS = [
  { value: 'publishedAt_desc', label: 'Mới nhất' },
  { value: 'publishedAt_asc', label: 'Cũ nhất' },
  { value: 'title_asc', label: 'Tên A → Z' },
  { value: 'sortOrder_asc', label: 'Thứ tự thủ công' },
];
const LAYOUT_OPTIONS = [
  { value: 'grid', label: 'Lưới thẻ' },
  { value: 'list', label: 'Danh sách (ảnh trái)' },
  { value: 'overlay', label: 'Chữ trên ảnh' },
];
/** Tuỳ chọn hiển thị thẻ dùng chung cho query-loop / entry-list */
const CARD_FIELDS: FieldDef[] = [
  { name: 'layout', label: 'Bố cục', type: 'select', options: LAYOUT_OPTIONS },
  { name: 'columns', label: 'Số cột', type: 'select', options: COLUMN_OPTIONS, showIf: { field: 'layout', equals: ['grid', 'overlay'] } },
  { name: 'showImage', label: 'Hiện ảnh', type: 'boolean' },
  { name: 'showExcerpt', label: 'Hiện mô tả ngắn', type: 'boolean' },
  { name: 'showDate', label: 'Hiện ngày đăng', type: 'boolean' },
  { name: 'showTerms', label: 'Hiện phân loại', type: 'boolean' },
  { name: 'fields', label: 'Trường tuỳ chỉnh hiện trên thẻ', type: 'text', placeholder: 'gia, vi_tri', help: 'Mã trường, cách nhau dấu phẩy (vd giá, vị trí, diện tích)' },
];

type CardDisplay = { layout: 'grid' | 'list' | 'overlay'; columns: number | string; showImage: boolean; showExcerpt: boolean; showDate: boolean; showTerms: boolean; fields: string };

/** Lưới thẻ theo loại (entry / post / product) */
function CardsGrid({ items, kind, data, ctx }: { items: unknown[]; kind: string; data: CardDisplay; ctx: RenderContext }) {
  const layout = data.layout === 'list' ? 'list' : data.layout === 'overlay' ? 'overlay' : 'grid';
  const cols = layout === 'list' ? 'grid-cols-1' : gridCols(data.columns, 3);
  if (kind === 'product') {
    return (
      <div className={cn('grid gap-3 @3xl:gap-5', layout === 'list' ? gridCols(2) : gridCols(data.columns, 4))}>
        {(items as ProductCardData[]).map((p) => (
          <ProductCard key={p.id} product={p} ctx={ctx} />
        ))}
      </div>
    );
  }
  if (kind === 'post') {
    return (
      <div className={cn('grid gap-8', cols)}>
        {(items as PostCardData[]).map((p) => (
          <PostCard key={p.id} post={p} ctx={ctx} layout={layout === 'list' ? 'list' : 'grid'} />
        ))}
      </div>
    );
  }
  const options = { layout, showImage: data.showImage !== false, showExcerpt: data.showExcerpt !== false, showDate: !!data.showDate, showTerms: data.showTerms !== false, fields: parseFieldKeys(data.fields) } as const;
  return (
    <div className={cn('grid gap-6 @3xl:gap-8', cols)}>
      {(items as EntryCardData[]).map((e) => (
        <EntryCard key={e.id} entry={e} ctx={ctx} options={options} />
      ))}
    </div>
  );
}

/** Phân trang đơn giản cho query-loop (link ?page=N theo basePath API trả) */
function LoopPager({ ctx, basePath, page, totalPages }: { ctx: RenderContext; basePath: string; page: number; totalPages: number }) {
  if (totalPages <= 1) return null;
  const href = (p: number) => {
    const [path, qs = ''] = basePath.split('?');
    const sp = new URLSearchParams(qs);
    if (p > 1) sp.set('page', String(p));
    else sp.delete('page');
    const s = sp.toString();
    return ctx.href(`${path || '/'}${s ? `?${s}` : ''}`);
  };
  const set = new Set([1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages));
  const pages = [...set].sort((a, b) => a - b);
  const cls = 'flex h-10 min-w-10 items-center justify-center rounded-lg border px-3 text-sm font-medium';
  return (
    <nav aria-label="Pagination" className="mt-10 flex justify-center">
      <ul className="flex flex-wrap items-center gap-1.5">
        {pages.map((p, i) => (
          <li key={p} className="flex items-center gap-1.5">
            {i > 0 && p - pages[i - 1] > 1 && <span className="px-1 text-slate-400">…</span>}
            {p === page ? (
              <span aria-current="page" className={cn(cls, 'border-brand bg-brand text-white')}>
                {p}
              </span>
            ) : (
              <ctx.Link href={href(p)} className={cn(cls, 'border-slate-200 hover:border-brand hover:text-brand')}>
                {String(p)}
              </ctx.Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ---------------- dynamic-title ---------------- */

export const dynamicTitle: BlockDefinition<{ tag: string; size: string; align: string; prefix: string }> = {
  type: 'dynamic-title',
  label: 'Tiêu đề động',
  description: 'Tiêu đề của bài / sản phẩm / trang đang xem',
  icon: 'heading-1',
  category: 'content',
  fields: [
    { name: 'tag', label: 'Thẻ heading (SEO)', type: 'select', options: ['h1', 'h2', 'h3', 'p'].map((v) => ({ value: v, label: v.toUpperCase() })) },
    { name: 'size', label: 'Cỡ chữ', type: 'select', options: [{ value: 'sm', label: 'Nhỏ' }, { value: 'md', label: 'Vừa' }, { value: 'lg', label: 'Lớn' }, { value: 'xl', label: 'Rất lớn' }] },
    { name: 'align', label: 'Căn lề', type: 'select', options: ALIGN },
    { name: 'prefix', label: 'Chữ đứng trước', type: 'text', placeholder: 'vd: Dự án' },
  ],
  defaults: { tag: 'h1', size: 'lg', align: 'left', prefix: '' },
  defaultSettings: { paddingTop: 'sm', paddingBottom: 'sm' },
  component: ({ data, ctx, block, resolved }) => {
    const record = getRecord(resolved);
    const Tag = (['h1', 'h2', 'h3', 'p'].includes(data.tag) ? data.tag : 'h1') as 'h1' | 'h2' | 'h3' | 'p';
    const size = { sm: 'text-xl @3xl:text-2xl', md: 'text-2xl @3xl:text-3xl', lg: 'text-3xl @3xl:text-4xl', xl: 'text-4xl @3xl:text-6xl' }[data.size] ?? 'text-3xl @3xl:text-4xl';
    const title = record?.title ?? (ctx.mode === 'edit' ? 'Tiêu đề bản ghi đang xem' : '');
    if (!title) return null;
    return (
      <div className={alignText(data.align)}>
        <Txt ctx={ctx} block={block} path="prefix" value={data.prefix} as="p" className="mb-2 block text-sm font-semibold uppercase tracking-wide text-brand" placeholder="" />
        <Tag className={cn('font-bold leading-tight tracking-tight', size, !record && 'text-slate-400')}>{title}</Tag>
      </div>
    );
  },
};

/* ---------------- dynamic-content ---------------- */

export const dynamicContent: BlockDefinition<{ showExcerpt: boolean }> = {
  type: 'dynamic-content',
  label: 'Nội dung động',
  description: 'Nội dung chính (HTML hoặc block) của bản ghi đang xem',
  icon: 'file-text',
  category: 'content',
  fields: [{ name: 'showExcerpt', label: 'Hiện mô tả ngắn phía trên', type: 'boolean' }],
  defaults: { showExcerpt: false },
  defaultSettings: { container: 'narrow' },
  component: ({ data, ctx, resolved }) => {
    const record = getRecord(resolved);
    const blocks = (Array.isArray(resolved?.blocks) ? resolved.blocks : []) as BlockNode[];
    if (!record && !blocks.length) return <Placeholder ctx={ctx}>Nội dung của bản ghi sẽ hiển thị tại đây</Placeholder>;
    return (
      <div>
        {data.showExcerpt && record?.excerpt ? <p className="mb-6 text-lg text-slate-600">{record.excerpt}</p> : null}
        {blocks.length ? (
          <div className={cn(ctx.mode === 'edit' && 'pointer-events-none')}>{ctx.renderBlocks?.(blocks)}</div>
        ) : record?.content ? (
          <Html edit={ctx.mode === 'edit'} html={record.content} className="cms-content prose prose-slate max-w-none prose-a:text-brand prose-img:rounded-xl" />
        ) : (
          <Placeholder ctx={ctx}>Bản ghi chưa có nội dung</Placeholder>
        )}
      </div>
    );
  },
};

/* ---------------- dynamic-meta ---------------- */

export const dynamicMeta: BlockDefinition<{ showDate: boolean; showUpdated: boolean; showAuthor: boolean; showTerms: boolean; taxonomy: string; align: string }> = {
  type: 'dynamic-meta',
  label: 'Thông tin bài (meta)',
  description: 'Ngày đăng, tác giả, phân loại của bản ghi đang xem',
  icon: 'info',
  category: 'content',
  fields: [
    { name: 'showDate', label: 'Ngày đăng', type: 'boolean' },
    { name: 'showUpdated', label: 'Ngày cập nhật', type: 'boolean' },
    { name: 'showAuthor', label: 'Tác giả', type: 'boolean' },
    { name: 'showTerms', label: 'Phân loại / chuyên mục', type: 'boolean' },
    { name: 'taxonomy', label: 'Chỉ hiện taxonomy', type: 'taxonomy', help: 'Để trống = mọi phân loại', showIf: { field: 'showTerms', equals: true } },
    { name: 'align', label: 'Căn lề', type: 'select', options: ALIGN },
  ],
  defaults: { showDate: true, showUpdated: false, showAuthor: true, showTerms: true, taxonomy: '', align: 'left' },
  defaultSettings: { paddingTop: 'sm', paddingBottom: 'sm' },
  component: ({ data, ctx, resolved }) => {
    const r = getRecord(resolved);
    if (!r) return <Placeholder ctx={ctx}>Ngày đăng · Tác giả · Phân loại</Placeholder>;
    const terms = data.showTerms ? (data.taxonomy ? (r.terms?.[data.taxonomy] ?? []) : Object.values(r.terms ?? {}).flat()) : [];
    const parts: { key: string; node: ReactNode }[] = [];
    if (data.showDate && r.publishedAt) parts.push({ key: 'date', node: <time dateTime={r.publishedAt}>{fmtDate(r.publishedAt, ctx.locale)}</time> });
    if (data.showUpdated && r.updatedAt) parts.push({ key: 'updated', node: <time dateTime={r.updatedAt}>↻ {fmtDate(r.updatedAt, ctx.locale)}</time> });
    if (data.showAuthor && r.author?.name) parts.push({ key: 'author', node: <span className="font-medium text-slate-700">{r.author.name}</span> });
    if (!parts.length && !terms.length) return null;
    return (
      <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500', alignText(data.align))}>
        {parts.map((p) => (
          <span key={p.key}>{p.node}</span>
        ))}
        {terms.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {terms.map((t, i) =>
              t.path ? (
                <ctx.Link key={`${t.slug}-${i}`} href={ctx.href(t.path)} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 hover:bg-brand hover:text-white">
                  {t.name}
                </ctx.Link>
              ) : (
                <span key={`${t.slug}-${i}`} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                  {t.name}
                </span>
              ),
            )}
          </span>
        )}
      </div>
    );
  },
};

/* ---------------- dynamic-image ---------------- */

export const dynamicImage: BlockDefinition<{ source: 'featured' | 'field'; fieldKey: string; aspect: string; fit: string; rounded: boolean; linkToRecord: boolean }> = {
  type: 'dynamic-image',
  label: 'Ảnh động',
  description: 'Ảnh đại diện hoặc ảnh từ trường tuỳ chỉnh của bản ghi đang xem',
  icon: 'image',
  category: 'media',
  fields: [
    { name: 'source', label: 'Nguồn ảnh', type: 'select', options: [{ value: 'featured', label: 'Ảnh đại diện' }, { value: 'field', label: 'Trường tuỳ chỉnh' }] },
    { name: 'fieldKey', label: 'Mã trường ảnh', type: 'custom-field-key', showIf: { field: 'source', equals: 'field' } },
    { name: 'aspect', label: 'Tỉ lệ khung', type: 'select', options: [{ value: 'auto', label: 'Theo ảnh' }, { value: '16/9', label: '16:9' }, { value: '4/3', label: '4:3' }, { value: '1/1', label: 'Vuông' }, { value: '21/9', label: '21:9 (banner)' }] },
    { name: 'fit', label: 'Cách lấp ảnh', type: 'select', options: [{ value: 'cover', label: 'Lấp đầy (cắt)' }, { value: 'contain', label: 'Vừa khung' }] },
    { name: 'rounded', label: 'Bo góc', type: 'boolean' },
    { name: 'linkToRecord', label: 'Bấm ảnh mở bản ghi', type: 'boolean' },
  ],
  defaults: { source: 'featured', fieldKey: '', aspect: '16/9', fit: 'cover', rounded: true, linkToRecord: false },
  component: ({ data, ctx, resolved }) => {
    const record = getRecord(resolved);
    const img = (resolved?.image ?? (data.source === 'featured' ? record?.featuredImage : null)) as Media | null;
    if (!img?.url) return <Placeholder ctx={ctx} className="aspect-video content-center">{data.source === 'field' ? `Ảnh từ trường “${data.fieldKey || '?'}”` : 'Ảnh đại diện của bản ghi'}</Placeholder>;
    const src = img.urls?.large ?? img.url;
    const alt = typeof img.alt === 'string' ? img.alt : (img.alt?.[ctx.locale] ?? record?.title ?? '');
    const box = cn('relative block w-full overflow-hidden bg-slate-100', data.rounded && 'rounded-2xl');
    const image =
      data.aspect === 'auto' ? (
        <span className={box}>
          <ctx.Image src={src} alt={alt} width={img.width ?? 1200} height={img.height ?? 675} sizes="(max-width: 1024px) 100vw, 1024px" className="h-auto w-full" />
        </span>
      ) : (
        <span className={box} style={{ aspectRatio: data.aspect }}>
          <ctx.Image src={src} alt={alt} fill sizes="(max-width: 1024px) 100vw, 1024px" className={data.fit === 'contain' ? 'object-contain' : 'object-cover'} />
        </span>
      );
    return data.linkToRecord && record?.path ? (
      <ctx.Link href={ctx.href(record.path)} aria-label={record.title}>
        {image}
      </ctx.Link>
    ) : (
      image
    );
  },
};

/* ---------------- dynamic-field ---------------- */

const FORMAT_TYPE: Record<string, string> = { text: 'text', html: 'richtext', image: 'image', gallery: 'gallery', link: 'link', date: 'date', number: 'number' };

export const dynamicField: BlockDefinition<{ fieldKey: string; format: string; label: string; showLabel: boolean; layout: string }> = {
  type: 'dynamic-field',
  label: 'Trường tuỳ chỉnh động',
  description: 'Giá trị một trường tuỳ chỉnh của bản ghi đang xem',
  icon: 'brackets',
  category: 'content',
  fields: [
    { name: 'fieldKey', label: 'Mã trường', type: 'custom-field-key' },
    {
      name: 'format',
      label: 'Kiểu hiển thị',
      type: 'select',
      options: [
        { value: 'auto', label: 'Tự động theo loại trường' },
        { value: 'text', label: 'Chữ' },
        { value: 'html', label: 'Văn bản định dạng' },
        { value: 'image', label: 'Ảnh' },
        { value: 'gallery', label: 'Bộ ảnh' },
        { value: 'link', label: 'Liên kết' },
        { value: 'list', label: 'Danh sách' },
        { value: 'date', label: 'Ngày' },
        { value: 'number', label: 'Số' },
      ],
    },
    { name: 'label', label: 'Nhãn', type: 'text', help: 'Để trống = dùng nhãn của trường' },
    { name: 'showLabel', label: 'Hiện nhãn', type: 'boolean' },
    { name: 'layout', label: 'Bố cục', type: 'select', options: [{ value: 'stacked', label: 'Nhãn trên, giá trị dưới' }, { value: 'inline', label: 'Cùng một dòng' }] },
  ],
  defaults: { fieldKey: '', format: 'auto', label: '', showLabel: true, layout: 'stacked' },
  defaultSettings: { paddingTop: 'sm', paddingBottom: 'sm' },
  component: ({ data, ctx, resolved }) => {
    const field = (resolved?.field ?? null) as { key: string; label: string; type: string } | null;
    const record = getRecord(resolved);
    const value = resolved && 'value' in resolved ? resolved.value : record?.customFields?.[data.fieldKey];
    const label = data.label || field?.label || data.fieldKey;
    if (!hasCustomValue(value) && typeof value !== 'boolean') return <Placeholder ctx={ctx}>{`Giá trị trường “${data.fieldKey || 'chưa chọn'}”`}</Placeholder>;
    let body: ReactNode;
    if (data.format === 'list') {
      const list = (Array.isArray(value) ? value : [value]).map((v) => plainFieldValue(v, ctx.locale)).filter(Boolean);
      body = (
        <ul className="list-disc space-y-1 pl-5">
          {list.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      );
    } else if (data.format === 'text') {
      body = <span>{plainFieldValue(value, ctx.locale)}</span>;
    } else {
      const type = data.format === 'auto' || !FORMAT_TYPE[data.format] ? (field?.type ?? (typeof value === 'number' ? 'number' : 'text')) : FORMAT_TYPE[data.format];
      const f: PublicCustomField = { key: data.fieldKey, label, type, value };
      body = <CustomFieldValue field={f} ctx={ctx} />;
    }
    if (!data.showLabel) return <div data-field={data.fieldKey}>{body}</div>;
    return data.layout === 'inline' ? (
      <div data-field={data.fieldKey} className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-slate-600">{label}:</span>
        {body}
      </div>
    ) : (
      <div data-field={data.fieldKey}>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <div className="mt-1">{body}</div>
      </div>
    );
  },
};

/* ---------------- query-loop ---------------- */

type QueryLoopData = CardDisplay & {
  title: string;
  source: 'current' | 'query';
  contentType: string;
  taxonomy: string;
  termIds: string[];
  limit: number;
  orderBy: string;
  featuredOnly: boolean;
  pagination: boolean;
  emptyText: string;
};

export const queryLoop: BlockDefinition<QueryLoopData> = {
  type: 'query-loop',
  label: 'Vòng lặp nội dung',
  description: 'Danh sách bản ghi của trang lưu trữ đang xem, hoặc theo truy vấn tuỳ chọn',
  icon: 'repeat',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'source', label: 'Nguồn', type: 'select', options: [{ value: 'current', label: 'Danh sách của trang đang xem' }, { value: 'query', label: 'Truy vấn tuỳ chọn' }] },
    { name: 'contentType', label: 'Loại nội dung', type: 'content-type', help: 'Loại nội dung tuỳ biến, hoặc "post" (bài viết) / "product" (sản phẩm)', showIf: { field: 'source', equals: 'query' } },
    { name: 'taxonomy', label: 'Lọc theo taxonomy', type: 'taxonomy', showIf: { field: 'source', equals: 'query' } },
    { name: 'termIds', label: 'Term', type: 'terms', taxonomyField: 'taxonomy', showIf: { field: 'source', equals: 'query' } },
    { name: 'limit', label: 'Số lượng', type: 'number', min: 1, max: 48 },
    { name: 'orderBy', label: 'Sắp xếp', type: 'select', options: ORDER_OPTIONS, showIf: { field: 'source', equals: 'query' } },
    { name: 'featuredOnly', label: 'Chỉ bài nổi bật', type: 'boolean', showIf: { field: 'source', equals: 'query' } },
    ...CARD_FIELDS,
    { name: 'pagination', label: 'Phân trang', type: 'boolean' },
    { name: 'emptyText', label: 'Chữ khi không có kết quả', type: 'text' },
  ],
  defaults: {
    title: '',
    source: 'current',
    contentType: '',
    taxonomy: '',
    termIds: [],
    limit: 12,
    orderBy: 'publishedAt_desc',
    featuredOnly: false,
    layout: 'grid',
    columns: 3,
    showImage: true,
    showExcerpt: true,
    showDate: false,
    showTerms: true,
    fields: '',
    pagination: true,
    emptyText: '',
  },
  component: ({ data, ctx, block, resolved }) => {
    const items = (Array.isArray(resolved?.items) ? resolved.items : []) as unknown[];
    const kind = String(resolved?.itemKind ?? (data.contentType === 'post' || data.contentType === 'product' ? data.contentType : 'entry'));
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} />
        {items.length ? (
          <CardsGrid items={items} kind={kind} data={data} ctx={ctx} />
        ) : ctx.mode === 'edit' ? (
          <Placeholder ctx={ctx}>{data.source === 'current' ? 'Danh sách bản ghi của trang lưu trữ sẽ hiển thị tại đây' : 'Chưa có bản ghi khớp truy vấn'}</Placeholder>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">{data.emptyText || ctx.t('noResults')}</p>
        )}
        {data.pagination && items.length > 0 && (
          <LoopPager ctx={ctx} basePath={String(resolved?.basePath ?? '')} page={Number(resolved?.page) || 1} totalPages={Number(resolved?.totalPages) || 1} />
        )}
      </div>
    );
  },
};

/* ---------------- entry-list ---------------- */

type EntryListData = CardDisplay & {
  title: string;
  subtitle: string;
  contentType: string;
  taxonomy: string;
  termIds: string[];
  limit: number;
  orderBy: string;
  featuredOnly: boolean;
  viewAllLabel: string;
  viewAllUrl: string;
};

export const entryList: BlockDefinition<EntryListData> = {
  type: 'entry-list',
  label: 'Danh sách nội dung tuỳ biến',
  description: 'Dự án, dịch vụ, tin tuyển dụng... theo loại nội dung',
  icon: 'layout-grid',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    { name: 'contentType', label: 'Loại nội dung', type: 'content-type' },
    { name: 'taxonomy', label: 'Lọc theo taxonomy', type: 'taxonomy' },
    { name: 'termIds', label: 'Term', type: 'terms', taxonomyField: 'taxonomy' },
    { name: 'limit', label: 'Số lượng', type: 'number', min: 1, max: 48 },
    { name: 'orderBy', label: 'Sắp xếp', type: 'select', options: ORDER_OPTIONS },
    { name: 'featuredOnly', label: 'Chỉ bài nổi bật', type: 'boolean' },
    ...CARD_FIELDS,
    { name: 'viewAllLabel', label: 'Nút xem tất cả - chữ', type: 'text' },
    { name: 'viewAllUrl', label: 'Nút xem tất cả - liên kết', type: 'url' },
  ],
  defaults: {
    title: '',
    subtitle: '',
    contentType: '',
    taxonomy: '',
    termIds: [],
    limit: 6,
    orderBy: 'publishedAt_desc',
    featuredOnly: false,
    layout: 'grid',
    columns: 3,
    showImage: true,
    showExcerpt: true,
    showDate: false,
    showTerms: true,
    fields: '',
    viewAllLabel: '',
    viewAllUrl: '',
  },
  component: ({ data, ctx, block, resolved }) => {
    const items = (Array.isArray(resolved?.items) ? resolved.items : []) as EntryCardData[];
    // storefront cũ / API chưa gắn dữ liệu: ngoài Page Builder thì ẩn hẳn
    if (!items.length && ctx.mode !== 'edit') return null;
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} />
        {items.length ? <CardsGrid items={items} kind="entry" data={data} ctx={ctx} /> : <Placeholder ctx={ctx}>{data.contentType ? 'Chưa có bài nào khớp điều kiện' : 'Chọn loại nội dung để hiển thị danh sách'}</Placeholder>}
        {data.viewAllUrl && (
          <div className="mt-8 text-center">
            <ctx.Link href={data.viewAllUrl} className="inline-flex rounded-lg border border-slate-300 px-6 py-2.5 text-sm font-semibold hover:border-brand hover:text-brand">
              {data.viewAllLabel || ctx.t('viewAll')}
            </ctx.Link>
          </div>
        )}
      </div>
    );
  },
};

/* ---------------- breadcrumbs ---------------- */

export const breadcrumbs: BlockDefinition<{ showHome: boolean }> = {
  type: 'breadcrumbs',
  label: 'Đường dẫn (breadcrumb)',
  description: 'Trang chủ › chuyên mục › trang đang xem',
  icon: 'chevrons-right',
  category: 'content',
  fields: [{ name: 'showHome', label: 'Hiện "Trang chủ"', type: 'boolean' }],
  defaults: { showHome: true },
  defaultSettings: { paddingTop: 'sm', paddingBottom: 'none' },
  component: ({ data, ctx, resolved }) => {
    let items = (Array.isArray(resolved?.items) ? resolved.items : []) as { label: string; path: string | null }[];
    if (!data.showHome) items = items.filter((it, i) => !(i === 0 && (it.path === '/' || it.path === `/${ctx.locale}`)));
    if (!items.length) return <Placeholder ctx={ctx} className="p-3 text-left">Trang chủ › … › Trang đang xem</Placeholder>;
    return (
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
          {items.map((it, i) => {
            const last = i === items.length - 1;
            return (
              <li key={i} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="text-slate-300">/</span>}
                {it.path && !last ? (
                  <ctx.Link href={ctx.href(it.path)} className="hover:text-brand">
                    {it.label}
                  </ctx.Link>
                ) : (
                  <span aria-current={last ? 'page' : undefined} className={last ? 'font-medium text-slate-700' : undefined}>
                    {it.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    );
  },
};

/* ---------------- term-list ---------------- */

export const termList: BlockDefinition<{ title: string; taxonomy: string; showCount: boolean; layout: string; parentOnly: boolean; columns: number | string }> = {
  type: 'term-list',
  label: 'Danh sách phân loại',
  description: 'Các term của một taxonomy (lĩnh vực, khu vực, cấp độ...)',
  icon: 'tags',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'taxonomy', label: 'Taxonomy', type: 'taxonomy' },
    { name: 'layout', label: 'Bố cục', type: 'select', options: [{ value: 'chips', label: 'Nhãn' }, { value: 'list', label: 'Danh sách' }, { value: 'grid', label: 'Lưới thẻ có ảnh' }] },
    { name: 'columns', label: 'Số cột', type: 'select', options: [2, 3, 4, 6].map((n) => ({ value: String(n), label: `${n} cột` })), showIf: { field: 'layout', equals: 'grid' } },
    { name: 'showCount', label: 'Hiện số bài', type: 'boolean' },
    { name: 'parentOnly', label: 'Chỉ term cấp gốc', type: 'boolean' },
  ],
  defaults: { title: '', taxonomy: '', showCount: true, layout: 'chips', parentOnly: false, columns: 4 },
  component: ({ data, ctx, block, resolved }) => {
    let terms = (Array.isArray(resolved?.terms) ? resolved.terms : []) as TermLike[];
    if (data.parentOnly) terms = terms.filter((t) => !t.parentId);
    if (!terms.length) return ctx.mode === 'edit' ? <Placeholder ctx={ctx}>{data.taxonomy ? 'Taxonomy chưa có term nào' : 'Chọn taxonomy để hiển thị'}</Placeholder> : null;
    const Item = ({ t, className }: { t: TermLike; className: string }) => {
      const label = (
        <>
          <span>{t.name}</span>
          {data.showCount && t.count != null && <span className="text-xs opacity-60">{t.count}</span>}
        </>
      );
      return t.path ? (
        <ctx.Link href={ctx.href(t.path)} className={className}>
          {label}
        </ctx.Link>
      ) : (
        <span className={className}>{label}</span>
      );
    };
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} />
        {data.layout === 'grid' ? (
          <div className={cn('grid gap-3 @3xl:gap-5', gridCols(data.columns, 4))}>
            {terms.map((t) => (
              <div key={t.id} className="group relative aspect-[4/3] overflow-hidden rounded-2xl bg-slate-100">
                {t.image?.url && <ctx.Image src={t.image.urls?.medium ?? t.image.url} alt={t.name} fill sizes="(max-width:768px) 50vw, 25vw" className="object-cover transition duration-500 group-hover:scale-105" />}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 text-white">
                  <Item t={t} className="flex items-baseline justify-between gap-2 font-semibold after:absolute after:inset-0" />
                </div>
              </div>
            ))}
          </div>
        ) : data.layout === 'list' ? (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {terms.map((t) => (
              <li key={t.id}>
                <Item t={t} className="flex items-center justify-between px-4 py-3 text-sm text-slate-700 hover:text-brand" />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {terms.map((t) => (
              <li key={t.id}>
                <Item t={t} className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3.5 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand" />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
};

/* ---------------- storefront-slot ---------------- */

/** Vùng chức năng storefront hiện thực sẵn (giá trị field type "storefront-slot") */
export const STOREFRONT_SLOTS: { value: string; label: string }[] = [
  { value: 'product-gallery', label: 'Bộ ảnh sản phẩm' },
  { value: 'product-purchase', label: 'Giá & nút mua hàng' },
  { value: 'product-reviews', label: 'Đánh giá sản phẩm' },
  { value: 'product-listing', label: 'Danh sách sản phẩm (bộ lọc + phân trang)' },
  { value: 'post-comments', label: 'Bình luận bài viết' },
  { value: 'share-buttons', label: 'Nút chia sẻ' },
  { value: 'related-posts', label: 'Bài viết liên quan' },
  { value: 'related-entries', label: 'Nội dung liên quan (loại tuỳ biến)' },
  { value: 'entry-default', label: 'Bố cục mặc định của nội dung tuỳ biến' },
  { value: 'page-content', label: 'Nội dung trang' },
];

export const storefrontSlot: BlockDefinition<{ slot: string }> = {
  type: 'storefront-slot',
  label: 'Vùng chức năng website',
  description: 'Chèn khu chức năng có sẵn: nút mua, bộ ảnh, đánh giá, bình luận, danh sách sản phẩm...',
  icon: 'puzzle',
  category: 'advanced',
  fields: [{ name: 'slot', label: 'Vùng chức năng', type: 'storefront-slot' }],
  defaults: { slot: '' },
  defaultSettings: { paddingTop: 'sm', paddingBottom: 'sm' },
  component: ({ data, ctx, block }) => {
    const node = data.slot ? ctx.renderSlot?.(data.slot, block) : null;
    if (node != null && node !== false) return <>{node}</>;
    const label = STOREFRONT_SLOTS.find((s) => s.value === data.slot)?.label ?? data.slot;
    return <Placeholder ctx={ctx}>{data.slot ? `Vùng “${label}” — hiển thị khi xem trên website` : 'Chọn vùng chức năng'}</Placeholder>;
  },
};
