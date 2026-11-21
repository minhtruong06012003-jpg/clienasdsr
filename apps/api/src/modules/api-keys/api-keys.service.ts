import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hasPermission, type ApiKeyCreated, type ApiKeyItem, type ApiKeyStatus } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { displayPrefix, generateApiKey, hashApiKey } from './api-key.util.js';
import type { ApiKeysQueryDto, CreateApiKeyDto } from './api-keys.dto.js';

/** Giới hạn số key còn hiệu lực mỗi người để tránh lạm dụng */
const MAX_ACTIVE_KEYS_PER_USER = 60;

const SELECT = {
  id: true,
  name: true,
  prefix: true,
  permissions: true,
  userId: true,
  lastUsedAt: true,
  lastUsedIp: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ApiKeySelect;

type Row = Prisma.ApiKeyGetPayload<{ select: typeof SELECT }>;

/** Quản lý API key cá nhân: tạo (trả key đầy đủ 1 lần), liệt kê, thu hồi */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** Người có roles.manage được xem/thu hồi key của mọi người */
  private canManageAll(user: AuthUser) {
    return hasPermission(user.permissions, 'roles.manage');
  }

  private status(r: { expiresAt: Date | null; revokedAt: Date | null }): ApiKeyStatus {
    if (r.revokedAt) return 'revoked';
    if (r.expiresAt && r.expiresAt.getTime() <= Date.now()) return 'expired';
    return 'active';
  }

  private present(r: Row): ApiKeyItem {
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      permissions: r.permissions,
      userId: r.userId,
      user: r.user,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: r.lastUsedIp,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      status: this.status(r),
    };
  }

  async list(user: AuthUser, q: ApiKeysQueryDto) {
    const all = q.all === '1' || q.all === 'true';
    if (all && !this.canManageAll(user)) throw new ForbiddenException('Bạn không có quyền xem API key của người khác');
    const now = new Date();
    const where: Prisma.ApiKeyWhereInput = all ? {} : { userId: user.id };
    if (q.status === 'revoked') where.revokedAt = { not: null };
    else if (q.status === 'expired') Object.assign(where, { revokedAt: null, expiresAt: { lte: now } });
    else if (q.status === 'active') Object.assign(where, { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    const rows = await this.prisma.apiKey.findMany({ where, select: SELECT, orderBy: { createdAt: 'desc' }, take: 500 });
    return { data: rows.map((r) => this.present(r)), canManageAll: this.canManageAll(user) };
  }

  /** maxActive: giới hạn số key còn hiệu lực (khách dùng mức thấp hơn quản trị) */
  async create(user: AuthUser, dto: CreateApiKeyDto, ip?: string, maxActive = MAX_ACTIVE_KEYS_PER_USER): Promise<ApiKeyCreated> {
    const permissions = [...new Set(dto.permissions ?? [])];
    // quyền của key phải nằm trong quyền chủ sở hữu đang có
    const outside = permissions.filter((p) => !hasPermission(user.permissions, p));
    if (outside.length) throw new BadRequestException(`Bạn không có các quyền: ${outside.join(', ')}`);
    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (expiresAt.getTime() <= Date.now()) throw new BadRequestException('Hạn dùng phải ở tương lai');
    }
    const active = await this.prisma.apiKey.count({
      where: { userId: user.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (active >= maxActive) throw new BadRequestException(`Mỗi tài khoản tối đa ${maxActive} API key còn hiệu lực`);

    const key = generateApiKey();
    const row = await this.prisma.apiKey.create({
      data: { name: dto.name, prefix: displayPrefix(key), hash: hashApiKey(key), permissions, userId: user.id, expiresAt },
      select: SELECT,
    });
    this.events.emit('activity', {
      userId: user.id,
      action: 'apikey.create',
      entityType: 'api_key',
      entityId: row.id,
      meta: { name: row.name, prefix: row.prefix, permissions, expiresAt: expiresAt?.toISOString() ?? null },
      ip,
    });
    return { ...this.present(row), key };
  }

  async revoke(user: AuthUser, id: string, ip?: string) {
    const row = await this.prisma.apiKey.findUnique({ where: { id }, select: { id: true, userId: true, name: true, prefix: true, revokedAt: true } });
    if (!row || (row.userId !== user.id && !this.canManageAll(user))) throw new NotFoundException('Không tìm thấy API key');
    if (!row.revokedAt) {
      await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      this.events.emit('activity', {
        userId: user.id,
        action: 'apikey.revoke',
        entityType: 'api_key',
        entityId: id,
        meta: { name: row.name, prefix: row.prefix, ownerId: row.userId },
        ip,
      });
    }
    return { success: true };
  }
}
