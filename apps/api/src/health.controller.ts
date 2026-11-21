import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/decorators/public.decorator.js';
import { PrismaService } from './prisma/prisma.service.js';
import { JobsService } from './modules/scheduler/jobs.service.js';
import { MailQueueService } from './modules/mail/mail-queue.service.js';

/** Thời gian chờ tối đa cho câu SELECT 1 — DB treo thì báo lỗi nhanh cho load balancer */
const DB_TIMEOUT_MS = 3000;

/**
 * `GET /api/health` cho load balancer / giám sát uptime. Nhẹ: chỉ một câu `SELECT 1`, phần worker đọc từ bộ nhớ.
 * - 200 `{ status: 'ok', db: { ok, ms }, workers: { jobs, mail } }`
 * - 503 khi DB lỗi / quá 3 giây (vẫn kèm trạng thái worker để chẩn đoán).
 * Không giới hạn request (giám sát gọi dày) và không cần đăng nhập.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly mailQueue: MailQueueService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    const started = Date.now();
    let dbError: string | null = null;
    try {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('DB không phản hồi')), DB_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch (err) {
      dbError = (err as Error).message || 'DB lỗi';
    }
    const body = {
      status: dbError ? 'error' : 'ok',
      time: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      db: { ok: !dbError, ms: Date.now() - started, ...(dbError ? { error: 'Không kết nối được cơ sở dữ liệu' } : {}) },
      // worker chạy nền trong tiến trình này: hàng đợi job + hàng chờ email (lần chạy gần nhất, job đang chạy)
      workers: { jobs: this.jobs.workerStatus(), mail: this.mailQueue.workerStatus() },
    };
    if (dbError) throw new ServiceUnavailableException(body);
    return body;
  }
}
