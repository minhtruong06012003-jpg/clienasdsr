/**
 * Test thuần (không gọi mạng) cho các adapter hãng vận chuyển:
 * ánh xạ trạng thái, dựng payload tạo đơn, chữ ký webhook, đọc webhook và meta của BUILTIN_CARRIERS.
 */
import { createHash } from 'node:crypto';
import type { CarrierConfig, CreateShipmentRequest } from './carrier.interface.js';
import { BUILTIN_CARRIERS } from './index.js';
import { buildGhnOrder, GhnCarrier, ghnRequiredNote, mapGhnStatus } from './ghn.carrier.js';
import { buildGhtkOrder, GhtkCarrier, mapGhtkStatus } from './ghtk.carrier.js';
import { buildViettelPostOrder, mapViettelPostStatus, vtpOrderPayment } from './viettelpost.carrier.js';
import { mapGoshipStatus, verifyGoshipHmac } from './goship.carrier.js';
import { NinjaVanCarrier, signNinjaVan, verifyNinjaVanHmac } from './ninjavan.carrier.js';
import { jtDigest } from './jt.carrier.js';
import { mapAhamoveStatus } from './ahamove.carrier.js';
import { hmacSha256Base64, parseDate, parseEstimatedDays, phoneVN, toKg } from './http.js';

const cfg = (extra: Record<string, unknown> = {}): CarrierConfig => ({ environment: 'sandbox', ...extra });

/** Request tạo đơn mẫu dùng chung */
const sample: CreateShipmentRequest = {
  orderCode: 'DH-1001',
  shipmentId: 'ship_1',
  service: '2',
  payer: 'shop',
  allowInspection: 'allow',
  note: 'Gọi trước khi giao',
  from: { name: 'Shop A', phone: '0912345678', line1: '12 Lê Lợi', provinceCode: 'VN-HN', provinceName: 'Hà Nội', districtName: 'Quận Hai Bà Trưng', wardName: 'Phường Bạch Mai', carrierCodes: { ghn: { province: '201', district: '1442', ward: '21211' }, viettelpost: { province: '1', district: '4', ward: '10' } } },
  to: { name: 'Nguyễn B', phone: '+84987654321', line1: '45 Nguyễn Huệ', provinceCode: 'VN-SG', provinceName: 'Hồ Chí Minh', districtName: 'Quận 1', wardName: 'Phường Bến Nghé', carrierCodes: { ghn: { province: '202', district: '1442', ward: '20109' }, viettelpost: { province: '2', district: '43', ward: '500' } } },
  parcel: {
    weight: 1200,
    length: 20,
    width: 15,
    height: 10,
    value: 1_000_000,
    codAmount: 500_000,
    items: [
      { name: 'Áo thun', quantity: 2, weight: 300, price: 250_000, sku: 'AO-01' },
      { name: 'Quần jean', quantity: 1, weight: 600, price: 500_000 },
    ],
  },
};

describe('shipping carriers: ánh xạ trạng thái', () => {
  it('GHN', () => {
    expect(mapGhnStatus('ready_to_pick')).toBe('PENDING');
    expect(mapGhnStatus('picking')).toBe('PICKING');
    expect(mapGhnStatus('storing')).toBe('PICKED');
    expect(mapGhnStatus('delivering')).toBe('DELIVERING');
    expect(mapGhnStatus('delivered')).toBe('DELIVERED');
    expect(mapGhnStatus('delivery_fail')).toBe('FAILED');
    expect(mapGhnStatus('return_transporting')).toBe('RETURNING');
    expect(mapGhnStatus('returned')).toBe('RETURNED');
    expect(mapGhnStatus('cancel')).toBe('CANCELLED');
    expect(mapGhnStatus('lost')).toBe('FAILED');
    expect(mapGhnStatus('unknown_xyz')).toBe('PENDING');
  });

  it('GHTK', () => {
    expect(mapGhtkStatus(-1)).toBe('CANCELLED');
    expect(mapGhtkStatus('2')).toBe('PENDING');
    expect(mapGhtkStatus(12)).toBe('PICKING');
    expect(mapGhtkStatus(3)).toBe('PICKED');
    expect(mapGhtkStatus(4)).toBe('DELIVERING');
    expect(mapGhtkStatus(9)).toBe('FAILED');
    expect(mapGhtkStatus(5)).toBe('DELIVERED');
    expect(mapGhtkStatus(6)).toBe('DELIVERED');
    expect(mapGhtkStatus(20)).toBe('RETURNING');
    expect(mapGhtkStatus(21)).toBe('RETURNED');
    expect(mapGhtkStatus(13)).toBe('FAILED');
  });

  it('Viettel Post (có suy theo nhóm trăm cho mã lạ)', () => {
    expect(mapViettelPostStatus(-100)).toBe('PENDING');
    expect(mapViettelPostStatus(103)).toBe('PICKING');
    expect(mapViettelPostStatus(200)).toBe('PICKED');
    expect(mapViettelPostStatus(500)).toBe('DELIVERING');
    expect(mapViettelPostStatus(501)).toBe('DELIVERED');
    expect(mapViettelPostStatus(505)).toBe('RETURNING');
    expect(mapViettelPostStatus(504)).toBe('RETURNED');
    expect(mapViettelPostStatus(107)).toBe('CANCELLED');
    expect(mapViettelPostStatus(506)).toBe('FAILED');
    expect(mapViettelPostStatus(320)).toBe('PICKED');
    expect(mapViettelPostStatus(105)).toBe('PICKING');
    expect(vtpOrderPayment(500_000, 'shop')).toBe(3);
    expect(vtpOrderPayment(500_000, 'customer')).toBe(2);
    expect(vtpOrderPayment(0, 'shop')).toBe(1);
    expect(vtpOrderPayment(0, 'customer')).toBe(4);
  });

  it('GoShip', () => {
    expect(mapGoshipStatus(900)).toBe('PENDING');
    expect(mapGoshipStatus('903')).toBe('PICKING');
    expect(mapGoshipStatus(904)).toBe('PICKED');
    expect(mapGoshipStatus(905)).toBe('DELIVERING');
    expect(mapGoshipStatus(906)).toBe('DELIVERED');
    expect(mapGoshipStatus(910)).toBe('DELIVERED');
    expect(mapGoshipStatus(907)).toBe('FAILED');
    expect(mapGoshipStatus(908)).toBe('RETURNING');
    expect(mapGoshipStatus(909)).toBe('RETURNED');
    expect(mapGoshipStatus(911)).toBe('CANCELLED');
    expect(mapGoshipStatus(1000)).toBe('FAILED');
  });

  it('Ahamove (status + sub_status)', () => {
    expect(mapAhamoveStatus('ASSIGNING')).toBe('PENDING');
    expect(mapAhamoveStatus('ACCEPTED', 'BOARDED')).toBe('PICKING');
    expect(mapAhamoveStatus('IN PROCESS')).toBe('DELIVERING');
    expect(mapAhamoveStatus('IN PROCESS', 'IN_RETURN')).toBe('RETURNING');
    expect(mapAhamoveStatus('COMPLETED')).toBe('DELIVERED');
    expect(mapAhamoveStatus('CANCELLED')).toBe('CANCELLED');
  });
});

describe('shipping carriers: tiện ích chung', () => {
  it('đổi đơn vị và parse ngày', () => {
    expect(toKg(1200)).toBe(1.2);
    expect(toKg(5)).toBe(0.01);
    expect(phoneVN('+84 987 654 321')).toBe('0987654321');
    expect(phoneVN('0912345678', true)).toBe('+84912345678');
    expect(parseDate('05/10/2026 10:30:00')?.toISOString()).toBe('2026-10-05T03:30:00.000Z');
    expect(parseDate(1_760_000_000)?.getTime()).toBe(1_760_000_000_000);
    expect(parseDate('rác')).toBeNull();
    expect(parseEstimatedDays('48 giờ')).toBe(2);
    expect(parseEstimatedDays('Dự kiến giao 2 ngày')).toBe(2);
    expect(parseEstimatedDays('')).toBeNull();
  });
});

describe('shipping carriers: dựng payload tạo đơn', () => {
  it('GHN: mã quận/phường, required_note, payment_type, items', () => {
    const body = buildGhnOrder(cfg({ token: 'x', shopId: '1', insure: true }), sample);
    expect(body.client_order_code).toBe('DH-1001');
    expect(body.to_district_id).toBe(1442);
    expect(body.to_ward_code).toBe('20109');
    expect(body.to_phone).toBe('0987654321');
    expect(body.from_district_id).toBe(1442);
    expect(body.service_type_id).toBe(2);
    expect(body.payment_type_id).toBe(1);
    expect(body.required_note).toBe('CHOXEMHANGKHONGTHU');
    expect(body.cod_amount).toBe(500_000);
    expect(body.insurance_value).toBe(1_000_000);
    expect(body.weight).toBe(1200);
    expect((body.items as unknown[]).length).toBe(2);
    expect(body.is_new_to_address).toBeUndefined();
    // người nhận trả phí + không cho xem hàng
    const b2 = buildGhnOrder(cfg({ useNewAddress: true }), { ...sample, payer: 'customer', allowInspection: 'deny' });
    expect(b2.payment_type_id).toBe(2);
    expect(b2.required_note).toBe('KHONGCHOXEMHANG');
    expect(b2.is_new_to_address).toBe(true);
    expect(b2.to_district_id).toBeUndefined();
    expect(ghnRequiredNote('try')).toBe('CHOTHUHANG');
  });

  it('GHTK: cân nặng kg, tên địa chỉ, is_freeship, pick_money', () => {
    const { products, order } = buildGhtkOrder(cfg({ token: 'x', pickAddressId: '99' }), { ...sample, service: 'xteam' });
    expect(products).toHaveLength(2);
    expect(products[0].weight).toBe(0.3);
    expect(products[1].weight).toBe(0.6);
    expect(order.id).toBe('DH-1001');
    expect(order.province).toBe('Hồ Chí Minh');
    expect(order.district).toBe('Quận 1');
    expect(order.ward).toBe('Phường Bến Nghé');
    expect(order.pick_province).toBe('Hà Nội');
    expect(order.pick_address_id).toBe('99');
    expect(order.tel).toBe('0987654321');
    expect(order.is_freeship).toBe(1);
    expect(order.pick_money).toBe(500_000);
    expect(order.value).toBe(1_000_000);
    expect(order.deliver_option).toBe('xteam');
    expect(order.transport).toBe('road');
    expect(buildGhtkOrder(cfg(), { ...sample, payer: 'customer' }).order.is_freeship).toBe(0);
  });

  it('Viettel Post: trường UPPERCASE, ORDER_PAYMENT, LIST_ITEM', () => {
    const body = buildViettelPostOrder(cfg({ groupAddressId: '123', cusId: '456', defaultService: 'VCN' }), { ...sample, service: '' }, 35_000);
    expect(body.ORDER_NUMBER).toBe('DH-1001');
    expect(body.GROUPADDRESS_ID).toBe(123);
    expect(body.SENDER_PROVINCE).toBe(1);
    expect(body.RECEIVER_DISTRICT).toBe(43);
    expect(body.PRODUCT_WEIGHT).toBe(1200);
    expect(body.ORDER_SERVICE).toBe('VCN');
    expect(body.ORDER_PAYMENT).toBe(3);
    expect(body.MONEY_COLLECTION).toBe(500_000);
    expect(body.MONEY_TOTAL).toBe(35_000);
    expect(body.LIST_ITEM).toHaveLength(2);
    expect(String(body.DELIVERY_DATE)).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('shipping carriers: chữ ký webhook', () => {
  const secret = 'client-secret-123';
  const body = JSON.stringify({ tracking_id: 'NVVN123', status: 'Successful Delivery' });

  it('Ninja Van HMAC round-trip', () => {
    const sig = signNinjaVan(body, secret);
    expect(sig).toBe(hmacSha256Base64(body, secret));
    expect(verifyNinjaVanHmac(body, secret, sig)).toBe(true);
    expect(verifyNinjaVanHmac(body, secret, `${sig}x`)).toBe(false);
    expect(verifyNinjaVanHmac(`${body} `, secret, sig)).toBe(false);
    expect(verifyNinjaVanHmac(body, '', sig)).toBe(false);
  });

  it('GoShip HMAC chấp nhận base64 hoặc hex', () => {
    const b64 = hmacSha256Base64(body, secret);
    expect(verifyGoshipHmac(body, secret, b64)).toBe(true);
    const hex = Buffer.from(b64, 'base64').toString('hex');
    expect(verifyGoshipHmac(body, secret, hex)).toBe(true);
    expect(verifyGoshipHmac(body, 'khac', b64)).toBe(false);
    expect(verifyGoshipHmac(body, secret, null)).toBe(false);
  });

  it('J&T data_digest = base64(md5(json + key))', () => {
    const raw = jtDigest('abc', 'key', 'raw');
    expect(raw).toBe(createHash('md5').update('abckey').digest('base64'));
    expect(Buffer.from(raw, 'base64')).toHaveLength(16);
    expect(Buffer.from(jtDigest('abc', 'key', 'hex'), 'base64')).toHaveLength(32);
  });

  it('Ninja Van parseWebhook từ chối chữ ký sai, nhận chữ ký đúng', async () => {
    const nv = new NinjaVanCarrier();
    const c = cfg({ clientId: 'id', clientSecret: secret });
    expect(await nv.parseWebhook!(c, { headers: { 'x-ninjavan-hmac-sha256': 'sai' }, body: JSON.parse(body), rawBody: body })).toBeNull();
    const ok = await nv.parseWebhook!(c, { headers: { 'X-Ninjavan-Hmac-Sha256': signNinjaVan(body, secret) }, body: JSON.parse(body), rawBody: body });
    expect(ok?.[0]).toMatchObject({ trackingCode: 'NVVN123', status: 'DELIVERED' });
  });
});

describe('shipping carriers: đọc webhook', () => {
  it('GHN: payload PascalCase', async () => {
    const ghn = new GhnCarrier();
    const payload = { ShopID: 1, Time: '2026-10-05T10:00:00+07:00', OrderCode: 'LADT8L', ClientOrderCode: 'DH-1001', Type: 'switch_status', Status: 'delivered', Description: 'Giao thành công', Reason: '', CODAmount: 500000, CODTransferDate: null, TotalFee: 32000, Warehouse: 'Kho Q1' };
    const events = await ghn.parseWebhook!(cfg(), { headers: {}, body: payload });
    expect(events).toHaveLength(1);
    expect(events![0]).toMatchObject({ trackingCode: 'LADT8L', status: 'DELIVERED', statusCode: 'delivered', fee: 32000, location: 'Kho Q1' });
    expect(events![0].at.toISOString()).toBe('2026-10-05T03:00:00.000Z');
    expect(await ghn.parseWebhook!(cfg(), { headers: {}, body: { Type: 'create' } })).toBeNull();
  });

  it('GHTK: form-urlencoded và JSON', async () => {
    const ghtk = new GhtkCarrier();
    const form = 'partner_id=DH-1001&label_id=S1.A1.2001297581&status_id=5&action_time=2026-10-06T09%3A00%3A00%2B07%3A00&reason_code=&reason=&weight=1.2&fee=25000&pick_money=500000';
    const ev = await ghtk.parseWebhook!(cfg(), { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, rawBody: form });
    expect(ev![0]).toMatchObject({ trackingCode: 'S1.A1.2001297581', status: 'DELIVERED', statusCode: '5', fee: 25000, codCollected: 500000 });
    const json = await ghtk.parseWebhook!(cfg(), { headers: {}, body: { label_id: 'S1.X', status_id: -1, reason: 'Khách huỷ', action_time: '2026-10-06 09:00:00' } });
    expect(json![0]).toMatchObject({ status: 'CANCELLED', message: 'Khách huỷ' });
    expect(await ghtk.parseWebhook!(cfg(), { headers: {}, body: { foo: 1 } })).toBeNull();
  });
});

describe('shipping carriers: BUILTIN_CARRIERS', () => {
  it('đủ key theo thứ tự và không trùng', () => {
    const keys = BUILTIN_CARRIERS.map((c) => c.meta.key);
    expect(keys).toEqual(['ghn', 'ghtk', 'viettelpost', 'goship', 'ahamove', 'vnpost', 'ninjavan', 'jt', 'best', 'supership', 'manual']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('meta đầy đủ: tên, mô tả, field required có label, capabilities khớp phương thức', () => {
    for (const c of BUILTIN_CARRIERS) {
      expect(c.meta.name.length).toBeGreaterThan(0);
      expect(c.meta.description.length).toBeGreaterThan(0);
      expect([2, 3, undefined]).toContain(c.meta.addressLevels);
      const fieldKeys = c.meta.fields.map((f) => f.key);
      expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
      for (const f of c.meta.fields) {
        expect(f.label.trim().length, `${c.meta.key}.${f.key}`).toBeGreaterThan(0);
        if (f.required) expect(f.type, `${c.meta.key}.${f.key}`).toBeTruthy();
      }
      if (c.meta.capabilities.locations) expect(typeof c.listLocations, c.meta.key).toBe('function');
      if (c.meta.capabilities.label) expect(typeof c.getLabel, c.meta.key).toBe('function');
      if (c.meta.capabilities.webhook) expect(typeof c.parseWebhook, c.meta.key).toBe('function');
    }
  });
});
