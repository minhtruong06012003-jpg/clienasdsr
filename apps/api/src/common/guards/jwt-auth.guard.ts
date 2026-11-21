import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IGNORE_AUTH_HEADER_KEY, IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { AuthUserCache } from '../../modules/auth/auth-user.cache.js';
import { ApiKeyAuthService } from '../../modules/api-keys/api-key-auth.service.js';
import { hasPermission } from '@cmsnt/shared';
import { extractApiKey, isApiKeyBlockedRoute, isCustomerApiKeyRoute } from '../../modules/api-keys/api-key.util.js';
import { DENY_API_KEY_KEY } from '../../modules/api-keys/deny-api-key.decorator.js';
import { SessionsService } from '../../modules/security/sessions.service.js';

/**
 * Guard toàn cục: xác thực Bearer token (JWT) hoặc API key cá nhân, gắn req.user.
 * - API key: `Authorization: Bearer cmsnt_...` hoặc header `X-API-Key` → req.user (quyền = giao quyền vai trò và quyền key),
 *   req.authMethod = 'api_key'. Key không dùng được cho route đổi mật khẩu/2FA/tạo key (403);
 *   key của khách (không có admin.access) chỉ gọi được nhóm route AI Studio (isCustomerApiKeyRoute).
 * - JWT: giữ nguyên hành vi cũ.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly users: AuthUserCache,
    private readonly apiKeys: ApiKeyAuthService,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest();
    if (isPublic && this.reflector.getAllAndOverride<boolean>(IGNORE_AUTH_HEADER_KEY, [context.getHandler(), context.getClass()])) return true;

    // Ưu tiên API key nếu request gửi key (định dạng cmsnt_...)
    const apiKey = extractApiKey(req.headers ?? {});
    if (apiKey) {
      const user = await this.apiKeys.authenticate(apiKey, req.ip);
      if (!user) throw new UnauthorizedException('API key không hợp lệ, đã hết hạn hoặc đã bị thu hồi');
      const path = String(req.originalUrl ?? req.url ?? '').split('?')[0].toLowerCase();
      const denied = this.reflector.getAllAndOverride<boolean>(DENY_API_KEY_KEY, [context.getHandler(), context.getClass()]);
      if (denied || isApiKeyBlockedRoute(String(req.method ?? 'GET'), path)) {
        throw new ForbiddenException('Không thể dùng API key cho thao tác này, vui lòng đăng nhập');
      }
      // key của khách (không có quyền quản trị) chỉ gọi được nhóm route AI Studio
      if (!hasPermission(user.permissions, 'admin.access') && !isCustomerApiKeyRoute(String(req.method ?? 'GET'), path)) {
        throw new ForbiddenException('API key chỉ dùng được cho các API AI Studio (xem tài liệu API)');
      }
      req.user = user;
      req.authMethod = 'api_key';
      return true;
    }

    const token = this.extractToken(req);

    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string; sid?: string; purpose?: string }>(token);
        if (payload.purpose) throw new Error('Token không dùng để xác thực');
        // token đăng nhập luôn gắn phiên (sid); token thiếu sid là token tự ký/giả -> từ chối
        if (!payload.sid) throw new Error('Token thiếu phiên');
        // phiên đã bị thu hồi (đăng xuất thiết bị, đổi mật khẩu, admin khoá...) -> token cũ hết hiệu lực ngay
        if (!(await this.sessions.isActive(payload.sid))) throw new Error('Phiên đã bị thu hồi');
        const user = await this.users.get(payload.sub);
        if (user) req.user = user;
      } catch {
        // kể cả route public: client đã gửi token thì phải là token hợp lệ (client sẽ refresh rồi gọi lại),
        // tránh thành viên có token hết hạn bị xử lý như khách vãng lai (đơn hàng không gắn tài khoản...)
        throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
      }
    }

    if (isPublic) return true;
    if (!req.user) throw new UnauthorizedException('Vui lòng đăng nhập');
    return true;
  }

  private extractToken(req: { headers: Record<string, string | undefined> }): string | undefined {
    const [type, token] = req.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
