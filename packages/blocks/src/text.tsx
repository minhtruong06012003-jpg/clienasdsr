import type { ElementType } from 'react';
import type { BlockNode } from '@cmsnt/shared';
import type { RenderContext } from './types';
import { Editable } from './editable';
import { sanitizeForEditor } from './sanitize';

export { sanitizeForEditor };

interface TxtProps {
  ctx: RenderContext;
  block: BlockNode;
  path: string;
  value: unknown;
  as?: ElementType;
  className?: string;
  multiline?: boolean;
  placeholder?: string;
}

/**
 * Hiển thị một trường text. Ở chế độ edit -> sửa trực tiếp trên giao diện;
 * ở storefront -> render HTML tĩnh (server component, không tốn JS).
 */
export function Txt({ ctx, block, path, value, as: Tag = 'span', className, multiline, placeholder }: TxtProps) {
  const text = value == null ? '' : String(value);
  if (ctx.mode === 'edit') return <Editable blockId={block.id} path={path} value={text} as={Tag} className={className} multiline={multiline} placeholder={placeholder} />;
  if (!text) return null;
  return <Tag className={className}>{text}</Tag>;
}

/**
 * Nội dung HTML từ rich text editor.
 * `edit` = đang ở canvas Page Builder -> làm sạch trước khi chèn vào DOM của trang quản trị.
 */
export function Html({ html, className, edit }: { html?: string; className?: string; edit?: boolean }) {
  if (!html) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: edit ? sanitizeForEditor(html) : html }} />;
}
