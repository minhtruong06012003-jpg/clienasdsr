import type { ReactNode } from 'react';
import type { BlockDefinition, RenderContext } from './types';
import { SectionTitle } from './blocks/content';
import { ProductCard, PostCard, productPath } from './cards';
import { Html } from './text';
import { cn, gridCols } from './utils';

/**
 * Hiển thị giá trị trường tuỳ chỉnh (dạng đã qua API public: i18n đã chọn ngôn ngữ, ảnh/sản phẩm đã thành object).
 * Dùng chung cho block "Trường tuỳ chỉnh" trong Page Builder và theme storefront (sản phẩm, bài viết).
 */
export interface PublicCustomField {
  key: string;
  label: string;
  type: string;
  value: unknown;
  options?: { value: string; label: string }[];
  /** trường con (repeater) để render nhãn */
  fields?: { key: string; label: string; type: string }[];
}

type MediaLike = { url: string; urls?: Record<string, string>; alt?: Record<string, string> | string; width?: number | null; height?: number | null; originalName?: string; filename?: string; mimeType?: string; size?: number };

const pickAlt = (m: MediaLike, locale: string) => (typeof m.alt === 'string' ? m.alt : (m.alt?.[locale] ?? Object.values(m.alt ?? {})[0] ?? ''));

/** Giá trị có đáng hiển thị không (bỏ rỗng / null / mảng rỗng) */
export function hasCustomValue(v: unknown): boolean {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('url' in o && typeof o.url === 'string') return !!o.url || !!o.label;
    return Object.keys(o).length > 0;
  }
  return true;
}

/** Render một giá trị theo loại trường */
export function CustomFieldValue({ field: f, ctx, className }: { field: PublicCustomField; ctx: RenderContext; className?: string }): ReactNode {
  const v = f.value;
  if (!hasCustomValue(v) && f.type !== 'boolean') return <span className={cn('text-slate-400', className)}>—</span>;
  switch (f.type) {
    case 'boolean':
      return <span className={cn(v ? 'text-emerald-600' : 'text-slate-400', className)}>{v ? ctx.t('yes') || 'Có' : ctx.t('no') || 'Không'}</span>;
    case 'number':
      return <span className={className}>{typeof v === 'number' ? v.toLocaleString(ctx.locale === 'vi' ? 'vi-VN' : ctx.locale) : String(v)}</span>;
    case 'select': {
      const opt = f.options?.find((o) => o.value === v);
      return <span className={className}>{opt?.label ?? String(v)}</span>;
    }
    case 'multiselect': {
      const list = Array.isArray(v) ? v : [];
      return (
        <span className={cn('flex flex-wrap gap-1', className)}>
          {list.map((x) => (
            <span key={String(x)} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
              {f.options?.find((o) => o.value === x)?.label ?? String(x)}
            </span>
          ))}
        </span>
      );
    }
    case 'date':
      return <span className={className}>{formatDate(String(v), ctx.locale)}</span>;
    case 'datetime':
      return <span className={className}>{formatDate(String(v), ctx.locale, true)}</span>;
    case 'color':
      return (
        <span className={cn('inline-flex items-center gap-1.5', className)}>
          <span className="size-4 rounded border border-slate-200" style={{ background: String(v) }} />
          {String(v)}
        </span>
      );
    case 'url':
      return (
        <a href={String(v)} target="_blank" rel="noreferrer" className={cn('break-all text-brand hover:underline', className)}>
          {String(v)}
        </a>
      );
    case 'email':
      return (
        <a href={`mailto:${String(v)}`} className={cn('text-brand hover:underline', className)}>
          {String(v)}
        </a>
      );
    case 'link': {
      const o = v as { label?: string; url: string; target?: string };
      if (!o.url) return <span className={className}>{o.label}</span>;
      const external = /^https?:\/\//i.test(o.url);
      return external ? (
        <a href={o.url} target={o.target ?? '_self'} rel={o.target === '_blank' ? 'noreferrer' : undefined} className={cn('text-brand hover:underline', className)}>
          {o.label || o.url}
        </a>
      ) : (
        <ctx.Link href={ctx.href(o.url)} target={o.target} className={cn('text-brand hover:underline', className)}>
          {o.label || o.url}
        </ctx.Link>
      );
    }
    case 'richtext':
      // edit = đang ở canvas Page Builder (admin) -> làm sạch trước khi chèn (áp cả cho trường con của repeater vì gọi đệ quy cùng ctx)
      return <Html edit={ctx.mode === 'edit'} html={String(v)} className={cn('prose prose-slate max-w-none text-sm', className)} />;
    case 'textarea':
      return <span className={cn('whitespace-pre-line', className)}>{String(v)}</span>;
    case 'image': {
      const m = v as MediaLike;
      return (
        <span className={cn('block max-w-xs overflow-hidden rounded-lg', className)}>
          <ctx.Image src={m.urls?.medium ?? m.url} alt={pickAlt(m, ctx.locale)} width={m.width ?? 640} height={m.height ?? 360} className="h-auto w-full" />
        </span>
      );
    }
    case 'gallery': {
      const list = (Array.isArray(v) ? v : []) as MediaLike[];
      return (
        <span className={cn('grid grid-cols-3 gap-2 @3xl:grid-cols-4', className)}>
          {list.map((m, i) => (
            <span key={i} className="block aspect-square overflow-hidden rounded-lg bg-slate-100">
              <ctx.Image src={m.urls?.thumb ?? m.urls?.medium ?? m.url} alt={pickAlt(m, ctx.locale)} width={300} height={300} className="h-full w-full object-cover" />
            </span>
          ))}
        </span>
      );
    }
    case 'file': {
      const m = v as MediaLike;
      return (
        <a href={m.url} target="_blank" rel="noreferrer" className={cn('inline-flex items-center gap-1.5 text-brand hover:underline', className)} download>
          {m.originalName || m.filename || m.url}
          {m.size ? <span className="text-xs text-slate-400">({(m.size / 1024).toFixed(0)} KB)</span> : null}
        </a>
      );
    }
    case 'products': {
      const list = (Array.isArray(v) ? v : []) as Parameters<typeof ProductCard>[0]['product'][];
      return (
        <span className={cn('grid gap-4', gridCols(Math.min(list.length, 4)), className)}>
          {list.map((p) => (
            <ProductCard key={p.id} product={p} ctx={ctx} />
          ))}
        </span>
      );
    }
    case 'posts': {
      const list = (Array.isArray(v) ? v : []) as Parameters<typeof PostCard>[0]['post'][];
      return (
        <span className={cn('grid gap-4', gridCols(Math.min(list.length, 3)), className)}>
          {list.map((p) => (
            <PostCard key={p.id} post={p} ctx={ctx} />
          ))}
        </span>
      );
    }
    case 'pages': {
      const list = (Array.isArray(v) ? v : []) as { id: string; title: string; slug: string }[];
      return (
        <span className={cn('flex flex-wrap gap-x-3 gap-y-1', className)}>
          {list.map((p) => (
            <ctx.Link key={p.id} href={ctx.href(`/${p.slug}`)} className="text-brand hover:underline">
              {p.title}
            </ctx.Link>
          ))}
        </span>
      );
    }
    case 'post_category': {
      const c = v as { name: string; slug: string };
      return (
        <ctx.Link href={ctx.href(`/blog/category/${c.slug}`)} className={cn('text-brand hover:underline', className)}>
          {c.name}
        </ctx.Link>
      );
    }
    case 'product_category': {
      const c = v as { name: string; slug: string };
      return (
        <ctx.Link href={ctx.href(`/product-category/${c.slug}`)} className={cn('text-brand hover:underline', className)}>
          {c.name}
        </ctx.Link>
      );
    }
    case 'repeater': {
      const rows = (Array.isArray(v) ? v : []) as Record<string, unknown>[];
      const sub = f.fields ?? [];
      // 1 trường con -> danh sách gạch đầu dòng; nhiều trường -> bảng nhỏ
      if (sub.length <= 1) {
        return (
          <ul className={cn('list-disc space-y-1 pl-5', className)}>
            {rows.map((r, i) => (
              <li key={i}>{sub[0] ? <CustomFieldValue field={{ ...sub[0], value: r[sub[0].key] }} ctx={ctx} /> : JSON.stringify(r)}</li>
            ))}
          </ul>
        );
      }
      return (
        <div className={cn('overflow-x-auto', className)}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                {sub.map((s) => (
                  <th key={s.key} className="py-1.5 pr-3 font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {sub.map((s) => (
                    <td key={s.key} className="py-1.5 pr-3 align-top">
                      <CustomFieldValue field={{ ...s, value: r[s.key] }} ctx={ctx} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'json':
      return <pre className={cn('overflow-x-auto rounded bg-slate-50 p-2 text-xs', className)}>{JSON.stringify(v, null, 2)}</pre>;
    default:
      return <span className={className}>{typeof v === 'string' ? v : JSON.stringify(v)}</span>;
  }
}

function formatDate(iso: string, locale: string, withTime = false) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : locale, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

/** Bảng/danh sách nhãn – giá trị (dùng cho block và theme) */
export function CustomFieldsList({ items, ctx, layout = 'table', className }: { items: PublicCustomField[]; ctx: RenderContext; layout?: 'table' | 'list' | 'grid'; className?: string }) {
  const list = items.filter((i) => hasCustomValue(i.value) || i.type === 'boolean');
  if (!list.length) return null;
  if (layout === 'table') {
    return (
      <table className={cn('w-full overflow-hidden rounded-xl text-sm ring-1 ring-slate-200', className)}>
        <tbody>
          {list.map((i) => (
            <tr key={i.key} className="odd:bg-slate-50">
              <th scope="row" className="w-2/5 px-4 py-3 text-left align-top font-medium text-slate-600">
                {i.label}
              </th>
              <td className="px-4 py-3 text-slate-900">
                <CustomFieldValue field={i} ctx={ctx} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (layout === 'grid') {
    return (
      <dl className={cn('grid gap-4 @3xl:grid-cols-2 @5xl:grid-cols-3', className)}>
        {list.map((i) => (
          <div key={i.key} className="rounded-xl border border-slate-200 bg-white p-4">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{i.label}</dt>
            <dd className="mt-1 text-slate-900">
              <CustomFieldValue field={i} ctx={ctx} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cn('space-y-4', className)}>
      {list.map((i) => (
        <div key={i.key}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{i.label}</dt>
          <dd className="mt-1 text-slate-900">
            <CustomFieldValue field={i} ctx={ctx} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Block "Trường tuỳ chỉnh": hiển thị giá trị trường tuỳ chỉnh của CHÍNH TRANG đang render
 * (API gắn `resolved.items` từ customFields của trang qua BlockResolverService).
 * Storefront cũ chưa build lại sẽ bỏ qua block này (BlockRenderer không biết type -> không render).
 */
export const customFields: BlockDefinition<{ title: string; subtitle: string; groupKey: string; layout: 'table' | 'list' | 'grid' }> = {
  type: 'custom-fields',
  label: 'Trường tuỳ chỉnh',
  description: 'Hiển thị trường tuỳ chỉnh của trang này (nhóm gắn vào Trang ở menu Trường tuỳ chỉnh)',
  icon: 'list-checks',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    { name: 'groupKey', label: 'Mã nhóm trường', type: 'text', help: 'Để trống = hiện mọi nhóm gắn vào Trang. Xem mã nhóm ở menu Trường tuỳ chỉnh.' },
    {
      name: 'layout',
      label: 'Bố cục',
      type: 'select',
      options: [
        { value: 'table', label: 'Bảng nhãn – giá trị' },
        { value: 'list', label: 'Danh sách dọc' },
        { value: 'grid', label: 'Lưới thẻ' },
      ],
    },
  ],
  defaults: { title: '', subtitle: '', groupKey: '', layout: 'table' },
  defaultSettings: { container: 'narrow' },
  component: ({ data, ctx, block, resolved }) => {
    const items = (Array.isArray(resolved?.items) ? resolved.items : []) as PublicCustomField[];
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} />
        {items.length ? (
          <CustomFieldsList items={items} ctx={ctx} layout={data.layout} />
        ) : ctx.mode === 'edit' ? (
          <div className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-400">
            {resolved?.inEditor ? 'Giá trị trường tuỳ chỉnh của trang sẽ hiển thị tại đây khi xem trên website (nhập ở tab “Trường” bên phải rồi lưu trang).' : 'Trang chưa có trường tuỳ chỉnh nào có giá trị. Tạo nhóm gắn vào “Trang” ở menu Trường tuỳ chỉnh và nhập ở tab “Trường”.'}
          </div>
        ) : null}
      </div>
    );
  },
};
