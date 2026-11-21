import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_BATCH, TableCleanupService } from './table-cleanup.service.js';

/** Prisma giả: $executeRaw trả lần lượt số dòng xoá trong `counts`, ghi lại SQL + tham số mỗi lần gọi */
function setup(counts: number[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const queue = [...counts];
  const prisma = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return queue.shift() ?? 0;
    }),
  };
  return { svc: new TableCleanupService(prisma as never), calls };
}

describe('TableCleanupService', () => {
  it('xoá theo lô tới khi lô cuối thiếu, giới hạn LIMIT bằng CLEANUP_BATCH', async () => {
    const { svc, calls } = setup([CLEANUP_BATCH, 12, 3]);
    const r = await svc.run(new Date('2026-10-07T00:00:00Z'));
    // refresh_tokens: 2 lô (đầy + thiếu), webhook logs: 1 lô
    expect(r).toEqual({ refreshTokens: CLEANUP_BATCH + 12, webhookLogs: 3 });
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toContain('DELETE FROM "refresh_tokens"');
    expect(calls[0].sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls[0].values).toContain(CLEANUP_BATCH);
    expect(calls[2].sql).toContain('DELETE FROM "payment_webhook_logs"');
  });

  it('mốc thời gian: token thu hồi > 30 ngày, webhook thường 90 ngày, đã khớp 365 ngày', async () => {
    const now = new Date('2026-10-07T00:00:00Z');
    const { svc, calls } = setup([0, 0]);
    await svc.run(now);
    const day = 86_400_000;
    expect(calls[0].values).toEqual([now, new Date(now.getTime() - 30 * day), CLEANUP_BATCH]);
    expect(calls[1].values).toEqual([new Date(now.getTime() - 90 * day), new Date(now.getTime() - 365 * day), CLEANUP_BATCH]);
  });
});
