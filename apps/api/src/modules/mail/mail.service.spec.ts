import { describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service.js';

/** Email nhạy cảm (giao mã) đang trong hàng chờ: meta còn html để worker gửi */
const SENSITIVE_META = { orderId: 'o1', event: 'digital.delivered', sensitive: true, subject: 'Mã của bạn', html: '<p>KEY-AAAA-BBBB</p>' };

/** Dựng MailService với prisma / settings giả; transport gửi luôn lỗi (lỗi vĩnh viễn) */
function setup() {
  const prisma = {
    emailLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'l1', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'l1', ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ id: 'l1', status: 'FAILED', meta: SENSITIVE_META })),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'l1', status: 'CANCELLED', meta: SENSITIVE_META })),
    },
  };
  const settings = { get: vi.fn(async () => ({ host: 'smtp.test', maxAttempts: 3 })) };
  const hooks = { doAction: vi.fn(async () => undefined) };
  const events = { emit: vi.fn() };
  const svc = new MailService(settings as never, prisma as never, {} as never, {} as never, hooks as never, {} as never, { get: vi.fn() } as never, events as never);
  // transport giả: sendMail ném lỗi vĩnh viễn (550) -> không thử lại
  (svc as any).getTransport = vi.fn(async () => ({ transporter: { sendMail: vi.fn(async () => Promise.reject(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }))) }, from: 'shop@test' }));
  return { svc, prisma, events };
}

describe('MailService — email nhạy cảm không lưu html trong nhật ký', () => {
  it('worker gửi lỗi hẳn (FAILED) -> xoá html, đánh dấu redacted', async () => {
    const { svc, prisma, events } = setup();
    const log = { id: 'l1', to: 'a@b.c', subject: 'Mã của bạn', meta: SENSITIVE_META, attachments: null, attempts: 3, maxAttempts: 3 };
    expect(await svc.deliverQueued(log as never)).toBe('FAILED');
    expect(prisma.emailLog.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: expect.objectContaining({ status: 'FAILED', meta: expect.objectContaining({ html: '', redacted: true, sensitive: true }) }) });
    expect(events.emit).toHaveBeenCalledWith('mail.failed', expect.anything());
  });

  it('gửi ngay (immediate) bị lỗi -> nhật ký FAILED không giữ html', async () => {
    const { svc, prisma } = setup();
    await expect(svc.send({ to: 'a@b.c', subject: 'Mã', html: '<p>KEY-AAAA-BBBB</p>', immediate: true, meta: { sensitive: true } })).rejects.toThrow('550');
    const data = prisma.emailLog.create.mock.calls[0][0].data as { status: string; meta: Record<string, unknown> };
    expect(data.status).toBe('FAILED');
    expect(data.meta).toMatchObject({ html: '', redacted: true });
  });

  it('email thường gửi lỗi vẫn giữ html để gửi lại từ nhật ký', async () => {
    const { svc, prisma } = setup();
    await expect(svc.send({ to: 'a@b.c', subject: 'Chào', html: '<p>Xin chào</p>', immediate: true })).rejects.toThrow();
    expect((prisma.emailLog.create.mock.calls[0][0].data as { meta: Record<string, unknown> }).meta).toMatchObject({ html: '<p>Xin chào</p>' });
  });

  it('huỷ email nhạy cảm trong hàng chờ -> xoá html', async () => {
    const { svc, prisma } = setup();
    await svc.cancel('l1');
    expect(prisma.emailLog.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { meta: expect.objectContaining({ html: '', redacted: true }) } });
  });

  it('không gửi lại email nhạy cảm từ nhật ký', async () => {
    const { svc } = setup();
    await expect(svc.resend('l1')).rejects.toThrow('Gửi lại email');
  });
});
