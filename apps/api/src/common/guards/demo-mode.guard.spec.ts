import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DemoModeGuard, demoPath, isDemoAllowed } from './demo-mode.guard.js';
import type { SettingsService } from '../../modules/settings/settings.service.js';

/** Dựng ExecutionContext HTTP tối thiểu với method/url/user cho guard */
function ctx(method: string, url: string, user?: { roleSlug: string }): ExecutionContext {
  return { getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: url, user }) }) } as unknown as ExecutionContext;
}

function guard(demo: Record<string, unknown> | undefined) {
  const get = vi.fn().mockResolvedValue(demo ?? {});
  return { g: new DemoModeGuard({ get } as unknown as SettingsService), get };
}

describe('demoPath / isDemoAllowed', () => {
  it('chuẩn hoá đường dẫn', () => {
    expect(demoPath('/api/Auth/Login/?x=1')).toBe('auth/login');
    expect(demoPath('//api//admin/edit-locks/post/1')).toBe('admin/edit-locks/post/1');
  });
  it('cho đọc và đăng nhập, chặn ghi khác', () => {
    expect(isDemoAllowed('GET', '/api/admin/products')).toBe(true);
    expect(isDemoAllowed('POST', '/api/auth/admin/login')).toBe(true);
    expect(isDemoAllowed('POST', '/api/admin/edit-locks/post/abc')).toBe(true);
    expect(isDemoAllowed('POST', '/api/admin/products')).toBe(false);
    expect(isDemoAllowed('PATCH', '/api/auth/me')).toBe(false);
    expect(isDemoAllowed('POST', '/api/auth/change-password')).toBe(false);
  });
});

describe('DemoModeGuard', () => {
  it('tắt demo -> cho qua', async () => {
    const { g } = guard({ enabled: false });
    await expect(g.canActivate(ctx('DELETE', '/api/admin/products/1', { roleSlug: 'administrator' }))).resolves.toBe(true);
  });

  it('bật demo -> chặn ghi kèm thông báo tuỳ chỉnh', async () => {
    const { g } = guard({ enabled: true, message: 'Bản demo' });
    await expect(g.canActivate(ctx('PUT', '/api/admin/settings/general', { roleSlug: 'administrator' }))).rejects.toThrow(new ForbiddenException('Bản demo'));
  });

  it('bật demo -> vẫn cho đọc mà không đọc cài đặt', async () => {
    const { g, get } = guard({ enabled: true });
    await expect(g.canActivate(ctx('GET', '/api/admin/products'))).resolves.toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('bật demo -> miễn cho Nhà phát triển', async () => {
    const { g } = guard({ enabled: true });
    await expect(g.canActivate(ctx('PUT', '/api/admin/settings/demo', { roleSlug: 'developer' }))).resolves.toBe(true);
  });

  it('bật demo -> khách chưa đăng nhập cũng bị chặn (đăng ký, đặt hàng...)', async () => {
    const { g } = guard({ enabled: true });
    await expect(g.canActivate(ctx('POST', '/api/auth/register'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
