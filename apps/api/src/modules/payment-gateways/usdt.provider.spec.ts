import { afterEach, vi } from 'vitest';
import { usdtProvider, usdtToVnd, vndToUsdt } from './usdt.provider.js';
import type { GatewayDeps } from './payment-utils.js';

/** Cổng USDT với cấu hình giả + một giao dịch giả trong "DB" (request_id = 123) */
const cfg = { enabled: true, endpoint: 'https://gw.test/', merchantId: 'M1', apiKey: 'K1', rate: 25000, minUsdt: 1 };
const tx = { id: 't1', amount: 100000, providerOrderCode: '123', rawResponse: { usdt: { transId: 'TX1', amount: 4, payAmount: '4.012', rate: 25000, currency: 'USDT' } } };
const make = () =>
  usdtProvider({
    settings: { get: async () => cfg },
    prisma: { paymentTransaction: { findUnique: async ({ where }: { where: { provider_providerOrderCode: { providerOrderCode: string } } }) => (where.provider_providerOrderCode.providerOrderCode === '123' ? tx : null) } },
  } as unknown as GatewayDeps);
const callback = { request_id: '123', trans_id: 'TX1', merchant_id: 'M1', api_key: 'K1', amount: '4', received: '4.012', status: 'completed' };

/** Giả lập GetInvoiceStatus trả trạng thái / số USDT nhận */
const mockStatus = (status: string, received: string) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'success', data: { trans_id: 'TX1', request_id: '123', amount: '4', received, status } })));

afterEach(() => vi.restoreAllMocks());

describe('USDT quy đổi', () => {
  it('VND -> USDT làm tròn lên 2 chữ số', () => {
    expect(vndToUsdt(100000, 25000)).toBe(4);
    expect(vndToUsdt(100001, 25000)).toBe(4.01);
  });
  it('nhận đủ (kể cả phần lẻ gateway cộng thêm) -> đúng số VND giao dịch; thiếu -> quy đổi theo tỉ giá', () => {
    expect(usdtToVnd(4.012, { amount: 4, rate: 25000 }, 100000)).toBe(100000);
    expect(usdtToVnd(3, { amount: 4, rate: 25000 }, 100000)).toBe(75000);
  });
});

describe('USDT callback', () => {
  it('sai api_key -> 401', async () => {
    const r = await make().handleWebhook({ headers: {}, body: {}, query: { ...callback, api_key: 'sai' } });
    expect(r.statusCode).toBe(401);
    expect(r.valid).toBe(false);
  });

  it('completed: hỏi lại gateway rồi ghi nhận đúng số VND', async () => {
    const f = mockStatus('completed', '4.012');
    const r = await make().handleWebhook({ headers: {}, body: {}, query: callback });
    expect(f).toHaveBeenCalledWith('https://gw.test/api/GetInvoiceStatus', expect.anything());
    expect(r).toMatchObject({ valid: true, success: true, providerOrderCode: '123', amount: 100000, txnId: 'usdt:TX1' });
  });

  it('callback báo completed nhưng gateway chưa completed -> không ghi nhận', async () => {
    mockStatus('waiting', '0');
    const r = await make().handleWebhook({ headers: {}, body: {}, query: callback });
    expect(r.success).toBe(false);
  });

  it('trans_id không khớp hoá đơn đã tạo -> không ghi nhận', async () => {
    const r = await make().handleWebhook({ headers: {}, body: {}, query: { ...callback, trans_id: 'TX9' } });
    expect(r.success).toBe(false);
  });

  it('expired -> bỏ qua, vẫn trả 200', async () => {
    const r = await make().handleWebhook({ headers: {}, body: {}, query: { ...callback, status: 'expired' } });
    expect(r).toMatchObject({ valid: true, success: false, statusCode: 200 });
  });

  it('fetchStatus: nhận đủ -> PAID, nhận thiếu -> PENDING, hết hạn -> EXPIRED', async () => {
    const p = make();
    mockStatus('completed', '4.012');
    expect(await p.fetchStatus!(tx as never)).toBe('PAID');
    vi.restoreAllMocks();
    mockStatus('completed', '3');
    expect(await p.fetchStatus!(tx as never)).toBe('PENDING');
    vi.restoreAllMocks();
    mockStatus('expired', '0');
    expect(await p.fetchStatus!(tx as never)).toBe('EXPIRED');
  });
});
