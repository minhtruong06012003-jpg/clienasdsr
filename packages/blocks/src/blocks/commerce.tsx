import type { BlockDefinition } from '../types';
import { ProductCard, PostCard, type PostCardData, type ProductCardData } from '../cards';
import { Slider } from '../slider';
import { SectionTitle } from './content';
import { cn, gridCols } from '../utils';

const SOURCE = [
  { value: 'latest', label: 'Mới nhất' },
  { value: 'featured', label: 'Nổi bật' },
  { value: 'best_selling', label: 'Bán chạy' },
  { value: 'on_sale', label: 'Đang giảm giá' },
  { value: 'category', label: 'Theo danh mục' },
  { value: 'manual', label: 'Chọn thủ công' },
];

const productFields = [
  { name: 'title', label: 'Tiêu đề', type: 'text' as const },
  { name: 'subtitle', label: 'Mô tả', type: 'textarea' as const },
  { name: 'source', label: 'Nguồn sản phẩm', type: 'select' as const, options: SOURCE },
  { name: 'categoryId', label: 'Danh mục', type: 'product-category' as const, showIf: { field: 'source', equals: 'category' } },
  { name: 'productIds', label: 'Sản phẩm', type: 'products' as const, showIf: { field: 'source', equals: 'manual' } },
  { name: 'limit', label: 'Số lượng', type: 'number' as const, min: 1, max: 48 },
];

type ProductBlockData = { title: string; subtitle: string; source: string; categoryId?: string; productIds?: string[]; limit: number; columns: number; viewAllLabel: string; viewAllUrl: string };

function ViewAll({ data, ctx }: { data: ProductBlockData; ctx: any }) {
  if (!data.viewAllUrl) return null;
  return (
    <div className="mt-8 text-center">
      <ctx.Link href={data.viewAllUrl} className="inline-flex rounded-lg border border-slate-300 px-6 py-2.5 text-sm font-semibold hover:border-brand hover:text-brand">
        {data.viewAllLabel || ctx.t('viewAll')}
      </ctx.Link>
    </div>
  );
}

function Empty({ ctx, kind }: { ctx: any; kind: 'products' | 'posts' }) {
  return <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">{ctx.t(kind === 'products' ? 'noProducts' : 'noPosts')}</div>;
}

export const productGrid: BlockDefinition<ProductBlockData> = {
  type: 'product-grid',
  label: 'Lưới sản phẩm',
  icon: 'shopping-bag',
  category: 'commerce',
  fields: [
    ...productFields,
    { name: 'columns', label: 'Số cột', type: 'select', options: [2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} cột` })) },
    { name: 'viewAllLabel', label: 'Nút xem tất cả - chữ', type: 'text' },
    { name: 'viewAllUrl', label: 'Nút xem tất cả - liên kết', type: 'url' },
  ],
  defaults: { title: 'Sản phẩm', subtitle: '', source: 'latest', limit: 8, columns: 4, viewAllLabel: '', viewAllUrl: '/products' },
  component: ({ data, ctx, block, resolved }) => {
    const products: ProductCardData[] = resolved?.products ?? [];
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} />
        {products.length ? (
          <div className={cn('grid gap-3 @3xl:gap-5', gridCols(data.columns, 4))}>
            {products.map((p) => (
              <ProductCard key={p.id} product={p} ctx={ctx} />
            ))}
          </div>
        ) : (
          <Empty ctx={ctx} kind="products" />
        )}
        <ViewAll data={data} ctx={ctx} />
      </div>
    );
  },
};

export const productCarousel: BlockDefinition<ProductBlockData> = {
  type: 'product-carousel',
  label: 'Carousel sản phẩm',
  icon: 'gallery-horizontal-end',
  category: 'commerce',
  fields: [...productFields, { name: 'viewAllLabel', label: 'Nút xem tất cả - chữ', type: 'text' }, { name: 'viewAllUrl', label: 'Nút xem tất cả - liên kết', type: 'url' }],
  defaults: { title: 'Sản phẩm bán chạy', subtitle: '', source: 'best_selling', limit: 10, columns: 4, viewAllLabel: '', viewAllUrl: '' },
  component: ({ data, ctx, block, resolved }) => {
    const products: ProductCardData[] = resolved?.products ?? [];
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} />
        {products.length ? (
          <Slider perView="cards">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} ctx={ctx} className="h-full" />
            ))}
          </Slider>
        ) : (
          <Empty ctx={ctx} kind="products" />
        )}
        <ViewAll data={data} ctx={ctx} />
      </div>
    );
  },
};

export const categoryGrid: BlockDefinition<{ title: string; subtitle: string; categoryIds: string[]; limit: number; columns: number }> = {
  type: 'category-grid',
  label: 'Danh mục sản phẩm',
  icon: 'folder-tree',
  category: 'commerce',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    { name: 'categoryIds', label: 'Danh mục (bỏ trống = danh mục gốc)', type: 'product-categories' },
    { name: 'limit', label: 'Số lượng', type: 'number', min: 1, max: 24 },
    { name: 'columns', label: 'Số cột', type: 'select', options: [2, 3, 4, 6].map((n) => ({ value: String(n), label: `${n} cột` })) },
  ],
  defaults: { title: 'Danh mục', subtitle: '', categoryIds: [], limit: 8, columns: 4 },
  component: ({ data, ctx, block, resolved }) => {
    const cats: { id: string; name: string; slug: string; image?: { url: string } | null; productCount: number }[] = resolved?.categories ?? [];
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} />
        <div className={cn('grid gap-3 @3xl:gap-5', gridCols(data.columns, 4))}>
          {cats.map((c) => (
            <ctx.Link key={c.id} href={ctx.href(`/product-category/${c.slug}`)} className="group relative block aspect-square overflow-hidden rounded-2xl bg-slate-100">
              {c.image?.url && <ctx.Image src={c.image.url} alt={c.name} fill sizes="(max-width:768px) 50vw, 25vw" className="object-cover transition duration-500 group-hover:scale-105" />}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 text-white">
                <div className="font-semibold">{c.name}</div>
                <div className="text-xs text-white/75">
                  {c.productCount} {ctx.t('products')}
                </div>
              </div>
            </ctx.Link>
          ))}
        </div>
      </div>
    );
  },
};

export const postList: BlockDefinition<{ title: string; subtitle: string; source: string; categoryId?: string; limit: number; columns: number; layout: string; viewAllLabel: string; viewAllUrl: string }> = {
  type: 'post-list',
  label: 'Danh sách bài viết',
  icon: 'newspaper',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    { name: 'source', label: 'Nguồn', type: 'select', options: [{ value: 'latest', label: 'Mới nhất' }, { value: 'featured', label: 'Nổi bật' }, { value: 'category', label: 'Theo chuyên mục' }] },
    { name: 'categoryId', label: 'Chuyên mục', type: 'post-category', showIf: { field: 'source', equals: 'category' } },
    { name: 'limit', label: 'Số lượng', type: 'number', min: 1, max: 30 },
    { name: 'layout', label: 'Bố cục', type: 'select', options: [{ value: 'grid', label: 'Lưới' }, { value: 'list', label: 'Danh sách' }] },
    { name: 'columns', label: 'Số cột', type: 'select', options: [2, 3, 4].map((n) => ({ value: String(n), label: `${n} cột` })), showIf: { field: 'layout', equals: 'grid' } },
    { name: 'viewAllLabel', label: 'Nút xem tất cả - chữ', type: 'text' },
    { name: 'viewAllUrl', label: 'Nút xem tất cả - liên kết', type: 'url' },
  ],
  defaults: { title: 'Tin tức', subtitle: '', source: 'latest', limit: 3, columns: 3, layout: 'grid', viewAllLabel: '', viewAllUrl: '/blog' },
  component: ({ data, ctx, block, resolved }) => {
    const posts: PostCardData[] = resolved?.posts ?? [];
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} />
        {posts.length ? (
          <div className={cn('grid gap-8', data.layout === 'list' ? 'grid-cols-1' : gridCols(data.columns, 3))}>
            {posts.map((p) => (
              <PostCard key={p.id} post={p} ctx={ctx} layout={data.layout === 'list' ? 'list' : 'grid'} />
            ))}
          </div>
        ) : (
          <Empty ctx={ctx} kind="posts" />
        )}
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
