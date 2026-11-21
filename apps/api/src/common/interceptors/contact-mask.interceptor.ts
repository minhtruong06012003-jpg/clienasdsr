import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { hasPermission } from '@cmsnt/shared';
import { map, Observable } from 'rxjs';
import type { AuthUser } from '../decorators/current-user.decorator.js';
import { isChildSite } from '../utils/tenant.js';

const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
/** Route trả file (CSV...) ghi thẳng vào response, không qua bước che -> chặn hẳn */
const EXPORT_RE = /(\.csv|\.xlsx)$|\/export$/;

export const maskEmail = (local: string, domain: string) => `${local.slice(0, Math.min(2, local.length - 1) || 1)}***@${domain}`;

function mask(value: unknown, ownEmail: string): unknown {
  if (typeof value === 'string') {
    return value.includes('@')
      ? value.replace(EMAIL_RE, (m, local: string, domain: string) => (m.toLowerCase() === ownEmail ? m : maskEmail(local, domain)))
      : value;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((v) => mask(v, ownEmail));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = mask(v, ownEmail);
  return out;
}

/**
 * Web con: tài khoản quản trị không có quyền sửa thành viên (vai trò Cộng tác viên của chủ web con)
 * vẫn xem được SĐT khách để hỗ trợ/chăm sóc, chỉ che email khách (ng***@gmail.com) trên mọi API /api/admin/*
 * và không được tải file xuất dữ liệu. Email của chính mình giữ nguyên.
 */
@Injectable()
export class ContactMaskInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!isChildSite() || context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{ path?: string; url?: string; user?: AuthUser }>();
    const path = String(req.path ?? req.url ?? '').split('?')[0];
    const user = req.user;
    if (!path.startsWith('/api/admin/') || !user?.permissions || hasPermission(user.permissions, 'users.write')) return next.handle();
    if (EXPORT_RE.test(path)) throw new ForbiddenException('Tài khoản cộng tác viên không được xuất dữ liệu');
    const own = String(user.email ?? '').toLowerCase();
    return next.handle().pipe(map((data) => mask(data, own)));
  }
}
