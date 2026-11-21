import { describe, expect, it, vi } from 'vitest';
import { parseChatIds, TelegramService } from './telegram.service.js';

const USER_ID = '3f2b8c1e-9a4d-4e7b-8c21-5d6e7f8a9b0c';

/** Service với Prisma giả: chỉ cần user.findFirst cho bước kiểm tra mã liên kết */
function makeService(linkedAt: Date | null) {
  const prisma = { user: { findFirst: vi.fn().mockResolvedValue({ id: USER_ID, name: 'A', email: 'a@x.vn', telegramLinkedAt: linkedAt }) } };
  const config = { get: () => 'test-secret' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new TelegramService(prisma as any, {} as any, config as any) as any;
}

describe('TelegramService — mã liên kết', () => {
  it('mã vừa tạo hợp lệ, dài tối đa 64 ký tự và chỉ gồm ký tự Telegram cho phép', async () => {
    const svc = makeService(null);
    const code: string = svc.linkCode(USER_ID, null);
    expect(code.length).toBeLessThanOrEqual(64);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await svc.verifyLinkCode(code))?.id).toBe(USER_ID);
  });

  it('mã bị sửa chữ ký thì bị từ chối', async () => {
    const svc = makeService(null);
    const code: string = svc.linkCode(USER_ID, null);
    const bad = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    expect(await svc.verifyLinkCode(bad)).toBeNull();
  });

  it('đã liên kết sau khi tạo mã thì mã cũ hết hiệu lực', async () => {
    const code: string = makeService(null).linkCode(USER_ID, null);
    expect(await makeService(new Date()).verifyLinkCode(code)).toBeNull();
  });

  it('mã hết hạn bị từ chối', async () => {
    const svc = makeService(null);
    vi.useFakeTimers();
    const code: string = svc.linkCode(USER_ID, null);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect(await svc.verifyLinkCode(code)).toBeNull();
    vi.useRealTimers();
  });
});

describe('parseChatIds', () => {
  it('tách theo phẩy / khoảng trắng / xuống dòng, bỏ trùng và giá trị lạ', () => {
    expect(parseChatIds('123, -100456\n123 abc @kenh_admin')).toEqual(['123', '-100456', '@kenh_admin']);
    expect(parseChatIds('')).toEqual([]);
  });
});
