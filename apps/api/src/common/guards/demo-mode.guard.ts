import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { DEVELOPER_ROLE } from '@cmsnt/shared';
import { SettingsService } from '../../modules/settings/settings.service.js';

/** Method chỉ đọc -> luôn cho qua */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Route ghi vẫn mở khi demo (so theo đường dẫn sau tiền tố /api, chữ thường):
 * đăng nhập / đăng xuất / làm mới token, khoá chỉnh sửa tạm thời, báo lỗi JS, thống kê lượt xem, token xem trước.
 */
const ALLOWED_EXACT = new Set([
  'auth/admin/login',
  'auth/login',
  'auth/2fa/verify',
  'auth/refresh',
  'auth/logout',
  'admin/client-errors',
  'public/client-errors',
  'public/track',
  'admin/preview/token',
  'admin/logs/seen',
]);
const ALLOWED_PREFIX = ['admin/edit-locks/'];

/** Đường dẫn request -> dạng "auth/login" (bỏ query, tiền tố /api, dấu / thừa) */
export function demoPath(url: string): string {
  return url
    .split('?')[0]
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/^\/(api\/)?/, '')
    .replace(/\/+$/, '');
}

/** Request ghi này có được phép khi đang bật chế độ demo không */
export function isDemoAllowed(method: string, url: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return true;
  const path = demoPath(url);
  return ALLOWED_EXACT.has(path) || ALLOWED_PREFIX.some((p) => path.startsWith(p));
}

/**
 * Guard toàn cục cho chế độ demo (Cài đặt › Chế độ demo, nhóm settings `demo`).
 * Bật -> mọi request thêm/sửa/xoá (POST/PUT/PATCH/DELETE) trả 403, kể cả siêu quản trị, để người xem demo
 * không làm hỏng dữ liệu. Miễn cho vai trò Nhà phát triển (người dựng demo, cũng là người duy nhất tắt được chế độ này)
 * -> tài khoản demo đưa cho khách KHÔNG được dùng vai trò Nhà phát triển.
 * Chạy sau JwtAuthGuard nên đã có req.user (nếu đăng nhập).
 */
@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(private readonly settings: SettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest();
    const method = String(req.method ?? 'GET');
    // request đọc: không tốn truy vấn cài đặt
    if (READ_METHODS.has(method.toUpperCase())) return true;
    if (isDemoAllowed(method, String(req.originalUrl ?? req.url ?? ''))) return true;

    // cài đặt đã cache trong bộ nhớ; lỗi đọc -> cho qua (fail-open) để không khoá cả hệ thống
    const demo = await this.settings.get<{ enabled?: boolean; message?: string }>('demo').catch(() => ({}) as { enabled?: boolean; message?: string });
    if (!demo.enabled) return true;
    if (req.user?.roleSlug === DEVELOPER_ROLE) return true;
    throw new ForbiddenException(demo.message?.trim() || 'Đang ở chế độ demo — không thể thêm, sửa hoặc xoá dữ liệu.');
  }
}
