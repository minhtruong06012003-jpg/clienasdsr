import { describe, expect, it, vi } from 'vitest';
import { CardTopupService } from './card-topup.service.js';

describe('Nạp thẻ: chủ tài khoản đã bị xoá khi có kết quả', () => {
  it('chốt thẻ (không treo PENDING), không cộng ví, ghi chú cần xử lý tay', async () => {
    const row = { id: 'c1', code: 'NT1', userId: 'u1', status: 'PENDING', telco: 'VIETTEL', declaredValue: 100000, serial: 'S', providerRef: null };
    const db = {
      cardTopup: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => ({})) },
      user: { findFirst: vi.fn(async () => null) },
    };
    const prisma = { cardTopup: { findUnique: vi.fn(async () => row) }, $transaction: vi.fn(async (fn: (d: typeof db) => unknown) => fn(db)) };
    const wallet = { apply: vi.fn(), afterChange: vi.fn() };
    const service = new CardTopupService(prisma as never, { get: async () => ({}) } as never, wallet as never, { emit: vi.fn() } as never, {} as never);
    const r = await (service as unknown as { finalize: (id: string, r: unknown, o: unknown) => Promise<unknown> }).finalize('c1', { status: 'SUCCESS' }, { credited: 80000 });
    expect(r).toBeNull();
    expect(wallet.apply).not.toHaveBeenCalled();
    expect(db.cardTopup.updateMany.mock.calls[0]).toBeDefined();
    expect(db.cardTopup.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { credited: 0, message: 'Chủ tài khoản đã xoá — cần xử lý tay' } });
  });
});
