import { HttpException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';

/**
 * Dựng AuthService với các phụ thuộc giả. Prisma giả mô phỏng bộ đếm `failedLogins` trong DB:
 * UPDATE ... + 1 RETURNING là nguyên tử (mỗi lời gọi nhận 1 giá trị khác nhau), UPDATE khoá có điều kiện.
 */
function make(max = 3) {
  const db = { failedLogins: 0, lockedUntil: null as Date | null };
  const sql = (q: TemplateStringsArray) => q.join('?');
  const prisma = {
    $queryRaw: vi.fn(async (q: TemplateStringsArray) => {
      if (sql(q).includes('"failedLogins" + 1')) {
        db.failedLogins += 1;
        return [{ failedLogins: db.failedLogins }];
      }
      return [];
    }),
    $executeRaw: vi.fn(async (q: TemplateStringsArray, ...vals: unknown[]) => {
      const text = sql(q);
      if (text.includes('"failedLogins" >=')) {
        const [until, , threshold] = vals as [Date, string, number];
        if (db.failedLogins < threshold) return 0;
        db.failedLogins = 0;
        db.lockedUntil = until;
        return 1;
      }
      if (text.includes('"lockedUntil" <= now()')) {
        if (db.lockedUntil && db.lockedUntil > new Date()) return 0;
        db.failedLogins = 0;
        db.lockedUntil = null;
        return 1;
      }
      return 0;
    }),
    user: { findUnique: vi.fn(async () => ({ lockedUntil: db.lockedUntil, lockReason: null })) },
  };
  const settings = { get: vi.fn(async (g: string) => (g === 'security' ? { maxFailedLogins: max, lockoutMinutes: 15 } : { timezone: 'Asia/Ho_Chi_Minh' })) };
  const events = { emit: vi.fn() };
  const audit = { record: vi.fn() };
  const protection = { afterFailure: vi.fn(), afterLock: vi.fn() };
  const none = {} as never;
  const svc = new AuthService(prisma as never, none, none, events as never, none, none, settings as never, none, none, audit as never, protection as never, none);
  return { svc, db, protection, prisma };
}

const user = { id: '00000000-0000-0000-0000-000000000001', email: 'a@x.vn', failedLogins: 0 };

describe('AuthService.registerFailure (đếm sai nguyên tử)', () => {
  it('nhiều request sai song song (đọc cùng failedLogins cũ) vẫn bị khoá đúng ngưỡng, chỉ cảnh báo khoá 1 lần', async () => {
    const { svc, db, protection } = make(3);
    const fail = () => (svc as unknown as { registerFailure: (...a: unknown[]) => Promise<never> }).registerFailure(user, {}, 'site', 'password').catch((e: unknown) => e);
    const results = await Promise.all([fail(), fail(), fail(), fail(), fail()]);
    const locked = results.filter((e) => e instanceof HttpException && e.getStatus() === 423);
    const wrong = results.filter((e) => e instanceof UnauthorizedException);
    // mỗi request nhận 1 giá trị đếm riêng (1..5): 3 request đạt ngưỡng đều bị báo khoá, không request nào lọt
    expect(locked).toHaveLength(3);
    expect(wrong).toHaveLength(2);
    expect(db.lockedUntil).toBeInstanceOf(Date);
    expect(protection.afterLock).toHaveBeenCalledTimes(1);
  });

  it('đúng mật khẩu nhưng tài khoản vừa bị request song song khoá -> bị chặn', async () => {
    const { svc, db } = make(3);
    db.lockedUntil = new Date(Date.now() + 60_000);
    const clear = (svc as unknown as { clearFailuresIfUnlocked: (id: string) => Promise<void> }).clearFailuresIfUnlocked(user.id);
    await expect(clear).rejects.toBeInstanceOf(HttpException);
  });

  it('hết hạn khoá -> reset bộ đếm bình thường', async () => {
    const { svc, db } = make(3);
    db.failedLogins = 2;
    await (svc as unknown as { clearFailuresIfUnlocked: (id: string) => Promise<void> }).clearFailuresIfUnlocked(user.id);
    expect(db.failedLogins).toBe(0);
  });
});

describe('AuthService.loginWithGoogle — liên kết theo email', () => {
  /** Dựng service: user có sẵn cùng email, chưa có googleId; ghi nhận các lệnh ghi trong transaction */
  function makeLink(emailVerified: Date | null) {
    const existing = {
      id: 'u1', email: 'khach@gmail.com', googleId: null, emailVerified, status: emailVerified ? 'ACTIVE' : 'PENDING', meta: {},
      role: { permissions: ['orders.own'] }, lockedUntil: null, lockReason: null, twoFactorEnabled: false, twoFactorSecret: null, name: 'K', locale: null,
    };
    const tx = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
      apiKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      passwordReset: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      user: { findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing).mockResolvedValue({ ...existing, status: 'ACTIVE', twoFactorEnabled: false }) },
      $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const settings = { get: vi.fn(async () => ({ googleLoginEnabled: true, googleClientId: 'cid' })) };
    const events = { emit: vi.fn() };
    const sessions = { forgetAll: vi.fn() };
    const none = {} as never;
    const svc = new AuthService(prisma as never, none, none, events as never, none, none, settings as never, none, none, none, none, none, sessions as never);
    const s = svc as unknown as { google: { verify: unknown }; completeLogin: unknown };
    s.google = { verify: vi.fn().mockResolvedValue({ sub: 'g-1', email: 'khach@gmail.com', emailVerified: true }) };
    s.completeLogin = vi.fn().mockResolvedValue({ accessToken: 'a' });
    return { svc, tx, events, sessions };
  }

  it('tài khoản chưa xác minh email: đổi mật khẩu ngẫu nhiên, tắt 2FA, thu hồi phiên + API key trong cùng transaction', async () => {
    const { svc, tx, events, sessions } = makeLink(null);
    await svc.loginWithGoogle('token', {});
    const data = tx.user.updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ googleId: 'g-1', status: 'ACTIVE', twoFactorEnabled: false, twoFactorSecret: null, recoveryCodes: [], totpLastStep: null, meta: { passwordSet: false } });
    expect(typeof data.passwordHash).toBe('string');
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    expect(tx.apiKey.updateMany).toHaveBeenCalled();
    expect(sessions.forgetAll).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('activity', expect.objectContaining({ action: 'auth.google_linked', meta: { resetCredentials: true } }));
  });

  it('tài khoản đã xác minh email: chỉ gắn googleId, giữ mật khẩu / phiên', async () => {
    const { svc, tx, events } = makeLink(new Date());
    await svc.loginWithGoogle('token', {});
    const data = tx.user.updateMany.mock.calls[0][0].data;
    expect(data).toEqual({ googleId: 'g-1' });
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('activity', expect.objectContaining({ meta: { resetCredentials: false } }));
  });
});
