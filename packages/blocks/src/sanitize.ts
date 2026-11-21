import DOMPurify from 'dompurify';

/**
 * Thẻ bị bỏ thêm (ngoài những gì DOMPurify đã chặn): iframe/nhúng, form và các thẻ cấu trúc trang
 * — giữ đúng hành vi cũ của canvas (không chạy nhúng, không cho bấm gửi form trong trình dựng).
 */
const EDITOR_FORBID_TAGS = ['iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'meta', 'style', 'form', 'input', 'button', 'textarea', 'select', 'noscript', 'template'];

/**
 * Làm sạch HTML để hiển thị trong canvas của Page Builder / hộp thoại xem phiên bản (trang quản trị):
 * nội dung do người dùng khác nhập không được chạy script trên origin admin.
 * Dùng DOMPurify (allowlist, chỉ hồ sơ HTML — bỏ SVG/MathML nên chặn được cả kiểu
 * `<svg><animate attributeName="href" values="javascript:...">` mà bản blacklist cũ để lọt).
 * Phía server (SSR) không có DOM -> trả chuỗi rỗng; client render lại sau khi hydrate.
 */
export function sanitizeForEditor(html: string): string {
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return '';
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: EDITOR_FORBID_TAGS,
    FORBID_ATTR: ['srcdoc', 'formaction', 'action'],
  });
}
