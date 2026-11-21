import sanitizeHtmlLib from 'sanitize-html';
import { hasPermission } from '@cmsnt/shared';

/**
 * Lọc HTML do người dùng nhập (chống XSS lưu trữ).
 *
 * Nội dung bài viết / sản phẩm / trang / Page Builder được storefront render thô (dangerouslySetInnerHTML),
 * nên mọi HTML lưu bởi người KHÔNG có quyền `content.unfiltered_html` (hoặc "*") phải đi qua allowlist ở đây
 * trước khi ghi DB. Allowlist bám theo những gì trình soạn thảo Tiptap ở admin sinh ra
 * (apps/admin/src/components/editor/extensions): đoạn, tiêu đề, danh sách, bảng (colgroup/colwidth),
 * ảnh có figure/figcaption/căn lề/độ rộng, nhúng YouTube/Vimeo/Google Maps/Facebook/TikTok,
 * khối mã (class language-xxx), màu chữ (span style color), tô sáng (mark data-color + background-color).
 */

/** Quyền cho phép lưu HTML/JS nguyên văn (block HTML tuỳ chỉnh, nhúng script...) */
export const UNFILTERED_HTML_PERMISSION = 'content.unfiltered_html';

/** Người dùng tối thiểu cần để xét quyền (AuthUser, hoặc undefined khi gọi nội bộ) */
type PermissionHolder = { permissions?: readonly string[] | null } | null | undefined;

/** Có được lưu HTML không lọc không: "*" hoặc quyền `content.unfiltered_html` */
export function canUseUnfilteredHtml(user: PermissionHolder): boolean {
  return hasPermission(user?.permissions ?? undefined, UNFILTERED_HTML_PERMISSION);
}

// ---------------------------------------------------------------------------
// Cấu hình allowlist
// ---------------------------------------------------------------------------

/** Domain được phép nhúng iframe (gồm cả subdomain, vd www.youtube.com, player.vimeo.com) */
const IFRAME_DOMAINS = ['youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'google.com', 'facebook.com', 'tiktok.com'];

/** id hợp lệ: chữ cái đầu, không bắt đầu bằng "_" (tránh DOM clobbering biến toàn cục kiểu __next_f) */
const SAFE_ID = /^[a-z][a-z0-9_-]{0,79}$/i;
/** độ dài CSS đơn giản: 12, 12px, 50%, 1.5rem... */
const CSS_LENGTH = /^-?\d+(\.\d+)?(px|%|em|rem|vw|vh)?$/i;
/** màu CSS: #hex, rgb()/hsl(), tên màu, inherit, var(--x) — không cho url()/expression() */
const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]+|var\(--[\w-]+\))$/i;

const OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    // khối văn bản
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'address',
    // định dạng chữ
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'sup', 'sub', 'mark', 'small', 'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'time', 'wbr',
    // danh sách
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // liên kết + media
    'a', 'img', 'picture', 'source', 'figure', 'figcaption', 'video', 'audio', 'track', 'iframe',
    // bảng (Tiptap TableKit)
    'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    // khác
    'details', 'summary',
  ],
  allowedAttributes: {
    // class (prose, cms-figure, cms-embed, language-xxx...), style (đã giới hạn thuộc tính ở allowedStyles), data-* (data-align, data-color, data-youtube-video...)
    '*': ['class', 'style', 'id', 'title', 'dir', 'lang', 'role', 'data-*', 'aria-*'],
    a: ['href', 'target', 'rel', 'hreflang'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
    source: ['src', 'srcset', 'sizes', 'type', 'media'],
    video: ['src', 'poster', 'controls', 'width', 'height', 'autoplay', 'muted', 'loop', 'playsinline', 'preload'],
    audio: ['src', 'controls', 'autoplay', 'muted', 'loop', 'preload'],
    track: ['src', 'kind', 'srclang', 'label', 'default'],
    iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'loading', 'referrerpolicy'],
    ol: ['start', 'reversed', 'type'],
    li: ['value'],
    th: ['colspan', 'rowspan', 'colwidth', 'scope'],
    td: ['colspan', 'rowspan', 'colwidth'],
    col: ['span', 'width'],
    blockquote: ['cite'],
    q: ['cite'],
    time: ['datetime'],
    details: ['open'],
  },
  // chỉ các scheme an toàn; URL tương đối (/, #, ?) vẫn được giữ
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // ảnh nhúng base64 (data:image/...) — loại data: khác bị chặn ở transformTags
  allowedSchemesByTag: { img: ['http', 'https', 'data'], iframe: ['https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'poster'],
  allowProtocolRelative: false,
  allowedIframeDomains: IFRAME_DOMAINS,
  allowIframeRelativeUrls: false,
  allowedStyles: {
    '*': {
      color: [CSS_COLOR],
      'background-color': [CSS_COLOR],
      'text-align': [/^(left|right|center|justify|start|end)$/i],
      'vertical-align': [/^(top|middle|bottom|baseline)$/i],
      'text-decoration': [/^[a-z\s-]+$/i],
      'font-weight': [/^(normal|bold|bolder|lighter|\d{3})$/i],
      'font-style': [/^(normal|italic|oblique)$/i],
      float: [/^(left|right|none)$/i],
      width: [CSS_LENGTH],
      'min-width': [CSS_LENGTH],
      'max-width': [CSS_LENGTH],
      height: [CSS_LENGTH],
    },
  },
  // thẻ không cho phép: bỏ thẻ, giữ chữ bên trong (script/style/textarea/noscript bị bỏ cả nội dung)
  disallowedTagsMode: 'discard',
  transformTags: {
    '*': (tagName, attribs) => {
      const attrs = { ...attribs };
      // id lạ (vd "__next_f", "location") có thể ghi đè biến toàn cục qua named access -> bỏ
      if (attrs.id !== undefined && !SAFE_ID.test(attrs.id)) delete attrs.id;
      if (tagName === 'a' && attrs.target) {
        // chỉ cho _blank/_self; mở tab mới luôn kèm noopener (chống tabnabbing)
        if (attrs.target !== '_blank' && attrs.target !== '_self') delete attrs.target;
        else if (attrs.target === '_blank') {
          const rel = new Set((attrs.rel ?? '').split(/\s+/).filter(Boolean));
          rel.add('noopener');
          attrs.rel = [...rel].join(' ');
        }
      }
      // ảnh data: chỉ nhận data:image/... (không SVG — tránh nhầm lẫn khi mở ảnh trực tiếp)
      if (tagName === 'img' && attrs.src && /^\s*data:/i.test(attrs.src) && !/^\s*data:image\/(png|jpe?g|gif|webp|avif);/i.test(attrs.src)) delete attrs.src;
      // Google: chỉ nhúng bản đồ (/maps), không nhúng trang google bất kỳ
      if (tagName === 'iframe' && attrs.src) {
        try {
          const u = new URL(attrs.src);
          if (u.protocol !== 'https:' || (/(^|\.)google\.com$/i.test(u.hostname) && !u.pathname.startsWith('/maps'))) delete attrs.src;
        } catch {
          delete attrs.src;
        }
      }
      return { tagName, attribs: attrs };
    },
  },
  // iframe / ảnh không còn src (bị chặn) -> bỏ hẳn thẻ cho gọn
  exclusiveFilter: (frame) => (frame.tag === 'iframe' || frame.tag === 'img') && !frame.attribs.src,
};

/** Lọc một chuỗi HTML theo allowlist nội dung soạn thảo (luôn lọc, không xét quyền) */
export function sanitizeRichHtml(html: string): string {
  if (!html) return html;
  return sanitizeHtmlLib(html, OPTIONS);
}

/**
 * Lọc HTML theo quyền người lưu: có quyền `content.unfiltered_html` / "*" -> giữ nguyên;
 * không có -> lọc. Giữ nguyên null/undefined (service hiểu là "không đổi").
 */
export function cleanHtmlFor<T extends string | null | undefined>(user: PermissionHolder, html: T): T {
  if (typeof html !== 'string' || !html || canUseUnfilteredHtml(user)) return html;
  return sanitizeRichHtml(html) as T;
}

// ---------------------------------------------------------------------------
// Page Builder JSON: [{ id, type, data, settings, resolved }]
// ---------------------------------------------------------------------------

/**
 * Trường HTML của block có sẵn (packages/blocks): kiểu "richtext" và "code".
 * path: "html" = data.html; "items.answer" = data.items[].answer.
 */
const BUILTIN_HTML_FIELDS: Record<string, string[]> = {
  'rich-text': ['html'],
  'image-text': ['html'],
  faq: ['items.answer'],
  columns: ['columns.html'],
  // block HTML tuỳ chỉnh: người không có quyền -> lọc (không xoá block)
  html: ['code'],
};

/** Danh sách block có sẵn — các trường còn lại là text thuần (React tự escape) nên không lọc để khỏi làm hỏng ký tự & < > */
const BUILTIN_TYPES = new Set([
  ...Object.keys(BUILTIN_HTML_FIELDS),
  'hero', 'slider', 'heading', 'image', 'gallery', 'video', 'banner-grid', 'features', 'stats', 'testimonials', 'cta', 'logos',
  'product-grid', 'product-carousel', 'category-grid', 'post-list', 'map', 'spacer', 'global-block', 'custom-fields',
  'entry-list', 'term-list', 'breadcrumbs', 'query-loop', 'dynamic-title', 'dynamic-content', 'dynamic-meta', 'dynamic-image', 'dynamic-field', 'storefront-slot',
]);

/** Key chứa URL (link nút, ảnh, nhúng...) -> chặn scheme nguy hiểm */
const URL_KEY = /(url|href|link|src|embed)$/i;
/** javascript:/vbscript:/data:text... (bỏ khoảng trắng & ký tự điều khiển trước khi so) */
const DANGEROUS_URL = /^(javascript|vbscript|data:(?!image\/(png|jpe?g|gif|webp|avif);))/i;
/** chuỗi trông như HTML (có thẻ mở/đóng/comment) */
const LOOKS_LIKE_HTML = /<[a-z!/?]/i;

const MAX_DEPTH = 20;

type Json = unknown;

/** Lọc giá trị trong data của block: URL nguy hiểm -> ''; với block lạ (tự đăng ký) lọc mọi chuỗi trông như HTML */
function cleanDataValue(value: Json, key: string, unknownType: boolean, depth: number): Json {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') {
    if (URL_KEY.test(key) && DANGEROUS_URL.test(value.replace(/[\s\u0000-\u001f]/g, ''))) return '';
    if (unknownType && LOOKS_LIKE_HTML.test(value)) return sanitizeRichHtml(value);
    return value;
  }
  if (Array.isArray(value)) {
    // mảng block lồng nhau (columns[].blocks...) -> xử lý như danh sách block
    if (key === 'blocks') return sanitizeBlocks(value, depth + 1);
    return value.map((v) => cleanDataValue(v, key, unknownType, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) out[k] = cleanDataValue(v, k, unknownType, depth + 1);
    return out;
  }
  return value;
}

/** Lọc trường HTML theo đường dẫn "a" hoặc "list.field" (list là mảng object) */
function cleanHtmlPath(data: Record<string, Json>, path: string) {
  const [head, sub] = path.split('.');
  if (!sub) {
    if (typeof data[head] === 'string') data[head] = sanitizeRichHtml(data[head] as string);
    return;
  }
  const list = data[head];
  if (!Array.isArray(list)) return;
  data[head] = list.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const copy = { ...(item as Record<string, Json>) };
    if (typeof copy[sub] === 'string') copy[sub] = sanitizeRichHtml(copy[sub] as string);
    return copy;
  });
}

/**
 * Lọc toàn bộ mảng block của Page Builder (luôn lọc, không xét quyền):
 * - trường richtext/code của block có sẵn -> sanitizeRichHtml
 * - block lạ: mọi chuỗi trông như HTML -> sanitizeRichHtml
 * - URL javascript:/vbscript:/data:text -> ''
 * - bỏ `resolved` (dữ liệu tính lúc render, không được lưu từ client — tránh resolved.html do người dùng chèn)
 * - đệ quy block lồng nhau (columns[].blocks)
 */
export function sanitizeBlocks(blocks: Json, depth = 0): Json {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) return blocks;
  return blocks.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const { resolved: _resolved, ...rest } = node as Record<string, Json> & { type?: unknown };
    const type = typeof rest.type === 'string' ? rest.type : '';
    const unknownType = !BUILTIN_TYPES.has(type);
    if (rest.data && typeof rest.data === 'object' && !Array.isArray(rest.data)) {
      const data = cleanDataValue(rest.data, '', unknownType, depth) as Record<string, Json>;
      for (const path of BUILTIN_HTML_FIELDS[type] ?? []) cleanHtmlPath(data, path);
      rest.data = data;
    }
    return rest;
  });
}

/** Lọc mảng block theo quyền người lưu (có quyền -> giữ nguyên). Giữ nguyên undefined/null. */
export function cleanBlocksFor<T>(user: PermissionHolder, blocks: T): T {
  if (blocks == null || canUseUnfilteredHtml(user)) return blocks;
  return sanitizeBlocks(blocks) as T;
}
