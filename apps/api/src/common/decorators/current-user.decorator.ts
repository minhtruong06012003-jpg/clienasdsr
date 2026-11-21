import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
  roleSlug: string;
  permissions: string[];
  /** Tài khoản đã bật 2FA chưa (guard quyền dùng để ép "Bắt buộc 2FA với quản trị"); không có với API key */
  twoFactorEnabled?: boolean;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  const req = ctx.switchToHttp().getRequest();
  return req.user;
});
