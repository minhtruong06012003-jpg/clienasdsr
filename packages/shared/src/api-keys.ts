/** Kiểu dùng chung cho API key cá nhân và khoá chỉnh sửa đồng thời (admin + API). */

/** Tiền tố nhận diện key; key đầy đủ = `cmsnt_` + 32 ký tự base62 */
export const API_KEY_PREFIX = 'cmsnt_';
/** Độ dài phần ngẫu nhiên của key */
export const API_KEY_RANDOM_LENGTH = 32;
/** Số ký tự đầu key được lưu để hiển thị nhận diện, vd "cmsnt_ab12cd" */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;

/** Kiểm tra nhanh chuỗi có đúng định dạng API key không (chưa xác thực với DB) */
export function isApiKeyFormat(value: string | undefined | null): value is string {
  return !!value && /^cmsnt_[0-9A-Za-z]{32}$/.test(value);
}

/** Một API key như trả về từ `GET /admin/api-keys` (không bao giờ chứa key đầy đủ) */
export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  /** rỗng = dùng toàn bộ quyền của chủ sở hữu */
  permissions: string[];
  userId: string;
  user?: { id: string; name: string; email: string } | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** active | expired | revoked */
  status: ApiKeyStatus;
}

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

/** Kết quả `POST /admin/api-keys`: chỉ lần này trả key đầy đủ */
export interface ApiKeyCreated extends ApiKeyItem {
  key: string;
}

/** Thực thể hỗ trợ khoá chỉnh sửa */
export type EditLockEntity = 'page' | 'post' | 'product' | 'entry' | 'theme_template' | 'global_block';
export const EDIT_LOCK_ENTITIES: readonly EditLockEntity[] = ['page', 'post', 'product', 'entry', 'theme_template', 'global_block'];
/** Thời gian giữ khoá mỗi lần heartbeat (giây) */
export const EDIT_LOCK_TTL_SECONDS = 60;
/** Chu kỳ heartbeat phía admin (giây) */
export const EDIT_LOCK_HEARTBEAT_SECONDS = 30;

/** Kết quả giữ/gia hạn khoá */
export type EditLockState =
  /** releaseToken: token ký sẵn để nhả khoá bằng navigator.sendBeacon khi đóng tab (beacon không gửi được header Authorization) */
  | { locked: false; expiresAt: string; releaseToken?: string }
  | { locked: true; by: { userId: string; userName: string }; expiresAt: string };
