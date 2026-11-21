import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';

/** Cache ngắn hạn thông tin user + quyền để guard không query DB mỗi request. */
@Injectable()
export class AuthUserCache {
  private cache = new Map<string, { user: AuthUser | null; at: number }>();
  private ttl = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  async get(id: string): Promise<AuthUser | null> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < this.ttl) return hit.user;
    const u = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, include: { role: true } });
    const user: AuthUser | null =
      u && u.status === 'ACTIVE'
        ? { id: u.id, email: u.email, name: u.name, roleId: u.roleId, roleSlug: u.role.slug, permissions: u.role.permissions, twoFactorEnabled: u.twoFactorEnabled }
        : null;
    this.cache.set(id, { user, at: Date.now() });
    return user;
  }

  invalidate(id?: string) {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  @OnEvent('user.changed')
  onUserChanged(payload: { id?: string }) {
    this.invalidate(payload?.id);
  }

  @OnEvent('role.changed')
  onRoleChanged() {
    this.invalidate();
  }
}
