import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './account.module.js';

/** AccountService với Prisma giả; `balance` = số dư ví đọc ra trong transaction (SELECT ... FOR UPDATE) */
async function make(opts: { balance?: number; meta?: Record<string, unknown>; password?: string; pendingCards?: number; pendingTopups?: number } = {}) {
  const passwordHash = await argon2.hash(opts.password ?? 'MatKhau@123', { type: argon2.argon2id });
  const calls: Record<string, unknown[]> = {};
  const track = (name: string) => vi.fn(async (arg: unknown) => {
    (calls[name] ??= []).push(arg);
    return { count: 1 };
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ walletBalance: String(opts.balance ?? 0) }]),
    cardTopup: { count: vi.fn().mockResolvedValue(opts.pendingCards ?? 0) },
    paymentTransaction: { count: vi.fn().mockResolvedValue(opts.pendingTopups ?? 0) },
    user: { update: track('user.update') },
    refreshToken: { updateMany: track('refreshToken.updateMany') },
    apiKey: { updateMany: track('apiKey.updateMany') },
    passwordReset: { updateMany: track('passwordReset.updateMany') },
    address: { deleteMany: track('address.deleteMany') },
    wishlistItem: { deleteMany: track('wishlistItem.deleteMany') },
    cart: { deleteMany: track('cart.deleteMany') },
  };
  const prisma = {
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'u1', email: 'khach@x.vn', passwordHash, meta: opts.meta ?? {} }) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const events = { emit: vi.fn() };
  const sessions = { forgetAll: vi.fn() };
  return { svc: new AccountService(prisma as never, events as never, sessions as never), calls, events, sessions };
}

const customer = { id: 'u1', permissions: ['orders.own'] };

describe('AccountService.deleteAccount', () => {
  it('sai câu xác nhận / nhân sự quản trị -> từ chối', async () => {
    const { svc } = await make();
    await expect(svc.deleteAccount(customer, { confirm: 'xoa', password: 'MatKhau@123' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.deleteAccount({ id: 'u1', permissions: ['admin.access'] }, { confirm: 'XOA TAI KHOAN', password: 'MatKhau@123' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('tài khoản có mật khẩu: thiếu hoặc sai mật khẩu -> từ chối', async () => {
    const { svc } = await make();
    await expect(svc.deleteAccount(customer, { confirm: 'XOA TAI KHOAN' })).rejects.toThrow(/nhập mật khẩu/);
    await expect(svc.deleteAccount(customer, { confirm: 'XOA TAI KHOAN', password: 'sai' })).rejects.toThrow(/không đúng/);
  });

  it('ví còn tiền -> không cho xoá', async () => {
    const { svc, calls } = await make({ balance: 15000 });
    await expect(svc.deleteAccount(customer, { confirm: 'XOA TAI KHOAN', password: 'MatKhau@123' })).rejects.toThrow(/Ví của bạn còn/);
    expect(calls['user.update']).toBeUndefined();
  });

  it('còn thẻ cào / giao dịch nạp ví đang chờ -> không cho xoá', async () => {
    for (const o of [{ pendingCards: 1 }, { pendingTopups: 1 }]) {
      const { svc, calls } = await make(o);
      await expect(svc.deleteAccount(customer, { confirm: 'XOA TAI KHOAN', password: 'MatKhau@123' })).rejects.toThrow(/đang chờ xử lý/);
      expect(calls['user.update']).toBeUndefined();
    }
  });

  it('tài khoản tạo qua Google (passwordSet=false) chỉ cần câu xác nhận; ẩn danh hoá + dọn dữ liệu, giữ đơn/ví', async () => {
    const { svc, calls, events, sessions } = await make({ meta: { passwordSet: false } });
    await expect(svc.deleteAccount(customer, { confirm: 'XOA TAI KHOAN' })).resolves.toEqual({ success: true });
    const data = (calls['user.update'][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ email: 'deleted+u1@deleted.local', name: 'Đã xoá', phone: null, googleId: null, meta: {}, twoFactorEnabled: false, status: 'INACTIVE' });
    expect(data.deletedAt).toBeInstanceOf(Date);
    for (const k of ['refreshToken.updateMany', 'address.deleteMany', 'wishlistItem.deleteMany', 'cart.deleteMany']) expect(calls[k]).toHaveLength(1);
    expect(calls['order.deleteMany']).toBeUndefined();
    expect(sessions.forgetAll).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('activity', expect.objectContaining({ action: 'account.deleted' }));
  });
});
