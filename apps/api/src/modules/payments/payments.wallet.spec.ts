import { describe, expect, it, vi } from 'vitest';
import { PaymentsService, normalizeTransferContent } from './payments.service.js';
import { WalletService } from '../wallet/wallet.service.js';

/** Giao dịch mẫu (nạp ví hoặc đơn hàng) */
function txRow(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    purpose: 'wallet',
    userId: 'u1',
    orderId: null,
    provider: 'sepay',
    amount: 100000,
    status: 'PENDING',
    providerOrderCode: '123',
    providerTxnId: null,
    reference: null,
    transferContent: 'NAPABCDEFGH',
    note: null,
    webhookData: null,
    ...over,
  } as never;
}

/** Dựng PaymentsService với Prisma giả; `claim` = số dòng updateMany "giành" được giao dịch */
function setup(opts: { claim?: number; owner?: boolean; claimError?: unknown; order?: Record<string, unknown> } = {}) {
  const claimData: Record<string, unknown>[] = [];
  const db = {
    $queryRaw: vi.fn(async () => []),
    user: { findFirst: vi.fn(async () => (opts.owner === false ? null : { id: 'u1' })) },
    order: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'o1', code: 'DH1', status: 'PENDING', paymentStatus: 'UNPAID', history: [], ...opts.order })),
      update: vi.fn(async (_args: unknown) => ({ id: 'o1', code: 'DH1', items: [] })),
    },
    paymentTransaction: {
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.claimError) throw opts.claimError;
        claimData.push(data);
        return { count: opts.claim ?? 1 };
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (d: typeof db) => unknown) => fn(db)),
    paymentTransaction: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const wallet = {
    apply: vi.fn(async (_db: unknown, c: { userId: string; amount: number }) => ({ id: 'w1', userId: c.userId, type: 'DEPOSIT', amount: c.amount, balanceAfter: c.amount, orderId: null })),
    afterChange: vi.fn(async () => undefined),
  };
  const events = { emit: vi.fn() };
  const hooks = { doAction: vi.fn(async () => undefined) };
  const settings = { get: vi.fn(async () => ({})) };
  const service = new PaymentsService(prisma as never, settings as never, hooks as never, events as never, { get: () => '' } as never, {} as never, wallet as never);
  return { service, prisma, db, wallet, events, claimData };
}

describe('Chuẩn hoá nội dung chuyển khoản', () => {
  it('chữ hoa, bỏ ký tự không phải A-Z0-9', () => {
    expect(normalizeTransferContent('nap-abc 12_3')).toBe('NAPABC123');
    expect(normalizeTransferContent('  ')).toBeNull();
    expect(normalizeTransferContent(null)).toBeNull();
  });
});

describe('Nạp ví qua cổng — markPaid', () => {
  it('nhận đủ tiền: cộng ví đúng số tiền, một lần, phát wallet.topup_completed', async () => {
    const { service, wallet, events } = setup();
    const r = await service.markPaid(txRow(), { amount: 100000, txnId: 'bank:1', source: 'webhook' });
    expect(r.ok).toBe(true);
    expect(wallet.apply).toHaveBeenCalledTimes(1);
    expect(wallet.apply.mock.calls[0][1]).toMatchObject({ userId: 'u1', type: 'DEPOSIT', amount: 100000, meta: { source: 'gateway', provider: 'sepay', transactionId: 't1' } });
    expect(events.emit).toHaveBeenCalledWith('wallet.topup_completed', { userId: 'u1', amount: 100000, transactionId: 't1' });
  });

  it('nhận thừa: cộng đúng số tiền thực nhận + ghi chú', async () => {
    const { service, wallet, claimData } = setup();
    await service.markPaid(txRow(), { amount: 150000, txnId: 'bank:2', source: 'webhook' });
    expect(wallet.apply.mock.calls[0][1]).toMatchObject({ amount: 150000 });
    expect(String(claimData[0].note)).toMatch(/Nhận thừa/);
    expect(claimData[0].needsRefund).toBe(false);
  });

  it('nhận thiếu: chỉ ghi chú, không cộng ví', async () => {
    const { service, wallet, prisma } = setup();
    const r = await service.markPaid(txRow(), { amount: 50000, txnId: 'bank:3', source: 'webhook' });
    expect(r.ok).toBeUndefined();
    expect(wallet.apply).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalled();
  });

  it('webhook gửi lại (giao dịch đã bị giành) -> không cộng lần hai', async () => {
    const { service, wallet, prisma } = setup({ claim: 0 });
    prisma.paymentTransaction.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'PAID', providerTxnId: 'bank:4' } as never);
    const r = await service.markPaid(txRow(), { amount: 100000, txnId: 'bank:4', source: 'webhook' });
    expect(r.note).toBe('Đã ghi nhận trước đó');
    expect(wallet.apply).not.toHaveBeenCalled();
  });

  it('hai webhook song song cùng mã (P2002) -> bỏ qua', async () => {
    const { service, wallet } = setup({ claimError: Object.assign(new Error('dup'), { code: 'P2002' }) });
    const r = await service.markPaid(txRow(), { amount: 100000, txnId: 'bank:5', source: 'webhook' });
    expect(r.note).toMatch(/xử lý trước đó/);
    expect(wallet.apply).not.toHaveBeenCalled();
  });

  it('tài khoản đã bị xoá: không cộng, đánh dấu cần hoàn tiền', async () => {
    const { service, wallet, claimData } = setup({ owner: false });
    await service.markPaid(txRow(), { amount: 100000, txnId: 'bank:6', source: 'webhook' });
    expect(wallet.apply).not.toHaveBeenCalled();
    expect(claimData[0].needsRefund).toBe(true);
  });
});

describe('Thanh toán đơn nhận thừa tiền', () => {
  it('đơn vẫn được ghi nhận đã thanh toán, giao dịch đánh dấu cần hoàn phần thừa', async () => {
    const { service, claimData, db, events } = setup();
    const r = await service.markPaid(txRow({ purpose: 'order', orderId: 'o1', userId: null }), { amount: 120000, txnId: 'bank:7', source: 'webhook' });
    expect(r.ok).toBe(true);
    expect(claimData[0]).toMatchObject({ status: 'PAID', needsRefund: true });
    expect(String(claimData[0].note)).toMatch(/Nhận thừa 20\.000đ/);
    expect(db.order.update.mock.calls[0][0]).toMatchObject({ data: { paymentStatus: 'PAID' } });
    expect(events.emit).toHaveBeenCalledWith('order.paid', expect.anything());
  });
});

describe('Admin cộng/trừ ví — idempotencyKey', () => {
  const actor = { id: 'admin', name: 'Admin', permissions: ['*'] } as never;

  it('trùng khoá -> trả giao dịch cũ, không ghi thêm', async () => {
    const existing = { id: 'w9', userId: 'u1', balanceAfter: 500 };
    const prisma = { walletTransaction: { findUnique: vi.fn(async () => existing) }, $transaction: vi.fn() };
    const service = new WalletService(prisma as never, { emit: vi.fn() } as never, { doAction: vi.fn() } as never);
    const r = await service.adjust('u1', { type: 'deposit', amount: 100, idempotencyKey: 'k1' }, actor);
    expect(r).toMatchObject({ transaction: existing, balance: 500, duplicate: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('request song song bị lỗi unique P2002 -> trả giao dịch của request kia', async () => {
    const existing = { id: 'w9', userId: 'u1', balanceAfter: 700 };
    const prisma = {
      walletTransaction: { findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing) },
      $transaction: vi.fn(async () => {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }),
    };
    const service = new WalletService(prisma as never, { emit: vi.fn() } as never, { doAction: vi.fn() } as never);
    const r = await service.adjust('u1', { type: 'deposit', amount: 100, idempotencyKey: 'k2' }, actor);
    expect(r).toMatchObject({ balance: 700, duplicate: true });
  });

  it('khoá đã dùng cho thành viên khác -> 409', async () => {
    const prisma = { walletTransaction: { findUnique: vi.fn(async () => ({ id: 'w9', userId: 'u2', balanceAfter: 1 })) }, $transaction: vi.fn() };
    const service = new WalletService(prisma as never, { emit: vi.fn() } as never, { doAction: vi.fn() } as never);
    await expect(service.adjust('u1', { type: 'deposit', amount: 100, idempotencyKey: 'k3' }, actor)).rejects.toThrow(/idempotencyKey/);
  });
});

describe('Chống ghi nhận hai lần sau khi admin xác nhận tay', () => {
  it('nhận thiếu: lưu mã giao dịch vào bí danh; thông báo gửi lại bị bỏ qua', async () => {
    const { service, prisma } = setup();
    await service.markPaid(txRow(), { amount: 90000, txnId: 'ipn:1', source: 'webhook' });
    const data = (prisma.paymentTransaction.updateMany.mock.calls[0] as unknown as [{ data: { webhookData: { txnAliases: string[] } } }])[0].data;
    expect(data.webhookData.txnAliases).toEqual(['ipn:1']);
    const r = await service.markPaid(txRow({ webhookData: data.webhookData }), { amount: 90000, txnId: 'ipn:1', source: 'webhook' });
    expect(r.note).toMatch(/gửi lại/);
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledTimes(1);
  });

  it('đã xác nhận tay 90k: webhook biến động số dư của CÙNG lần chuyển tới sau -> chỉ gắn mã, không cộng ví', async () => {
    const { service, prisma, wallet } = setup();
    const paid = txRow({ status: 'PAID', providerTxnId: null, webhookData: { manual: true, manualAmount: 90000, txnAliases: ['ipn:1'], underpayments: [{ amount: 90000 }] } });
    prisma.paymentTransaction.findUnique.mockImplementation((async (args: { where: { id?: string } }) => (args.where.id ? paid : null)) as never);
    (prisma.paymentTransaction as Record<string, unknown>).update = vi.fn(async () => ({}));
    const r = await service.markPaid(paid, { amount: 90000, txnId: 'bank:9', source: 'webhook' });
    expect(r.note).toMatch(/xác nhận thủ công/);
    expect(wallet.apply).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ providerTxnId: 'bank:9' }) }));
  });

  it('khi đánh dấu PAID vẫn giữ bí danh + khoản nhận thiếu cũ trong webhookData', async () => {
    const { mergeWebhookData } = await import('./payments.service.js');
    expect(mergeWebhookData({ txnAliases: ['ipn:1'], underpayments: [{ amount: 1 }], x: 1 }, { manual: true }, 'manual')).toEqual({ manual: true, txnAliases: ['ipn:1'], underpayments: [{ amount: 1 }] });
  });

  it('xác nhận tay với mã giao dịch ngân hàng đã dùng -> lỗi', async () => {
    const { service, prisma } = setup();
    prisma.paymentTransaction.findUnique.mockResolvedValue({ id: 'other' } as never);
    (prisma.paymentTransaction as Record<string, unknown>).findUniqueOrThrow = vi.fn(async () => txRow());
    await expect(service.confirmManually('t1', { id: 'a', permissions: ['*'] } as never, undefined, undefined, 'FT123')).rejects.toThrow(/đã được ghi nhận/);
  });
});
