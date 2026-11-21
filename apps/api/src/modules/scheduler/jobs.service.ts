import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Job, Prisma } from '../../generated/prisma/client.js';

/**
 * Handler của một loại job. `signal` bị abort khi job chạy quá thời gian cho phép (JOB_TIMEOUT_MS) hoặc API đang tắt:
 * handler chạy lâu (sao lưu, đồng bộ...) nên kiểm tra `signal.aborted` / truyền signal vào fetch để dừng sớm.
 */
export type JobHandler<P = unknown> = (payload: P, job: Job, signal: AbortSignal) => Promise<unknown> | unknown;

export interface EnqueueOptions {
  /** Thời điểm chạy (mặc định: ngay) */
  runAt?: Date;
  /** Số lần thử tối đa (mặc định 3) */
  maxAttempts?: number;
  /** Module sở hữu job (để lọc / gỡ theo module) */
  owner?: string;
  /** Khoá chống trùng: nếu đã có job PENDING cùng khoá thì không tạo thêm */
  dedupeKey?: string;
}

/** Kết quả chạy handler: thành công hoặc lỗi (kèm lỗi) */
type Outcome = { ok: true } | { ok: false; err: unknown };

const CLAIM_BATCH = 10;
/** Job RUNNING mà lockedAt cũ hơn mốc này (không còn heartbeat) -> coi như tiến trình đã chết, trả lại hàng đợi */
const STUCK_MINUTES = 10;
/** Thời gian chạy bình thường tối đa: quá mốc này handler nhận tín hiệu abort (vẫn giữ khoá tới khi nó dừng thật) */
const JOB_TIMEOUT_MS = 5 * 60_000;
/** Trần cứng: handler bỏ qua abort và chạy quá mốc này thì thôi chờ, ghi lỗi (để không giữ khoá vĩnh viễn) */
const JOB_HARD_LIMIT_MS = 60 * 60_000;
/** Chu kỳ gia hạn khoá (lockedAt) cho job đang chạy ở tiến trình này */
const HEARTBEAT_MS = 60_000;
/** Thời gian tối đa chờ job đang chạy xong khi API tắt (trước khi Prisma ngắt kết nối) */
export const SHUTDOWN_WAIT_MS = 20_000;

/** Job đang chạy trong tiến trình này */
interface ActiveJob {
  type: string;
  startedAt: number;
  controller: AbortController;
}

/**
 * Hàng đợi job lưu trong PostgreSQL (bảng jobs), chạy nền ngay trong tiến trình API.
 * - Nhiều instance API chạy song song vẫn an toàn nhờ FOR UPDATE SKIP LOCKED; job đang chạy được gia hạn khoá
 *   (lockedAt) mỗi phút nên instance khác không "cứu" nhầm job còn sống.
 * - `lockedAt` đặt lại lúc BẮT ĐẦU chạy từng job (lô nhận 10 job chạy tuần tự, job cuối có thể bắt đầu muộn).
 * - Quá JOB_TIMEOUT_MS: abort `signal` truyền vào handler, KHÔNG đánh FAILED khi handler còn chạy; vòng lặp
 *   chuyển sang job khác, kết quả được ghi khi handler dừng thật (hoặc quá trần JOB_HARD_LIMIT_MS).
 * - Thất bại thì thử lại theo backoff (30s, 60s, 120s...), quá maxAttempts -> FAILED.
 * - Khi API tắt: ngừng nhận job mới, trả job đã nhận mà chưa chạy về hàng đợi, chờ job đang chạy tối đa 20s.
 * Dùng: jobs.register('mail.send', handler) rồi jobs.enqueue('mail.send', payload).
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private handlers = new Map<string, { fn: JobHandler; owner?: string }>();
  private ticking = false;
  private stopped = false;
  /** job đang chạy ở tiến trình này (id -> thông tin) */
  private active = new Map<string, ActiveJob>();
  /** phần chờ nền của job đã quá thời gian (để lúc tắt còn chờ được) */
  private detached = new Set<Promise<void>>();
  /** mốc thời gian cho test ghi đè */
  timeouts = { soft: JOB_TIMEOUT_MS, hard: JOB_HARD_LIMIT_MS };
  private lastTickAt: Date | null = null;
  private lastJobAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /** API đang tắt: dừng nhận job, báo handler dừng sớm, chờ việc đang làm xong (tối đa SHUTDOWN_WAIT_MS) */
  async onModuleDestroy() {
    this.stopped = true;
    const busy = () => this.ticking || this.active.size > 0 || this.detached.size > 0;
    if (!busy()) return;
    this.logger.log(`Đang chờ ${this.active.size} job chạy xong trước khi tắt...`);
    const deadline = Date.now() + SHUTDOWN_WAIT_MS;
    while (busy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (busy()) {
      // còn chạy -> báo dừng; job vẫn RUNNING trong DB và sẽ được trả về hàng đợi khi khoá hết hạn (recoverStuck)
      for (const a of this.active.values()) a.controller.abort(new Error('API đang tắt'));
      this.logger.warn(`Hết thời gian chờ, còn ${this.active.size} job đang chạy sẽ được chạy lại sau`);
    }
  }

  register<P = unknown>(type: string, fn: JobHandler<P>, owner?: string) {
    this.handlers.set(type, { fn: fn as JobHandler, owner });
    return () => this.handlers.delete(type);
  }

  unregisterOwner(owner: string) {
    for (const [type, h] of this.handlers) if (h.owner === owner) this.handlers.delete(type);
  }

  hasHandler(type: string) {
    return this.handlers.has(type);
  }

  async enqueue<P extends object = Record<string, unknown>>(type: string, payload: P, opts: EnqueueOptions = {}) {
    if (opts.dedupeKey) {
      const dup = await this.prisma.job.findFirst({ where: { dedupeKey: opts.dedupeKey, status: { in: ['PENDING', 'RUNNING'] } }, select: { id: true } });
      if (dup) return dup;
    }
    return this.prisma.job.create({
      data: { type, payload: payload as object, runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 3, owner: opts.owner, dedupeKey: opts.dedupeKey },
      select: { id: true },
    });
  }

  /** Nhặt job tới hạn và chạy. Chạy mỗi 5 giây; bỏ qua nếu lần trước chưa xong. */
  @Interval(5000)
  async tick() {
    if (this.ticking || this.stopped || process.env.NODE_ENV === 'test') return;
    await this.processBatch();
  }

  /** Một lượt: nhận lô job rồi chạy tuần tự; đang tắt thì trả phần chưa chạy về hàng đợi */
  async processBatch() {
    this.ticking = true;
    this.lastTickAt = new Date();
    try {
      const jobs = await this.claim();
      for (let i = 0; i < jobs.length; i++) {
        if (this.stopped) {
          await this.release(jobs.slice(i));
          break;
        }
        await this.run(jobs[i]);
      }
    } catch (err) {
      this.logger.error(`Lỗi vòng lặp job: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private claim(): Promise<Job[]> {
    return this.prisma.$queryRaw<Job[]>`
      UPDATE "jobs" SET "status" = 'RUNNING', "lockedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "jobs"
        WHERE "status" = 'PENDING' AND "runAt" <= now()
        ORDER BY "runAt" ASC
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
  }

  /** Trả job đã nhận nhưng chưa chạy về hàng đợi (không tính lượt thử) */
  private async release(jobs: Job[]) {
    if (!jobs.length) return;
    await this.prisma.job
      .updateMany({ where: { id: { in: jobs.map((j) => j.id) }, status: 'RUNNING' }, data: { status: 'PENDING', lockedAt: null, attempts: { decrement: 1 } } })
      .catch((err: Error) => this.logger.warn(`Không trả được job về hàng đợi: ${err.message}`));
  }

  private async run(job: Job) {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      // Chưa có handler (module chưa khởi tạo?) -> trả về hàng đợi, thử lại sau 1 phút, không tính lượt
      await this.prisma.job.update({ where: { id: job.id }, data: { status: 'PENDING', attempts: { decrement: 1 }, runAt: new Date(Date.now() + 60_000), lastError: `Không có handler cho "${job.type}"` } });
      return;
    }
    // khoá tính từ lúc BẮT ĐẦU chạy job này (không phải lúc nhận cả lô)
    await this.prisma.job.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { lockedAt: new Date() } });
    const controller = new AbortController();
    this.active.set(job.id, { type: job.type, startedAt: Date.now(), controller });
    this.lastJobAt = new Date();

    const execution: Promise<Outcome> = Promise.resolve()
      .then(() => handler.fn(job.payload, job, controller.signal))
      .then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    const first = await raceTimeout(execution, this.timeouts.soft);
    if (first !== TIMEOUT) {
      await this.finish(job, first);
      return;
    }

    // Quá thời gian: báo handler dừng nhưng KHÔNG đánh FAILED khi nó còn chạy (vẫn giữ khoá + heartbeat).
    // Vòng tick đi tiếp; kết quả được ghi khi handler dừng thật, hoặc khi quá trần cứng.
    controller.abort(new Error('Job quá thời gian cho phép'));
    this.logger.warn(`Job ${job.type}#${job.id.slice(0, 8)} chạy quá ${Math.round(this.timeouts.soft / 1000)}s — đã gửi tín hiệu dừng, chờ handler kết thúc`);
    const tail = raceTimeout(execution, Math.max(0, this.timeouts.hard - this.timeouts.soft)).then((r) =>
      this.finish(job, r === TIMEOUT ? { ok: false, err: new Error('Job vượt quá thời gian tối đa, đã bỏ chờ') } : r),
    );
    this.detached.add(tail);
    void tail.finally(() => this.detached.delete(tail));
  }

  /** Ghi kết quả job (chỉ khi job vẫn RUNNING — tránh đè trạng thái đã bị xử lý ở nơi khác) */
  private async finish(job: Job, outcome: Outcome) {
    this.active.delete(job.id);
    try {
      if (outcome.ok) {
        await this.prisma.job.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'DONE', lastError: null, lockedAt: null } });
        return;
      }
      const err = outcome.err as Error | undefined;
      const message = err?.message ?? String(outcome.err);
      const retry = job.attempts < job.maxAttempts;
      const delay = 30_000 * 2 ** Math.max(0, job.attempts - 1);
      this.logger.warn(`Job ${job.type}#${job.id.slice(0, 8)} lỗi (lần ${job.attempts}/${job.maxAttempts}): ${message}`);
      await this.prisma.job.updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: retry ? { status: 'PENDING', runAt: new Date(Date.now() + delay), lastError: message, lockedAt: null } : { status: 'FAILED', lastError: message, lockedAt: null },
      });
      if (!retry) this.events.emit('job.failed', { ...job, status: 'FAILED', lastError: message });
    } catch (e) {
      this.logger.error(`Không ghi được kết quả job ${job.id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }

  /** Gia hạn khoá cho job đang chạy ở tiến trình này để recoverStuck (của instance khác) không trả nhầm về hàng đợi */
  @Interval(HEARTBEAT_MS)
  async heartbeat() {
    if (!this.active.size) return;
    await this.prisma.job
      .updateMany({ where: { id: { in: [...this.active.keys()] }, status: 'RUNNING' }, data: { lockedAt: new Date() } })
      .catch((err: Error) => this.logger.warn(`Không gia hạn được khoá job: ${err.message}`));
  }

  /** Job RUNNING quá lâu không gia hạn khoá (tiến trình chết giữa chừng) -> trả lại hàng đợi; bỏ qua job đang chạy ở đây */
  @Interval(60_000)
  async recoverStuck() {
    if (process.env.NODE_ENV === 'test' || this.stopped) return;
    const mine = [...this.active.keys()];
    const r = await this.prisma.job.updateMany({
      where: { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - STUCK_MINUTES * 60_000) }, ...(mine.length ? { id: { notIn: mine } } : {}) },
      data: { status: 'PENDING', lockedAt: null },
    });
    if (r.count) this.logger.warn(`Đã trả ${r.count} job bị kẹt về hàng đợi`);
  }

  /** Trạng thái worker trong tiến trình này (cho /api/health — không truy vấn DB) */
  workerStatus() {
    return {
      running: !this.stopped,
      active: [...this.active.values()].map((a) => ({ type: a.type, seconds: Math.round((Date.now() - a.startedAt) / 1000) })),
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastJobAt: this.lastJobAt?.toISOString() ?? null,
    };
  }

  /** Dọn job đã xong > 7 ngày, job lỗi > 30 ngày */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup() {
    const day = 86_400_000;
    await this.prisma.job.deleteMany({ where: { OR: [{ status: 'DONE', updatedAt: { lt: new Date(Date.now() - 7 * day) } }, { status: 'FAILED', updatedAt: { lt: new Date(Date.now() - 30 * day) } }] } });
  }

  async stats() {
    const rows = await this.prisma.job.groupBy({ by: ['status'], _count: true });
    const counts = Object.fromEntries(rows.map((r) => [r.status, r._count])) as Record<string, number>;
    return { pending: counts.PENDING ?? 0, running: counts.RUNNING ?? 0, done: counts.DONE ?? 0, failed: counts.FAILED ?? 0, handlers: [...this.handlers.keys()] };
  }

  list(q: { status?: string; type?: string; page?: number; limit?: number }) {
    const where: Prisma.JobWhereInput = {};
    if (q.status) where.status = q.status as Prisma.JobWhereInput['status'];
    if (q.type) where.type = q.type;
    const limit = Math.min(q.limit ?? 50, 200);
    const page = q.page ?? 1;
    return Promise.all([this.prisma.job.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }), this.prisma.job.count({ where })]).then(([data, total]) => ({
      data,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    }));
  }

  /** Chạy lại job FAILED */
  retry(id: string) {
    return this.prisma.job.update({ where: { id }, data: { status: 'PENDING', attempts: 0, runAt: new Date(), lastError: null } });
  }
}

/** Giá trị đánh dấu hết giờ của raceTimeout */
const TIMEOUT = Symbol('timeout');

/** Chờ promise tối đa `ms`; hết giờ trả TIMEOUT (không huỷ promise gốc). Timer unref để không giữ tiến trình sống. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
