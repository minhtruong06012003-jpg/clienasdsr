import { createHash, randomInt } from 'node:crypto';
import { API_KEY_DISPLAY_PREFIX_LENGTH, API_KEY_PREFIX, API_KEY_RANDOM_LENGTH, hasPermission, isApiKeyFormat } from '@cmsnt/shared';

/** Bảng ký tự base62 dùng sinh phần ngẫu nhiên của key */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Sinh key mới `cmsnt_<32 ký tự base62>` bằng nguồn ngẫu nhiên mật mã (randomInt không lệch phân phối) */
export function generateApiKey(): string {
  let out = '';
  for (let i = 0; i < API_KEY_RANDOM_LENGTH; i++) out += BASE62[randomInt(BASE62.length)];
  return API_KEY_PREFIX + out;
}

/** Băm sha256 (hex) — DB chỉ lưu giá trị này, không lưu key gốc */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Phần đầu key để hiển thị nhận diện (vd "cmsnt_ab12cd") */
export function displayPrefix(key: string): string {
  return key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

/**
 * Lấy API key từ request: `Authorization: Bearer cmsnt_...` hoặc header `X-API-Key`.
 * Trả undefined nếu không có key (Bearer khác định dạng key được coi là JWT — guard xử lý riêng).
 */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const x = headers['x-api-key'];
  const xv = Array.isArray(x) ? x[0] : x;
  if (xv) return xv.trim();
  const auth = headers.authorization;
  const av = Array.isArray(auth) ? auth[0] : auth;
  const [type, token] = av?.split(' ') ?? [];
  if (type === 'Bearer' && token?.startsWith(API_KEY_PREFIX)) return token;
  return undefined;
}

/** Định dạng hợp lệ của key (kiểm trước khi truy vấn DB) */
export const isValidKeyFormat = isApiKeyFormat;

/**
 * Quyền hiệu lực khi gọi bằng key = giao(quyền vai trò, quyền của key).
 * Key không giới hạn quyền (mảng rỗng) -> toàn bộ quyền vai trò hiện tại.
 * Vai trò bị thu hẹp sau khi tạo key thì key cũng tự mất quyền tương ứng.
 */
export function effectivePermissions(rolePermissions: readonly string[], keyPermissions: readonly string[]): string[] {
  if (!keyPermissions.length) return [...rolePermissions];
  return keyPermissions.filter((p) => hasPermission(rolePermissions, p));
}

/**
 * Route không cho phép dùng API key (chỉ phiên đăng nhập thật mới được làm):
 * mọi route /auth/* (đổi mật khẩu, 2FA, phiên, hồ sơ...) trừ `GET /auth/me`,
 * và mọi thao tác ghi trên /admin/api-keys, /account/api-keys (tạo/thu hồi key).
 * `path` là đường dẫn đã bỏ query, có hoặc không có tiền tố `/api`.
 */
export function isApiKeyBlockedRoute(method: string, path: string): boolean {
  // so khớp không phân biệt hoa/thường: Express mặc định khớp route không phân biệt, /api/Auth/... vẫn vào AuthController
  const p = path.toLowerCase().replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  if (p === '/auth' || p.startsWith('/auth/')) return !(m === 'GET' && p === '/auth/me');
  if (p === '/admin/api-keys' || p.startsWith('/admin/api-keys/')) return m !== 'GET';
  if (p === '/account/api-keys' || p.startsWith('/account/api-keys/')) return m !== 'GET';
  return false;
}

/**
 * Route khách (không có quyền admin.access) được gọi bằng API key — chỉ phần AI Studio cho đối tác tích hợp:
 * xem thông tin tài khoản (`GET /auth/me`), dữ liệu công khai (`GET /public/*`, gồm danh mục công cụ), chạy/báo giá/xem/huỷ tác vụ
 * và tải file đầu vào (`/account/ai/*`), xem số dư và lịch sử credits (`GET /account/credits`, `/transactions`).
 * Các route khác (mua gói, rút hoa hồng, đổi hồ sơ...) bắt buộc đăng nhập thật để key lộ ra không bị lạm dụng.
 */
export function isCustomerApiKeyRoute(method: string, path: string): boolean {
  const p = path.toLowerCase().replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  if (p.startsWith('/public/')) return m === 'GET';
  if (p.startsWith('/account/ai/')) return true;
  // API theo model chuẩn (/api/v1/models, /api/v1/generations)
  if (p === '/v1' || p.startsWith('/v1/')) return true;
  if (p === '/auth/me' || p === '/account/credits' || p === '/account/credits/transactions') return m === 'GET';
  return false;
}
