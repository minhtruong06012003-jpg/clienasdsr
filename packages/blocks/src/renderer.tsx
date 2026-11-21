import type { BlockNode } from '@cmsnt/shared';
import type { RenderContext } from './types';
import { getBlock } from './registry';
import { containerClass, sectionClasses } from './utils';

/** Bọc block trong <section> áp dụng cài đặt chung (khoảng cách, nền, container, ẩn theo thiết bị) */
export function BlockSection({ block, ctx }: { block: BlockNode; ctx: RenderContext }) {
  const def = getBlock(block.type);
  if (!def) {
    // Block chưa đăng ký trong registry (vd. dữ liệu cũ): chỉ báo ở chế độ chỉnh sửa, ngoài site thì bỏ qua
    return ctx.mode === 'edit' ? <div className="m-4 rounded-lg border border-dashed border-amber-400 bg-amber-50 p-4 text-sm text-amber-700">Block "{block.type}" chưa được đăng ký</div> : null;
  }
  const settings = { ...(def.defaultSettings ?? {}), ...(block.settings ?? {}) };
  const Component = def.component;
  return (
    <section
      id={settings.anchor || undefined}
      data-block-type={block.type}
      className={sectionClasses(settings)}
      style={{ background: settings.background || undefined, color: settings.textColor || undefined }}
    >
      <div className={containerClass(settings.container)}>
        <Component block={block} data={{ ...def.defaults, ...(block.data ?? {}) }} resolved={block.resolved ?? {}} ctx={ctx} />
      </div>
    </section>
  );
}

/** Render danh sách block cho storefront */
export function BlockRenderer({ blocks, ctx }: { blocks: BlockNode[] | undefined; ctx: RenderContext }) {
  const withNested: RenderContext = { ...ctx, renderBlocks: (nested) => <BlockRenderer blocks={nested} ctx={ctx} /> };
  return (
    <>
      {(blocks ?? []).map((b) => (
        <BlockSection key={b.id} block={b} ctx={withNested} />
      ))}
    </>
  );
}
