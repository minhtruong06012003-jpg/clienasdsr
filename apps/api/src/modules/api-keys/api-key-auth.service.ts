import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuthUserCache } from '../auth/auth-user.cache.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { effectivePermissions, hashApiKey, isValidKeyFormat } from './api-key.util.js';

/** User xác thực bằng API key: thêm id key để log/giới hạn route */
export interface ApiKeyAuthUser extends AuthUser {
  apiKeyId: string;
}

/** Ghi lastUsedAt/IP tối đa 1 lần/phút cho mỗi key (tránh UPDATE mỗi request) */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Xác thực API key cho guard toàn cục: tra key theo sha256, kiểm tra thu hồi/hết hạn,
 * lấy user (qua AuthUserCache — user bị khoá/xoá thì key vô hiệu) và tính quyền hiệu lực.
 */
@Injectable()
export class ApiKeyAuthService {
  private readonly logger = new Logger('ApiKeyAuth');
  /** keyId -> thời điểm ghi lastUsed gần nhất */
  private touched = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: AuthUserCache,
  ) {}

  /** Trả user kèm quyền hiệu lực, hoặc null nếu key sai/thu hồi/hết hạn/chủ key không còn hoạt động */
  async authenticate(rawKey: string, ip?: string): Promise<ApiKeyAuthUser | null> {
    if (!isValidKeyFormat(rawKey)) return null;
    const key = await this.prisma.apiKey.findUnique({
      where: { hash: hashApiKey(rawKey) },
      select: { id: true, userId: true, permissions: true, expiresAt: true, revokedAt: true },
    });
    if (!key || key.revokedAt) return null;
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;
    const user = await this.users.get(key.userId);
    if (!user) return null;
    this.touch(key.id, ip);
    return { ...user, permissions: effectivePermissions(user.permissions, key.permissions), apiKeyId: key.id };
  }

  /** Cập nhật lần dùng cuối (không chờ, lỗi ghi không làm hỏng request) */
  private touch(id: string, ip?: string) {
    const now = Date.now();
    const last = this.touched.get(id) ?? 0;
    if (now - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(id, now);
    // giữ map nhỏ: dọn mục cũ khi phình to
    if (this.touched.size > 5000) for (const [k, t] of this.touched) if (now - t > TOUCH_INTERVAL_MS) this.touched.delete(k);
    this.prisma.apiKey
      .update({ where: { id }, data: { lastUsedAt: new Date(now), lastUsedIp: ip ?? null } })
      .catch((e: unknown) => this.logger.warn(`Không ghi được lastUsedAt cho key ${id}: ${String(e)}`));
  }
}
