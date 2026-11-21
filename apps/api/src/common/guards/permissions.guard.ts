import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasAnyPermission, hasPermission } from '@cmsnt/shared';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } from '../decorators/permissions.decorator.js';
import { IpRulesService } from '../../modules/security/ip-rules.service.js';
import { SettingsService } from '../../modules/settings/settings.service.js';

/**
 * Guard toàn cục kiểm quyền cho route có @RequirePermissions (tức thao tác quản trị), kèm 2 lớp chặn theo người dùng
 * (không dựa vào đường dẫn, nên phủ mọi route và mọi cách viết hoa/thường của URL):
 * - "Chỉ cho phép IP trong danh sách vào trang quản trị": IP ngoài danh sách -> 403, dù token lấy từ đăng nhập website.
 * - "Bắt buộc 2FA với tài khoản quản trị": tài khoản quản trị chưa bật 2FA -> 403 cho mọi thao tác quản trị
 *   (vẫn dùng được /auth/* để bật 2FA vì các route đó không gắn @RequirePermissions).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly ipRules: IpRulesService,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndMerge<string[]>(PERMISSIONS_KEY, [context.getClass(), context.getHandler()]);
    const anyRequired = this.reflector.getAllAndMerge<string[]>(ANY_PERMISSIONS_KEY, [context.getClass(), context.getHandler()]);
    if (!required?.length && !anyRequired?.length) return true;
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
    }
    if (required?.length && !hasPermission(user.permissions, required)) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
    }
    if (anyRequired?.length && !hasAnyPermission(user.permissions, anyRequired)) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
    }
    let ipAllowed = true;
    try {
      ipAllowed = await this.ipRules.isAdminAllowed(req.ip);
    } catch {
      // lỗi tra quy tắc -> cho qua (fail-open) giống middleware lọc IP, tránh khoá toàn bộ trang quản trị
    }
    if (!ipAllowed) throw new ForbiddenException('Địa chỉ IP của bạn không được phép truy cập trang quản trị');
    // API key là cơ chế riêng của chính tài khoản đó, không áp yêu cầu 2FA theo phiên
    if (req.authMethod !== 'api_key' && user.twoFactorEnabled === false) {
      const security = await this.settings.get<{ require2faForAdmins?: boolean }>('security').catch(() => ({}) as { require2faForAdmins?: boolean });
      if (security.require2faForAdmins && hasPermission(user.permissions, 'admin.access')) {
        throw new ForbiddenException('Bạn cần bật xác thực 2 lớp (Hồ sơ › Bảo mật) trước khi dùng trang quản trị');
      }
    }
    return true;
  }
}
