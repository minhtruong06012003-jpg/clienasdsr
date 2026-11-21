import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { generateRecoveryCodes, generateSecret, matchTotpStep, normalizeRecoveryCode, otpauthUrl } from './totp.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Tên nhà phát hành hiển thị trong app xác thực */
export const TOTP_ISSUER = 'CMSNT';
/** Thời hạn challenge sau khi nhập đúng mật khẩu */
export const CHALLENGE_TTL = '5m';
/** Thời hạn cookie "tin cậy thiết bị" */
export const TRUST_DAYS = 30;

interface ChallengePayload {
  sub: string;
  purpose?: string;
  /** khu đăng nhập (admin | site) để ghi nhật ký đúng ở bước 2 */
  area?: 'admin' | 'site';
}

interface TrustPayload {
  sub: string;
  purpose?: string;
  /** hash secret 2FA lúc tin cậy — đổi/tắt 2FA là cookie hết hiệu lực */
  sh?: string;
}

/** Xác thực 2 bước TOTP + mã dự phòng + challenge / tin cậy thiết bị */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly events: EventEmitter2,
  ) {}

  private secretHash(secret: string) {
    return sha256(secret).slice(0, 32);
  }

  /** Bước 1: tạo secret tạm (chưa bật) + URL otpauth để vẽ QR */
  async setup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, twoFactorEnabled: true } });
    if (user.twoFactorEnabled) throw new BadRequestException('Xác thực 2 bước đã được bật. Hãy tắt trước khi thiết lập lại.');
    const secret = generateSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret, twoFactorEnabled: false, totpLastStep: null } });
    return { secret, otpauthUrl: otpauthUrl({ issuer: TOTP_ISSUER, label: user.email, secret }), issuer: TOTP_ISSUER };
  }

  /** Bước 2: xác minh mã từ app -> bật 2FA, sinh mã dự phòng (trả plain đúng 1 lần) */
  async enable(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorSecret: true, twoFactorEnabled: true } });
    if (user.twoFactorEnabled) throw new BadRequestException('Xác thực 2 bước đã được bật');
    if (!user.twoFactorSecret) throw new BadRequestException('Chưa thiết lập. Hãy gọi bước thiết lập để lấy mã QR trước.');
    if (!(await this.consumeTotp(userId, user.twoFactorSecret, code))) throw new BadRequestException('Mã xác thực không đúng. Kiểm tra lại giờ trên điện thoại và thử lại.');
    const codes = generateRecoveryCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true, recoveryCodes: codes.map(sha256) } });
    this.events.emit('user.changed', { id: userId });
    this.events.emit('activity', { userId, action: 'auth.2fa.enabled', entityType: 'user', entityId: userId });
    return { success: true, recoveryCodes: codes };
  }

  /** Tắt 2FA bằng mã TOTP / mã dự phòng hoặc mật khẩu hiện tại */
  async disable(userId: string, input: { code?: string; password?: string }) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorSecret: true, twoFactorEnabled: true, recoveryCodes: true, passwordHash: true } });
    if (!user.twoFactorEnabled) throw new BadRequestException('Xác thực 2 bước chưa được bật');
    let ok = false;
    if (input.code && user.twoFactorSecret) ok = (await this.consumeTotp(userId, user.twoFactorSecret, input.code)) || user.recoveryCodes.includes(sha256(normalizeRecoveryCode(input.code)));
    if (!ok && input.password) ok = await argon2.verify(user.passwordHash, input.password);
    if (!ok) throw new BadRequestException('Mã xác thực hoặc mật khẩu không đúng');
    await this.reset(userId, userId);
    return { success: true };
  }

  /** Xoá hoàn toàn 2FA (tự tắt hoặc admin đặt lại) */
  async reset(userId: string, actorId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, twoFactorSecret: null, recoveryCodes: [], totpLastStep: null } });
    this.events.emit('user.changed', { id: userId });
    this.events.emit('activity', { userId: actorId, action: actorId === userId ? 'auth.2fa.disabled' : 'auth.2fa.reset', entityType: 'user', entityId: userId });
    return { success: true };
  }

  /** Sinh lại bộ mã dự phòng mới (mã cũ hết hiệu lực) */
  async regenerateRecoveryCodes(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorSecret: true, twoFactorEnabled: true } });
    if (!user.twoFactorEnabled || !user.twoFactorSecret) throw new BadRequestException('Xác thực 2 bước chưa được bật');
    if (!(await this.consumeTotp(userId, user.twoFactorSecret, code))) throw new BadRequestException('Mã xác thực không đúng');
    const codes = generateRecoveryCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { recoveryCodes: codes.map(sha256) } });
    this.events.emit('activity', { userId, action: 'auth.2fa.recovery_regenerated', entityType: 'user', entityId: userId });
    return { success: true, recoveryCodes: codes };
  }

  /** Challenge JWT 5 phút cấp sau khi mật khẩu đúng nhưng còn thiếu bước 2 */
  issueChallenge(userId: string, area: 'admin' | 'site' = 'site') {
    return this.jwt.signAsync({ sub: userId, purpose: '2fa', area }, { expiresIn: CHALLENGE_TTL });
  }

  /** Như readChallenge nhưng trả kèm khu đăng nhập (challenge cũ không có -> 'site') */
  async readChallengeFull(challenge: string): Promise<{ userId: string; area: 'admin' | 'site' }> {
    const userId = await this.readChallenge(challenge);
    const payload = this.jwt.decode<ChallengePayload>(challenge);
    return { userId, area: payload?.area === 'admin' ? 'admin' : 'site' };
  }

  /** Giải mã challenge; không hợp lệ / hết hạn -> 401 */
  async readChallenge(challenge: string): Promise<string> {
    let payload: ChallengePayload;
    try {
      payload = await this.jwt.verifyAsync<ChallengePayload>(challenge);
    } catch {
      throw new UnauthorizedException('Phiên xác thực đã hết hạn, vui lòng đăng nhập lại');
    }
    if (payload.purpose !== '2fa' || !payload.sub) throw new UnauthorizedException('Phiên xác thực không hợp lệ');
    return payload.sub;
  }

  /**
   * Dùng mã TOTP 1 lần duy nhất: tìm bước thời gian (30 giây) của mã khớp, chỉ chấp nhận nếu bước đó lớn hơn
   * `totpLastStep` và ghi nhận bước bằng UPDATE có điều kiện (nguyên tử) — mã vừa dùng (hoặc mã cũ hơn trong
   * cửa sổ ±1 bước) bị lộ / bị bắt lại không dùng thêm lần nữa được, kể cả 2 request gửi song song.
   */
  private async consumeTotp(userId: string, secret: string, code: string): Promise<boolean> {
    const step = matchTotpStep(secret, code);
    if (step === null) return false;
    const n = await this.prisma.$executeRaw`
      UPDATE "users" SET "totpLastStep" = ${step}
      WHERE "id" = ${userId}::uuid AND ("totpLastStep" IS NULL OR "totpLastStep" < ${step})`;
    return n > 0;
  }

  /**
   * Gỡ 1 mã dự phòng NGUYÊN TỬ (array_remove có điều kiện mã còn trong danh sách): 2 request song song dùng
   * cùng mã thì chỉ 1 request thành công. Trả số mã còn lại, hoặc null khi mã không hợp lệ / đã dùng.
   */
  private async consumeRecoveryCode(userId: string, hash: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ left: number }[]>`
      UPDATE "users" SET "recoveryCodes" = array_remove("recoveryCodes", ${hash}::text)
      WHERE "id" = ${userId}::uuid AND ${hash}::text = ANY("recoveryCodes")
      RETURNING COALESCE(array_length("recoveryCodes", 1), 0)::int AS "left"`;
    return rows.length ? Number(rows[0].left) : null;
  }

  /**
   * Kiểm tra mã TOTP hoặc mã dự phòng của user. Mã TOTP không dùng lại được; mã dự phòng dùng 1 lần (bị xoá khỏi danh sách).
   * Trả về `{ ok, usedRecovery, recoveryLeft }`; không ném lỗi để nơi gọi tự đếm lần sai.
   */
  async verifyCode(userId: string, input: { code?: string; recoveryCode?: string }) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorSecret: true, twoFactorEnabled: true, recoveryCodes: true } });
    if (!user.twoFactorEnabled || !user.twoFactorSecret) return { ok: true, usedRecovery: false, recoveryLeft: user.recoveryCodes.length };
    if (input.code && (await this.consumeTotp(userId, user.twoFactorSecret, input.code))) return { ok: true, usedRecovery: false, recoveryLeft: user.recoveryCodes.length };
    const raw = input.recoveryCode ?? (input.code && !/^\d{6}$/.test(input.code.replace(/\s/g, '')) ? input.code : undefined);
    if (raw) {
      const left = await this.consumeRecoveryCode(userId, sha256(normalizeRecoveryCode(raw)));
      if (left !== null) {
        this.events.emit('activity', { userId, action: 'auth.2fa.recovery_used', entityType: 'user', entityId: userId, meta: { left } });
        return { ok: true, usedRecovery: true, recoveryLeft: left };
      }
    }
    return { ok: false, usedRecovery: false, recoveryLeft: user.recoveryCodes.length };
  }

  /** Cookie "tin cậy thiết bị": JWT gắn với secret hiện tại */
  async issueTrustToken(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorSecret: true } });
    return this.jwt.signAsync({ sub: userId, purpose: '2fa-trust', sh: this.secretHash(user.twoFactorSecret ?? '') }, { expiresIn: `${TRUST_DAYS}d` });
  }

  /** Thiết bị có được tin cậy với user này không (cookie còn hạn và secret chưa đổi) */
  async isTrusted(token: string | undefined, userId: string, secret: string | null): Promise<boolean> {
    if (!token || !secret) return false;
    try {
      const payload = await this.jwt.verifyAsync<TrustPayload>(token);
      return payload.purpose === '2fa-trust' && payload.sub === userId && payload.sh === this.secretHash(secret);
    } catch {
      return false;
    }
  }
}
