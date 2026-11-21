import { buildPath, type ContentType } from '@cmsnt/shared';

/**
 * Địa chỉ website/frontend riêng (tuỳ chọn, NEXT_PUBLIC_WEB_URL). Mặc định rỗng: dự án chỉ dùng admin + API headless
 * thì mọi link "Xem website / Xem trên web" được ẩn đi thay vì trỏ tới địa chỉ không tồn tại.
 */
const RAW_WEB_URL = (process.env.NEXT_PUBLIC_WEB_URL ?? '').trim();

/**
 * NEXT_PUBLIC_WEB_URL=/ : website chạy cùng domain với admin (web con dùng chung bản build) -> link tương đối theo domain đang mở.
 * Khi đó WEB_URL = '' và mọi link ghép `${WEB_URL}/duong-dan` thành đường dẫn tương đối.
 */
export const WEB_URL = RAW_WEB_URL.replace(/\/+$/, '');

/** Đã cấu hình địa chỉ website chưa — dùng để ẩn/hiện các link mở website */
export const HAS_WEB_URL = RAW_WEB_URL !== '';

/** Trang chủ website (dùng cho link "Xem website"); cùng domain thì là '/' */
export const WEB_HOME = WEB_URL || '/';

/** URL công khai trên website của một nội dung; trả '' khi chưa cấu hình WEB_URL (nơi gọi ẩn link) */
export function siteUrl(type: ContentType, slug: string | null | undefined, locale: string, defaultLocale: string) {
  if (!HAS_WEB_URL) return '';
  return `${WEB_URL}${buildPath(type, slug, locale, defaultLocale)}`;
}

/** Đường dẫn con của admin (vd: /admin khi chạy chung domain với website/frontend riêng) */
export const BASE_PATH = (process.env.NEXT_PUBLIC_ADMIN_BASE_PATH ?? '').replace(/\/+$/, '');

/** Bỏ basePath khỏi pathname của trình duyệt để dùng với router của Next (router tự thêm lại) */
export function stripBasePath(pathname: string) {
  return BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`)) ? pathname.slice(BASE_PATH.length) || '/' : pathname;
}
