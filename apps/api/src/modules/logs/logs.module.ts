import { Module } from '@nestjs/common';
import { LogsService } from './logs.service.js';
import { AdminClientErrorsController, LogsController, PublicClientErrorsController } from './logs.controller.js';

/** Nhật ký lỗi: đọc/lọc/dọn file log, nhận lỗi từ trình duyệt và storefront */
@Module({
  controllers: [LogsController, AdminClientErrorsController, PublicClientErrorsController],
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
