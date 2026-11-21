import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** Header frontend SSR dùng để chuyển IP thật của khách khi đã xác thực bằng x-server-secret */
export const CLIENT_IP_HEADER = 'x-client-ip';

/** So sánh header x-server-secret với env SERVER_API_SECRET theo thời gian hằng (băm sha256 để hai bên cùng độ dài) */
export function matchesServerSecret(header: unknown, secret = process.env.SERVER_API_SECRET ?? ''): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!secret || typeof value !== 'string' || !value) return false;
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** IP thật của khách do máy chủ frontend (đã xác thực) chuyển qua header x-client-ip; không hợp lệ thì dùng IP kết nối */
export function trustedClientIp(req: { headers?: Record<string, unknown>; ip?: string }): string {
  const raw = req.headers?.[CLIENT_IP_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw) as string | undefined;
  const ip = typeof value === 'string' ? value.split(',')[0].trim() : '';
  return ip && isIP(ip) ? ip : (req.ip ?? '');
}

/** Request Express tối thiểu cần cho middleware (tránh phụ thuộc kiểu express trong test) */
interface ClientIpRequest {
  originalUrl?: string;
  url?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Đường dẫn trang quản trị: luôn dùng IP kết nối thật (danh sách IP được phép vào admin không được phép bị khai hộ) */
const ADMIN_PATH = /^\/api\/admin(\/|$)/;

/**
 * IP thật của khách do máy chủ frontend (SSR) khai qua header `x-client-ip`.
 * Chỉ tin khi request kèm `x-server-secret` khớp env SERVER_API_SECRET (bí mật chỉ máy chủ frontend biết)
 * và không phải route quản trị; trả null nếu không đủ điều kiện hoặc IP không hợp lệ.
 */
export function forwardedClientIp(req: ClientIpRequest): string | null {
  const path = req.originalUrl ?? req.url ?? '';
  if (ADMIN_PATH.test(path)) return null;
  if (!matchesServerSecret(req.headers['x-server-secret'])) return null;
  const raw = req.headers[CLIENT_IP_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const ip = value.split(',')[0].trim();
  return ip && isIP(ip) ? ip : null;
}

/**
 * Middleware gắn ngay sau `trust proxy`: frontend SSR gọi API thay cho khách (đăng nhập, checkout, bình luận...)
 * thì `req.ip` được thay bằng IP thật của khách, để chặn IP, chống dò mật khẩu, nhật ký đăng nhập, đơn hàng...
 * ghi đúng người dùng thay vì IP máy chủ frontend (và máy chủ frontend không bị tự động chặn IP).
 */
export function clientIpMiddleware() {
  return (req: ClientIpRequest, _res: unknown, next: () => void) => {
    const ip = forwardedClientIp(req);
    // req.ip của Express là getter trên prototype -> gán thuộc tính riêng của request để ghi đè
    if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
    next();
  };
}
