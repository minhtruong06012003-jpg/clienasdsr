import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { AnnouncementsService } from './announcements.service.js';
import { UpsertAnnouncementDto } from './announcements.dto.js';

/** Bảng tin ở trang Tổng quan & Timeline trang Bảng giá dịch vụ (cho phép cả khách chưa đăng nhập đọc thông báo đang bật) */
@Controller('account/announcements')
export class AccountAnnouncementsController {
  constructor(private readonly svc: AnnouncementsService) {}

  @Public()
  @Get()
  list() {
    return this.svc.memberList();
  }
}

/** Admin: thêm / sửa / xoá thông báo bảng tin (quyền announcements.manage) */
@Controller('admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly svc: AnnouncementsService) {}

  @RequirePermissions('announcements.manage')
  @Get()
  list() {
    return this.svc.adminList();
  }

  @RequirePermissions('announcements.manage')
  @Post()
  create(@Body() dto: UpsertAnnouncementDto, @CurrentUser() user: AuthUser) {
    return this.svc.save(dto, user.id);
  }

  @RequirePermissions('announcements.manage')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertAnnouncementDto, @CurrentUser() user: AuthUser) {
    return this.svc.save(dto, user.id, id);
  }

  @RequirePermissions('announcements.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }
}
