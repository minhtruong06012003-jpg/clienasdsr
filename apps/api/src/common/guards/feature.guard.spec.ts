import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { FeatureGuard } from './feature.guard.js';
import { RequireFeature } from '../decorators/feature.decorator.js';
import type { SettingsService } from '../../modules/settings/settings.service.js';

// Controller giả để gắn metadata như khi dùng thật
@RequireFeature('shop')
class ShopController {
  list() {}
  @RequireFeature('accounts')
  mine() {}
}
class OpenController {
  open() {}
  @RequireFeature('blog')
  posts() {}
}

/** Dựng ExecutionContext tối thiểu cho guard */
function ctx(cls: new () => object, handler: string): ExecutionContext {
  return { getClass: () => cls, getHandler: () => (cls.prototype as Record<string, unknown>)[handler], switchToHttp: () => ({ getRequest: () => ({}) }) } as unknown as ExecutionContext;
}

function guard(features: Record<string, unknown> | undefined) {
  const get = vi.fn().mockResolvedValue(features ?? {});
  const settings = { get } as unknown as SettingsService;
  return { g: new FeatureGuard(new Reflector(), settings), get };
}

describe('FeatureGuard', () => {
  it('route không gắn decorator -> cho qua, không đọc settings', async () => {
    const { g, get } = guard({ shop: false });
    await expect(g.canActivate(ctx(OpenController, 'open'))).resolves.toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('thiếu khoá trong settings = bật (tương thích website cũ)', async () => {
    const { g } = guard({});
    await expect(g.canActivate(ctx(ShopController, 'list'))).resolves.toBe(true);
    await expect(g.canActivate(ctx(OpenController, 'posts'))).resolves.toBe(true);
  });

  it('tính năng tắt -> 404 "Tính năng đã tắt"', async () => {
    const { g } = guard({ blog: false });
    await expect(g.canActivate(ctx(OpenController, 'posts'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(g.canActivate(ctx(OpenController, 'posts'))).rejects.toThrow('Tính năng đã tắt');
  });

  it('gộp decorator class + handler: cần bật tất cả', async () => {
    await expect(guard({ shop: true, accounts: false }).g.canActivate(ctx(ShopController, 'mine'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(guard({ shop: false, accounts: true }).g.canActivate(ctx(ShopController, 'mine'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(guard({ shop: true, accounts: true }).g.canActivate(ctx(ShopController, 'mine'))).resolves.toBe(true);
    // handler chỉ kế thừa 'shop' từ class
    await expect(guard({ shop: true, accounts: false }).g.canActivate(ctx(ShopController, 'list'))).resolves.toBe(true);
  });

  it('giá trị không phải boolean bị bỏ qua (coi như bật)', async () => {
    const { g } = guard({ shop: 'no' });
    await expect(g.canActivate(ctx(ShopController, 'list'))).resolves.toBe(true);
  });
});
