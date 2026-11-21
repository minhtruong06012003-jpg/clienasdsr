import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DigitalCodesService } from './digital-codes.service.js';
import { decryptCode, deriveCodeKeys, encryptCode, hashCode, normalizeCode } from './digital-codes.crypto.js';

/** Bộ khoá giống service trong test (DIGITAL_CODES_KEY môi trường nếu có, không thì dẫn xuất từ JWT giả) */
const KEYS = deriveCodeKeys(process.env.DIGITAL_CODES_KEY ?? '', 'test-secret-test-secret-test-secret');
/** Nội dung mã đã mã hoá đúng khoá (giải mã được) */
const ENC = (plain = 'KEY-OK') => encryptCode(plain, KEYS);
/** Nội dung mã hoá bằng khoá KHÁC (mô phỏng đã đổi DIGITAL_CODES_KEY) */
const BAD_ENC = encryptCode('KEY-OLD', deriveCodeKeys('khoa-cu-da-doi', 'x'));

/** Sản phẩm bán theo kho mã (không biến thể) dùng chung cho các test */
const PRODUCT = {
  id: 'p1',
  type: 'SIMPLE',
  sku: 'KEY-1',
  codeDelivery: true,
  codeFields: [],
  codeWarrantyDays: 7,
  stockStatus: 'IN_STOCK',
  stockQuantity: 10,
  manageStock: true,
  options: [],
  deletedAt: null,
  translations: [{ locale: 'vi', name: 'Key Windows', deliveryNote: null }],
  variants: [],
};

/** Dựng service với prisma / phụ thuộc giả; `prisma` có thể ghi đè từng phần */
function setup(prisma: Record<string, any> = {}, settings: Record<string, unknown> = {}) {
  const db: Record<string, any> = {
    product: { findMany: vi.fn(async () => [PRODUCT]), findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    digitalCode: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
      // số dòng cập nhật = số id truyền vào (mô phỏng mọi dòng còn khớp điều kiện); không lọc theo id -> 0
      updateMany: vi.fn(async (args?: { where?: { id?: { in?: unknown[] } | string } }) => ({ count: typeof args?.where?.id === 'string' ? 1 : (args?.where?.id?.in?.length ?? 0) })),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
    },
    orderItem: { findMany: vi.fn(async () => []) },
    order: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    ...prisma,
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const config = { get: vi.fn((k: string) => (k === 'jwt.accessSecret' ? 'test-secret-test-secret-test-secret' : undefined)) };
  const settingsSvc = { get: vi.fn(async () => ({ autoCompleteOrders: false, ...settings })) };
  const mail = { sendTemplate: vi.fn(async () => ({ status: 'QUEUED', logId: 'l1' })), orderVars: vi.fn(async () => ({})) };
  const hooks = { doAction: vi.fn(async () => undefined), applyFilters: vi.fn(async (_n: string, v: unknown) => v) };
  const events = { emit: vi.fn() };
  const service = new DigitalCodesService(db as never, config as never, settingsSvc as never, mail as never, hooks as never, events as never, {} as never);
  return { service, db, mail, events, hooks };
}

const actor = { id: 'u1', name: 'Admin' } as never;

describe('digital-codes.crypto', () => {
  it('mã hoá / giải mã vòng, IV ngẫu nhiên, sai khoá trả null', () => {
    const keys = deriveCodeKeys('', 'jwt-secret');
    const a = encryptCode('user@example.com|Pass 123', keys);
    const b = encryptCode('user@example.com|Pass 123', keys);
    expect(a).toMatch(/^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(a).not.toBe(b);
    expect(decryptCode(a, keys)).toBe('user@example.com|Pass 123');
    expect(decryptCode(a, deriveCodeKeys('khoa-rieng', 'jwt-secret'))).toBeNull();
    expect(decryptCode('hỏng', keys)).toBeNull();
    expect(deriveCodeKeys('a'.repeat(64), 'x').source).toBe('env');
  });

  it('chuẩn hoá: cắt khoảng trắng, gộp khoảng trắng, bỏ khoảng trắng quanh "|"', () => {
    expect(normalizeCode('  AAAA-BBBB  ')).toBe('AAAA-BBBB');
    expect(normalizeCode('user@x.com  |  pass\t 1 ')).toBe('user@x.com|pass 1');
    const keys = deriveCodeKeys('', 's');
    expect(hashCode(normalizeCode(' a | b '), keys)).toBe(hashCode(normalizeCode('a|b'), keys));
  });
});

describe('DigitalCodesService.import', () => {
  it('chuẩn hoá, đếm dòng lỗi, chống trùng trong file và với kho', async () => {
    const { service, db } = setup();
    // kho đã có "EXIST-1"
    const existingHash = (service as any).hash('EXIST-1');
    db.digitalCode.findMany = vi.fn(async () => [{ contentHash: existingHash }]);
    vi.spyOn(service, 'syncStock').mockResolvedValue();
    vi.spyOn(service, 'fulfillBackorders').mockResolvedValue(0);
    const res = await service.import({ productId: 'p1', text: 'KEY-A\n  KEY-A  \nKEY-B\n\nEXIST-1\n' + 'x'.repeat(2001) }, actor);
    expect(res).toEqual({ created: 2, duplicates: 2, invalid: 1, fulfilledOrders: 0 });
    const data = db.digitalCode.createMany.mock.calls[0][0].data as { content: string; preview: string; contentHash: string }[];
    expect(data).toHaveLength(2);
    // lưu bản mã hoá, không lưu nguyên văn
    expect(data[0].content.startsWith('v1:')).toBe(true);
    expect(data[0].content).not.toContain('KEY-A');
    expect((service as any).decrypt({ id: 'x', content: data[0].content })).toBe('KEY-A');
    expect(service.syncStock).toHaveBeenCalledWith('p1');
  });

  it('sản phẩm có biến thể bắt buộc chọn biến thể', async () => {
    const { service, db } = setup();
    db.product.findMany = vi.fn(async () => [{ ...PRODUCT, type: 'VARIABLE', variants: [{ id: 'v1' }] }]);
    await expect(service.import({ productId: 'p1', text: 'A' }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DigitalCodesService.reserveForOrder', () => {
  const order = { id: 'o1', items: [{ id: 'i1', productId: 'p1', variantId: null, quantity: 3, name: 'Key Windows' }] };

  it('thiếu mã -> ném BadRequest (rollback đơn)', async () => {
    const { service, db } = setup({ $queryRaw: vi.fn(async () => [{ id: 'c1', content: ENC(), note: null }]) });
    await expect(service.reserveForOrder(db as never, order)).rejects.toThrow('chỉ còn 1 mã');
    expect(db.digitalCode.updateMany).not.toHaveBeenCalled();
  });

  it('BACKORDER -> giữ phần có, không ném lỗi', async () => {
    const { service, db } = setup({ $queryRaw: vi.fn(async () => [{ id: 'c1', content: ENC(), note: null }]) });
    db.product.findMany = vi.fn(async () => [{ ...PRODUCT, stockStatus: 'BACKORDER' }]);
    const sync = vi.spyOn(service, 'syncStock').mockResolvedValue();
    await service.reserveForOrder(db as never, order);
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'RESERVED', orderId: 'o1', orderItemId: 'i1' }) }));
    expect(db.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { codeStatus: 'pending' } });
    // trong transaction chỉ ghi biến thể vừa giữ (sản phẩm không biến thể -> tập rỗng)
    expect(sync).toHaveBeenCalledWith('p1', db, { '': 1 }, new Set());
  });
});

describe('DigitalCodesService.deliverForOrder', () => {
  it('RESERVED -> SOLD và cấp bù phần thiếu từ kho, codeStatus delivered', async () => {
    const paidOrder = { id: 'o1', code: 'DH1', status: 'PENDING', paymentStatus: 'PAID', codeStatus: 'pending', codesDeliveredAt: null, customerEmail: null, locale: 'vi', userId: null, items: [{ id: 'i1', productId: 'p1', variantId: null, quantity: 3, name: 'Key' }] };
    // SQL: khoá đơn -> []; chọn mã còn trong kho -> c3
    const queryRaw = vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('digital_codes') ? [{ id: 'c3', content: ENC(), note: null }] : []));
    const { service, db, events, hooks } = setup({ $queryRaw: queryRaw });
    db.order.findUnique = vi.fn(async () => paidOrder);
    db.digitalCode.count = vi.fn(async () => 0);
    db.digitalCode.findMany = vi.fn(async (args: { where: { status?: string; id?: unknown } }) => {
      if (args.where.id) return [{ id: 'c1', productId: 'p1' }, { id: 'c2', productId: 'p1' }, { id: 'c3', productId: 'p1' }].map((c) => ({ ...c, variantId: null, preview: '***', status: 'SOLD', createdAt: new Date() }));
      // 2 mã đã giữ cho dòng i1, không có mã giữ thừa
      return args.where.status === 'RESERVED' && 'orderItemId' in args.where ? [{ id: 'c1', content: ENC(), note: null }, { id: 'c2', content: ENC(), note: null }] : [];
    });
    vi.spyOn(service, 'syncStock').mockResolvedValue();
    const res = await service.deliverForOrder('o1', { notify: true });
    expect(res).toEqual({ delivered: 3, missing: 0, codeStatus: 'delivered' });
    // chỉ chuyển mã vẫn đang giữ cho đúng đơn (không chen ngang thu hồi)
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['c1', 'c2'] }, status: 'RESERVED', orderId: 'o1' }, data: expect.objectContaining({ status: 'SOLD' }) });
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['c3'] }, status: 'AVAILABLE' }, data: expect.objectContaining({ status: 'SOLD', orderId: 'o1', orderItemId: 'i1' }) });
    expect(db.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: expect.objectContaining({ codeStatus: 'delivered' }) });
    expect(events.emit).toHaveBeenCalledWith('digital.delivered', { orderId: 'o1', count: 3 });
    expect(hooks.doAction).toHaveBeenCalledWith('digital.delivered', paidOrder, expect.any(Array));
  });

  it('đơn chưa thanh toán và không force -> không giao', async () => {
    const { service, db } = setup();
    db.order.findUnique = vi.fn(async () => ({ id: 'o1', status: 'PENDING', paymentStatus: 'UNPAID', codeStatus: 'pending', items: [] }));
    const res = await service.deliverForOrder('o1');
    expect(res.delivered).toBe(0);
    expect(db.digitalCode.updateMany).not.toHaveBeenCalled();
  });
});

describe('DigitalCodesService release khi huỷ', () => {
  it('order.statusChanged -> CANCELLED: RESERVED -> AVAILABLE và đồng bộ kho', async () => {
    const { service, db } = setup();
    db.digitalCode.findMany = vi.fn(async () => [{ id: 'c1', productId: 'p1' }]);
    const sync = vi.spyOn(service, 'syncStock').mockResolvedValue();
    await service.onStatusChanged({ order: { id: 'o1' }, to: 'CANCELLED' });
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['c1'] }, status: 'RESERVED' }, data: { status: 'AVAILABLE', orderId: null, orderItemId: null, reservedAt: null } });
    expect(sync).toHaveBeenCalledWith('p1');
  });

  it('chuyển sang trạng thái khác (SHIPPING) không nhả mã', async () => {
    const { service, db } = setup();
    await service.onStatusChanged({ order: { id: 'o1' }, to: 'SHIPPING' });
    expect(db.digitalCode.findMany).not.toHaveBeenCalled();
  });
});

/** Đơn đã thanh toán 1 dòng (p1, số lượng `quantity`) cho các test giao mã */
function paidOrder(quantity = 1) {
  return { id: 'o1', code: 'DH1', status: 'PENDING', paymentStatus: 'PAID', codeStatus: 'pending', codesDeliveredAt: null, customerEmail: null, locale: 'vi', userId: null, items: [{ id: 'i1', productId: 'p1', variantId: null, quantity, name: 'Key' }] };
}

describe('DigitalCodesService.deliverForOrder — mã giữ hết hạn / mã thu hồi', () => {
  it('mã RESERVED đã hết hạn -> trả về kho, cấp mã khác từ kho và đồng bộ tồn kho', async () => {
    const queryRaw = vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('digital_codes') ? [{ id: 'c9', content: ENC(), note: null }] : []));
    const { service, db } = setup({ $queryRaw: queryRaw });
    db.order.findUnique = vi.fn(async () => paidOrder(1));
    // có 1 mã giữ đã hết hạn -> updateMany trả về 1
    db.digitalCode.updateMany = vi.fn(async (args: { where: Record<string, any> }) => ({ count: args.where.expiresAt ? 1 : (args.where.id?.in?.length ?? 0) }));
    db.digitalCode.findMany = vi.fn(async (args: { where: { id?: unknown } }) => (args.where.id ? [{ id: 'c9', productId: 'p1', variantId: null, preview: '***', status: 'SOLD', createdAt: new Date() }] : []));
    const sync = vi.spyOn(service, 'syncStock').mockResolvedValue();
    const res = await service.deliverForOrder('o1');
    expect(res).toEqual({ delivered: 1, missing: 0, codeStatus: 'delivered' });
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', orderItemId: 'i1', status: 'RESERVED', expiresAt: { lte: expect.any(Date) } },
      data: { status: 'AVAILABLE', orderId: null, orderItemId: null, reservedAt: null },
    });
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['c9'] }, status: 'AVAILABLE' }, data: expect.objectContaining({ status: 'SOLD', orderId: 'o1' }) });
    expect(sync).toHaveBeenCalledWith('p1', undefined, { '': 1 });
  });

  it('mã REVOKED tính là đã giao: không tự cấp mã khác, codeStatus delivered', async () => {
    const queryRaw = vi.fn(async () => []);
    const { service, db } = setup({ $queryRaw: queryRaw });
    db.order.findUnique = vi.fn(async () => paidOrder(1));
    // 1 mã của dòng đã bị thu hồi
    db.digitalCode.count = vi.fn(async () => 1);
    const res = await service.deliverForOrder('o1');
    expect(res).toEqual({ delivered: 0, missing: 0, codeStatus: 'delivered' });
    expect(db.digitalCode.count).toHaveBeenCalledWith({ where: { orderItemId: 'i1', status: { in: ['SOLD', 'REVOKED'] }, replacesId: null } });
    // không chọn mã từ kho (chỉ có câu khoá đơn)
    expect((queryRaw.mock.calls as unknown[][]).some((c) => (c[0] as string[]).join('?').includes('digital_codes'))).toBe(false);
  });
});

describe('DigitalCodesService.revoke', () => {
  /** Dựng service + mã có trạng thái `status` gắn đơn o1 */
  function revokeSetup(status: 'SOLD' | 'RESERVED') {
    const row = { id: 'c1', productId: 'p1', variantId: null, status, orderId: 'o1', orderItemId: 'i1', note: null, reportStatus: null, viewedAt: null, preview: '••••', createdAt: new Date() };
    const queryRaw = vi.fn(async () => [{ id: 'c1' }]);
    const ctx = setup({ $queryRaw: queryRaw });
    ctx.db.digitalCode.findUniqueOrThrow = vi.fn(async () => row);
    ctx.db.digitalCode.findUnique = vi.fn(async () => ({ ...row, order: { code: 'DH1' } }));
    ctx.db.digitalCode.update = vi.fn(async () => row);
    const refresh = vi.fn(async () => undefined);
    (ctx.service as any).refreshCodeStatus = refresh;
    const sync = vi.spyOn(ctx.service, 'syncStock').mockResolvedValue();
    return { ...ctx, queryRaw, refresh, sync };
  }

  it('mã SOLD + restock -> vẫn REVOKED (không trả về kho), khoá dòng và tính lại codeStatus', async () => {
    const { service, db, queryRaw, refresh, sync } = revokeSetup('SOLD');
    await service.revoke('c1', { restock: true, reason: 'Hoàn tiền' }, actor);
    expect(((queryRaw.mock.calls as unknown[][])[0][0] as string[]).join('?')).toContain('FOR UPDATE');
    expect(db.digitalCode.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: expect.objectContaining({ status: 'REVOKED', revokeReason: 'Hoàn tiền' }) });
    expect(sync).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith('o1');
  });

  it('mã RESERVED + restock -> trả về kho (AVAILABLE) và đồng bộ tồn kho', async () => {
    const { service, db, refresh, sync } = revokeSetup('RESERVED');
    await service.revoke('c1', { restock: true }, actor);
    expect(db.digitalCode.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: expect.objectContaining({ status: 'AVAILABLE', orderId: null, orderItemId: null }) });
    expect(sync).toHaveBeenCalledWith('p1');
    expect(refresh).toHaveBeenCalledWith('o1');
  });
});

describe('DigitalCodesService.update', () => {
  const stockRow = { id: 'c1', productId: 'p1', variantId: null, status: 'AVAILABLE', contentHash: 'h', note: null };

  it('đổi trạng thái khi mã vừa bị giữ / giao (updateMany count=0) -> ConflictException', async () => {
    const { service, db } = setup();
    db.digitalCode.findUnique = vi.fn(async () => stockRow);
    db.digitalCode.updateMany = vi.fn(async () => ({ count: 0 }));
    await expect(service.update('c1', { status: 'DISABLED' }, actor)).rejects.toBeInstanceOf(ConflictException);
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', status: { in: ['AVAILABLE', 'DISABLED'] } }, data: { status: 'DISABLED' } });
  });

  it('chỉ sửa ghi chú -> update thường, không kiểm tra trạng thái', async () => {
    const { service, db } = setup();
    db.digitalCode.findUnique = vi.fn(async () => ({ ...stockRow, status: 'SOLD', order: null, createdAt: new Date() }));
    db.digitalCode.update = vi.fn(async () => ({}));
    await service.update('c1', { note: 'ghi chú' }, actor);
    expect(db.digitalCode.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { note: 'ghi chú' } });
    expect(db.digitalCode.updateMany).not.toHaveBeenCalled();
  });
});

describe('bản che preview (shared maskSecret / codePreview)', () => {
  it('email giữ 2 ký tự đầu + tên miền; chuỗi dài chỉ lộ 4 ký tự cuối; phần sau "|" che hết', async () => {
    const { maskSecret, codePreview } = await import('@cmsnt/shared');
    expect(maskSecret('gamer01@gmail.com')).toBe('ga***@gmail.com');
    expect(maskSecret('ABCD-EFGH-IJKL')).toBe('••••IJKL');
    expect(maskSecret('ABC1234')).toBe('••••');
    expect(codePreview('user@x.com | Pass123 | 9999')).toBe('us***@x.com | •••• | ••••');
    expect(codePreview('X'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('DigitalCodesService.list — tìm theo nội dung mã', () => {
  it('chỉ người có quyền digital_codes.reveal mới khớp theo contentHash', async () => {
    const { service, db } = setup();
    db.digitalCode.findMany = vi.fn(async () => []);
    await service.list({ search: 'KEY-1' } as never, { permissions: ['digital_codes.read'] });
    const where1 = db.digitalCode.findMany.mock.calls[0][0].where as { OR: Record<string, unknown>[] };
    expect(where1.OR.some((c) => 'contentHash' in c)).toBe(false);
    await service.list({ search: 'KEY-1' } as never, { permissions: ['digital_codes.read', 'digital_codes.reveal'] });
    const where2 = db.digitalCode.findMany.mock.calls[1][0].where as { OR: Record<string, unknown>[] };
    expect(where2.OR.some((c) => 'contentHash' in c)).toBe(true);
  });
});

describe('DigitalCodesService — mã không giải mã được (đổi khoá)', () => {
  it('chọn từ kho: mã hỏng -> Tạm khoá + ghi chú, cấp mã khác', async () => {
    // lần chọn 1 trả mã hỏng, lần 2 trả mã tốt
    let picks = 0;
    const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
      if (!strings.join('?').includes('digital_codes')) return [];
      picks++;
      return picks === 1 ? [{ id: 'bad', content: BAD_ENC, note: 'lô A' }] : [{ id: 'good', content: ENC(), note: null }];
    });
    const { service, db } = setup({ $queryRaw: queryRaw });
    db.order.findUnique = vi.fn(async () => paidOrder(1));
    db.digitalCode.update = vi.fn(async () => ({}));
    db.digitalCode.findMany = vi.fn(async (args: { where: { id?: unknown } }) => (args.where.id ? [{ id: 'good', productId: 'p1', variantId: null, preview: '***', status: 'SOLD', createdAt: new Date() }] : []));
    vi.spyOn(service, 'syncStock').mockResolvedValue();
    const res = await service.deliverForOrder('o1');
    expect(res).toEqual({ delivered: 1, missing: 0, codeStatus: 'delivered' });
    expect(db.digitalCode.update).toHaveBeenCalledWith({ where: { id: 'bad' }, data: expect.objectContaining({ status: 'DISABLED', note: 'lô A\nKhông giải mã được (sai DIGITAL_CODES_KEY?)' }) });
    expect(db.digitalCode.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['good'] }, status: 'AVAILABLE' }, data: expect.objectContaining({ status: 'SOLD' }) });
    expect(db.digitalCode.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: expect.arrayContaining(['bad']) } }) }));
  });

  it('mã đang giữ không giải mã được -> Tạm khoá, rời đơn, không giao', async () => {
    const { service, db } = setup({ $queryRaw: vi.fn(async () => []) });
    db.order.findUnique = vi.fn(async () => paidOrder(1));
    db.digitalCode.update = vi.fn(async () => ({}));
    db.digitalCode.findMany = vi.fn(async (args: { where: { status?: string; id?: unknown } }) => (args.where.status === 'RESERVED' && 'orderItemId' in args.where ? [{ id: 'held', content: BAD_ENC, note: null }] : []));
    vi.spyOn(service, 'syncStock').mockResolvedValue();
    const res = await service.deliverForOrder('o1');
    expect(res).toEqual({ delivered: 0, missing: 1, codeStatus: 'pending' });
    expect(db.digitalCode.update).toHaveBeenCalledWith({ where: { id: 'held' }, data: expect.objectContaining({ status: 'DISABLED', orderId: null, note: 'Không giải mã được (sai DIGITAL_CODES_KEY?)' }) });
  });
});

describe('DigitalCodesService.onOrderCreated — chỉ giao ngay cho đơn admin', () => {
  it('đơn web đã trả bằng ví (PAID) -> không giao ở đây (order.paid lo)', async () => {
    const { service } = setup();
    const deliver = vi.spyOn(service, 'deliverForOrder').mockResolvedValue({ delivered: 0, missing: 0, codeStatus: null });
    await service.onOrderCreated({ order: { id: 'o1', paymentStatus: 'PAID', source: 'web' } });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('đơn admin tạo đã thanh toán -> giao ngay', async () => {
    const { service } = setup();
    const deliver = vi.spyOn(service, 'deliverForOrder').mockResolvedValue({ delivered: 1, missing: 0, codeStatus: 'delivered' });
    await service.onOrderCreated({ order: { id: 'o1', paymentStatus: 'PAID', source: 'admin' } });
    expect(deliver).toHaveBeenCalledWith('o1', { notify: true });
  });
});

describe('DigitalCodesService.reconcileOrder — đơn chưa thanh toán', () => {
  it('đã giao đủ (admin "Vẫn giao") -> codeStatus delivered thay vì pending', async () => {
    const order = { id: 'o1', status: 'PENDING', paymentStatus: 'UNPAID', codeStatus: 'pending', codesDeliveredAt: null, items: [{ id: 'i1', productId: 'p1', variantId: null, quantity: 1 }] };
    const { service, db } = setup();
    db.order.findUnique = vi.fn(async () => order);
    db.orderItem.findMany = vi.fn(async () => order.items);
    db.digitalCode.count = vi.fn(async () => 1);
    vi.spyOn(service, 'syncStock').mockResolvedValue();
    await service.reconcileOrder('o1');
    expect(db.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: expect.objectContaining({ codeStatus: 'delivered', codesDeliveredAt: expect.any(Date) }) });
  });
});

describe('DigitalCodesService.byOrder — delivered', () => {
  it('đếm SOLD + REVOKED của đúng dòng, bỏ mã thay thế và mã đang giữ', async () => {
    const { service, db } = setup();
    db.order.findUnique = vi.fn(async () => ({ id: 'o1', code: 'DH1', codeStatus: 'delivered', paymentStatus: 'PAID', items: [{ id: 'i1', productId: 'p1', variantId: null, quantity: 2, name: 'Key', optionValues: null, meta: null }] }));
    const base = { productId: 'p1', variantId: null, preview: '***', createdAt: new Date(), order: { code: 'DH1' } };
    db.digitalCode.findMany = vi.fn(async () => [
      { ...base, id: 'a', orderItemId: 'i1', status: 'REVOKED', replacesId: null },
      { ...base, id: 'b', orderItemId: 'i1', status: 'SOLD', replacesId: 'a' },
      { ...base, id: 'c', orderItemId: 'i1', status: 'SOLD', replacesId: null },
      { ...base, id: 'd', orderItemId: 'i1', status: 'RESERVED', replacesId: null },
    ]);
    const res = await service.byOrder('o1');
    expect(res.items[0].delivered).toBe(2);
  });
});

describe('DigitalCodesService — báo lỗi mã (chống spam, bảo hành theo mã gốc)', () => {
  const DAY = 86_400_000;
  /** Dựng service với 1 mã SOLD `row` thuộc đơn đã thanh toán + các mã tổ tiên `ancestors` (chuỗi replacesId) */
  function reportSetup(row: Record<string, unknown>, ancestors: Record<string, unknown>[] = []) {
    const ctx = setup({}, { allowReports: true });
    const full = { id: 'c1', productId: 'p1', variantId: null, status: 'SOLD', content: ENC(), orderId: 'o1', orderItemId: 'i1', soldAt: new Date(), replacesId: null, reportStatus: null, reportNote: null, reportedAt: null, reportReply: null, revokedAt: null, revokeReason: null, expiresAt: null, preview: '***', createdAt: new Date(), ...row };
    ctx.db.digitalCode.findUnique = vi.fn(async () => ({ ...full, order: { id: 'o1', userId: 'u1', code: 'DH1', paymentStatus: 'PAID', locale: 'vi', items: [{ id: 'i1', name: 'Key', optionValues: null }] } }));
    ctx.db.digitalCode.findMany = vi.fn(async (args: { where: { id?: { in: string[] } } }) => ancestors.filter((a) => args.where.id?.in.includes(a.id as string)));
    ctx.db.digitalCode.update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...full, ...data }));
    return { ...ctx, full };
  }

  it('đã bị từ chối (REJECTED) -> không cho báo lại', async () => {
    const { service } = reportSetup({ reportStatus: 'REJECTED' });
    await expect(service.reportMine('u1', 'c1', 'vẫn lỗi')).rejects.toThrow('từ chối');
  });

  it('cả chuỗi đổi mã đã báo 3 lần -> chặn', async () => {
    const { service } = reportSetup({ replacesId: 'a2' }, [
      { id: 'a2', replacesId: 'a1', soldAt: new Date(), reportStatus: 'RESOLVED' },
      { id: 'a1', replacesId: 'a0', soldAt: new Date(), reportStatus: 'RESOLVED' },
      { id: 'a0', replacesId: null, soldAt: new Date(), reportStatus: 'RESOLVED' },
    ]);
    // reportMine kiểm tra chủ đơn qua findUnique (order.userId)
    (service as any).prisma.digitalCode.findUnique = vi.fn(async () => ({ id: 'c1', productId: 'p1', status: 'SOLD', soldAt: new Date(), replacesId: 'a2', reportStatus: null, order: { id: 'o1', userId: 'u1', code: 'DH1', paymentStatus: 'PAID', items: [] } }));
    await expect(service.reportMine('u1', 'c1', 'lỗi nữa')).rejects.toThrow('đã được báo lỗi 3 lần');
  });

  it('mã thay thế: bảo hành tính từ soldAt của mã gốc (đã quá hạn) -> hết bảo hành', async () => {
    const { service } = reportSetup({ replacesId: 'root', soldAt: new Date() }, [{ id: 'root', replacesId: null, soldAt: new Date(Date.now() - 10 * DAY), reportStatus: 'RESOLVED' }]);
    (service as any).prisma.digitalCode.findUnique = vi.fn(async () => ({ id: 'c1', productId: 'p1', status: 'SOLD', soldAt: new Date(), replacesId: 'root', reportStatus: null, order: { id: 'o1', userId: 'u1', code: 'DH1', paymentStatus: 'PAID', items: [] } }));
    await expect(service.reportMine('u1', 'c1', 'mã lỗi')).rejects.toThrow('hết thời hạn bảo hành');
  });

  it('myCodes: warrantyUntil theo mã gốc, canReport=false khi REJECTED', async () => {
    const { service, db } = setup({}, { allowReports: true });
    const rootSold = new Date(Date.now() - 2 * DAY);
    const base = { productId: 'p1', variantId: null, content: ENC(), orderId: 'o1', orderItemId: 'i1', revokeReason: null, expiresAt: null, reportNote: null, reportedAt: null, reportReply: null, viewedAt: new Date(), order: { code: 'DH1', locale: 'vi' }, orderItem: null };
    db.digitalCode.findMany = vi.fn(async (args: { where: { id?: { in: string[] } } }) => {
      if (args.where.id) return [{ id: 'root', replacesId: null, soldAt: rootSold, reportStatus: 'RESOLVED' }];
      return [
        { ...base, id: 'new', status: 'SOLD', soldAt: new Date(), replacesId: 'root', reportStatus: null },
        { ...base, id: 'rej', status: 'SOLD', soldAt: new Date(), replacesId: null, reportStatus: 'REJECTED' },
      ];
    });
    const codes = await service.myCodes('u1');
    const fresh = codes.find((c) => c.id === 'new')!;
    expect(fresh.warrantyUntil).toBe(new Date(rootSold.getTime() + 7 * DAY).toISOString());
    expect(fresh.canReport).toBe(true);
    expect(codes.find((c) => c.id === 'rej')!.canReport).toBe(false);
  });
});
