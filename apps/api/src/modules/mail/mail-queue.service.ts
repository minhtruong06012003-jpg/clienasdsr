import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from './mail.service.js';

/** Số email tối đa nhận mỗi lượt (2 giây/lượt) */
const CLAIM_BATCH = 20;
/** Số email gửi song song (khớp maxConnections của pool SMTP) */
const CONCURRENCY = 3;
/** Email ở trạng thái SENDING quá lâu (tiến trình chết giữa chừng) → trả lại hàng chờ */
const STUCK_MINUTES = 10;
/** Thời gian tối đa chờ lô email đang gửi xong khi API tắt (trước khi Prisma ngắt kết nối) */
const SHUTDOWN_WAIT_MS = 20_000;

/**
 * Worker hàng chờ email: chạy nền ngay trong tiến trình API, đọc bảng email_logs (status QUEUED).
 * - Nhiều instance API chạy song song vẫn an toàn nhờ FOR UPDATE SKIP LOCKED (mỗi email chỉ một worker nhận).
 * - Gửi theo ưu tiên (priority cao trước) rồi tới thứ tự xếp hàng.
 * - Giới hạn tốc độ theo cài đặt "tối đa N email/phút" (tính cả email gửi ngay), tạm dừng được.
 * - Thử lại theo backoff do MailService.deliverQueued quyết định.
 * - Khi API tắt: không nhận lô mới, gửi nốt nhóm đang gửi (tối đa 20s), email đã nhận mà chưa gửi trả lại hàng chờ.
 */
@Injectable()
export class MailQueueService implements OnModuleDestroy {
  private readonly logger = new Logger('MailQueue');
  private ticking = false;
  private stopped = false;
  /** mốc lượt chạy / lần gửi gần nhất (cho /api/health) */
  private lastTickAt: Date | null = null;
  private lastBatchAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** API đang tắt: ngừng nhận email mới và chờ nhóm đang gửi xong (tối đa SHUTDOWN_WAIT_MS) */
  async onModuleDestroy() {
    this.stopped = true;
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (this.ticking && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (this.ticking) this.logger.warn('Hết thời gian chờ gửi email khi tắt — email đang gửi dở sẽ được trả lại hàng chờ sau 10 phút');
  }

  /** Trạng thái worker trong tiến trình này (cho /api/health — không truy vấn DB) */
  workerStatus() {
    return { running: !this.stopped, busy: this.ticking, lastTickAt: this.lastTickAt?.toISOString() ?? null, lastBatchAt: this.lastBatchAt?.toISOString() ?? null };
  }

  @Interval(2000)
  async tick() {
    if (this.ticking || this.stopped || process.env.NODE_ENV === 'test') return;
    this.ticking = true;
    this.lastTickAt = new Date();
    try {
      await this.process();
    } catch (err) {
      this.logger.error(`Lỗi vòng lặp hàng chờ email: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Một lượt xử lý: kiểm tra cấu hình + hạn mức tốc độ, nhận một lô rồi gửi. Trả số email đã nhận. */
  async process(): Promise<number> {
    // đọc thẳng DB mỗi lượt: tạm dừng / đổi tốc độ có hiệu lực ngay trên mọi instance
    const cfg = await this.mail.queueConfig(true);
    if (cfg.paused || !cfg.hostConfigured) return 0;
    let budget = CLAIM_BATCH;
    if (cfg.rateLimitPerMinute > 0) {
      const sentLastMinute = await this.prisma.emailLog.count({ where: { sentAt: { gte: new Date(Date.now() - 60_000) } } });
      budget = Math.min(budget, cfg.rateLimitPerMinute - sentLastMinute);
    }
    if (budget <= 0) return 0;

    const ids = await this.claim(budget);
    if (!ids.length) return 0;
    this.lastBatchAt = new Date();
    const rows = await this.prisma.emailLog.findMany({ where: { id: { in: ids } }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
    let i = 0;
    for (; i < rows.length && !this.stopped; i += CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + CONCURRENCY).map((r) =>
          this.mail.deliverQueued(r).catch(async (err) => {
            // lỗi ngoài dự kiến (DB...) → trả lại hàng chờ sau 1 phút để không kẹt ở SENDING
            this.logger.error(`Không xử lý được email #${r.id.slice(0, 8)}: ${(err as Error).message}`);
            await this.prisma.emailLog.update({ where: { id: r.id }, data: { status: 'QUEUED', lockedAt: null, nextAttemptAt: new Date(Date.now() + 60_000), error: (err as Error).message } }).catch(() => undefined);
          }),
        ),
      );
    }
    // đang tắt giữa chừng: email đã nhận mà chưa gửi -> trả lại hàng chờ ngay (không tính lượt thử), khỏi chờ 10 phút
    if (i < rows.length) {
      const rest = rows.slice(i).map((r) => r.id);
      await this.prisma.emailLog
        .updateMany({ where: { id: { in: rest }, status: 'SENDING' }, data: { status: 'QUEUED', lockedAt: null, attempts: { decrement: 1 } } })
        .catch((err: Error) => this.logger.warn(`Không trả được email về hàng chờ: ${err.message}`));
    }
    return rows.length;
  }

  /** Nhận tối đa `limit` email tới hạn: chuyển sang SENDING + tăng số lần thử trong cùng một câu lệnh */
  private async claim(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "email_logs" SET "status" = 'SENDING', "lockedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "email_logs"
        WHERE "status" = 'QUEUED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
        ORDER BY "priority" DESC, "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    return rows.map((r) => r.id);
  }

  /** Email kẹt ở SENDING (API bị tắt giữa lúc gửi) → trả lại hàng chờ */
  @Interval(60_000)
  async recoverStuck() {
    if (process.env.NODE_ENV === 'test') return;
    const r = await this.prisma.emailLog.updateMany({ where: { status: 'SENDING', lockedAt: { lt: new Date(Date.now() - STUCK_MINUTES * 60_000) } }, data: { status: 'QUEUED', lockedAt: null, nextAttemptAt: new Date() } });
    if (r.count) this.logger.warn(`Đã trả ${r.count} email bị kẹt về hàng chờ`);
  }
}
