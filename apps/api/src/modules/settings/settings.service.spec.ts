import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService, settingsCacheTtlMs } from './settings.service.js';

/** Prisma giả: đếm số lần đọc bảng settings */
function setup() {
  const prisma = {
    setting: {
      findMany: vi.fn(async () => [{ key: 'general', value: { siteName: 'A' } }]),
      findUnique: vi.fn(async () => ({ key: 'general', value: { siteName: 'A', tagline: 'cũ' } })),
      upsert: vi.fn(async () => ({})),
    },
  };
  const events = { emit: vi.fn() };
  return { svc: new SettingsService(prisma as never, events as never), prisma };
}

describe('SettingsService cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('TTL đọc từ env SETTINGS_CACHE_TTL (giây), mặc định 30s', () => {
    expect(settingsCacheTtlMs({})).toBe(30_000);
    expect(settingsCacheTtlMs({ SETTINGS_CACHE_TTL: '5' })).toBe(5_000);
    expect(settingsCacheTtlMs({ SETTINGS_CACHE_TTL: '0' })).toBe(0);
    expect(settingsCacheTtlMs({ SETTINGS_CACHE_TTL: 'x' })).toBe(30_000);
  });

  it('trong TTL dùng cache, hết TTL đọc lại DB (instance khác sửa thì vẫn thấy)', async () => {
    const { svc, prisma } = setup();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await svc.get('general');
    await svc.get('general');
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(1);
    now += 31_000;
    await svc.get('general');
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(2);
  });

  it('nhiều request đồng thời chỉ đọc DB một lần', async () => {
    const { svc, prisma } = setup();
    await Promise.all([svc.get('general'), svc.get('general'), svc.all()]);
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it('cập nhật: trộn với bản mới nhất trong DB rồi xoá cache ngay trong tiến trình', async () => {
    const { svc, prisma } = setup();
    await svc.get('general');
    await svc.update('general', { siteName: 'B' });
    expect(prisma.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: expect.objectContaining({ siteName: 'B', tagline: 'cũ' }) } }));
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(2);
  });
});
