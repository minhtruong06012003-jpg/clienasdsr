/**
 * Adapter SuperShip — https://docs.developers.supership.vn (tin cậy A).
 *
 * - Xác thực: Personal Access Token (https://khachhang.supership.vn/apis) -> `Authorization: Bearer`.
 * - Địa chỉ: danh mục MÃ (/v1/partner/areas/*) nhưng tính phí & tạo đơn dùng TÊN tỉnh/quận/phường.
 * - Dịch vụ duy nhất `service = "1"` (Express). Không có sandbox công khai.
 * - Webhook: không chữ ký; payload { code, soc, status, status_name, weight, fee, updated_at }.
 */
import type { CancelShipmentResult, CarrierConfig, CarrierLocation, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, LabelResult, NormalizedShipmentStatus, RateQuote, RateRequest, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, describeItems, extractMessage, int, parseDate, phoneVN, qs, str, vnd } from './http.js';

const URLS = { sandbox: 'https://api.mysupership.vn', production: 'https://api.mysupership.vn' };

interface SsEnvelope<T = unknown> {
  status?: string;
  message?: string;
  results?: T;
}

const STATUS_MAP: Record<string, NormalizedShipmentStatus> = {
  '0': 'CANCELLED',
  '1': 'PENDING',
  '2': 'PENDING',
  '3': 'PICKING',
  '5': 'PICKING',
  '6': 'FAILED',
  '4': 'PICKED',
  '7': 'PICKED',
  '8': 'PICKED',
  '9': 'PICKED',
  '10': 'PICKED',
  '23': 'PICKED',
  '11': 'DELIVERING',
  '14': 'DELIVERING',
  '12': 'DELIVERED',
  '13': 'DELIVERED',
  '16': 'DELIVERED',
  '15': 'FAILED',
  '24': 'RETURNING',
  '18': 'RETURNING',
  '19': 'RETURNING',
  '20': 'RETURNING',
  '22': 'RETURNING',
  '21': 'RETURNED',
  '17': 'RETURNED',
  '26': 'FAILED',
  '25': 'FAILED',
  '27': 'FAILED',
};

export function mapSupershipStatus(code: unknown): NormalizedShipmentStatus {
  return STATUS_MAP[String(code ?? '').trim()] ?? 'PENDING';
}

export class SupershipCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'supership',
    name: 'SuperShip',
    description: 'SuperShip — tính phí, tạo/huỷ đơn, tra cứu, in nhãn, webhook. Một dịch vụ Express; dùng tên tỉnh/quận/phường.',
    website: 'https://supership.vn',
    docsUrl: 'https://docs.developers.supership.vn/en/guide/',
    fields: [
      { key: 'accessToken', label: 'Personal Access Token', type: 'password', required: true, help: 'https://khachhang.supership.vn/apis › tạo token.' },
      { key: 'pickupCode', label: 'Mã kho lấy hàng (pickup_code)', type: 'text', help: 'Kho đã khai báo trên SuperShip; để trống dùng địa chỉ kho nhập tay.' },
      { key: 'productionUrl', label: 'URL API', type: 'url', env: 'production', default: URLS.production },
      { key: 'sandboxUrl', label: 'URL API (không có sandbox — dùng tài khoản thật)', type: 'url', env: 'sandbox', default: URLS.sandbox },
    ],
    capabilities: { rates: true, services: false, leadtime: false, create: true, track: true, cancel: true, label: true, webhook: true, locations: true, testConnection: true },
    addressLevels: 3,
    notes: ['SuperShip không có sandbox: thử nghiệm bằng tài khoản thật rồi huỷ đơn test.', 'Webhook tạo qua API POST /v1/partner/webhooks/create (nút Kiểm tra kết nối không tự tạo); không chữ ký → dán URL kèm ?key=<khoá webhook>.'],
  };

  private headers(cfg: CarrierConfig): Record<string, string> {
    return { Authorization: `Bearer ${str(cfg.accessToken)}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  private async api<T = unknown>(cfg: CarrierConfig, path: string, body?: unknown, what = 'Gọi SuperShip'): Promise<T> {
    const res = await call<SsEnvelope<T>>(`${baseUrl(cfg, URLS)}${path}`, { method: body ? 'POST' : 'GET', headers: this.headers(cfg), body, timeoutMs: 30_000 }, what);
    const env = (res.data ?? {}) as SsEnvelope<T>;
    if (!res.ok || env.status === 'Error') throw new ShippingCarrierError(`${what} thất bại: ${extractMessage(env) || res.text?.slice(0, 200) || `HTTP ${res.status}`}`, env, res.status >= 500);
    return env.results as T;
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      const rows = await this.api<{ code: string; name: string }[]>(cfg, '/v1/partner/areas/province', undefined, 'Kiểm tra token SuperShip');
      return { ok: true, message: `Token SuperShip hợp lệ (${Array.isArray(rows) ? rows.length : 0} tỉnh/thành).` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listLocations(cfg: CarrierConfig, level: 1 | 2 | 3, parentCode?: string | null): Promise<CarrierLocation[]> {
    const path = level === 1 ? '/v1/partner/areas/province' : level === 2 ? `/v1/partner/areas/district${qs({ province: parentCode })}` : `/v1/partner/areas/commune${qs({ district: parentCode })}`;
    const rows = await this.api<{ code: string; name: string }[]>(cfg, path, undefined, 'Lấy danh mục địa chỉ SuperShip');
    return (Array.isArray(rows) ? rows : []).map((r) => ({ code: String(r.code), name: r.name, parentCode: level === 1 ? null : (parentCode ?? null) }));
  }

  async getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    if (!req.to.provinceName || !req.to.districtName) throw new ShippingCarrierError('SuperShip cần tên tỉnh và quận/huyện người nhận.');
    const r = await this.api<{ fee?: number | string; insurance_fee?: number | string }>(cfg, `/v1/partner/orders/price${qs({ sender_province: req.from.provinceName, sender_district: req.from.districtName, receiver_province: req.to.provinceName, receiver_district: req.to.districtName, weight: int(req.parcel.weight, 1), value: vnd(req.parcel.value) })}`, undefined, 'Tính phí SuperShip');
    return [{ carrier: 'supership', serviceCode: '1', serviceName: 'SuperShip Express', fee: vnd(r?.fee) + vnd(r?.insurance_fee), breakdown: { base: vnd(r?.fee), insurance: vnd(r?.insurance_fee) }, estimatedDays: null, raw: r }];
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = {
      pickup_code: str(cfg.pickupCode) || undefined,
      pickup_phone: phoneVN(req.from.phone),
      pickup_address: clip(addressLine(req.from), 200),
      pickup_commune: req.from.wardName ?? '',
      pickup_district: req.from.districtName ?? '',
      pickup_province: req.from.provinceName ?? '',
      name: clip(req.to.name, 100),
      phone: phoneVN(req.to.phone),
      email: req.to.email || undefined,
      address: clip(addressLine(req.to), 200),
      province: req.to.provinceName ?? '',
      district: req.to.districtName ?? '',
      commune: req.to.wardName ?? '',
      amount: vnd(req.parcel.codAmount),
      value: vnd(req.parcel.value),
      weight: int(req.parcel.weight, 1),
      payer: req.payer === 'customer' ? '2' : '1',
      service: '1',
      // config: 1 cho xem, 2 cho thử, 3 không cho xem
      config: req.allowInspection === 'try' ? '2' : req.allowInspection === 'deny' ? '3' : '1',
      product_type: '1',
      products: describeItems(req.parcel.items),
      soc: clip(req.orderCode, 50),
      note: clip(req.note ?? '', 200),
    };
    const d = await this.api<{ code?: string; shortcode?: string; fee?: number | string; insurance?: number | string; status?: string | number; status_name?: string }>(cfg, '/v1/partner/orders/add', body, 'Tạo đơn SuperShip');
    if (!d?.code) throw new ShippingCarrierError('SuperShip không trả về mã đơn', d);
    return { trackingCode: String(d.code), carrierOrderId: String(d.code), fee: vnd(d.fee) + vnd(d.insurance), serviceName: 'SuperShip Express', trackingUrl: this.trackingUrl(cfg, { id: req.shipmentId, trackingCode: String(d.code) }), status: d.status != null ? mapSupershipStatus(d.status) : 'PENDING', raw: d };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Đơn chưa có mã SuperShip');
    const d = await this.api<{ status?: string | number; status_name?: string; fee?: number | string; amount?: number | string; updated_at?: string }>(cfg, `/v1/partner/orders/info${qs({ code: ref.trackingCode })}`, undefined, 'Tra cứu đơn SuperShip');
    const status = mapSupershipStatus(d?.status);
    const at = parseDate(d?.updated_at) ?? new Date();
    return { status, statusCode: str(d?.status) || null, message: d?.status_name ?? null, events: [{ status, statusCode: str(d?.status) || null, message: d?.status_name ?? null, at }], fee: d?.fee != null ? vnd(d.fee) : null, codCollected: status === 'DELIVERED' ? vnd(d?.amount) : null, raw: d };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef): Promise<CancelShipmentResult> {
    if (!ref.trackingCode) return { ok: true, message: 'Chưa có mã SuperShip, chỉ huỷ trong hệ thống' };
    try {
      const r = await this.api(cfg, '/v1/partner/orders/cancel', { code: ref.trackingCode }, 'Huỷ đơn SuperShip');
      return { ok: true, raw: r };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  async getLabel(cfg: CarrierConfig, ref: ShipmentRef): Promise<LabelResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Đơn chưa có mã SuperShip');
    const r = await this.api<{ token?: string } | string>(cfg, '/v1/partner/orders/token', { code: [ref.trackingCode] }, 'Lấy token in nhãn SuperShip');
    const token = typeof r === 'string' ? r : r?.token;
    if (!token) throw new ShippingCarrierError('SuperShip không trả về token in nhãn', r);
    return { url: `${baseUrl(cfg, URLS)}/v1/partner/orders/label?token=${encodeURIComponent(token)}&size=A5` };
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://supership.vn/tra-cuu-don-hang?code=${encodeURIComponent(ref.trackingCode)}` : null;
  }

  async parseWebhook(_cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const b = bodyObject(input.body, input.rawBody);
    const code = str(b.code);
    if (!code || b.status === undefined) return null;
    const status = mapSupershipStatus(b.status);
    return [{ trackingCode: code, carrierOrderId: code, status, statusCode: String(b.status), message: str(b.status_name) || null, at: parseDate(b.updated_at) ?? new Date(), fee: b.fee != null && b.fee !== '' ? vnd(b.fee) : null, raw: b }];
  }
}
