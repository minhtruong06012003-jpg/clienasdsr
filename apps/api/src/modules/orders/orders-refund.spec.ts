import { describe, expect, it, vi } from 'vitest';

// phụ thuộc nặng không cần cho luồng hoàn tiền
vi.mock('../digital-codes/digital-codes.service.js', () => ({ DigitalCodesService: class {} }));
vi.mock('../mail/mail.service.js', () => ({ MailService: class {} }));

import { OrdersAdminService } from './orders-admin.service.js';

/** Dựng OrdersAdminService với Prisma giả cho luồng hoàn tiền qua cổng */
function setup(opts: { gatewayError?: Error; step3Error?: Error; pendingSum?: number } = {}) {
  const order = { id: 'o1', code: 'DH1', status: 'CONFIRMED', paymentStatus: 'PAID', paymentMethod: 'payos', userId: null, total: 100000, refundedTotal: 0, currency: 'VND', history: [], items: [], customerEmail: null };
  let txCount = 0;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    order: { findUniqueOrThrow: vi.fn(async () => order), update: vi.fn(async (_args: unknown) => ({ ...order, items: [] })) },
    refund: {
      aggregate: vi.fn(async () => ({ _sum: { amount: opts.pendingSum ?? 0 } })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r1', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r1', ...data })),
    },
    paymentTransaction: { findFirst: vi.fn(async () => ({ id: 'p1', amount: 100000, status: 'PAID' })) },
  };
  const prisma = {
    order: { findUnique: vi.fn(async () => order) },
    refund: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => {
      txCount += 1;
      if (txCount === 2 && opts.step3Error) throw opts.step3Error;
      return fn(tx);
    }),
  };
  const payments = {
    isOnline: () => true,
    supportsRefund: () => true,
    refund: vi.fn(async () => {
      if (opts.gatewayError) throw opts.gatewayError;
      return { providerRef: 'GW1' };
    }),
    cancelPendingForOrder: vi.fn(async () => undefined),
  };
  const service = new OrdersAdminService(
    prisma as never, {} as never, {} as never, {} as never, {} as never,
    { doAction: vi.fn(async () => undefined) } as never, { emit: vi.fn() } as never, payments as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  // get() đọc nhiều quan hệ — không cần cho test
  (service as unknown as { get: () => Promise<unknown> }).get = async () => ({});
  return { service, prisma, tx, payments };
}

const actor = { id: 'a1', name: 'Admin', permissions: ['*'] } as never;

describe('Hoàn tiền qua cổng — 3 bước', () => {
  it('giữ chỗ Refund PENDING, gọi cổng ngoài transaction, rồi cập nhật COMPLETED', async () => {
    const { service, tx, payments, prisma } = setup();
    await service.refund('o1', { amount: 50000, method: 'gateway' } as never, actor);
    expect(tx.refund.create.mock.calls[0][0].data).toMatchObject({ status: 'PENDING', transactionId: 'p1' });
    expect(payments.refund).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.refund.update.mock.calls[0][0].data).toMatchObject({ status: 'COMPLETED', providerRef: 'GW1' });
    expect(tx.order.update.mock.calls[0][0]).toMatchObject({ data: { refundedTotal: 50000, paymentStatus: 'PARTIALLY_REFUNDED' } });
  });

  it('cổng từ chối -> Refund FAILED kèm lý do, không cộng refundedTotal', async () => {
    const { service, prisma, tx } = setup({ gatewayError: new Error('từ chối') });
    await expect(service.refund('o1', { amount: 50000, method: 'gateway' } as never, actor)).rejects.toThrow(/từ chối/);
    expect(prisma.refund.update.mock.calls[0]).toBeDefined();
    expect((prisma.refund.update.mock.calls[0] as unknown as [{ data: { status: string; reason: string } }])[0].data).toMatchObject({ status: 'FAILED', reason: expect.stringMatching(/Lỗi cổng/) });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('cổng đã hoàn nhưng ghi DB lỗi -> báo lỗi kèm mã đối soát', async () => {
    const { service } = setup({ step3Error: new Error('DB mất kết nối') });
    await expect(service.refund('o1', { amount: 50000, method: 'gateway' } as never, actor)).rejects.toThrow(/đối soát Refund r1/);
  });

  it('Refund PENDING đang giữ chỗ được tính vào số tiền còn hoàn được', async () => {
    const { service, payments } = setup({ pendingSum: 80000 });
    await expect(service.refund('o1', { amount: 50000, method: 'gateway' } as never, actor)).rejects.toThrow(/tối đa còn lại/);
    expect(payments.refund).not.toHaveBeenCalled();
  });
});
