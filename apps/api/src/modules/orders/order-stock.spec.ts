import { describe, expect, it, vi } from 'vitest';
import { restockOrderItem } from './order-stock.js';
import { deleteBlockReason } from './orders-admin.service.js';
import { generateOrderCode, ORDER_CODE_RANDOM_LENGTH } from './orders.service.js';

// OrdersAdminService / OrdersService kéo theo nhiều module — chỉ cần các hàm thuần nên mock phụ thuộc nặng
vi.mock('../digital-codes/digital-codes.service.js', () => ({ DigitalCodesService: class {} }));
vi.mock('../mail/mail.service.js', () => ({ MailService: class {} }));

/** Transaction giả: dòng order_items với quantity / restockedQty cho trước; ghi lại số kho đã cộng */
function fakeTx(row: { quantity: number; restockedQty: number }, opts: { conflict?: boolean } = {}) {
  const state = { ...row, stockAdded: 0 };
  const tx = {
    $queryRaw: vi.fn(async () => [{ quantity: state.quantity, restockedQty: state.restockedQty }]),
    orderItem: {
      updateMany: vi.fn(async ({ where, data }: { where: { restockedQty: number }; data: { restockedQty: number } }) => {
        if (opts.conflict || where.restockedQty !== state.restockedQty) return { count: 0 };
        state.restockedQty = data.restockedQty;
        return { count: 1 };
      }),
    },
    product: {
      findUnique: vi.fn(async () => ({ id: 'p1', manageStock: true })),
      update: vi.fn(async ({ data }: { data: { stockQuantity?: { increment: number } } }) => {
        if (data.stockQuantity) state.stockAdded += data.stockQuantity.increment;
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    productVariant: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { tx, state };
}

const item = { id: '00000000-0000-4000-8000-0000000000aa', productId: 'p1', variantId: null };

describe('Hoàn kho đúng một lần (restockedQty)', () => {
  it('huỷ đơn: hoàn toàn bộ phần chưa hoàn', async () => {
    const { tx, state } = fakeTx({ quantity: 5, restockedQty: 0 });
    expect(await restockOrderItem(tx as never, item)).toBe(5);
    expect(state).toMatchObject({ restockedQty: 5, stockAdded: 5 });
  });

  it('đã hoàn kho một phần khi hoàn tiền -> huỷ đơn chỉ hoàn phần còn lại', async () => {
    const { tx, state } = fakeTx({ quantity: 5, restockedQty: 2 });
    expect(await restockOrderItem(tx as never, item)).toBe(3);
    expect(state).toMatchObject({ restockedQty: 5, stockAdded: 3 });
  });

  it('hoàn một phần không vượt phần còn lại', async () => {
    const { tx, state } = fakeTx({ quantity: 5, restockedQty: 4 });
    expect(await restockOrderItem(tx as never, item, 3)).toBe(1);
    expect(state).toMatchObject({ restockedQty: 5, stockAdded: 1 });
  });

  it('đã hoàn đủ -> không cộng kho nữa', async () => {
    const { tx, state } = fakeTx({ quantity: 5, restockedQty: 5 });
    expect(await restockOrderItem(tx as never, item)).toBe(0);
    expect(state.stockAdded).toBe(0);
    expect(tx.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it('request khác vừa hoàn chen giữa (update có điều kiện thất bại) -> không cộng kho', async () => {
    const { tx, state } = fakeTx({ quantity: 5, restockedQty: 0 }, { conflict: true });
    expect(await restockOrderItem(tx as never, item)).toBe(0);
    expect(state.stockAdded).toBe(0);
  });
});

describe('Chặn xoá đơn có tiền', () => {
  const base = { status: 'CANCELLED', paymentStatus: 'UNPAID', _count: { refunds: 0, payments: 0 } };
  it('đơn huỷ chưa từng có tiền -> được xoá', () => expect(deleteBlockReason(base)).toBeNull());
  it('đơn chưa huỷ', () => expect(deleteBlockReason({ ...base, status: 'PENDING' })).toMatch(/đã huỷ/));
  it('có giao dịch PAID / cần hoàn tiền', () => expect(deleteBlockReason({ ...base, _count: { refunds: 0, payments: 1 } })).toMatch(/nhận tiền/));
  it('có bản ghi hoàn tiền', () => expect(deleteBlockReason({ ...base, _count: { refunds: 1, payments: 0 } })).toMatch(/hoàn tiền/));
  it('trạng thái thanh toán khác UNPAID', () => expect(deleteBlockReason({ ...base, paymentStatus: 'REFUNDED' })).toMatch(/Đã hoàn tiền/));
});

describe('Mã đơn hàng', () => {
  it('tiền tố + yymmdd + 8 ký tự khó đoán, thử lại khi trùng', async () => {
    let calls = 0;
    const code = await generateOrderCode('DH', async () => ++calls === 1, new Date(2026, 9, 7));
    expect(calls).toBe(2);
    expect(code).toMatch(new RegExp(`^DH261007[2-9A-HJKMNP-Z]{${ORDER_CODE_RANDOM_LENGTH}}$`));
  });
});
