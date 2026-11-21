import type { BlockDefinition } from '../types';
import { Html, sanitizeForEditor } from '../text';
import { cn } from '../utils';

export const html: BlockDefinition<{ code: string }> = {
  type: 'html',
  label: 'HTML tuỳ chỉnh',
  description: 'Chèn mã HTML / embed',
  icon: 'code',
  category: 'advanced',
  fields: [{ name: 'code', label: 'Mã HTML', type: 'code', help: 'Chỉ dán mã từ nguồn tin cậy.' }],
  defaults: { code: '<div class="text-center">HTML tuỳ chỉnh</div>' },
  component: ({ data, ctx }) =>
    ctx.mode === 'edit' ? (
      <div className="relative">
        <div className="pointer-events-none" dangerouslySetInnerHTML={{ __html: sanitizeForEditor(data.code ?? '') }} />
        <span className="absolute right-2 top-2 rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] text-white">HTML · script không chạy trong trình dựng</span>
      </div>
    ) : (
      <Html html={data.code} />
    ),
};

export const spacer: BlockDefinition<{ size: number; divider: boolean }> = {
  type: 'spacer',
  label: 'Khoảng trắng / Đường kẻ',
  icon: 'separator-horizontal',
  category: 'layout',
  fields: [
    { name: 'size', label: 'Chiều cao (px)', type: 'number', min: 0, max: 400 },
    { name: 'divider', label: 'Hiển thị đường kẻ', type: 'boolean' },
  ],
  defaults: { size: 40, divider: false },
  defaultSettings: { paddingTop: 'none', paddingBottom: 'none' },
  component: ({ data }) => (
    <div style={{ height: Number(data.size) || 0 }} className="flex items-center">
      {data.divider && <hr className="w-full border-slate-200" />}
    </div>
  ),
};

/** Nhúng Global Block (block dùng chung, sửa 1 nơi cập nhật mọi nơi) */
export const globalBlock: BlockDefinition<{ blockKey: string }> = {
  type: 'global-block',
  label: 'Block dùng chung',
  description: 'Chèn block toàn cục (header, footer, CTA...)',
  icon: 'blocks',
  category: 'layout',
  fields: [{ name: 'blockKey', label: 'Block', type: 'global-block' }],
  defaults: { blockKey: '' },
  defaultSettings: { container: 'full', paddingTop: 'none', paddingBottom: 'none' },
  component: ({ data, ctx, resolved }) => {
    const blocks = resolved?.blocks ?? [];
    if (!blocks.length) return ctx.mode === 'edit' ? <div className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-400">Chọn block dùng chung ({data.blockKey || 'chưa chọn'})</div> : null;
    return <div className={cn(ctx.mode === 'edit' && 'pointer-events-none')}>{ctx.renderBlocks?.(blocks)}</div>;
  },
};

type Column = { blocks: any[]; html?: string };
export const columns: BlockDefinition<{ columns: Column[]; gap: string; verticalAlign: string }> = {
  type: 'columns',
  label: 'Cột nội dung',
  description: 'Chia nhiều cột văn bản',
  icon: 'columns-3',
  category: 'layout',
  fields: [
    {
      name: 'columns',
      label: 'Cột',
      type: 'repeater',
      fields: [{ name: 'html', label: 'Nội dung', type: 'richtext' }],
    },
    { name: 'gap', label: 'Khoảng cách', type: 'select', options: [{ value: 'sm', label: 'Nhỏ' }, { value: 'md', label: 'Vừa' }, { value: 'lg', label: 'Lớn' }] },
    { name: 'verticalAlign', label: 'Căn dọc', type: 'select', options: [{ value: 'start', label: 'Trên' }, { value: 'center', label: 'Giữa' }] },
  ],
  defaults: { columns: [{ blocks: [], html: '<p>Cột 1</p>' }, { blocks: [], html: '<p>Cột 2</p>' }], gap: 'md', verticalAlign: 'start' },
  component: ({ data, ctx }) => {
    const cols = data.columns ?? [];
    const gap = data.gap === 'sm' ? 'gap-4' : data.gap === 'lg' ? 'gap-12' : 'gap-8';
    return (
      <div className={cn('grid', gap, data.verticalAlign === 'center' && 'items-center')} style={{ gridTemplateColumns: undefined }}>
        <div className={cn('grid', gap, cols.length >= 3 ? 'grid-cols-1 @3xl:grid-cols-3' : 'grid-cols-1 @3xl:grid-cols-2', cols.length >= 4 && '@5xl:grid-cols-4')}>
          {cols.map((c, i) => (
            <div key={i}>
              {c.blocks?.length ? ctx.renderBlocks?.(c.blocks) : null}
              <Html edit={ctx.mode === 'edit'} html={c.html} className="prose prose-slate max-w-none" />
            </div>
          ))}
        </div>
      </div>
    );
  },
};
