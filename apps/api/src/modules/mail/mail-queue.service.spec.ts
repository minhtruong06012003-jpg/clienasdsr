import { describe, expect, it, vi } from 'vitest';
import { MailQueueService } from './mail-queue.service.js';

/** Dựng worker với prisma/mail giả: `sentLastMinute` email đã gửi trong phút qua, `queued` id đang chờ */
function setup(cfg: { paused?: boolean; hostConfigured?: boolean; rateLimitPerMinute?: number }, sentLastMinute = 0, queued = 50) {
  const claimed: number[] = [];
  const prisma = {
    emailLog: {
      count: vi.fn(async () => sentLastMinute),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id }))),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // claim: LIMIT ${limit} là tham số thứ 2 của tagged template
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, limit: number) => {
      claimed.push(limit);
      return Array.from({ length: Math.min(limit, queued) }, (_, i) => ({ id: `id-${i}` }));
    }),
  };
  const mail = {
    queueConfig: vi.fn(async () => ({ paused: false, hostConfigured: true, rateLimitPerMinute: 0, maxAttempts: 5, ...cfg })),
    deliverQueued: vi.fn(async () => 'SENT'),
  };
  const worker = new MailQueueService(prisma as never, mail as never);
  return { worker, prisma, mail, claimed };
}

describe('MailQueueService', () => {
  it('đọc cấu hình mới nhất từ DB mỗi lượt (bỏ qua cache)', async () => {
    const { worker, mail } = setup({});
    await worker.process();
    expect(mail.queueConfig).toHaveBeenCalledWith(true);
  });

  it('tạm dừng hoặc chưa cấu hình SMTP thì không nhận email nào', async () => {
    for (const cfg of [{ paused: true }, { hostConfigured: false }]) {
      const { worker, prisma, mail } = setup(cfg);
      expect(await worker.process()).toBe(0);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(mail.deliverQueued).not.toHaveBeenCalled();
    }
  });

  it('không giới hạn tốc độ: nhận tối đa 20 email mỗi lượt và gửi hết', async () => {
    const { worker, mail, claimed } = setup({ rateLimitPerMinute: 0 });
    expect(await worker.process()).toBe(20);
    expect(claimed).toEqual([20]);
    expect(mail.deliverQueued).toHaveBeenCalledTimes(20);
  });

  it('giới hạn tốc độ: chỉ nhận phần còn lại của hạn mức trong phút', async () => {
    const { worker, claimed } = setup({ rateLimitPerMinute: 10 }, 7);
    expect(await worker.process()).toBe(3);
    expect(claimed).toEqual([3]);
  });

  it('đã chạm hạn mức thì chờ phút sau', async () => {
    const { worker, prisma } = setup({ rateLimitPerMinute: 5 }, 5);
    expect(await worker.process()).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('lỗi ngoài dự kiến khi gửi: trả email về hàng chờ, không kẹt ở SENDING', async () => {
    const { worker, prisma, mail } = setup({}, 0, 1);
    mail.deliverQueued.mockRejectedValueOnce(new Error('DB mất kết nối'));
    await worker.process();
    expect(prisma.emailLog.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'id-0' }, data: expect.objectContaining({ status: 'QUEUED' }) }));
  });

  it('đang tắt: email đã nhận mà chưa gửi được trả lại hàng chờ, không tính lượt thử', async () => {
    const { worker, prisma, mail } = setup({}, 0, 5);
    await worker.onModuleDestroy();
    await worker.process();
    expect(mail.deliverQueued).not.toHaveBeenCalled();
    expect(prisma.emailLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['id-0', 'id-1', 'id-2', 'id-3', 'id-4'] }, status: 'SENDING' }, data: expect.objectContaining({ status: 'QUEUED', attempts: { decrement: 1 } }) }),
    );
  });
});
