import { Module } from '@nestjs/common';
import { EditLocksController } from './edit-locks.controller.js';
import { EditLocksService } from './edit-locks.service.js';

/** Module khoá chỉnh sửa đồng thời */
@Module({
  controllers: [EditLocksController],
  providers: [EditLocksService],
  exports: [EditLocksService],
})
export class EditLocksModule {}
