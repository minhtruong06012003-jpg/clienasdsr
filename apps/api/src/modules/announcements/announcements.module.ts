import { Module } from '@nestjs/common';
import { AccountAnnouncementsController, AdminAnnouncementsController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';

/** Bảng tin thông báo do admin viết (trang Tổng quan của khách) */
@Module({
  controllers: [AccountAnnouncementsController, AdminAnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
