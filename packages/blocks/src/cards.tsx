import { Star } from 'lucide-react';
import type { RenderContext } from './types';
import { cn } from './utils';

export interface ProductCardData {
  id: string;
  type: string;
  name: string;
  slug: string;
  price: number;
  salePrice: number | null;
  finalPrice: number;
  maxPrice?: number | null;
  discountPercent: number;
  inStock: boolean;
  /** có ô thông tin khách bắt buộc nhập khi mua (ID game...) — không thêm thẳng vào giỏ */
  hasPurchaseFields?: boolean;
  ratingAverage?: number;
  ratingCount?: number;
  image?: { url: string; urls?: Record<string, string>; width?: number | null; height?: number | null; alt?: Record<string, string> | string } | null;
  hoverImage?: { url: string; urls?: Record<string, string> } | null;
  brand?: { name: string } | null;
}

export interface PostCardData {
  id: string;
  title: string;
  slug: string;
  excerpt?: string;
  readingTime?: number;
  publishedAt?: string;
  featuredImage?: { url: string; urls?: Record<string, string>; width?: number | null; height?: number | null } | null;
  categories?: { name: string; slug: string }[];
}

const altText = (alt: unknown, locale: string, fallback: string) => (typeof alt === 'string' ? alt : ((alt as Record<string, string>)?.[locale] ?? fallback));

export function productPath(slug: string) {
  return `/products/${slug}`;
}

export function ProductCard({ product: p, ctx, className }: { product: ProductCardData; ctx: RenderContext; className?: string }) {
  const { Link, Image, AddToCart } = ctx;
  const href = ctx.href(productPath(p.slug));
  const img = p.image?.urls?.medium ?? p.image?.url;
  return (
    <div className={cn('group relative flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:shadow-lg', className)}>
      <Link href={href} className="relative block aspect-square overflow-hidden bg-slate-100" aria-label={p.name}>
        {img ? (
          <Image src={img} alt={altText(p.image?.alt, ctx.locale, p.name)} fill sizes="(max-width: 768px) 50vw, 25vw" className="object-cover transition duration-500 group-hover:scale-105" />
        ) : null}
        {p.discountPercent > 0 && (
          <span className="absolute left-2 top-2 rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">-{p.discountPercent}%</span>
        )}
        {!p.inStock && <span className="absolute right-2 top-2 rounded-md bg-slate-900/80 px-2 py-0.5 text-xs text-white">{ctx.t('outOfStock')}</span>}
      </Link>
      <div className="flex flex-1 flex-col gap-1.5 p-3 @3xl:p-4">
        {p.brand?.name && <span className="text-xs uppercase tracking-wide text-slate-500">{p.brand.name}</span>}
        <h3 className="line-clamp-2 text-sm font-medium text-slate-900 @3xl:text-base">
          <Link href={href} className="hover:text-brand">
            {p.name}
          </Link>
        </h3>
        {p.ratingCount ? (
          <div className="flex items-center gap-1 text-xs text-slate-500" aria-label={`${p.ratingAverage}/5`}>
            <span className="flex text-amber-400" aria-hidden>
              {[1, 2, 3, 4, 5].map((i) => (
                <Star key={i} className={cn('size-3.5', i <= Math.round(p.ratingAverage ?? 0) ? 'fill-current' : 'opacity-30')} />
              ))}
            </span>
            ({p.ratingCount})
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap items-baseline gap-2 pt-1">
          {p.maxPrice ? <span className="text-xs text-slate-500">{ctx.t('from')}</span> : null}
          <span className="font-semibold text-brand">{ctx.formatPrice(p.finalPrice)}</span>
          {p.salePrice != null && <span className="text-xs text-slate-400 line-through">{ctx.formatPrice(p.price)}</span>}
        </div>
        {AddToCart && p.inStock && (
          <div className="pt-2">
            <AddToCart productId={p.id} type={p.type} slug={p.slug} hasPurchaseFields={p.hasPurchaseFields} />
          </div>
        )}
      </div>
    </div>
  );
}

export function PostCard({ post, ctx, layout = 'grid' }: { post: PostCardData; ctx: RenderContext; layout?: 'grid' | 'list' }) {
  const { Link, Image } = ctx;
  const href = ctx.href(`/blog/${post.slug}`);
  const img = post.featuredImage?.urls?.medium ?? post.featuredImage?.url;
  const date = post.publishedAt ? new Date(post.publishedAt).toLocaleDateString(ctx.locale === 'vi' ? 'vi-VN' : ctx.locale) : '';
  return (
    <article className={cn('group flex gap-4 overflow-hidden', layout === 'grid' ? 'flex-col' : 'flex-row items-start')}>
      <Link href={href} className={cn('relative block shrink-0 overflow-hidden rounded-xl bg-slate-100', layout === 'grid' ? 'aspect-video w-full' : 'aspect-video w-40 @3xl:w-64')}>
        {img && <Image src={img} alt={post.title} fill sizes="(max-width: 768px) 100vw, 33vw" className="object-cover transition duration-500 group-hover:scale-105" />}
      </Link>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          {post.categories?.[0] && (
            <Link href={ctx.href(`/blog/category/${post.categories[0].slug}`)} className="font-medium uppercase tracking-wide text-brand">
              {post.categories[0].name}
            </Link>
          )}
          {date && <time dateTime={post.publishedAt}>{date}</time>}
          {post.readingTime ? <span>· {post.readingTime} {ctx.t('minRead')}</span> : null}
        </div>
        <h3 className="text-lg font-semibold leading-snug text-slate-900">
          <Link href={href} className="hover:text-brand">
            {post.title}
          </Link>
        </h3>
        {post.excerpt && <p className="line-clamp-3 text-sm text-slate-600">{post.excerpt}</p>}
      </div>
    </article>
  );
}

/* ---------------- Thẻ nội dung tuỳ biến (entry) ---------------- */

type CardMedia = { url: string; urls?: Record<string, string>; width?: number | null; height?: number | null; alt?: Record<string, string> | string } | null;

/** Dữ liệu thẻ entry (khớp EntryCard của @cmsnt/shared, các trường đều có thể thiếu để dùng lại cho mọi nguồn) */
export interface EntryCardData {
  id: string;
  type?: string;
  title: string;
  slug?: string;
  excerpt?: string | null;
  featuredImage?: CardMedia;
  publishedAt?: string | null;
  isFeatured?: boolean;
  /** đường dẫn công khai (đã có tiền tố ngôn ngữ) — null nếu loại nội dung không public */
  path?: string | null;
  terms?: Record<string, { id?: string; name: string; slug?: string; path?: string | null }[]>;
  customFields?: Record<string, unknown>;
}

/** Tuỳ chọn hiển thị thẻ entry (block entry-list / query-loop, lưới lưu trữ của storefront) */
export interface EntryCardOptions {
  layout?: 'grid' | 'list' | 'overlay';
  showImage?: boolean;
  showExcerpt?: boolean;
  showDate?: boolean;
  showTerms?: boolean;
  /** mã trường tuỳ chỉnh hiện trên thẻ (vd giá, vị trí) */
  fields?: string[];
}

/**
 * Giá trị trường tuỳ chỉnh dạng chữ gọn để hiện trên thẻ: chuỗi/số giữ nguyên,
 * object có label/name/title/url lấy nhãn, mảng nối bằng dấu phẩy. Không hiện được -> ''.
 */
export function plainFieldValue(v: unknown, locale = 'vi'): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return v.toLocaleString(locale === 'vi' ? 'vi-VN' : locale);
  if (typeof v === 'boolean') return v ? '✓' : '';
  if (typeof v === 'string') return v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (Array.isArray(v)) return v.map((x) => plainFieldValue(x, locale)).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['label', 'name', 'title', 'value']) if (typeof o[k] === 'string' || typeof o[k] === 'number') return plainFieldValue(o[k], locale);
  }
  return '';
}

/** Danh sách term (phẳng) của thẻ entry */
function entryTerms(entry: EntryCardData) {
  return Object.values(entry.terms ?? {}).flat();
}

/** Mã trường phân cách bằng dấu phẩy -> mảng */
export function parseFieldKeys(s: unknown): string[] {
  if (Array.isArray(s)) return s.map(String).filter(Boolean);
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Thẻ bài của loại nội dung tuỳ biến (dự án, dịch vụ, tin tuyển dụng...). Dùng chung cho block
 * entry-list / query-loop và lưới lưu trữ của storefront. Bố cục: grid (ảnh trên), list (ảnh trái), overlay (chữ trên ảnh).
 */
export function EntryCard({ entry, ctx, options = {}, className }: { entry: EntryCardData; ctx: RenderContext; options?: EntryCardOptions; className?: string }) {
  const { Link, Image } = ctx;
  const { layout = 'grid', showImage = true, showExcerpt = true, showDate = false, showTerms = true, fields = [] } = options;
  const href = entry.path ? ctx.href(entry.path) : null;
  const img = entry.featuredImage?.urls?.medium ?? entry.featuredImage?.url;
  const alt = altText(entry.featuredImage?.alt, ctx.locale, entry.title);
  const date = showDate && entry.publishedAt ? new Date(entry.publishedAt).toLocaleDateString(ctx.locale === 'vi' ? 'vi-VN' : ctx.locale) : '';
  const terms = showTerms ? entryTerms(entry).slice(0, 3) : [];
  const values = fields.map((k) => ({ key: k, text: plainFieldValue(entry.customFields?.[k], ctx.locale) })).filter((x) => x.text);
  const Title = ({ className: c }: { className?: string }) => (
    <h3 className={c}>
      {href ? (
        <Link href={href} className="hover:text-brand">
          {entry.title}
        </Link>
      ) : (
        entry.title
      )}
    </h3>
  );
  const Meta = () =>
    terms.length || date ? (
      <div className="flex flex-wrap items-center gap-2 text-xs opacity-80">
        {terms.map((t, i) =>
          t.path ? (
            <Link key={`${t.slug}-${i}`} href={ctx.href(t.path)} className="font-medium uppercase tracking-wide text-brand">
              {t.name}
            </Link>
          ) : (
            <span key={`${t.slug}-${i}`} className="font-medium uppercase tracking-wide text-brand">
              {t.name}
            </span>
          ),
        )}
        {date && <time dateTime={entry.publishedAt ?? undefined}>{date}</time>}
      </div>
    ) : null;
  const Values = () =>
    values.length ? (
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {values.map((v) => (
          <li key={v.key} data-field={v.key} className="font-medium text-slate-700">
            {v.text}
          </li>
        ))}
      </ul>
    ) : null;

  if (layout === 'overlay') {
    return (
      <article className={cn('group relative aspect-[4/3] overflow-hidden rounded-2xl bg-slate-800 text-white', className)}>
        {showImage && img ? <Image src={img} alt={alt} fill sizes="(max-width: 768px) 100vw, 33vw" className="object-cover opacity-80 transition duration-500 group-hover:scale-105" /> : null}
        <div className="absolute inset-0 flex flex-col justify-end gap-2 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-5">
          <Meta />
          <Title className="text-lg font-semibold leading-snug [&_a]:text-white [&_a:hover]:text-white/80" />
          {showExcerpt && entry.excerpt && <p className="line-clamp-2 text-sm text-white/80">{entry.excerpt}</p>}
        </div>
        {href && <Link href={href} className="absolute inset-0" aria-label={entry.title} />}
      </article>
    );
  }

  const list = layout === 'list';
  return (
    <article className={cn('group flex gap-4', list ? 'flex-row items-start' : 'flex-col', className)} data-entry-type={entry.type}>
      {showImage && (
        <div className={cn('relative block shrink-0 overflow-hidden rounded-xl bg-slate-100', list ? 'aspect-[4/3] w-32 @3xl:w-56' : 'aspect-[4/3] w-full')}>
          {img ? <Image src={img} alt={alt} fill sizes="(max-width: 768px) 100vw, 33vw" className="object-cover transition duration-500 group-hover:scale-105" /> : null}
          {href && <Link href={href} className="absolute inset-0" aria-label={entry.title} />}
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-2">
        <Meta />
        <Title className="text-lg font-semibold leading-snug text-slate-900" />
        <Values />
        {showExcerpt && entry.excerpt && <p className="line-clamp-3 text-sm text-slate-600">{entry.excerpt}</p>}
      </div>
    </article>
  );
}
