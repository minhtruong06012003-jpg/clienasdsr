import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EDIT_LOCK_TTL_SECONDS, type EditLockState } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';

interface LockRow {
  userId: string;
  userName: string;
  expiresAt: Date;
}

/**
 * Khoá chỉnh sửa đồng thời (giống post lock của WordPress).
 * Người đang sửa gửi heartbeat 30 giây/lần để gia hạn khoá 60 giây; rời trang thì nhả.
 * Khoá hết hạn coi như tự nhả — người khác giữ được ngay.
 */
@Injectable()
export class EditLocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Token nhả khoá cho sendBeacon (beacon không gửi header Authorization).
   * Ký bằng secret JWT với `purpose` riêng nên guard không chấp nhận nó làm token đăng nhập;
   * chỉ cho phép nhả đúng khoá (entity + id) của đúng người.
   */
  private releaseToken(entity: string, entityId: string, userId: string) {
    return this.jwt.sign({ sub: userId, purpose: 'edit-lock-release', e: entity, i: entityId }, { expiresIn: '1d' });
  }

  /** Nhả khoá bằng token beacon; token sai/hết hạn thì bỏ qua (khoá tự hết hạn sau 60 giây) */
  async releaseWithToken(entity: string, entityId: string, token: string) {
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; purpose?: string; e?: string; i?: string }>(token);
      if (p.purpose !== 'edit-lock-release' || p.e !== entity || p.i !== entityId) return { released: false };
      const r = await this.prisma.editLock.deleteMany({ where: { entity, entityId, userId: p.sub } });
      return { released: r.count > 0 };
    } catch {
      return { released: false };
    }
  }

  private expiry() {
    return new Date(Date.now() + EDIT_LOCK_TTL_SECONDS * 1000);
  }

  /**
   * Giữ/gia hạn khoá. Câu lệnh nguyên tử: chỉ ghi đè khi khoá là của mình hoặc đã hết hạn
   * (ON CONFLICT ... WHERE), tránh 2 người cùng giữ khi gửi đồng thời.
   */
  async acquire(entity: string, entityId: string, user: AuthUser, attempt = 0): Promise<EditLockState> {
    const expiresAt = this.expiry();
    // dùng giờ của ứng dụng thay cho now() của DB
    const now = new Date();
    // cột timestamp(3) không múi giờ lưu giờ UTC -> truyền chuỗi UTC không hậu tố Z rồi ép kiểu, độc lập TimeZone của session
    const utc = (d: Date) => d.toISOString().replace('Z', '');
    const rows = await this.prisma.$queryRaw<LockRow[]>`
      INSERT INTO "edit_locks" ("id", "entity", "entityId", "userId", "userName", "expiresAt", "createdAt")
      VALUES (gen_random_uuid(), ${entity}, ${entityId}, ${user.id}::uuid, ${user.name}, ${utc(expiresAt)}::timestamp(3), ${utc(now)}::timestamp(3))
      ON CONFLICT ("entity", "entityId") DO UPDATE
        SET "userId" = EXCLUDED."userId", "userName" = EXCLUDED."userName", "expiresAt" = EXCLUDED."expiresAt",
            "createdAt" = CASE WHEN "edit_locks"."userId" = EXCLUDED."userId" THEN "edit_locks"."createdAt" ELSE EXCLUDED."createdAt" END
        WHERE "edit_locks"."userId" = EXCLUDED."userId" OR "edit_locks"."expiresAt" <= ${utc(now)}::timestamp(3)
      RETURNING "userId", "userName", "expiresAt"`;
    if (rows.length) return { locked: false, expiresAt: expiresAt.toISOString(), releaseToken: this.releaseToken(entity, entityId, user.id) };
    // người khác đang giữ, chưa hết hạn
    const cur = await this.prisma.editLock.findUnique({ where: { entity_entityId: { entity, entityId } } });
    // khoá vừa bị nhả/hết hạn giữa 2 câu lệnh -> thử lại (tối đa 2 lần)
    if ((!cur || cur.userId === user.id || cur.expiresAt.getTime() <= Date.now()) && attempt < 2) return this.acquire(entity, entityId, user, attempt + 1);
    if (!cur || cur.userId === user.id) return { locked: false, expiresAt: expiresAt.toISOString(), releaseToken: this.releaseToken(entity, entityId, user.id) };
    return { locked: true, by: { userId: cur.userId, userName: cur.userName }, expiresAt: cur.expiresAt.toISOString() };
  }

  /** Giành quyền sửa: ghi đè khoá của người khác (ghi nhật ký). Người cũ sẽ thấy banner ở heartbeat kế tiếp. */
  async takeover(entity: string, entityId: string, user: AuthUser, ip?: string): Promise<EditLockState> {
    const expiresAt = this.expiry();
    const prev = await this.prisma.editLock.findUnique({ where: { entity_entityId: { entity, entityId } } });
    await this.prisma.editLock.upsert({
      where: { entity_entityId: { entity, entityId } },
      create: { entity, entityId, userId: user.id, userName: user.name, expiresAt },
      update: { userId: user.id, userName: user.name, expiresAt, createdAt: new Date() },
    });
    if (prev && prev.userId !== user.id && prev.expiresAt.getTime() > Date.now()) {
      this.events.emit('activity', {
        userId: user.id,
        action: 'editlock.takeover',
        entityType: entity,
        entityId,
        meta: { from: { userId: prev.userId, userName: prev.userName } },
        ip,
      });
    }
    return { locked: false, expiresAt: expiresAt.toISOString(), releaseToken: this.releaseToken(entity, entityId, user.id) };
  }

  /** Nhả khoá — chỉ khi đang là người giữ */
  async release(entity: string, entityId: string, user: AuthUser) {
    const r = await this.prisma.editLock.deleteMany({ where: { entity, entityId, userId: user.id } });
    return { released: r.count > 0 };
  }

  /** Dọn khoá đã hết hạn lâu (khoá hết hạn vẫn vô hại, chỉ dọn cho gọn bảng) */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanup() {
    await this.prisma.editLock.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } }).catch(() => undefined);
  }
}
