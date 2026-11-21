import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { HooksService } from '../hooks/hooks.service.js';

/**
 * Tự chuyển nội dung hẹn giờ (SCHEDULED, publishedAt <= now) sang PUBLISHED mỗi phút,
 * đồng thời chạy hook <type>.published và báo frontend riêng (nếu có) làm mới cache.
 * (Nội dung hẹn giờ vẫn hiển thị công khai đúng giờ nhờ publishedCondition(); cron này bổ sung
 * phần trạng thái + hook để webhook/email nhận được sự kiện.)
 * Nhiều instance API cùng chạy cron: mỗi id được chuyển trạng thái bằng một câu UPDATE có điều kiện
 * (status vẫn SCHEDULED) — chỉ instance cập nhật được (count = 1) mới phát sự kiện, nên không bắn trùng hook/webhook.
 */
@Injectable()
export class ScheduledPublishService {
  private readonly logger = new Logger('ScheduledPublish');

  constructor(
    private readonly prisma: PrismaService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run() {
    if (process.env.NODE_ENV === 'test') return;
    const now = new Date();
    const where = { status: 'SCHEDULED' as const, publishedAt: { lte: now }, deletedAt: null };
    const [pages, posts, products] = await Promise.all([
      this.prisma.page.findMany({ where, select: { id: true } }),
      this.prisma.post.findMany({ where, select: { id: true } }),
      this.prisma.product.findMany({ where, select: { id: true } }),
    ]);
    if (!pages.length && !posts.length && !products.length) return;

    const flip = async (type: 'page' | 'post' | 'product', ids: string[], tags: string[]) => {
      if (!ids.length) return;
      const model = this.prisma[type] as unknown as { updateMany: (args: unknown) => Promise<{ count: number }> };
      let published = 0;
      for (const id of ids) {
        // cập nhật có điều kiện từng id: instance khác đã chuyển trước thì count = 0 -> bỏ qua, không phát sự kiện trùng
        const { count } = await model.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'PUBLISHED' } });
        if (count !== 1) continue;
        published++;
        this.events.emit(`${type}.published`, { id });
        await this.hooks.doAction(`${type}.published`, { id, scheduled: true });
        this.events.emit('content.changed', { type, id, tags: [...tags, `${type}:${id}`] });
      }
      if (published) this.logger.log(`Đã xuất bản ${published} ${type} hẹn giờ`);
    };
    await flip('page', pages.map((p) => p.id), ['pages', 'menus']);
    await flip('post', posts.map((p) => p.id), ['posts']);
    await flip('product', products.map((p) => p.id), ['products', 'pages']);
  }
}
