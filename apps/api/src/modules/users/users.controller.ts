import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { UsersService } from './users.service.js';
import { BulkUserDto, CreateUserDto, DeleteUserDto, LockUserDto, UpdateUserDto, UserQueryDto } from './users.dto.js';

@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions('users.read')
  @Get()
  list(@Query() q: UserQueryDto) {
    return this.users.list(q);
  }

  /** Thao tác hàng loạt (khai báo trước route :id); xoá cần thêm quyền users.delete — kiểm tra trong service */
  @RequirePermissions('users.write')
  @Post('bulk')
  bulk(@Body() dto: BulkUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.bulk(dto, actor);
  }

  @RequirePermissions('users.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @RequirePermissions('users.write')
  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.create(dto, actor);
  }

  @RequirePermissions('users.write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.update(id, dto, actor);
  }

  @RequirePermissions('users.write')
  @Post(':id/revoke-sessions')
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.users.revokeSessions(id, actor);
  }

  @RequirePermissions('users.read')
  @Get(':id/sessions')
  sessions(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.listSessions(id);
  }

  @RequirePermissions('users.write')
  @Delete(':id/sessions/:sid')
  revokeOne(@Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string, @CurrentUser() actor: AuthUser) {
    return this.users.revokeSession(id, sid, actor);
  }

  @RequirePermissions('users.write')
  @Post(':id/unlock')
  unlock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.users.unlock(id, actor);
  }

  @RequirePermissions('users.write')
  @Post(':id/reset-2fa')
  reset2fa(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthUser) {
    return this.users.reset2fa(id, actor);
  }

  /** Khoá tạm thời tới thời điểm chỉ định (kèm lý do), đăng xuất mọi thiết bị */
  @RequirePermissions('users.write')
  @Post(':id/lock')
  lock(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LockUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.lock(id, dto, actor);
  }

  /** Thống kê dữ liệu liên quan để admin chọn xoá kèm */
  @RequirePermissions('users.delete')
  @Get(':id/delete-preview')
  deletePreview(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.deletePreview(id);
  }

  /** Xoá vĩnh viễn thành viên + các nhóm dữ liệu đã chọn (body bắt buộc có confirmEmail) */
  @RequirePermissions('users.delete')
  @Post(':id/delete')
  remove(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeleteUserDto, @CurrentUser() actor: AuthUser) {
    return this.users.remove(id, actor, dto);
  }
}
