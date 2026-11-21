/**
 * Adapter J&T Express Việt Nam — Open API dạng `logistics_interface` (tin cậy C: tài liệu https://api-docs.jtexpress.vn
 * không đọc được trực tiếp, dựng theo trích đoạn tài liệu + tài liệu đối tác; PHẢI kiểm chứng khi có hợp đồng).
 *
 * - Yêu cầu ký hợp đồng với J&T để được cấp: API key (khoá ký), customerid, eccompanyid, URL (test/production).
 * - Request: POST application/x-www-form-urlencoded với `logistics_interface` (JSON), `data_digest` = base64(md5(json + key)),
 *   `msg_type` (ORDERCREATE | ORDERCANCEL | TRACKQUERY), `eccompanyid`.
 * - Địa chỉ: TÊN (prov / city / area). Cân nặng KG.
 * - Không có API tính phí xác nhận được -> capabilities.rates = false (phí cố định tuỳ chọn).
 */
import type { CancelShipmentResult, CarrierAddress, CarrierConfig, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, NormalizedShipmentStatus, RateQuote, ShipmentEvent, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, extractMessage, fold, formEncode, int, md5Base64Raw, md5Hex, parseDate, phoneVN, safeEqual, str, toKg, vnd } from './http.js';

const URLS = { sandbox: 'http://47.57.106.86/yuenan-interface-web/order/orderAction!createOrder.action', production: '' };

/** Chữ ký J&T: base64(md5 raw) mặc định; một số tài liệu dùng base64(md5 hex) -> `mode` = 'hex' */
export function jtDigest(json: string, key: string, mode: 'raw' | 'hex' = 'raw'): string {
  return mode === 'hex' ? Buffer.from(md5Hex(json + key), 'utf8').toString('base64') : md5Base64Raw(json + key);
}

/** scantype / desc tiếng Việt -> chuẩn (so khớp từ khoá, cần đối chiếu bảng gốc) */
export function mapJtStatus(scanType: unknown): NormalizedShipmentStatus {
  const s = fold(scanType);
  if (!s) return 'PENDING';
  if (s.includes('huy')) return 'CANCELLED';
  if (s.includes('hoan hang thanh cong') || s.includes('da hoan') || s.includes('hoan thanh cong')) return 'RETURNED';
  if (s.includes('hoan') || s.includes('tra hang') || s.includes('return')) return 'RETURNING';
  if (s.includes('giao hang thanh cong') || s.includes('ky nhan') || s.includes('da giao') || s.includes('delivered')) return 'DELIVERED';
  if (s.includes('that bai') || s.includes('khong thanh cong') || s.includes('fail')) return 'FAILED';
  if (s.includes('dang giao') || s.includes('dang phat') || s.includes('delivering')) return 'DELIVERING';
  if (s.includes('lay hang') || s.includes('nhap kho') || s.includes('xuat kho') || s.includes('van chuyen') || s.includes('pickup') || s.includes('transit')) return 'PICKED';
  if (s.includes('dang lay') || s.includes('phan cong')) return 'PICKING';
  return 'PENDING';
}

/** Body JSON ORDERCREATE (export để test) */
export function buildJtOrder(cfg: CarrierConfig, req: CreateShipmentRequest): Record<string, unknown> {
  const party = (a: CarrierAddress) => ({ name: clip(a.name, 100), phone: phoneVN(a.phone), prov: a.provinceName ?? '', city: a.districtName ?? '', area: a.wardName ?? '', address: clip(addressLine(a), 200) });
  const items = req.parcel.items.length ? req.parcel.items : [{ name: 'Hàng hoá', quantity: 1, price: req.parcel.value }];
  const cod = vnd(req.parcel.codAmount);
  return {
    actiontype: 'add',
    environment: cfg.environment === 'production' ? 'pro' : 'test',
    eccompanyid: str(cfg.eccompanyid),
    customerid: str(cfg.customerid),
    txlogisticid: clip(req.orderCode, 50),
    ordertype: 1,
    servicetype: Number(req.service) || Number(cfg.serviceType) || 1,
    deliverytype: 1,
    sender: party(req.from),
    receiver: party(req.to),
    items: items.map((i) => ({ itemname: clip(i.name, 100), number: int(i.quantity, 1), itemvalue: vnd(i.price) })),
    weight: toKg(req.parcel.weight),
    volume: int(req.parcel.length, 0) * int(req.parcel.width, 0) * int(req.parcel.height, 0) || undefined,
    totalquantity: items.reduce((s, i) => s + int(i.quantity, 1), 0),
    goodsvalue: vnd(req.parcel.value),
    itemsvalue: cod,
    // PP_PM: shop thanh toán cuối tháng; PP_CASH: người gửi trả; CC_CASH: người nhận trả
    paytype: req.payer === 'customer' ? 'CC_CASH' : str(cfg.payType, 'PP_PM'),
    remark: clip([req.note, req.allowInspection === 'deny' ? 'Không cho xem hàng' : ''].filter(Boolean).join('. '), 200),
    isInsured: cfg.insure !== false ? 1 : 0,
  };
}

export class JtCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'jt',
    name: 'J&T Express',
    description: 'J&T Express Việt Nam (Open API theo hợp đồng): tạo đơn, tra hành trình, huỷ đơn, webhook ký MD5. Chưa xác minh với tài liệu gốc — cần kiểm thử với tài khoản thật.',
    website: 'https://jtexpress.vn',
    docsUrl: 'https://api-docs.jtexpress.vn',
    fields: [
      { key: 'eccompanyid', label: 'Mã nguồn khách (eccompanyid / API account)', type: 'text', required: true, help: 'Do J&T cấp sau khi ký hợp đồng, vd CUSMODEL.' },
      { key: 'customerid', label: 'Mã khách hàng (customerid)', type: 'text', required: true, placeholder: '084LC012345' },
      { key: 'privateKey', label: 'API key (khoá ký)', type: 'password', required: true, help: 'Dùng ký data_digest = base64(md5(json + key)).' },
      { key: 'password', label: 'Mật khẩu tài khoản (nếu hãng yêu cầu)', type: 'password' },
      { key: 'digestMode', label: 'Cách tính data_digest', type: 'select', default: 'raw', options: [{ value: 'raw', label: 'base64(md5 raw 16 byte) — PHP md5(…, true)' }, { value: 'hex', label: 'base64(md5 hex 32 ký tự)' }], help: 'Tài liệu J&T không thống nhất; nếu bị báo sai chữ ký hãy đổi cách còn lại.' },
      { key: 'serviceType', label: 'Loại dịch vụ mặc định', type: 'text', default: '1', help: '1 = EZ (tiêu chuẩn); mã khác theo hợp đồng.' },
      { key: 'payType', label: 'Hình thức thanh toán cước', type: 'select', default: 'PP_PM', options: [{ value: 'PP_PM', label: 'Shop thanh toán cuối tháng (PP_PM)' }, { value: 'PP_CASH', label: 'Người gửi trả tiền mặt (PP_CASH)' }] },
      { key: 'insure', label: 'Mua bảo hiểm (isInsured)', type: 'boolean', default: false },
      { key: 'flatFee', label: 'Phí hiển thị ở checkout (VND)', type: 'number', default: 0, help: 'J&T không trả phí khi tạo đơn; nhập phí theo hợp đồng (0 = không báo giá).' },
      { key: 'sandboxUrl', label: 'URL API test', type: 'url', env: 'sandbox', default: URLS.sandbox, help: 'URL test ghi trong tài liệu J&T; có thể thay đổi.' },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', required: true, help: 'Do J&T cấp, dạng https://<host>/yuenan-interface-web/order/orderAction!createOrder.action' },
    ],
    capabilities: { rates: true, services: false, leadtime: false, create: true, track: true, cancel: true, label: false, webhook: true, locations: false, testConnection: false },
    addressLevels: 3,
    notes: [
      'Mức tin cậy C: endpoint, tên trường và bảng scantype dựng theo trích đoạn tài liệu — phải đối chiếu với tài liệu J&T cấp kèm hợp đồng trước khi dùng thật.',
      'Không có sandbox tự đăng ký; không có API in nhãn (in trên https://vip.jtexpress.vn). Chỉ huỷ được trước khi lấy hàng.',
      'Webhook do J&T push tới URL gửi cho nhân viên kinh doanh; payload form có logistics_interface + data_digest, hệ thống kiểm chữ ký bằng API key. Nếu không ký hợp đồng trực tiếp, dùng GoShip (jnt/jnt2).',
    ],
  };

  private url(cfg: CarrierConfig) {
    const u = baseUrl(cfg, URLS);
    if (!u) throw new ShippingCarrierError('Chưa cấu hình URL API J&T (do hãng cấp theo hợp đồng).');
    return u;
  }

  /** Gọi API J&T: form-urlencoded + chữ ký */
  private async api<T = unknown>(cfg: CarrierConfig, msgType: string, payload: Record<string, unknown>, what: string): Promise<T> {
    const json = JSON.stringify(payload);
    const form = formEncode({ logistics_interface: json, data_digest: jtDigest(json, str(cfg.privateKey), str(cfg.digestMode) === 'hex' ? 'hex' : 'raw'), msg_type: msgType, eccompanyid: str(cfg.eccompanyid) });
    const res = await call<T>(this.url(cfg), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, timeoutMs: 30_000 }, what);
    if (!res.ok) throw new ShippingCarrierError(`${what} thất bại (HTTP ${res.status}): ${extractMessage(res.data) || res.text?.slice(0, 200)}`, res.data, res.status >= 500);
    return res.data;
  }

  /** Lấy phần tử đầu của responseitems, kiểm `success` */
  private firstItem(data: unknown, what: string): Record<string, unknown> {
    const items = (data as { responseitems?: Record<string, unknown>[] })?.responseitems;
    const it = Array.isArray(items) ? items[0] : (data as Record<string, unknown>);
    if (!it) throw new ShippingCarrierError(`${what}: J&T không trả về dữ liệu`, data);
    if (String(it.success) === 'false') throw new ShippingCarrierError(`${what} thất bại: ${str(it.reason) || 'J&T từ chối'}`, data);
    return it;
  }

  async testConnection(): Promise<CarrierTestResult> {
    return { ok: false, message: 'J&T không có API kiểm tra kết nối; hãy tạo một đơn thử trên môi trường test.' };
  }

  async getRates(cfg: CarrierConfig): Promise<RateQuote[]> {
    const fee = vnd(cfg.flatFee);
    if (fee <= 0) return [];
    return [{ carrier: 'jt', serviceCode: str(cfg.serviceType, '1'), serviceName: 'J&T Express', fee, estimatedDays: null }];
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = buildJtOrder(cfg, req);
    const data = await this.api(cfg, 'ORDERCREATE', body, 'Tạo đơn J&T');
    const it = this.firstItem(data, 'Tạo đơn J&T');
    const mailno = str(it.mailno ?? it.billcode);
    if (!mailno) throw new ShippingCarrierError('J&T không trả về mã vận đơn (mailno)', data);
    return { trackingCode: mailno, carrierOrderId: str(it.txlogisticid) || mailno, fee: vnd(cfg.flatFee), serviceName: 'J&T Express', trackingUrl: this.trackingUrl(cfg, { id: req.shipmentId, trackingCode: mailno }), status: 'PENDING', raw: data };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã J&T');
    const data = await this.api(cfg, 'TRACKQUERY', { billcode: ref.trackingCode, lang: 'vi' }, 'Tra hành trình J&T');
    const it = this.firstItem(data, 'Tra hành trình J&T');
    const details = Array.isArray(it.details) ? (it.details as Record<string, unknown>[]) : [];
    const events: ShipmentEvent[] = details
      .map((d) => ({ status: mapJtStatus(`${str(d.scantype)} ${str(d.desc)}`), statusCode: str(d.scantype) || null, message: str(d.desc) || null, location: str(d.city ?? d.scanname) || null, at: parseDate(d.scantime) ?? new Date() }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const last = events[events.length - 1];
    return { status: last?.status ?? 'PENDING', statusCode: last?.statusCode ?? null, message: last?.message ?? null, events, raw: data };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef, reason?: string): Promise<CancelShipmentResult> {
    if (!ref.trackingCode && !ref.carrierOrderId) return { ok: true, message: 'Chưa có mã J&T, chỉ huỷ trong hệ thống' };
    try {
      const data = await this.api(cfg, 'ORDERCANCEL', { eccompanyid: str(cfg.eccompanyid), customerid: str(cfg.customerid), txlogisticid: ref.carrierOrderId || ref.trackingCode, reason: clip(reason || 'Shop huỷ đơn', 200) }, 'Huỷ đơn J&T');
      this.firstItem(data, 'Huỷ đơn J&T');
      return { ok: true, raw: data };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://jtexpress.vn/vi/tracking?type=track&billcode=${encodeURIComponent(ref.trackingCode)}` : null;
  }

  /** Webhook: form logistics_interface + data_digest (ký bằng cùng API key) */
  async parseWebhook(cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const form = bodyObject(input.body, input.rawBody);
    const json = str(form.logistics_interface);
    let payload: Record<string, unknown>;
    if (json) {
      const key = str(cfg.privateKey);
      const digest = str(form.data_digest);
      if (key && digest && !safeEqual(digest, jtDigest(json, key, 'raw')) && !safeEqual(digest, jtDigest(json, key, 'hex'))) return null;
      try {
        payload = JSON.parse(json) as Record<string, unknown>;
      } catch {
        return null;
      }
    } else payload = form;
    const billcode = str(payload.billcode ?? payload.mailno);
    const txid = str(payload.txlogisticid);
    if (!billcode && !txid) return null;
    const details = Array.isArray(payload.details) ? (payload.details as Record<string, unknown>[]) : [payload];
    return details.map((d) => ({
      trackingCode: billcode || null,
      carrierOrderId: txid || billcode || null,
      status: mapJtStatus(`${str(d.scantype)} ${str(d.desc)}`),
      statusCode: str(d.scantype) || null,
      message: str(d.desc) || null,
      location: str(d.city ?? d.scanname) || null,
      at: parseDate(d.scantime) ?? new Date(),
      raw: payload,
    }));
  }
}
