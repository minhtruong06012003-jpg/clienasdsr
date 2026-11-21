import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';

export type ImageAlign = 'left' | 'center' | 'right' | null;

export interface ImageFigureAttrs {
  src: string | null;
  alt: string | null;
  title: string | null;
  /** '50%' | '320px' | null */
  width: string | null;
  align: ImageAlign;
  caption: string | null;
  href: string | null;
}

/** Chuẩn hoá độ rộng về dạng 'NN%' hoặc 'NNpx' */
export function normalizeWidth(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?%$/.test(s)) return s;
  if (/^\d+(\.\d+)?px$/.test(s)) return s;
  if (/^\d+(\.\d+)?$/.test(s)) return `${s}px`;
  return null;
}

function widthFromStyle(el: Element | null): string | null {
  if (!el) return null;
  const style = (el as HTMLElement).style;
  return normalizeWidth(style?.width || el.getAttribute('width'));
}

function alignFromClass(el: Element | null): ImageAlign {
  if (!el) return null;
  const data = el.getAttribute('data-align');
  if (data === 'left' || data === 'center' || data === 'right') return data;
  const cls = el.className || '';
  if (/\b(aligncenter|align-center|text-center|mx-auto)\b/.test(cls)) return 'center';
  if (/\b(alignleft|align-left|float-left)\b/.test(cls)) return 'left';
  if (/\b(alignright|align-right|float-right)\b/.test(cls)) return 'right';
  const fl = (el as HTMLElement).style?.float;
  if (fl === 'left' || fl === 'right') return fl;
  return null;
}

/**
 * Node ảnh mở rộng: căn lề, độ rộng, chú thích (figure + figcaption) và liên kết.
 * Xuất HTML:
 *   - không có tuỳ chọn thêm: <img>
 *   - có căn lề/độ rộng/chú thích/link: <figure class="cms-figure" data-align style="width:…"><a><img></a><figcaption>…</figcaption></figure>
 */
export const ImageFigure = Image.extend({
  addOptions() {
    const parent = this.parent?.();
    return { ...parent, inline: false, allowBase64: false, resize: parent?.resize ?? false, HTMLAttributes: { loading: 'lazy' } };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null, renderHTML: () => ({}) },
      align: { default: null, renderHTML: () => ({}) },
      caption: { default: null, renderHTML: () => ({}) },
      href: { default: null, renderHTML: () => ({}) },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure',
        getAttrs: (el) => {
          const img = el.querySelector('img');
          if (!img?.getAttribute('src')) return false;
          return {
            src: img.getAttribute('src'),
            alt: img.getAttribute('alt'),
            title: img.getAttribute('title'),
            width: widthFromStyle(el) ?? widthFromStyle(img),
            align: alignFromClass(el) ?? alignFromClass(img),
            caption: el.querySelector('figcaption')?.textContent?.trim() || null,
            href: el.querySelector('a[href]')?.getAttribute('href') ?? null,
          } satisfies ImageFigureAttrs;
        },
      },
      {
        tag: 'img[src]',
        getAttrs: (img) => {
          const parent = img.parentElement;
          return {
            src: img.getAttribute('src'),
            alt: img.getAttribute('alt'),
            title: img.getAttribute('title'),
            width: widthFromStyle(img),
            align: alignFromClass(img) ?? (parent?.tagName === 'P' ? alignFromClass(parent) : null),
            caption: null,
            href: parent?.tagName === 'A' ? parent.getAttribute('href') : null,
          } satisfies ImageFigureAttrs;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { width, align, caption, href } = node.attrs as ImageFigureAttrs;
    const img: DOMOutputSpec = ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
    const inner: DOMOutputSpec = href ? ['a', { href, target: '_blank', rel: 'noopener' }, img] : img;
    if (!width && !align && !caption && !href) return img;
    const figAttrs: Record<string, string> = { class: 'cms-figure' };
    if (align) figAttrs['data-align'] = align;
    if (width) figAttrs.style = `width:${width}`;
    return caption ? ['figure', figAttrs, inner, ['figcaption', {}, caption]] : ['figure', figAttrs, inner];
  },
});
