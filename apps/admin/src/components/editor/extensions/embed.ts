import { Node, mergeAttributes } from '@tiptap/core';
import { isValidYoutubeUrl } from '@tiptap/extension-youtube';

export interface EmbedAttrs {
  src: string;
  width: string;
  height: string;
  title: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    embed: {
      /** Chèn iframe nhúng (chỉ nhận src https) */
      setEmbed: (attrs: Partial<EmbedAttrs> & { src: string }) => ReturnType;
    };
  }
}

/** Chỉ chấp nhận URL https tuyệt đối */
export function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export type ResolvedEmbed = { kind: 'youtube'; src: string } | { kind: 'iframe'; src: string; width?: string; height?: string; title?: string | null };

/**
 * Nhận URL (YouTube, Facebook video, TikTok, Google Maps, URL https bất kỳ) hoặc mã <iframe> dán vào,
 * trả về cấu hình nhúng đã sanitize. Trả null nếu không hợp lệ.
 */
export function resolveEmbed(input: string): ResolvedEmbed | null {
  const text = input.trim();
  if (!text) return null;

  // mã iframe HTML
  if (/<iframe[\s>]/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const iframe = doc.querySelector('iframe');
    const src = safeHttpsUrl(iframe?.getAttribute('src'));
    if (!src) return null;
    if (isValidYoutubeUrl(src)) return { kind: 'youtube', src };
    const w = iframe?.getAttribute('width');
    const h = iframe?.getAttribute('height');
    return { kind: 'iframe', src, width: w && /^\d+%?$/.test(w) ? w : undefined, height: h && /^\d+$/.test(h) ? h : undefined, title: iframe?.getAttribute('title') };
  }

  const url = safeHttpsUrl(text);
  if (!url) return null;
  if (isValidYoutubeUrl(url)) return { kind: 'youtube', src: url };

  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');

  // Facebook video / post
  if (/(^|\.)facebook\.com$/.test(host) || host === 'fb.watch') {
    if (u.pathname.startsWith('/plugins/')) return { kind: 'iframe', src: url, height: '400' };
    const isVideo = /\/videos?\//.test(u.pathname) || /\/watch/.test(u.pathname) || /\/reel\//.test(u.pathname) || host === 'fb.watch';
    const plugin = isVideo ? 'video' : 'post';
    return { kind: 'iframe', src: `https://www.facebook.com/plugins/${plugin}.php?href=${encodeURIComponent(url)}&show_text=false`, height: isVideo ? '400' : '600', title: 'Facebook' };
  }

  // TikTok: https://www.tiktok.com/@user/video/123456
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const m = u.pathname.match(/\/video\/(\d+)/);
    if (m) return { kind: 'iframe', src: `https://www.tiktok.com/embed/v2/${m[1]}`, width: '325', height: '580', title: 'TikTok' };
    if (u.pathname.startsWith('/embed/')) return { kind: 'iframe', src: url, width: '325', height: '580', title: 'TikTok' };
    return null;
  }

  // Google Maps: chỉ nhận link embed (link share thường không cho phép nhúng)
  if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname.startsWith('/maps')) {
    if (u.pathname.startsWith('/maps/embed')) return { kind: 'iframe', src: url, height: '450', title: 'Google Maps' };
    return { kind: 'iframe', src: `https://maps.google.com/maps?q=${encodeURIComponent(u.searchParams.get('q') ?? u.pathname.replace('/maps/place/', '').split('/')[0] ?? '')}&output=embed`, height: '450', title: 'Google Maps' };
  }

  // Vimeo
  if (host === 'vimeo.com') {
    const m = u.pathname.match(/\/(\d+)/);
    if (m) return { kind: 'iframe', src: `https://player.vimeo.com/video/${m[1]}`, title: 'Vimeo' };
  }

  // URL https khác: nhúng trực tiếp
  return { kind: 'iframe', src: url };
}

/** Node iframe nhúng chung (Facebook, TikTok, Google Maps, iframe https bất kỳ) */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      width: { default: '100%' },
      height: { default: '450' },
      title: { default: null },
    };
  },

  parseHTML() {
    const fromIframe = (iframe: Element | null) => {
      const src = safeHttpsUrl(iframe?.getAttribute('src'));
      if (!iframe || !src) return false;
      // iframe YouTube do extension Youtube xử lý
      if (iframe.closest('[data-youtube-video]') || /youtube(-nocookie)?\.com\/embed\//.test(src)) return false;
      return { src, width: iframe.getAttribute('width') || '100%', height: iframe.getAttribute('height') || '450', title: iframe.getAttribute('title') };
    };
    return [
      { tag: 'div.cms-embed', getAttrs: (el) => fromIframe(el.querySelector('iframe')) },
      { tag: 'iframe[src]', getAttrs: (el) => fromIframe(el) },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { src, width, height, title } = HTMLAttributes as EmbedAttrs;
    return [
      'div',
      { class: 'cms-embed', 'data-embed': '' },
      [
        'iframe',
        mergeAttributes({
          src,
          width,
          height,
          title: title ?? undefined,
          frameborder: '0',
          allowfullscreen: 'true',
          loading: 'lazy',
          allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
          referrerpolicy: 'strict-origin-when-cross-origin',
        }),
      ],
    ];
  },

  addCommands() {
    return {
      setEmbed:
        (attrs) =>
        ({ commands }) => {
          const src = safeHttpsUrl(attrs.src);
          if (!src) return false;
          return commands.insertContent({ type: this.name, attrs: { ...attrs, src } });
        },
    };
  },
});
