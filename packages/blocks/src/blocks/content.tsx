import { Quote, Star } from 'lucide-react';
import type { BlockDefinition } from '../types';
import { Html, Txt } from '../text';
import { BlockIcon, ICON_OPTIONS } from '../icons';
import { cn, gridCols } from '../utils';

const ALIGN = [
  { value: 'left', label: 'Trái' },
  { value: 'center', label: 'Giữa' },
  { value: 'right', label: 'Phải' },
];
/** Bỏ thẻ HTML và giải mã entity cơ bản cho dữ liệu cấu trúc */
const plain = (html?: string) =>
  (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const alignClass = (a?: string) => (a === 'center' ? 'text-center mx-auto' : a === 'right' ? 'text-right ml-auto' : '');

/** Tiêu đề section dùng chung */
export function SectionTitle({ ctx, block, title, subtitle, align = 'left', path = '' }: { ctx: any; block: any; title?: string; subtitle?: string; align?: string; path?: string }) {
  if (!title && !subtitle && ctx.mode !== 'edit') return null;
  return (
    <div className={cn('mb-8 max-w-3xl', alignClass(align))}>
      <Txt ctx={ctx} block={block} path={`${path}title`} value={title} as="h2" className="block text-2xl font-bold tracking-tight text-current @3xl:text-3xl" placeholder="Tiêu đề" />
      <Txt ctx={ctx} block={block} path={`${path}subtitle`} value={subtitle} as="p" className="mt-2 block text-base opacity-70" placeholder="Mô tả ngắn" />
    </div>
  );
}

export const heading: BlockDefinition<{ title: string; subtitle: string; level: string; align: string }> = {
  type: 'heading',
  label: 'Tiêu đề',
  description: 'Tiêu đề + mô tả ngắn',
  icon: 'heading',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    { name: 'level', label: 'Cấp heading (SEO)', type: 'select', options: ['h1', 'h2', 'h3'].map((v) => ({ value: v, label: v.toUpperCase() })) },
    { name: 'align', label: 'Căn lề', type: 'select', options: ALIGN },
  ],
  defaults: { title: 'Tiêu đề mới', subtitle: '', level: 'h2', align: 'left' },
  component: ({ data, ctx, block }) => {
    const size = data.level === 'h1' ? 'text-3xl @3xl:text-5xl' : data.level === 'h3' ? 'text-xl @3xl:text-2xl' : 'text-2xl @3xl:text-4xl';
    return (
      <div className={cn('max-w-3xl', alignClass(data.align))}>
        <Txt ctx={ctx} block={block} path="title" value={data.title} as={(data.level || 'h2') as 'h1' | 'h2' | 'h3'} className={cn('block font-bold tracking-tight', size)} />
        <Txt ctx={ctx} block={block} path="subtitle" value={data.subtitle} as="p" multiline className="mt-3 block text-lg opacity-70" placeholder="Mô tả ngắn" />
      </div>
    );
  },
};

export const richText: BlockDefinition<{ html: string }> = {
  type: 'rich-text',
  label: 'Văn bản',
  description: 'Nội dung định dạng (rich text)',
  icon: 'type',
  category: 'content',
  fields: [{ name: 'html', label: 'Nội dung', type: 'richtext' }],
  defaults: { html: '<p>Nhập nội dung tại đây...</p>' },
  defaultSettings: { container: 'narrow' },
  component: ({ data, ctx }) => <Html edit={ctx.mode === 'edit'} html={data.html} className="prose prose-slate max-w-none prose-a:text-brand prose-img:rounded-xl" />,
};

export const imageText: BlockDefinition<{ image: any; eyebrow: string; title: string; html: string; imagePosition: string; buttonLabel: string; buttonUrl: string }> = {
  type: 'image-text',
  label: 'Ảnh + Văn bản',
  description: 'Ảnh một bên, nội dung một bên',
  icon: 'layout-panel-left',
  category: 'content',
  fields: [
    { name: 'image', label: 'Ảnh', type: 'image' },
    { name: 'eyebrow', label: 'Dòng nhỏ phía trên', type: 'text' },
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'html', label: 'Nội dung', type: 'richtext' },
    { name: 'imagePosition', label: 'Vị trí ảnh', type: 'select', options: [{ value: 'left', label: 'Trái' }, { value: 'right', label: 'Phải' }] },
    { name: 'buttonLabel', label: 'Nút - chữ', type: 'text' },
    { name: 'buttonUrl', label: 'Nút - liên kết', type: 'url' },
  ],
  defaults: { image: null, eyebrow: '', title: 'Tiêu đề', html: '<p>Mô tả nội dung...</p>', imagePosition: 'left', buttonLabel: '', buttonUrl: '' },
  component: ({ data, ctx, block }) => (
    <div className="grid items-center gap-8 @3xl:grid-cols-2 @3xl:gap-14">
      <div className={cn('relative aspect-[4/3] overflow-hidden rounded-2xl bg-slate-100', data.imagePosition === 'right' && '@3xl:order-2')}>
        {data.image?.url && <ctx.Image src={data.image.url} alt={data.image.alt || data.title} fill sizes="(max-width: 768px) 100vw, 50vw" className="object-cover" />}
      </div>
      <div>
        <Txt ctx={ctx} block={block} path="eyebrow" value={data.eyebrow} as="p" className="mb-2 block text-sm font-semibold uppercase tracking-wider text-brand" placeholder="Dòng nhỏ" />
        <Txt ctx={ctx} block={block} path="title" value={data.title} as="h2" className="block text-2xl font-bold tracking-tight @3xl:text-4xl" />
        <Html edit={ctx.mode === 'edit'} html={data.html} className="prose prose-slate mt-4 max-w-none" />
        {data.buttonLabel && (
          <ctx.Link href={data.buttonUrl || '#'} className="mt-6 inline-flex rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white hover:opacity-90">
            {data.buttonLabel}
          </ctx.Link>
        )}
      </div>
    </div>
  ),
};

type FeatureItem = { icon: string; title: string; text: string };
export const features: BlockDefinition<{ title: string; subtitle: string; columns: number; style: string; items: FeatureItem[] }> = {
  type: 'features',
  label: 'Tính năng / Lợi ích',
  description: 'Lưới icon + tiêu đề + mô tả',
  icon: 'layout-grid',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    { name: 'columns', label: 'Số cột', type: 'select', options: [2, 3, 4].map((n) => ({ value: String(n), label: `${n} cột` })) },
    { name: 'style', label: 'Kiểu', type: 'select', options: [{ value: 'card', label: 'Thẻ' }, { value: 'inline', label: 'Ngang (icon bên trái)' }] },
    {
      name: 'items',
      label: 'Mục',
      type: 'repeater',
      itemLabelField: 'title',
      fields: [
        { name: 'icon', label: 'Icon', type: 'icon', options: ICON_OPTIONS.map((v) => ({ value: v, label: v })) },
        { name: 'title', label: 'Tiêu đề', type: 'text' },
        { name: 'text', label: 'Mô tả', type: 'textarea' },
      ],
    },
  ],
  defaults: {
    title: 'Vì sao chọn chúng tôi',
    subtitle: '',
    columns: 3,
    style: 'card',
    items: [
      { icon: 'truck', title: 'Giao hàng nhanh', text: 'Giao trong 24h' },
      { icon: 'shield-check', title: 'Chính hãng', text: 'Cam kết 100%' },
      { icon: 'headphones', title: 'Hỗ trợ 24/7', text: 'Luôn sẵn sàng' },
    ],
  },
  component: ({ data, ctx, block }) => (
    <div>
      <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} align="center" />
      <div className={cn('grid gap-4 @3xl:gap-6', gridCols(data.columns, 3))}>
        {(data.items ?? []).map((it, i) =>
          data.style === 'inline' ? (
            <div key={i} className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
                <BlockIcon name={it.icon} className="h-5 w-5" />
              </span>
              <div>
                <Txt ctx={ctx} block={block} path={`items.${i}.title`} value={it.title} as="h3" className="block text-sm font-semibold" />
                <Txt ctx={ctx} block={block} path={`items.${i}.text`} value={it.text} as="p" className="block text-xs opacity-70" />
              </div>
            </div>
          ) : (
            <div key={i} className="rounded-2xl border border-slate-200/70 bg-white/60 p-6 text-center">
              <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                <BlockIcon name={it.icon} className="h-7 w-7" />
              </span>
              <Txt ctx={ctx} block={block} path={`items.${i}.title`} value={it.title} as="h3" className="block text-lg font-semibold" />
              <Txt ctx={ctx} block={block} path={`items.${i}.text`} value={it.text} as="p" multiline className="mt-2 block text-sm opacity-70" />
            </div>
          ),
        )}
      </div>
    </div>
  ),
};

export const stats: BlockDefinition<{ items: { value: string; label: string }[] }> = {
  type: 'stats',
  label: 'Con số ấn tượng',
  icon: 'bar-chart-3',
  category: 'marketing',
  fields: [
    {
      name: 'items',
      label: 'Số liệu',
      type: 'repeater',
      itemLabelField: 'label',
      fields: [
        { name: 'value', label: 'Giá trị', type: 'text' },
        { name: 'label', label: 'Nhãn', type: 'text' },
      ],
    },
  ],
  defaults: { items: [{ value: '10K+', label: 'Khách hàng' }, { value: '500+', label: 'Sản phẩm' }, { value: '99%', label: 'Hài lòng' }] },
  component: ({ data, ctx, block }) => (
    <div className={cn('grid gap-8 text-center', gridCols(Math.min(data.items?.length || 1, 4), 3))}>
      {(data.items ?? []).map((it, i) => (
        <div key={i}>
          <Txt ctx={ctx} block={block} path={`items.${i}.value`} value={it.value} as="div" className="block text-4xl font-extrabold tracking-tight @3xl:text-5xl" />
          <Txt ctx={ctx} block={block} path={`items.${i}.label`} value={it.label} as="div" className="mt-2 block text-sm uppercase tracking-wider opacity-70" />
        </div>
      ))}
    </div>
  ),
};

export const faq: BlockDefinition<{ title: string; subtitle: string; items: { question: string; answer: string }[] }> = {
  type: 'faq',
  label: 'Câu hỏi thường gặp',
  description: 'Accordion + Schema FAQPage cho SEO',
  icon: 'circle-help',
  category: 'content',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    {
      name: 'items',
      label: 'Câu hỏi',
      type: 'repeater',
      itemLabelField: 'question',
      fields: [
        { name: 'question', label: 'Câu hỏi', type: 'text' },
        { name: 'answer', label: 'Trả lời', type: 'richtext' },
      ],
    },
  ],
  defaults: { title: 'Câu hỏi thường gặp', subtitle: '', items: [{ question: 'Câu hỏi?', answer: '<p>Câu trả lời.</p>' }] },
  defaultSettings: { container: 'narrow' },
  component: ({ data, ctx, block }) => {
    const items = data.items ?? [];
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: items.map((i) => ({ '@type': 'Question', name: plain(i.question), acceptedAnswer: { '@type': 'Answer', text: plain(i.answer) } })),
    };
    return (
      <div>
        <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} align="center" />
        <div className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
          {items.map((it, i) => (
            <details key={i} className="group p-5" open={ctx.mode === 'edit' && i === 0}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-slate-900">
                <Txt ctx={ctx} block={block} path={`items.${i}.question`} value={it.question} as="span" />
                <span className="text-xl text-slate-400 transition group-open:rotate-45">+</span>
              </summary>
              <Html edit={ctx.mode === 'edit'} html={it.answer} className="prose prose-slate prose-sm mt-3 max-w-none" />
            </details>
          ))}
        </div>
        {ctx.mode === 'view' && items.length > 0 && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />}
      </div>
    );
  },
};

type Testimonial = { name: string; role: string; content: string; rating: number; avatar?: any };
export const testimonials: BlockDefinition<{ title: string; subtitle: string; items: Testimonial[] }> = {
  type: 'testimonials',
  label: 'Đánh giá khách hàng',
  icon: 'message-square-quote',
  category: 'marketing',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'subtitle', label: 'Mô tả', type: 'textarea' },
    {
      name: 'items',
      label: 'Đánh giá',
      type: 'repeater',
      itemLabelField: 'name',
      fields: [
        { name: 'name', label: 'Tên', type: 'text' },
        { name: 'role', label: 'Chức danh / nơi ở', type: 'text' },
        { name: 'avatar', label: 'Ảnh đại diện', type: 'image' },
        { name: 'content', label: 'Nội dung', type: 'textarea' },
        { name: 'rating', label: 'Số sao (1-5)', type: 'number', min: 1, max: 5 },
      ],
    },
  ],
  defaults: { title: 'Khách hàng nói gì', subtitle: '', items: [{ name: 'Nguyễn Văn A', role: 'Khách hàng', content: 'Dịch vụ rất tốt!', rating: 5 }] },
  component: ({ data, ctx, block }) => (
    <div>
      <SectionTitle ctx={ctx} block={block} title={data.title} subtitle={data.subtitle} align="center" />
      <div className={cn('grid gap-6', gridCols(Math.min(data.items?.length || 1, 3), 3))}>
        {(data.items ?? []).map((it, i) => (
          <figure key={i} className="relative flex flex-col rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-sm">
            <Quote className="absolute right-5 top-5 h-8 w-8 text-brand/15" />
            <div className="mb-3 flex gap-0.5 text-amber-400">
              {Array.from({ length: 5 }).map((_, s) => (
                <Star key={s} className={cn('h-4 w-4', s < (Number(it.rating) || 5) ? 'fill-current' : 'opacity-30')} />
              ))}
            </div>
            <blockquote className="flex-1 text-sm leading-relaxed">
              <Txt ctx={ctx} block={block} path={`items.${i}.content`} value={it.content} as="p" multiline />
            </blockquote>
            <figcaption className="mt-5 flex items-center gap-3">
              {it.avatar?.url ? (
                <ctx.Image src={it.avatar.url} alt={it.name} width={40} height={40} className="h-10 w-10 rounded-full object-cover" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand/10 font-semibold text-brand">{it.name?.[0] ?? '?'}</span>
              )}
              <div>
                <Txt ctx={ctx} block={block} path={`items.${i}.name`} value={it.name} as="div" className="block text-sm font-semibold" />
                <Txt ctx={ctx} block={block} path={`items.${i}.role`} value={it.role} as="div" className="block text-xs text-slate-500" />
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  ),
};

export const cta: BlockDefinition<{ title: string; text: string; buttonLabel: string; buttonUrl: string; style: string; image: any }> = {
  type: 'cta',
  label: 'Kêu gọi hành động (CTA)',
  icon: 'megaphone',
  category: 'marketing',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    { name: 'text', label: 'Mô tả', type: 'textarea' },
    { name: 'buttonLabel', label: 'Nút - chữ', type: 'text' },
    { name: 'buttonUrl', label: 'Nút - liên kết', type: 'url' },
    { name: 'style', label: 'Kiểu', type: 'select', options: [{ value: 'primary', label: 'Màu thương hiệu' }, { value: 'dark', label: 'Tối' }, { value: 'image', label: 'Ảnh nền' }] },
    { name: 'image', label: 'Ảnh nền', type: 'image', showIf: { field: 'style', equals: 'image' } },
  ],
  defaults: { title: 'Sẵn sàng bắt đầu?', text: 'Liên hệ ngay để được tư vấn miễn phí.', buttonLabel: 'Liên hệ', buttonUrl: '/lien-he', style: 'primary', image: null },
  component: ({ data, ctx, block }) => (
    <div
      className={cn('relative overflow-hidden rounded-3xl px-6 py-12 text-center text-white @3xl:px-16 @3xl:py-16', data.style === 'dark' ? 'bg-slate-900' : 'bg-brand')}
      style={data.style === 'image' && data.image?.url ? { backgroundImage: `linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55)),url(${data.image.url})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
    >
      <Txt ctx={ctx} block={block} path="title" value={data.title} as="h2" className="block text-2xl font-bold @3xl:text-4xl" />
      <Txt ctx={ctx} block={block} path="text" value={data.text} as="p" multiline className="mx-auto mt-3 block max-w-2xl text-white/85" />
      {data.buttonLabel && (
        <ctx.Link href={data.buttonUrl || '#'} className="mt-7 inline-flex rounded-lg bg-white px-7 py-3 text-sm font-semibold text-slate-900 hover:bg-white/90">
          {data.buttonLabel}
        </ctx.Link>
      )}
    </div>
  ),
};

export const logos: BlockDefinition<{ title: string; logos: { image: any; url: string; name: string }[] }> = {
  type: 'logos',
  label: 'Logo đối tác',
  icon: 'building-2',
  category: 'marketing',
  fields: [
    { name: 'title', label: 'Tiêu đề', type: 'text' },
    {
      name: 'logos',
      label: 'Logo',
      type: 'repeater',
      itemLabelField: 'name',
      fields: [
        { name: 'name', label: 'Tên', type: 'text' },
        { name: 'image', label: 'Logo', type: 'image' },
        { name: 'url', label: 'Liên kết', type: 'url' },
      ],
    },
  ],
  defaults: { title: 'Đối tác tin cậy', logos: [] },
  component: ({ data, ctx, block }) => (
    <div>
      <Txt ctx={ctx} block={block} path="title" value={data.title} as="p" className="mb-6 block text-center text-sm font-semibold uppercase tracking-wider opacity-60" />
      <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
        {(data.logos ?? []).map((l, i) =>
          l.image?.url ? (
            <ctx.Link key={i} href={l.url || '#'} className="opacity-60 grayscale transition hover:opacity-100 hover:grayscale-0">
              <ctx.Image src={l.image.url} alt={l.name || 'logo'} width={140} height={56} className="h-10 w-auto object-contain @3xl:h-12" />
            </ctx.Link>
          ) : (
            <span key={i} className="text-lg font-bold opacity-40">
              {l.name}
            </span>
          ),
        )}
      </div>
    </div>
  ),
};
