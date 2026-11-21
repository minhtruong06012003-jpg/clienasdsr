import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chargingwsProvider, mapChargingStatus } from './chargingws.provider.js';
import { CARD_PROVIDERS } from './index.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const cfg = { partnerId: '123', partnerKey: 'secret-key' };
const card = { code: 'NTABC', telco: 'VIETTEL', serial: '10000000000', pin: '1234567890123', amount: 100000 };

describe('chargingws/v2 (Card24h, TheSieuRe...)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('đổi mã trạng thái sang trạng thái chuẩn', () => {
    expect(mapChargingStatus(1)).toBe('SUCCESS');
    expect(mapChargingStatus('2')).toBe('WRONG_VALUE');
    expect(mapChargingStatus(99)).toBe('PENDING');
    expect(mapChargingStatus(3)).toBe('FAILED');
    expect(mapChargingStatus(100)).toBe('FAILED');
  });

  it('callback đúng chữ ký: chuẩn hoá mệnh giá thật, số tiền nhận, mã yêu cầu', () => {
    const p = chargingwsProvider({ key: 'card24h', label: 'Card24h', baseUrl: 'https://card24h.com', method: 'GET' });
    const query = { status: '1', request_id: 'NTABC', value: '100000', declared_value: '100000', amount: '82000', code: card.pin, serial: card.serial, trans_id: 'T1', callback_sign: md5(cfg.partnerKey + card.pin + card.serial) };
    const r = p.parseCallback(cfg, { query, body: {}, headers: {} });
    expect(r).toMatchObject({ valid: true, status: 'SUCCESS', code: 'NTABC', realValue: 100000, providerAmount: 82000, providerRef: 'T1' });
  });

  it('callback POST JSON vẫn đọc được; sai chữ ký thì không hợp lệ', () => {
    const p = chargingwsProvider({ key: 'thesieure', label: 'TSR', baseUrl: 'https://thesieure.com' });
    const body = { status: 3, request_id: 'NTABC', code: card.pin, serial: card.serial, callback_sign: md5(cfg.partnerKey + card.pin + card.serial), message: 'Thẻ lỗi' };
    expect(p.parseCallback(cfg, { query: {}, body, headers: {} })).toMatchObject({ valid: true, status: 'FAILED', message: 'Thẻ lỗi' });
    expect(p.parseCallback(cfg, { query: {}, body: { ...body, callback_sign: 'abc' }, headers: {} }).valid).toBe(false);
    expect(p.parseCallback(cfg, { query: {}, body: { ...body, callback_sign: undefined }, headers: {} }).valid).toBe(false);
  });

  it('gửi thẻ Card24h bằng GET với sign = md5(partner_key + pin + serial)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 99, message: 'PENDING', trans_id: 9 })));
    const p = CARD_PROVIDERS.find((x) => x.key === 'card24h')!;
    const r = await p.submit(cfg, card);
    expect(r.status).toBe('PENDING');
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://card24h.com/chargingws/v2');
    expect(url.searchParams.get('sign')).toBe(md5(cfg.partnerKey + card.pin + card.serial));
    expect(url.searchParams.get('command')).toBe('charging');
    expect(url.searchParams.get('request_id')).toBe('NTABC');
  });

  it('nhà cung cấp "tuỳ chỉnh" dùng tên miền admin nhập, gửi POST form', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 100, data: { msg: 'Sai partner' } })));
    const p = CARD_PROVIDERS.find((x) => x.key === 'chargingws')!;
    expect(p.needsDomain).toBe(true);
    const r = await p.submit({ ...cfg, domain: 'doithe.example.vn/' }, card);
    // 100 = nhà cung cấp không nhận yêu cầu → đánh dấu rejected (không tính là thẻ lỗi của khách)
    expect(r).toMatchObject({ status: 'FAILED', message: 'Sai partner', rejected: true });
    expect(fetchMock.mock.calls[0][0]).toBe('https://doithe.example.vn/chargingws/v2');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('kiểm tra trạng thái gặp "bảo trì" (4) thì vẫn giữ chờ', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ status: 4 })));
    const p = CARD_PROVIDERS.find((x) => x.key === 'card24h')!;
    expect((await p.check!(cfg, card)).status).toBe('PENDING');
    expect((await p.submit(cfg, card)).status).toBe('FAILED');
  });

  it('kiểm tra trả 100 (không tìm thấy giao dịch) → lỗi phía hệ thống, không phải thẻ lỗi', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ status: 100, message: 'Không tìm thấy' })));
    const p = CARD_PROVIDERS.find((x) => x.key === 'card24h')!;
    expect(await p.check!(cfg, card)).toMatchObject({ status: 'FAILED', rejected: true });
  });
});
