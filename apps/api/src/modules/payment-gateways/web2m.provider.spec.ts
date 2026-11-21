import { web2mProvider } from './web2m.provider.js';
import type { GatewayDeps } from './payment-utils.js';

/** Cổng Web2M với cấu hình giả (không cần DB) */
const make = (cfg: Record<string, unknown>) => web2mProvider({ settings: { get: async () => cfg }, prisma: {} } as unknown as GatewayDeps);
const cfg = { enabled: true, bank: 'MB', accountNumber: '0123456789', token: 'secret-token' };
const body = {
  status: true,
  data: [
    // dạng đúng như tài liệu Web2M: id / transactionID / amount đều là chuỗi
    { id: '753632', type: 'IN', transactionID: '24213', amount: '100000', description: 'NAPAB12CD34 GD 941234-010624 16:56:30', date: '01/04/2024', bank: 'ACB' },
    { id: '753633', type: 'OUT', transactionID: '24212', amount: '300000', description: 'chi tien', date: '01/04/2024', bank: 'ACB' },
  ],
};

describe('Web2M webhook', () => {
  it('sai hoặc thiếu Bearer token -> 401', async () => {
    const p = make(cfg);
    expect((await p.handleWebhook({ headers: {}, body, query: {} })).statusCode).toBe(401);
    expect((await p.handleWebhook({ headers: { authorization: 'Bearer sai' }, body, query: {} })).valid).toBe(false);
  });

  it('chỉ lấy giao dịch tiền vào, chống trùng theo id, trả {status:true}', async () => {
    const r = await make(cfg).handleWebhook({ headers: { authorization: 'Bearer secret-token' }, body, query: {} });
    expect(r.valid).toBe(true);
    expect(r.response).toEqual({ status: true, msg: 'Ok' });
    expect(r.payments).toEqual([expect.objectContaining({ transferContent: 'NAPAB12CD34 GD 941234-010624 16:56:30', amount: 100000, reference: '24213', txnId: 'w2m:753632' })]);
  });

  it('chưa cấu hình token thì không nhận webhook', async () => {
    const r = await make({ ...cfg, token: '' }).handleWebhook({ headers: { authorization: 'Bearer ' }, body, query: {} });
    expect(r.valid).toBe(false);
    expect(await make({ ...cfg, token: '' }).isConfigured()).toBe(false);
  });
});

describe('Web2M tạo giao dịch', () => {
  it('dựng VietQR vào tài khoản cấu hình, nội dung CK = mã nạp ví', async () => {
    const r = await make({ ...cfg, accountName: 'NGUYEN VAN A' }).createPayment({ order: { code: 'NAPAB12CD34' }, amount: 50000 } as never);
    expect(r.transferContent).toBe('NAPAB12CD34');
    expect(r.qrImageUrl).toBe('https://img.vietqr.io/image/MB-0123456789-compact2.png?amount=50000&addInfo=NAPAB12CD34&accountName=NGUYEN+VAN+A');
    expect(r.bank).toEqual({ bankName: 'MB', accountNumber: '0123456789', accountName: 'NGUYEN VAN A' });
  });
});
