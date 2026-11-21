/** Cấu hình tĩnh của website (lấy từ biến môi trường NEXT_PUBLIC_*, có thể bị bootstrap ghi đè khi hiển thị) */
export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || "NOV AI";
export const SITE_DESCRIPTION = process.env.NEXT_PUBLIC_SITE_DESCRIPTION || "Tạo video, ảnh, giọng đọc, âm nhạc bằng AI với các model hàng đầu — trả phí theo lượt dùng";
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");
/** Địa chỉ trang quản trị (apps/admin); rỗng = không hiện nút mở trang quản trị */
export const ADMIN_URL = (process.env.NEXT_PUBLIC_ADMIN_URL || "").replace(/\/+$/, "");

/** Tài khoản được vào trang quản trị: vai trò có quyền "admin.access" hoặc toàn quyền "*" (khớp kiểm tra ở API) */
export function canOpenAdmin(user?: { role?: { permissions?: string[] } } | null) {
  const perms = user?.role?.permissions ?? [];
  return ADMIN_URL !== "" && (perms.includes("*") || perms.includes("admin.access"));
}

/** Địa chỉ API phía máy chủ Next (server component gọi thẳng, không qua rewrite) */
export const SERVER_API_URL = (process.env.API_URL || "http://localhost:4537").replace(/\/+$/, "");
