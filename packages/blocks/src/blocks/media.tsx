import type { BlockDefinition } from '../types';
import { Txt } from '../text';
import { Slider } from '../slider';
import { cn, gridCols, videoEmbed } from '../utils';

const HEIGHT: Record<string, string> = { sm: 'min-h-[320px]', md: 'min-h-[440px]', lg: 'min-h-[560px] @5xl:min-h-[640px]', full: 'min-h-[100svh]' };

export const hero: BlockDefinition<{
  eyebrow: string;
  title: string;
  subtitle: string;
  image: any;
  primaryLabel: string;
  primaryUrl: string;
  secondaryLabel: string;
  secondaryUrl: string;
  align: string;
  height: string;
  overlay: number;
}> = {
  type: 'hero',
  label: 'Hero banner',
  description: 'Banner lớn đầu trang với tiêu đề và nút',
  icon: 'panel-top',
  category: 'media',
  fields: [
    { name: 'eyebrow', label: 'Dòng nhỏ phía trên', type: 'text' },
    { name: 'title', label: 'Tiêu đề (H1)', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    { name: 'image', label: 'Ảnh nền', type: 'image' },
    { name: 'primaryLabel', label: 'Nút chính - chữ', type: 'text' },
    { name: 'primaryUrl', label: 'Nút chính - liên kết', type: 'url' },
    { name: 'secondaryLabel', label: 'Nút phụ - chữ', type: 'text' },
    { name: 'secondaryUrl', label: 'Nút phụ - liên kết', type: 'url' },
    { name: 'align', label: 'Căn lề', type: 'select', options: [{ value: 'left', label: 'Trái' }, { value: 'center', label: 'Giữa' }] },
    { name: 'height', label: 'Chiều cao', type: 'select', options: [{ value: 'sm', label: 'Thấp' }, { value: 'md', label: 'Vừa' }, { value: 'lg', label: 'Cao' }, { value: 'full', label: 'Toàn màn hình' }] },
    { name: 'overlay', label: 'Độ tối lớp phủ (%)', type: 'number', min: 0, max: 90 },
  ],
  defaults: {
    eyebrow: '',
    title: 'Tiêu đề nổi bật của bạn',
    subtitle: 'Mô tả ngắn gọn giá trị bạn mang lại cho khách hàng.',
    image: null,
    primaryLabel: 'Mua ngay',
    primaryUrl: '/products',
    secondaryLabel: '',
    secondaryUrl: '',
    align: 'left',
    height: 'lg',
    overlay: 40,
  },
  defaultSettings: { container: 'full', paddingTop: 'none', paddingBottom: 'none' },
  component: ({ data, ctx, block }) => (
    <div className={cn('relative isolate flex items-center overflow-hidden bg-slate-900 text-white', HEIGHT[data.height] ?? HEIGHT.lg)}>
      {data.image?.url && <ctx.Image src={data.image.url} alt={data.image.alt || data.title} fill priority sizes="100vw" className="-z-10 object-cover" />}
      <div className="absolute inset-0 -z-10 bg-black" style={{ opacity: (Number(data.overlay) || 0) / 100 }} />
      <div className={cn('mx-auto w-full max-w-7xl px-4 py-16 @3xl:px-6', data.align === 'center' && 'text-center')}>
        <div className={cn('max-w-2xl', data.align === 'center' && 'mx-auto')}>
          <Txt ctx={ctx} block={block} path="eyebrow" value={data.eyebrow} as="p" className="mb-4 inline-block rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-wider backdrop-blur" placeholder="Dòng nhỏ" />
          <Txt ctx={ctx} block={block} path="title" value={data.title} as="h1" className="block text-4xl font-extrabold leading-tight tracking-tight @3xl:text-6xl" />
          <Txt ctx={ctx} block={block} path="subtitle" value={data.subtitle} as="p" multiline className="mt-5 block text-lg text-white/85 @3xl:text-xl" />
          <div className={cn('mt-8 flex flex-wrap gap-3', data.align === 'center' && 'justify-center')}>
            {data.primaryLabel && (
              <ctx.Link href={data.primaryUrl || '#'} className="inline-flex rounded-lg bg-brand px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-black/20 hover:opacity-90">
                {data.primaryLabel}
              </ctx.Link>
            )}
            {data.secondaryLabel && (
              <ctx.Link href={data.secondaryUrl || '#'} className="inline-flex rounded-lg border border-white/40 bg-white/10 px-7 py-3.5 text-sm font-semibold text-white backdrop-blur hover:bg-white/20">
                {data.secondaryLabel}
              </ctx.Link>
            )}
          </div>
        </div>
      </div>
    </div>
  ),
};

type Slide = { image: any; title: string; subtitle: string; buttonLabel: string; buttonUrl: string };
export const slider: BlockDefinition<{ slides: Slide[]; autoplay: boolean; interval: number; height: string }> = {
  type: 'slider',
  label: 'Slider ảnh',
  icon: 'gallery-horizontal',
  category: 'media',
  fields: [
    {
      name: 'slides',
      label: 'Slide',
      type: 'repeater',
      itemLabelField: 'title',
      fields: [
        { name: 'image', label: 'Ảnh', type: 'image' },
        { name: 'title', label: 'Tiêu đề', type: 'text' },
        { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
        { name: 'buttonLabel', label: 'Nút - chữ', type: 'text' },
        { name: 'buttonUrl', label: 'Nút - liên kết', type: 'url' },
      ],
    },
    { name: 'autoplay', label: 'Tự động chuyển', type: 'boolean' },
    { name: 'interval', label: 'Thời gian mỗi slide (giây)', type: 'number', min: 2, max: 20 },
    { name: 'height', label: 'Chiều cao', type: 'select', options: [{ value: 'sm', label: 'Thấp' }, { value: 'md', label: 'Vừa' }, { value: 'lg', label: 'Cao' }] },
  ],
  defaults: { slides: [{ image: null, title: 'Slide 1', subtitle: '', buttonLabel: '', buttonUrl: '' }], autoplay: true, interval: 5, height: 'md' },
  defaultSettings: { container: 'full', paddingTop: 'none', paddingBottom: 'none' },
  component: ({ data, ctx, block }) => (
    <Slider autoplay={ctx.mode === 'view' && data.autoplay} interval={data.interval}>
      {(data.slides ?? []).map((s, i) => (
        <div key={i} className={cn('relative isolate flex items-end bg-slate-800 text-white', HEIGHT[data.height] ?? HEIGHT.md)}>
          {s.image?.url && <ctx.Image src={s.image.url} alt={s.image.alt || s.title} fill priority={i === 0} sizes="100vw" className="-z-10 object-cover" />}
          <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className="mx-auto w-full max-w-7xl px-4 pb-14 @3xl:px-6">
            <Txt ctx={ctx} block={block} path={`slides.${i}.title`} value={s.title} as={i === 0 ? 'h2' : 'p'} className="block max-w-2xl text-3xl font-bold @3xl:text-5xl" />
            <Txt ctx={ctx} block={block} path={`slides.${i}.subtitle`} value={s.subtitle} as="p" className="mt-3 block max-w-xl text-white/85" />
            {s.buttonLabel && (
              <ctx.Link href={s.buttonUrl || '#'} className="mt-6 inline-flex rounded-lg bg-white px-6 py-3 text-sm font-semibold text-slate-900">
                {s.buttonLabel}
              </ctx.Link>
            )}
          </div>
        </div>
      ))}
    </Slider>
  ),
};

export const image: BlockDefinition<{ image: any; caption: string; link: string; rounded: boolean; aspect: string }> = {
  type: 'image',
  label: 'Ảnh',
  icon: 'image',
  category: 'media',
  fields: [
    { name: 'image', label: 'Ảnh', type: 'image' },
    { name: 'caption', label: 'Chú thích', type: 'text' },
    { name: 'link', label: 'Liên kết', type: 'url' },
    { name: 'aspect', label: 'Tỉ lệ', type: 'select', options: [{ value: 'auto', label: 'Gốc' }, { value: '16/9', label: '16:9' }, { value: '4/3', label: '4:3' }, { value: '1/1', label: '1:1' }, { value: '21/9', label: '21:9' }] },
    { name: 'rounded', label: 'Bo góc', type: 'boolean' },
  ],
  defaults: { image: null, caption: '', link: '', rounded: true, aspect: 'auto' },
  component: ({ data, ctx, block }) => {
    const img = data.image?.url ? (
      data.aspect && data.aspect !== 'auto' ? (
        <div className={cn('relative w-full overflow-hidden bg-slate-100', data.rounded && 'rounded-2xl')} style={{ aspectRatio: data.aspect }}>
          <ctx.Image src={data.image.url} alt={data.image.alt || data.caption || ''} fill sizes="100vw" className="object-cover" />
        </div>
      ) : (
        <ctx.Image src={data.image.url} alt={data.image.alt || data.caption || ''} width={data.image.width ?? 1600} height={data.image.height ?? 900} sizes="100vw" className={cn('h-auto w-full', data.rounded && 'rounded-2xl')} />
      )
    ) : (
      <div className="flex aspect-video items-center justify-center rounded-2xl bg-slate-100 text-sm text-slate-400">Chưa chọn ảnh</div>
    );
    return (
      <figure>
        {data.link ? <ctx.Link href={data.link}>{img}</ctx.Link> : img}
        <Txt ctx={ctx} block={block} path="caption" value={data.caption} as="figcaption" className="mt-2 block text-center text-sm text-slate-500" placeholder="Chú thích ảnh" />
      </figure>
    );
  },
};

export const gallery: BlockDefinition<{ title: string; images: any[]; columns: number }> = {
  type: 'gallery',
  label: 'Thư viện ảnh',
  icon: 'images',
  category: 'media',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'images', label: 'Ảnh', type: 'images' },
    { name: 'columns', label: 'Số cột', type: 'select', options: [2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} cột` })) },
  ],
  defaults: { title: '', images: [], columns: 4 },
  component: ({ data, ctx, block }) => (
    <div>
      <Txt ctx={ctx} block={block} path="title" value={data.title} as="h2" className="mb-6 block text-2xl font-bold" placeholder="Tiêu đề" />
      <div className={cn('grid gap-3', gridCols(data.columns, 4))}>
        {(data.images ?? []).map((img, i) => (
          <a key={i} href={img.url} target="_blank" rel="noopener" className="relative block aspect-square overflow-hidden rounded-xl bg-slate-100">
            <ctx.Image src={img.url} alt={img.alt || `image ${i + 1}`} fill sizes="(max-width:768px) 50vw, 25vw" className="object-cover transition hover:scale-105" />
          </a>
        ))}
        {!data.images?.length && ctx.mode === 'edit' && <div className="col-span-full rounded-xl bg-slate-100 p-10 text-center text-sm text-slate-400">Chọn ảnh ở panel bên phải</div>}
      </div>
    </div>
  ),
};

export const video: BlockDefinition<{ url: string; title: string; poster: any }> = {
  type: 'video',
  label: 'Video',
  description: 'YouTube, Vimeo hoặc file mp4',
  icon: 'play',
  category: 'media',
  fields: [
    { name: 'url', label: 'URL video (YouTube/Vimeo/mp4)', type: 'url' },
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'poster', label: 'Ảnh bìa (mp4)', type: 'image' },
  ],
  defaults: { url: '', title: '', poster: null },
  component: ({ data, ctx, block }) => {
    const v = videoEmbed(data.url);
    return (
      <div>
        <Txt ctx={ctx} block={block} path="title" value={data.title} as="h2" className="mb-5 block text-center text-2xl font-bold" placeholder="Tiêu đề video" />
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-slate-900">
          {v?.type === 'iframe' ? (
            <iframe src={v.src} title={data.title || 'video'} loading="lazy" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className={cn('absolute inset-0 h-full w-full', ctx.mode === 'edit' && 'pointer-events-none')} />
          ) : v ? (
            <video src={v.src} poster={data.poster?.url} controls preload="metadata" className="absolute inset-0 h-full w-full" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/60">Nhập URL video</div>
          )}
        </div>
      </div>
    );
  },
};

export const bannerGrid: BlockDefinition<{ columns: number; items: { image: any; title: string; url: string }[] }> = {
  type: 'banner-grid',
  label: 'Lưới banner',
  description: 'Banner khuyến mãi dạng lưới',
  icon: 'layout-dashboard',
  category: 'marketing',
  fields: [
    { name: 'columns', label: 'Số cột', type: 'select', options: [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} cột` })) },
    {
      name: 'items',
      label: 'Banner',
      type: 'repeater',
      itemLabelField: 'title',
      fields: [
        { name: 'image', label: 'Ảnh', type: 'image' },
        { name: 'title', label: 'Tiêu đề (alt)', type: 'text' },
        { name: 'url', label: 'Liên kết', type: 'url' },
      ],
    },
  ],
  defaults: { columns: 2, items: [] },
  component: ({ data, ctx }) => (
    <div className={cn('grid gap-4', gridCols(data.columns, 2))}>
      {(data.items ?? []).map((it, i) => (
        <ctx.Link key={i} href={it.url || '#'} className="group relative block aspect-[9/5] overflow-hidden rounded-2xl bg-slate-100" aria-label={it.title}>
          {it.image?.url && <ctx.Image src={it.image.url} alt={it.title || it.image.alt || ''} fill sizes="(max-width:768px) 100vw, 50vw" className="object-cover transition duration-500 group-hover:scale-105" />}
        </ctx.Link>
      ))}
      {!data.items?.length && ctx.mode === 'edit' && <div className="col-span-full rounded-xl bg-slate-100 p-10 text-center text-sm text-slate-400">Thêm banner ở panel bên phải</div>}
    </div>
  ),
};

export const map: BlockDefinition<{ embed: string; height: number }> = {
  type: 'map',
  label: 'Bản đồ',
  description: 'Nhúng Google Maps',
  icon: 'map',
  category: 'media',
  fields: [
    { name: 'embed', label: 'Link nhúng Google Maps (src của iframe)', type: 'url' },
    { name: 'height', label: 'Chiều cao (px)', type: 'number', min: 200, max: 800 },
  ],
  defaults: { embed: '', height: 400 },
  component: ({ data, ctx }) => {
    const src = data.embed?.match(/src="([^"]+)"/)?.[1] ?? data.embed;
    return src ? (
      <iframe src={src} title="map" loading="lazy" className={cn('w-full rounded-2xl border-0', ctx.mode === 'edit' && 'pointer-events-none')} style={{ height: Number(data.height) || 400 }} referrerPolicy="no-referrer-when-downgrade" />
    ) : (
      <div className="flex h-60 items-center justify-center rounded-2xl bg-slate-100 text-sm text-slate-400">Dán link Google Maps embed</div>
    );
  },
};
