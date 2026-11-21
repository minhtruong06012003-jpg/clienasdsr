import { describe, expect, it, vi } from 'vitest';
import { JobsService } from './jobs.service.js';

/** Job giả trả về từ câu claim */
const job = (id: string, type = 't') => ({ id, type, payload: {}, attempts: 1, maxAttempts: 3, status: 'RUNNING' }) as never;

/** Prisma giả: claim trả `claimed`, ghi lại mọi updateMany */
function setup(claimed: unknown[]) {
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const prisma = {
    $queryRaw: vi.fn(async () => claimed),
    job: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: 1 };
      }),
    },
  };
  const events = { emit: vi.fn() };
  const svc = new JobsService(prisma as never, events as never);
  return { svc, prisma, updates, events };
}

const statusUpdates = (updates: { data: Record<string, unknown> }[]) => updates.map((u) => u.data.status).filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('JobsService', () => {
  it('đặt lockedAt lúc bắt đầu chạy từng job rồi đánh DONE', async () => {
    const { svc, updates } = setup([job('a'), job('b')]);
    svc.register('t', async () => undefined);
    await svc.processBatch();
    // mỗi job: 1 lần đặt lockedAt (không có status) + 1 lần DONE
    expect(updates.filter((u) => !u.data.status && u.data.lockedAt instanceof Date)).toHaveLength(2);
    expect(statusUpdates(updates)).toEqual(['DONE', 'DONE']);
  });

  it('quá thời gian: abort signal, KHÔNG đánh FAILED khi handler còn chạy, vòng lặp đi tiếp', async () => {
    const { svc, updates } = setup([job('slow')]);
    svc.timeouts = { soft: 20, hard: 10_000 };
    let signal: AbortSignal | undefined;
    let finishHandler!: () => void;
    svc.register('t', (_p, _j, s) => {
      signal = s;
      return new Promise<void>((r) => (finishHandler = r));
    });
    await svc.processBatch();
    expect(signal?.aborted).toBe(true);
    expect(statusUpdates(updates)).toEqual([]);
    expect(svc.workerStatus().active).toHaveLength(1);
    // handler dừng thật -> mới ghi kết quả
    finishHandler();
    await sleep(10);
    expect(statusUpdates(updates)).toEqual(['DONE']);
    expect(svc.workerStatus().active).toHaveLength(0);
  });

  it('handler lỗi: trả về hàng đợi để thử lại theo backoff', async () => {
    const { svc, updates } = setup([job('x')]);
    svc.register('t', async () => {
      throw new Error('hỏng');
    });
    await svc.processBatch();
    expect(updates.at(-1)?.data).toMatchObject({ status: 'PENDING', lastError: 'hỏng' });
  });

  it('recoverStuck bỏ qua job đang chạy ở tiến trình này', async () => {
    const { svc, prisma } = setup([job('busy')]);
    svc.timeouts = { soft: 10, hard: 10_000 };
    let done!: () => void;
    svc.register('t', () => new Promise<void>((r) => (done = r)));
    await svc.processBatch();
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await svc.recoverStuck();
    } finally {
      process.env.NODE_ENV = env;
    }
    const last = prisma.job.updateMany.mock.calls.at(-1)?.[0] as { where: { id?: { notIn: string[] } } };
    expect(last.where.id).toEqual({ notIn: ['busy'] });
    done();
    await sleep(5);
  });

  it('đang tắt: trả job đã nhận nhưng chưa chạy về hàng đợi và chờ job đang chạy xong', async () => {
    const { svc, updates } = setup([job('1'), job('2')]);
    let release!: () => void;
    svc.register('t', () => new Promise<void>((r) => (release = r)));
    const batch = svc.processBatch();
    await sleep(5);
    const destroy = svc.onModuleDestroy();
    release();
    await batch;
    await destroy;
    expect(statusUpdates(updates)).toEqual(['DONE', 'PENDING']);
    expect(updates.at(-1)?.where).toMatchObject({ id: { in: ['2'] } });
  });
});
