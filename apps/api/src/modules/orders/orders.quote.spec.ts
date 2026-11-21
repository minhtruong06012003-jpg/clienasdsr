import { vi } from 'vitest';

// DigitalCodesService (module kho mã) không cần cho báo giá — thay bằng lớp rỗng để test không phụ thuộc Prisma/crypto
vi.mock('../digital-codes/digital-codes.service.js', () => ({ DigitalCodesService: class {} }));

import { OrdersService } from './orders.service.js';

/** Sản phẩm mẫu: mặc định hàng thật có cân nặng; ghi đè để tạo hàng ảo / kho mã */
function product(over: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'SIMPLE',
    price: 100000,
    salePrice: null,
    saleStart: null,
    saleEnd: null,
    stockStatus: 'IN_STOCK',
    stockQuantity: 10,
    manageStock: true,
    featuredImageId: null,
    weight: 0.5,
    taxClass: null,
    isVirtual: false,
    codeDelivery: false,
    purchaseFields: [],
    translations: [{ locale: 'vi', name: 'Sản phẩm', slug: 'san-pham' }],
    variants: [],
    categories: [],
    ...over,
  };
}

/** Dựng OrdersService với các phụ thuộc giả; trả kèm spy của dịch vụ vận chuyển */
function setup(products: Record<string, unknown>[], opts: { digital?: Record<string, unknown>; coupon?: Record<string, unknown> } = {}) {
  const resolveMethods = vi.fn(async () => [{ id: 'default', name: 'Giao tiêu chuẩn', cost: 30000 }]);
  const prisma = { product: { findMany: vi.fn(async () => products) }, coupon: { findUnique: vi.fn(async () => opts.coupon ?? null) } };
  const languages = { resolve: async (l?: string) => l ?? 'vi', defaultLocale: async () => 'vi' };
  // settings theo nhóm: 'digital' (kho mã) riêng, còn lại là commerce
  const settings = { get: async (k: string) => (k === 'digital' ? (opts.digital ?? {}) : { currency: 'VND', orderCodePrefix: 'DH', enableGuestCheckout: true, paymentMethods: [] }) };
  const media = { findMany: async () => new Map() };
  const hooks = { applyFilters: async (_k: string, v: unknown) => v, doAction: async () => undefined };
  const payments = { isValidMethod: async () => true, isWallet: () => false };
  const tax = { compute: async () => ({ taxTotal: 0, breakdown: [], inclusive: false }) };
  const service = new OrdersService(
    prisma as never,
    languages as never,
    settings as never,
    media as never,
    hooks as never,
    { emit: vi.fn() } as never,
    payments as never,
    { resolveMethods } as never,
    {} as never,
    tax as never,
    {} as never,
  );
  return { service, resolveMethods };
}

const P1 = '00000000-0000-4000-8000-000000000001';
const P2 = '00000000-0000-4000-8000-000000000002';

describe('OrdersService.quote — hàng ảo / kho mã', () => {
  it('giỏ toàn hàng ảo: requiresShipping=false, không gọi vận chuyển, không phí ship', async () => {
    const { service, resolveMethods } = setup([product({ codeDelivery: true })]);
    const q = await service.quote({ items: [{ productId: P1, quantity: 2 }] });
    expect(q.requiresShipping).toBe(false);
    expect(resolveMethods).not.toHaveBeenCalled();
    expect(q.shippingMethods).toEqual([]);
    expect(q.shippingTotal).toBe(0);
    expect(q.shippingUnavailable).toBe(false);
    expect(q.total).toBe(200000);
    expect(q.items[0]).toMatchObject({ virtual: true, codeDelivery: true, available: true, weight: 0 });
  });

  it('sản phẩm DIGITAL / isVirtual cũng là hàng ảo', async () => {
    const { service } = setup([product({ type: 'DIGITAL' }), product({ id: P2, isVirtual: true })]);
    const q = await service.quote({ items: [{ productId: P1, quantity: 1 }, { productId: P2, quantity: 1 }] });
    expect(q.requiresShipping).toBe(false);
  });

  it('giỏ lẫn hàng thật: vẫn tính vận chuyển, chỉ gửi dòng hàng thật cho hãng', async () => {
    const { service, resolveMethods } = setup([product({ codeDelivery: true }), product({ id: P2 })]);
    const q = await service.quote({ items: [{ productId: P1, quantity: 1 }, { productId: P2, quantity: 1 }] });
    expect(q.requiresShipping).toBe(true);
    expect(resolveMethods).toHaveBeenCalledTimes(1);
    const arg = (resolveMethods.mock.calls[0] as unknown as [{ items: unknown[]; weight: number }])[0];
    expect(arg.items).toHaveLength(1);
    expect(arg.weight).toBe(500);
    expect(q.shippingTotal).toBe(30000);
  });

  it('thiếu ô bắt buộc (purchaseFields) -> dòng không hợp lệ kèm thông báo', async () => {
    const fields = [{ key: 'game_id', label: { vi: 'ID game', en: 'Game ID' }, type: 'text', required: true }];
    const { service } = setup([product({ codeDelivery: true, purchaseFields: fields })]);
    const q = await service.quote({ items: [{ productId: P1, quantity: 1 }] });
    expect(q.hasErrors).toBe(true);
    expect(q.items[0].available).toBe(false);
    expect(q.items[0].error).toBe('Vui lòng nhập "ID game"');
    expect(q.items[0].purchaseFields).toEqual([{ key: 'game_id', label: 'ID game', type: 'text', required: true, placeholder: null, help: null, options: [], maxLength: 255 }]);

    // locale en -> thông báo + nhãn tiếng Anh
    const en = await service.quote({ items: [{ productId: P1, quantity: 1 }], locale: 'en' });
    expect(en.items[0].error).toBe('Please enter "Game ID"');
  });

  it('ô hợp lệ -> echo fields (bỏ khoá lạ, cắt khoảng trắng) và fieldValues có nhãn', async () => {
    const fields = [
      { key: 'game_id', label: { vi: 'ID game' }, type: 'number', required: true },
      { key: 'server', label: { vi: 'Máy chủ' }, type: 'select', options: [{ value: 'vn', label: { vi: 'Việt Nam' } }] },
    ];
    const { service } = setup([product({ codeDelivery: true, purchaseFields: fields })]);
    const q = await service.quote({ items: [{ productId: P1, quantity: 1, fields: { game_id: ' 123456 ', server: 'vn', hack: 'x' } }] });
    expect(q.items[0].available).toBe(true);
    expect(q.items[0].fields).toEqual({ game_id: '123456', server: 'vn' });
    expect(q.items[0].fieldValues).toEqual([
      { key: 'game_id', label: 'ID game', value: '123456', type: 'number' },
      { key: 'server', label: 'Máy chủ', value: 'vn', type: 'select' },
    ]);

    // sai định dạng số / lựa chọn ngoài danh sách
    const bad = await service.quote({ items: [{ productId: P1, quantity: 1, fields: { game_id: 'abc' } }] });
    expect(bad.items[0].error).toBe('"ID game" phải là số');
    const badSelect = await service.quote({ items: [{ productId: P1, quantity: 1, fields: { game_id: '1', server: 'us' } }] });
    expect(badSelect.items[0].error).toBe('Vui lòng chọn "Máy chủ"');
  });
});

describe('OrdersService.checkout — kiểm tra trước khi tạo đơn', () => {
  const base = { customerName: 'Khách', customerPhone: '0900000000', paymentMethod: 'cod' };

  it('hàng ảo + khách vãng lai không có email -> báo nhập email', async () => {
    const { service } = setup([product({ codeDelivery: true })]);
    await expect(service.checkout({ ...base, items: [{ productId: P1, quantity: 1 }] }, undefined)).rejects.toThrow('Vui lòng nhập email để nhận mã / tài khoản');
  });

  it('hàng thật mà không có địa chỉ -> báo nhập địa chỉ', async () => {
    const { service } = setup([product()]);
    await expect(service.checkout({ ...base, items: [{ productId: P1, quantity: 1 }] }, undefined)).rejects.toThrow('Vui lòng nhập địa chỉ giao hàng');
  });
});

/** Mã giảm giá mẫu (mặc định miễn phí vận chuyển, không điều kiện) */
function coupon(over: Record<string, unknown> = {}) {
  return { id: 'cp1', code: 'FREESHIP', type: 'FREE_SHIPPING', value: 0, isActive: true, startsAt: null, endsAt: null, usageLimit: null, usedCount: 0, minOrderTotal: null, maxDiscount: null, productIds: [], categoryIds: [], excludeProductIds: [], perUserLimit: null, firstOrderOnly: false, ...over };
}

describe('OrdersService.quote — sửa sau rà soát kho mã', () => {
  it('vận chuyển chỉ nhận tiền hàng / cân nặng của dòng cần giao (không tính hàng ảo)', async () => {
    const { service, resolveMethods } = setup([product({ codeDelivery: true, price: 900000 }), product({ id: P2, price: 100000 })]);
    const q = await service.quote({ items: [{ productId: P1, quantity: 1 }, { productId: P2, quantity: 2 }] });
    expect(q.subtotal).toBe(1100000);
    const arg = (resolveMethods.mock.calls[0] as unknown as [{ subtotal: number; weight: number }])[0];
    expect(arg.subtotal).toBe(200000);
    expect(arg.weight).toBe(1000);
  });

  it('mã FREE_SHIPPING cho đơn không cần giao hàng -> couponError, không áp dụng mã', async () => {
    const { service } = setup([product({ codeDelivery: true })], { coupon: coupon() });
    const q = await service.quote({ items: [{ productId: P1, quantity: 1 }], couponCode: 'freeship' });
    expect(q.coupon).toBeNull();
    expect(q.couponError).toBe('Mã miễn phí vận chuyển không áp dụng cho đơn không cần giao hàng');
    // giỏ có hàng thật -> mã vẫn dùng được
    const { service: s2 } = setup([product()], { coupon: coupon() });
    const q2 = await s2.quote({ items: [{ productId: P1, quantity: 1 }], couponCode: 'freeship' });
    expect(q2.coupon?.code).toBe('FREESHIP');
    expect(q2.shippingTotal).toBe(0);
  });

  it('emailRequired = khách chưa đăng nhập + có dòng hàng ảo hợp lệ', async () => {
    const { service } = setup([product({ codeDelivery: true })]);
    expect((await service.quote({ items: [{ productId: P1, quantity: 1 }] })).emailRequired).toBe(true);
    expect((await service.quote({ items: [{ productId: P1, quantity: 1 }] }, { userId: 'u1' })).emailRequired).toBe(false);
    const { service: real } = setup([product()]);
    expect((await real.quote({ items: [{ productId: P1, quantity: 1 }] })).emailRequired).toBe(false);
  });

  it('inputFields echo giá trị khách gửi (đã cắt khoảng trắng, không lọc theo định nghĩa) kể cả dòng lỗi', async () => {
    const fields = [{ key: 'game_id', label: { vi: 'ID game' }, type: 'number', required: true }];
    const { service } = setup([product({ codeDelivery: true, purchaseFields: fields })]);
    const q = await service.quote({ items: [{ productId: P1, quantity: 1, fields: { game_id: ' abc ', note: ' x ', empty: '  ' } }] });
    expect(q.items[0].available).toBe(false);
    expect(q.items[0].inputFields).toEqual({ game_id: 'abc', note: 'x' });
    const ok = await service.quote({ items: [{ productId: P1, quantity: 1, fields: { game_id: '12', hack: 'y' } }] });
    expect(ok.items[0].fields).toEqual({ game_id: '12' });
    expect(ok.items[0].inputFields).toEqual({ game_id: '12', hack: 'y' });
  });
});

describe('OrdersService.checkout — khách vãng lai mua sản phẩm giao mã', () => {
  const base = { customerName: 'Khách', customerPhone: '0900000000', customerEmail: 'a@b.vn', paymentMethod: 'cod' };

  it('tắt cả xem mã khi chưa đăng nhập lẫn gửi mã qua email -> bắt đăng nhập', async () => {
    const { service } = setup([product({ codeDelivery: true })], { digital: { guestAccess: false, emailCodes: false } });
    await expect(service.checkout({ ...base, items: [{ productId: P1, quantity: 1 }] }, undefined)).rejects.toThrow('Vui lòng đăng nhập để mua sản phẩm giao mã');
  });

  it('chỉ tắt một trong hai -> không chặn ở bước này', async () => {
    const { service } = setup([product({ codeDelivery: true })], { digital: { guestAccess: false, emailCodes: true } });
    // đi tiếp tới bước tạo mã đơn (prisma giả không có order) -> lỗi khác, không phải lỗi đăng nhập
    await expect(service.checkout({ ...base, items: [{ productId: P1, quantity: 1 }] }, undefined)).rejects.not.toThrow('Vui lòng đăng nhập để mua sản phẩm giao mã');
  });
});
