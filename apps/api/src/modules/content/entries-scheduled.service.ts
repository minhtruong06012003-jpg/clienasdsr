import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EntriesService } from './entries.service.js';

/**
 * Tự chuyển bài hẹn giờ (SCHEDULED, publishedAt <= now) sang PUBLISHED mỗi phút — giống
 * ScheduledPublishService của page/post/product. Bài hẹn giờ vẫn hiển thị đúng giờ nhờ
 * publishedEntryWhere(); cron này bổ sung trạng thái + hook `entry.published` + revalidate.
 */
@Injectable()
export class EntriesScheduledService {
  private readonly logger = new Logger('ScheduledEntries');

  constructor(
    private readonly prisma: PrismaService,
    private readonly entries: EntriesService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run() {
    if (process.env.NODE_ENV === 'test') return;
    const due = await this.prisma.entry.findMany({
      where: { status: 'SCHEDULED', publishedAt: { lte: new Date() }, deletedAt: null },
      select: { id: true, type: { select: { key: true } } },
      take: 500,
    });
    if (!due.length) return;
    await this.prisma.entry.updateMany({ where: { id: { in: due.map((d) => d.id) }, status: 'SCHEDULED' }, data: { status: 'PUBLISHED' } });
    for (const d of due) {
      await this.entries.published(d.id, d.type.key, true);
      this.entries.afterChange(d.id, d.type.key, 'entry.scheduled_published');
    }
    this.logger.log(`Đã xuất bản ${due.length} bài hẹn giờ (nội dung tuỳ biến)`);
  }
}
