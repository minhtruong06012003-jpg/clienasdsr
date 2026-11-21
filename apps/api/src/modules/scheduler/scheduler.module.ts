import { Global, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CronService } from './cron.service.js';
import { JobsService } from './jobs.service.js';
import { ScheduledPublishService } from './scheduled-publish.service.js';
import { SchedulerController } from './scheduler.controller.js';
import { TableCleanupService } from './table-cleanup.service.js';

const schedulerDisabled = process.env.DISABLE_SCHEDULER === '1' || process.env.DISABLE_SCHEDULER === 'true';

/** Hạ tầng tác vụ nền: cron (định kỳ) + hàng đợi job (DB) + tự xuất bản nội dung hẹn giờ + dọn bảng phình (refresh token, nhật ký webhook). */
@Global()
@Module({
  imports: [
    ScheduleModule.forRoot({
      cronJobs: !schedulerDisabled,
      intervals: !schedulerDisabled,
      timeouts: !schedulerDisabled,
    }),
  ],
  controllers: [SchedulerController],
  providers: [JobsService, CronService, ScheduledPublishService, TableCleanupService],
  exports: [JobsService, CronService],
})
export class SchedulerModule {}
