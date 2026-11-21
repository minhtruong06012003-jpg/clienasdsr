import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Số dòng xoá mỗi câu lệnh — đủ nhỏ để không khoá bảng lâu / không phình WAL */
export const CLEANUP_BATCH = 5000;
/** Nghỉ giữa hai lô để nhường tài nguyên DB cho request thật */
const PAUSE_MS = 200;
/** Trần số lô mỗi bảng mỗi lượt (5000 × 400 = 2 triệu dòng) — phần còn lại để lượt sau */
const MAX_BATCHES = 400;
const DAY_MS = 86_400_000;

/** Refresh token đã thu hồi / xoay vòng được giữ thêm 30 ngày (phục vụ phát hiện dùng lại token, danh sách phiên) */
export const REFRESH_TOKEN_KEEP_DAYS = 30;
/** Nhật ký webhook thanh toán thường (sai chữ ký, không khớp đơn...) giữ 90 ngày */
export const WEBHOOK_LOG_KEEP_DAYS = 90;
/** Nhật ký webhook đã khớp giao dịch giữ lâu hơn (1 năm) — bằng chứng đối soát khi khách khiếu nại */
export const WEBHOOK_LOG_MATCHED_KEEP_DAYS = 365;

/**
 * Dọn các bảng chỉ tăng mà không ai xoá: `refresh_tokens`, `payment_webhook_logs`.
 * - Xoá theo lô `CLEANUP_BATCH` dòng bằng `DELETE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`:
 *   mỗi câu chỉ khoá đúng các dòng nó xoá, không khoá cả bảng.
 * - An toàn khi nhiều instance API cùng chạy cron: SKIP LOCKED làm các instance nhặt các dòng khác nhau,
 *   xoá trùng một dòng là vô hại (dòng đã mất thì câu sau không thấy nữa).
 * Chạy 4h15 sáng mỗi ngày (giờ máy chủ), sau job dọn bảng jobs (3h).
 */
@Injectable()
export class TableCleanupService {
  private readonly logger = new Logger('TableCleanup');
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron('15 4 * * *')
  async nightly() {
    if (process.env.NODE_ENV === 'test') return;
    await this.run().catch((err: Error) => this.logger.error(`Dọn bảng lỗi: ${err.message}`));
  }

  /** Một lượt dọn đầy đủ; trả số dòng đã xoá theo từng bảng (dùng cho log / gọi tay) */
  async run(now = new Date()): Promise<{ refreshTokens: number; webhookLogs: number }> {
    if (this.running) return { refreshTokens: 0, webhookLogs: 0 };
    this.running = true;
    try {
      const refreshTokens = await this.cleanRefreshTokens(now);
      const webhookLogs = await this.cleanWebhookLogs(now);
      if (refreshTokens || webhookLogs) this.logger.log(`Đã dọn ${refreshTokens} refresh token, ${webhookLogs} nhật ký webhook thanh toán`);
      return { refreshTokens, webhookLogs };
    } finally {
      this.running = false;
    }
  }

  /**
   * Refresh token: đã hết hạn (không dùng lại được nữa) hoặc đã thu hồi / xoay vòng quá 30 ngày.
   * Token xoay vòng luôn có revokedAt = rotatedAt nên cùng điều kiện; chỉ cần giữ trong cửa sổ ân hạn
   * vài giây + phát hiện dùng lại token cũ, 30 ngày là dư.
   */
  cleanRefreshTokens(now: Date) {
    const keepFrom = new Date(now.getTime() - REFRESH_TOKEN_KEEP_DAYS * DAY_MS);
    return this.batchDelete(
      'refresh_tokens',
      (limit) => this.prisma.$executeRaw`
        DELETE FROM "refresh_tokens" WHERE "id" IN (
          SELECT "id" FROM "refresh_tokens"
          WHERE "expiresAt" < ${now}
             OR ("revokedAt" IS NOT NULL AND "revokedAt" < ${keepFrom})
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )`,
    );
  }

  /** Nhật ký webhook thanh toán: thường giữ 90 ngày, đã khớp đơn/giao dịch giữ 365 ngày */
  cleanWebhookLogs(now: Date) {
    const normal = new Date(now.getTime() - WEBHOOK_LOG_KEEP_DAYS * DAY_MS);
    const matched = new Date(now.getTime() - WEBHOOK_LOG_MATCHED_KEEP_DAYS * DAY_MS);
    return this.batchDelete(
      'payment_webhook_logs',
      (limit) => this.prisma.$executeRaw`
        DELETE FROM "payment_webhook_logs" WHERE "id" IN (
          SELECT "id" FROM "payment_webhook_logs"
          WHERE ("matched" = false AND "createdAt" < ${normal})
             OR ("matched" = true AND "createdAt" < ${matched})
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )`,
    );
  }

  /** Lặp xoá từng lô tới khi lô cuối thiếu (hết dòng cần xoá) hoặc chạm trần số lô */
  private async batchDelete(table: string, deleteBatch: (limit: number) => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await deleteBatch(CLEANUP_BATCH);
      total += n;
      if (n < CLEANUP_BATCH) return total;
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    this.logger.warn(`Bảng ${table} còn nhiều dòng cũ, sẽ dọn tiếp ở lượt sau`);
    return total;
  }
}
