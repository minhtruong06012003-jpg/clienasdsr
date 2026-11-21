import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SessionsService } from './sessions.service.js';
import { generateSecret, matchTotpStep, totp } from './totp.js';
import { TwoFactorService } from './two-factor.service.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('matchTotpStep', () => {
  it('trả bước thời gian của mã khớp trong cửa sổ ±1, sai -> null', () => {
    const secret = generateSecret();
    const t = 1_800_000_000_000;
    const step = Math.floor(t / 30_000);
    expect(matchTotpStep(secret, totp(secret, { time: t }), { time: t })).toBe(step);
    expect(matchTotpStep(secret, totp(secret, { time: t - 30_000 }), { time: t })).toBe(step - 1);
    expect(matchTotpStep(secret, totp(secret, { time: t + 30_000 }), { time: t })).toBe(step + 1);
    expect(matchTotpStep(secret, totp(secret, { time: t - 90_000 }), { time: t })).toBeNull();
    expect(matchTotpStep(secret, 'abc', { time: t })).toBeNull();
  });
});

/** TwoFactorService với Prisma giả: totpLastStep / recoveryCodes giữ trong bộ nhớ để mô phỏng UPDATE có điều kiện */
function makeTwoFactor(user: { twoFactorSecret: string; recoveryCodes: string[]; totpLastStep: number | null }) {
  const state = { ...user, recoveryCodes: [...user.recoveryCodes] };
  const sqlText = (q: TemplateStringsArray) => q.join('?');
  const prisma = {
    user: { findUniqueOrThrow: vi.fn(async () => ({ twoFactorSecret: state.twoFactorSecret, twoFactorEnabled: true, recoveryCodes: [...state.recoveryCodes] })) },
    // UPDATE "totpLastStep" ... WHERE totpLastStep IS NULL OR < step
    $executeRaw: vi.fn(async (q: TemplateStringsArray, step: number) => {
      if (!sqlText(q).includes('totpLastStep')) return 0;
      if (state.totpLastStep !== null && state.totpLastStep >= step) return 0;
      state.totpLastStep = step;
      return 1;
    }),
    // UPDATE recoveryCodes = array_remove(...) WHERE hash = ANY(...) RETURNING left
    $queryRaw: vi.fn(async (_q: TemplateStringsArray, hash: string) => {
      if (!state.recoveryCodes.includes(hash)) return [];
      state.recoveryCodes = state.recoveryCodes.filter((h) => h !== hash);
      return [{ left: state.recoveryCodes.length }];
    }),
  } as unknown as PrismaService;
  const events = { emit: vi.fn() } as unknown as EventEmitter2;
  return { svc: new TwoFactorService(prisma, {} as JwtService, events), state };
}

describe('TwoFactorService.verifyCode', () => {
  it('mã TOTP chỉ dùng được 1 lần (chống phát lại), kể cả gửi song song', async () => {
    const secret = generateSecret();
    const { svc } = makeTwoFactor({ twoFactorSecret: secret, recoveryCodes: [], totpLastStep: null });
    const code = totp(secret);
    const [a, b] = await Promise.all([svc.verifyCode('u1', { code }), svc.verifyCode('u1', { code })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await svc.verifyCode('u1', { code })).ok).toBe(false);
  });

  it('mã của bước cũ hơn bước đã dùng bị từ chối', async () => {
    const secret = generateSecret();
    const step = Math.floor(Date.now() / 30_000);
    const { svc } = makeTwoFactor({ twoFactorSecret: secret, recoveryCodes: [], totpLastStep: step });
    expect((await svc.verifyCode('u1', { code: totp(secret, { time: Date.now() - 30_000 }) })).ok).toBe(false);
  });

  it('mã dự phòng dùng 1 lần; 2 request song song cùng mã chỉ 1 thành công', async () => {
    const codes = ['abcde-fghjk', 'mnpqr-stuvw'];
    const { svc, state } = makeTwoFactor({ twoFactorSecret: generateSecret(), recoveryCodes: codes.map(sha256), totpLastStep: null });
    const [a, b] = await Promise.all([svc.verifyCode('u1', { recoveryCode: 'ABCDE FGHJK' }), svc.verifyCode('u1', { recoveryCode: 'abcde-fghjk' })]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => r.ok)?.recoveryLeft).toBe(1);
    expect(state.recoveryCodes).toEqual([sha256('mnpqr-stuvw')]);
  });
});

describe('SessionsService.isActive', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  function make(row: Record<string, unknown> | null, liveInChain: number) {
    const count = vi.fn().mockResolvedValue(liveInChain);
    const prisma = { refreshToken: { findUnique: vi.fn().mockResolvedValue(row), count } } as unknown as PrismaService;
    return { svc: new SessionsService(prisma), count };
  }

  it('dòng chưa thu hồi -> còn hiệu lực; thu hồi chủ động -> hết hiệu lực', async () => {
    expect(await make({ userId: 'u', createdAt: created, revokedAt: null, rotatedAt: null }, 0).svc.isActive('s1')).toBe(true);
    expect(await make({ userId: 'u', createdAt: created, revokedAt: new Date(), rotatedAt: null }, 1).svc.isActive('s1')).toBe(false);
    expect(await make(null, 0).svc.isActive('s1')).toBe(false);
  });

  it('dòng đã xoay vòng: chuỗi còn dòng sống -> hiệu lực; chuỗi đã bị thu hồi -> từ chối ngay', async () => {
    const old = new Date(Date.now() - 60_000);
    const alive = make({ userId: 'u', createdAt: created, revokedAt: old, rotatedAt: old }, 1);
    expect(await alive.svc.isActive('s1')).toBe(true);
    expect(alive.count).toHaveBeenCalledWith({ where: expect.objectContaining({ userId: 'u', createdAt: created, revokedAt: null }) });
    const dead = make({ userId: 'u', createdAt: created, revokedAt: old, rotatedAt: old }, 0);
    expect(await dead.svc.isActive('s1')).toBe(false);
  });

  it('vừa xoay vòng (<5s) -> chưa kiểm tra chuỗi', async () => {
    const now = new Date();
    const s = make({ userId: 'u', createdAt: created, revokedAt: now, rotatedAt: now }, 0);
    expect(await s.svc.isActive('s1')).toBe(true);
    expect(s.count).not.toHaveBeenCalled();
  });
});

describe('SessionsService thu hồi theo chuỗi', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  function make(found: Record<string, unknown> | null) {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const findFirst = vi.fn().mockResolvedValue(found);
    const prisma = { refreshToken: { findFirst, updateMany } } as unknown as PrismaService;
    return { svc: new SessionsService(prisma), updateMany, findFirst };
  }

  it('revoke thu hồi mọi dòng cùng userId + createdAt (cả nhánh rẽ / dòng đã xoay vòng)', async () => {
    const { svc, updateMany } = make({ userId: 'u', createdAt: created });
    await svc.revoke('u', 's1');
    expect(updateMany).toHaveBeenCalledWith({ where: { userId: 'u', createdAt: created, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });

  it('revoke phiên không thuộc user -> 404', async () => {
    const { svc } = make(null);
    await expect(svc.revoke('u', 's1')).rejects.toThrow(/không tồn tại/);
  });

  it('revokeOthers giữ nguyên cả chuỗi hiện tại (so theo createdAt)', async () => {
    const { svc, updateMany } = make({ createdAt: created });
    await svc.revokeOthers('u', 'sid-cu-da-xoay-vong');
    expect(updateMany).toHaveBeenCalledWith({ where: { userId: 'u', revokedAt: null, createdAt: { not: created } }, data: { revokedAt: expect.any(Date) } });
  });
});
