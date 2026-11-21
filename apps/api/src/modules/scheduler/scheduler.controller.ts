import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CronService } from './cron.service.js';
import { JobsService } from './jobs.service.js';

/** Xem hàng đợi job / cron (dùng cho trang Công cụ › Tác vụ nền) */
@Controller('admin/jobs')
@RequirePermissions('settings.manage')
export class SchedulerController {
  constructor(
    private readonly jobs: JobsService,
    private readonly cron: CronService,
  ) {}

  @Get()
  list(@Query() q: { status?: string; type?: string; page?: string; limit?: string }) {
    return this.jobs.list({ status: q.status, type: q.type, page: q.page ? Number(q.page) : undefined, limit: q.limit ? Number(q.limit) : undefined });
  }

  @Get('stats')
  async stats() {
    return { ...(await this.jobs.stats()), cron: this.cron.list() };
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.jobs.retry(id);
  }
}
