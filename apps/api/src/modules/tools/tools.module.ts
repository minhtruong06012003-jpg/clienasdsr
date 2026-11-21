import { Module } from '@nestjs/common';
import { EventsModule } from '../events/revalidate.listener.js';
import { ToolsService } from './tools.service.js';
import { ToolsController } from './tools.controller.js';
import { BackupService } from './backup.service.js';
import { BackupController } from './backup.controller.js';
import { SiteHealthService } from './site-health.service.js';

/** Công cụ vận hành: xuất/nhập cấu hình, sao lưu/khôi phục, Site Health, xoá cache */
@Module({
  imports: [EventsModule],
  controllers: [ToolsController, BackupController],
  providers: [ToolsService, BackupService, SiteHealthService],
  exports: [BackupService],
})
export class ToolsModule {}
