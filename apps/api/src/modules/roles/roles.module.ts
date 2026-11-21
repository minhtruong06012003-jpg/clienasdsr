import { BadRequestException, Body, ForbiddenException, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { ALL_PERMISSIONS, hasPermission, PERMISSION_GROUPS, slugify } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { isChildSite } from '../../common/utils/tenant.js';

class RoleDto {
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @IsString({ each: true }) permissions: string[];
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  list() {
    return this.prisma.role.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { users: true } } } });
  }

  get(id: string) {
    return this.prisma.role.findUniqueOrThrow({ where: { id } });
  }

  private clean(perms: string[]) {
    if (perms.includes('*')) return ['*'];
    return perms.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  }

  /**
   * Chống leo thang đặc quyền qua vai trò. Người không phải siêu quản trị ('*'):
   * - không được gán '*' và không được gán quyền mà chính họ không có;
   * - không được sửa/xoá vai trò đang có '*' và không được sửa vai trò của chính mình
   *   (nếu không, người có roles.manage tự thêm quyền cho mình rồi dùng ngay);
   * - không được cấp quyền vào trang quản trị cho vai trò khách hàng (mọi người đăng ký đều thành nhân viên).
   */
  private assertCanGrant(actor: AuthUser, target: { id?: string; slug?: string; permissions?: string[] } | null, next?: string[]) {
    if (actor.permissions.includes('*')) return;
    if (target?.permissions?.includes('*')) throw new ForbiddenException('Chỉ siêu quản trị mới được sửa vai trò có toàn quyền');
    if (target?.id && target.id === actor.roleId) throw new ForbiddenException('Không thể tự sửa vai trò của chính mình');
    if (!next) return;
    if (next.includes('*')) throw new ForbiddenException('Chỉ siêu quản trị mới được gán toàn quyền (*)');
    if (!isChildSite() && next.includes('settings.mail') && !actor.permissions.includes('settings.mail')) {
      throw new ForbiddenException('Chỉ siêu quản trị mới được cấp quyền Email SMTP');
    }
    const missing = next.filter((p) => !hasPermission(actor.permissions, p));
    if (missing.length) throw new ForbiddenException(`Không thể gán quyền bạn không có: ${missing.join(', ')}`);
    if (target?.slug === 'customer' && next.includes('admin.access')) throw new ForbiddenException('Không thể cấp quyền quản trị cho vai trò khách hàng');
  }

  async create(dto: RoleDto, actor: AuthUser) {
    const actorId = actor.id;
    this.assertCanGrant(actor, null, this.clean(dto.permissions));
    const role = await this.prisma.role.create({
      data: { name: dto.name, slug: dto.slug ? slugify(dto.slug) : slugify(dto.name), description: dto.description, permissions: this.clean(dto.permissions) },
    });
    this.events.emit('activity', { userId: actorId ?? null, action: 'role.create', entityType: 'role', entityId: role.id, meta: { name: role.name, slug: role.slug } });
    return role;
  }

  async update(id: string, dto: Partial<RoleDto>, actor: AuthUser) {
    const actorId = actor.id;
    const role = await this.get(id);
    this.assertCanGrant(actor, role, dto.permissions ? this.clean(dto.permissions) : undefined);
    if (role.slug === 'administrator' && dto.permissions && !dto.permissions.includes('*')) {
      throw new BadRequestException('Không thể giới hạn quyền của vai trò Quản trị viên');
    }
    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        slug: role.isSystem ? undefined : dto.slug ? slugify(dto.slug) : undefined,
        permissions: dto.permissions ? this.clean(dto.permissions) : undefined,
      },
    });
    this.events.emit('role.changed', { id });
    this.events.emit('activity', { userId: actorId ?? null, action: 'role.update', entityType: 'role', entityId: id, meta: { name: updated.name, slug: updated.slug, permissions: updated.permissions.length } });
    return updated;
  }

  async remove(id: string, actor: AuthUser) {
    const actorId = actor.id;
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id }, include: { _count: { select: { users: true } } } });
    this.assertCanGrant(actor, role);
    if (role.isSystem) throw new BadRequestException('Không thể xoá vai trò hệ thống');
    if (role._count.users > 0) throw new BadRequestException('Vai trò đang được gán cho thành viên, hãy chuyển họ sang vai trò khác trước');
    await this.prisma.role.delete({ where: { id } });
    this.events.emit('activity', { userId: actorId ?? null, action: 'role.delete', entityType: 'role', entityId: id, meta: { name: role.name, slug: role.slug } });
    return { success: true };
  }
}

@Controller('admin/roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermissions('users.read')
  @Get('permissions')
  permissions() {
    return PERMISSION_GROUPS;
  }

  @RequirePermissions('users.read')
  @Get()
  list() {
    return this.roles.list();
  }

  @RequirePermissions('roles.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(id);
  }

  @RequirePermissions('roles.manage')
  @Post()
  create(@Body() dto: RoleDto, @CurrentUser() user: AuthUser) {
    return this.roles.create(dto, user);
  }

  @RequirePermissions('roles.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RoleDto, @CurrentUser() user: AuthUser) {
    return this.roles.update(id, dto, user);
  }

  @RequirePermissions('roles.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.roles.remove(id, user);
  }
}

@Module({ controllers: [RolesController], providers: [RolesService] })
export class RolesModule {}
