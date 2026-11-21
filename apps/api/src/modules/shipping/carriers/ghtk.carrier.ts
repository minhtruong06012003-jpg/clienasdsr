/**
 * Adapter Giao Hàng Tiết Kiệm (GHTK) — https://api.ghtk.vn/en/docs (tin cậy A).
 *
 * - Xác thực: header `Token` (API token ở trang quản lý shop) + `X-Client-Source` (mã đối tác, có thể trống).
 * - Địa chỉ: dùng TÊN tỉnh/quận/phường (không có API danh mục) -> dùng tên từ danh mục nội bộ.
 * - Tính phí: GET /services/shipment/fee (weight GRAM); tạo đơn products[].weight tính bằng KG.
 * - Dịch vụ: `deliver_option` = `none` (Chuẩn) | `xteam` (Nhanh nội thành).
 * - Webhook: form-urlencoded hoặc JSON, không chữ ký; bảo vệ bằng `?key=` trên URL.
 */
import type { CancelShipmentResult, CarrierConfig, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, LabelResult, NormalizedShipmentStatus, RateQuote, RateRequest, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, ensureOk, extractMessage, int, parseDate, phoneVN, qs, str, toKg, vnd } from './http.js';

const URLS = { sandbox: 'https://services-staging.ghtklab.com', production: 'https://services.giaohangtietkiem.vn' };

/** status_id GHTK -> chuẩn */
const STATUS_MAP: Record<string, NormalizedShipmentStatus> = {
  '-1': 'CANCELLED',
  '1': 'PENDING',
  '2': 'PENDING',
  '12': 'PICKING',
  '7': 'FAILED',
  '8': 'PICKING',
  '3': 'PICKED',
  '4': 'DELIVERING',
  '10': 'DELIVERING',
  '9': 'FAILED',
  '5': 'DELIVERED',
  '6': 'DELIVERED',
  '20': 'RETURNING',
  '21': 'RETURNED',
  '11': 'RETURNED',
  '13': 'FAILED',
  // mã shipper báo (tham khảo): ánh xạ gần nhất
  '123': 'PICKED',
  '127': 'FAILED',
  '128': 'PICKING',
  '45': 'DELIVERED',
  '49': 'FAILED',
  '410': 'DELIVERING',
};

export function mapGhtkStatus(statusId: unknown): NormalizedShipmentStatus {
  return STATUS_MAP[String(statusId ?? '').trim()] ?? 'PENDING';
}

const SERVICES: { code: string; name: string }[] = [
  { code: 'none', name: 'Giao hàng tiêu chuẩn' },
  { code: 'xteam', name: 'Giao nhanh (xteam)' },
];

/** Dựng body tạo đơn GHTK (export để test): products (kg) + order */
export function buildGhtkOrder(cfg: CarrierConfig, req: CreateShipmentRequest): { products: Record<string, unknown>[]; order: Record<string, unknown> } {
  const { from, to, parcel } = req;
  const items = parcel.items.length ? parcel.items : [{ name: 'Hàng hoá', quantity: 1, weight: parcel.weight }];
  const perItemFallback = parcel.weight / Math.max(1, items.reduce((s, i) => s + int(i.quantity, 1), 0));
  const products = items.map((i) => ({
    name: clip(i.name, 200),
    weight: toKg(i.weight ?? perItemFallback),
    quantity: int(i.quantity, 1),
    product_code: i.sku ?? undefined,
    price: i.price != null ? vnd(i.price) : undefined,
  }));
  const deliver = req.service === 'xteam' ? 'xteam' : 'none';
  const order: Record<string, unknown> = {
    id: clip(req.orderCode, 50),
    pick_name: clip(from.name, 100),
    pick_address: clip(addressLine(from), 200),
    pick_province: from.provinceName ?? '',
    pick_district: from.districtName ?? '',
    pick_ward: from.wardName ?? undefined,
    pick_tel: phoneVN(from.phone),
    pick_address_id: str(cfg.pickAddressId) || undefined,
    tel: phoneVN(to.phone),
    name: clip(to.name, 100),
    address: clip(addressLine(to), 200),
    province: to.provinceName ?? '',
    district: to.districtName ?? '',
    ward: to.wardName ?? '',
    hamlet: 'Khác',
    email: to.email || undefined,
    // is_freeship: 1 = chỉ thu COD (shop trả phí); 0 = thu COD + phí ship từ người nhận
    is_freeship: req.payer === 'customer' ? 0 : 1,
    pick_money: vnd(parcel.codAmount),
    value: vnd(parcel.value),
    transport: str(cfg.transport) === 'fly' ? 'fly' : 'road',
    pick_option: req.pickupMode === 'dropoff' ? 'post' : 'cod',
    deliver_option: deliver,
    note: clip(req.note ?? '', 120) || undefined,
    is_fragile: 0,
  };
  if (req.allowInspection === 'deny') order.note = clip([str(order.note), 'Không cho xem hàng'].filter(Boolean).join('. '), 120);
  if (req.pickupAt) {
    const d = new Date(req.pickupAt);
    order.pick_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return { products, order };
}

export class GhtkCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'ghtk',
    name: 'Giao Hàng Tiết Kiệm',
    description: 'GHTK — tính phí, tạo đơn theo tên tỉnh/quận/phường, tra cứu, huỷ, in nhãn PDF, webhook trạng thái.',
    website: 'https://giaohangtietkiem.vn',
    docsUrl: 'https://api.ghtk.vn/en/docs/intro/',
    fields: [
      { key: 'token', label: 'API Token', type: 'password', required: true, help: 'Trang quản lý shop GHTK › Thông tin shop › API token. Staging cấp token riêng.' },
      { key: 'partnerCode', label: 'Mã đối tác (X-Client-Source)', type: 'text', help: 'Do GHTK cấp cho nền tảng; shop lẻ có thể để trống.' },
      { key: 'pickAddressId', label: 'Mã kho lấy hàng (pick_address_id)', type: 'text', help: 'Lấy từ GET /services/shipment/list_pick_add; ưu tiên hơn địa chỉ kho nhập tay.' },
      { key: 'transport', label: 'Phương thức vận chuyển', type: 'select', default: 'road', options: [{ value: 'road', label: 'Đường bộ (road)' }, { value: 'fly', label: 'Đường bay (fly)' }] },
      { key: 'sandboxUrl', label: 'URL API staging', type: 'url', env: 'sandbox', default: URLS.sandbox },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', default: URLS.production },
    ],
    capabilities: { rates: true, services: true, leadtime: false, create: true, track: true, cancel: true, label: true, webhook: true, locations: false, testConnection: true },
    addressLevels: 3,
    notes: [
      'GHTK không có API danh mục địa chỉ: tên tỉnh/quận/phường lấy từ danh mục nội bộ (đồng bộ từ GHN/Viettel Post/GoShip).',
      'Webhook đăng ký qua nhân viên kinh doanh GHTK; không có chữ ký → dán URL kèm ?key=<khoá webhook>. GHTK retry 1 lần.',
      'Trạng thái 7 (không lấy được) và 9 (không giao được) là tạm thời — đơn vẫn có thể tiếp tục.',
    ],
  };

  private headers(cfg: CarrierConfig): Record<string, string> {
    const h: Record<string, string> = { Token: str(cfg.token), 'Content-Type': 'application/json' };
    if (str(cfg.partnerCode)) h['X-Client-Source'] = str(cfg.partnerCode);
    return h;
  }

  private url(cfg: CarrierConfig, path: string) {
    return `${baseUrl(cfg, URLS)}${path}`;
  }

  /** Gọi API GHTK; kiểm tra HTTP + `success` */
  private async api<T extends { success?: boolean; message?: string }>(cfg: CarrierConfig, path: string, body?: unknown, what = 'Gọi GHTK', method?: 'GET' | 'POST'): Promise<T> {
    const res = await call<T>(this.url(cfg, path), { method: method ?? (body ? 'POST' : 'GET'), headers: this.headers(cfg), body, timeoutMs: 30_000 }, what);
    const data = (res.data ?? {}) as T;
    if (!res.ok || data.success === false) {
      const msg = extractMessage(data) || res.text?.slice(0, 200) || `HTTP ${res.status}`;
      throw new ShippingCarrierError(`${what} thất bại: ${msg}`, data, res.status >= 500);
    }
    return data;
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      const r = await this.api<{ success?: boolean; message?: string }>(cfg, '/services/authenticated', undefined, 'Kiểm tra token GHTK');
      return { ok: true, message: r.message || 'Token GHTK hợp lệ.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    const { from, to, parcel } = req;
    if (!to.provinceName || !to.districtName) throw new ShippingCarrierError('GHTK cần tên tỉnh và quận/huyện của người nhận.');
    const base: Record<string, unknown> = {
      pick_province: from.provinceName,
      pick_district: from.districtName,
      pick_ward: from.wardName,
      pick_address: addressLine(from),
      pick_address_id: str(cfg.pickAddressId) || undefined,
      province: to.provinceName,
      district: to.districtName,
      ward: to.wardName,
      address: addressLine(to),
      weight: int(parcel.weight, 1),
      value: vnd(parcel.value),
      transport: str(cfg.transport) === 'fly' ? 'fly' : 'road',
    };
    const services = req.service ? SERVICES.filter((s) => s.code === req.service) : SERVICES;
    const quotes = await Promise.all(
      services.map(async (s): Promise<RateQuote | { error: string }> => {
        try {
          const r = await this.api<{ success?: boolean; fee?: { fee: number; insurance_fee?: number; delivery?: boolean; ship_fee_only?: number; extFees?: { amount: number }[] } }>(cfg, `/services/shipment/fee${qs({ ...base, deliver_option: s.code })}`, undefined, `Tính phí GHTK (${s.name})`);
          if (!r.fee || r.fee.delivery === false) return { error: `GHTK không hỗ trợ giao ${s.name} tới địa chỉ này` };
          return { carrier: 'ghtk', serviceCode: s.code, serviceName: s.name, fee: vnd(r.fee.fee), breakdown: { base: vnd(r.fee.ship_fee_only ?? r.fee.fee), insurance: vnd(r.fee.insurance_fee), other: (r.fee.extFees ?? []).reduce((a, f) => a + vnd(f.amount), 0) }, estimatedDays: null, raw: r };
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),
    );
    const ok = quotes.filter((q): q is RateQuote => !('error' in q));
    if (!ok.length) throw new ShippingCarrierError((quotes[0] as { error: string }).error);
    return ok;
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = buildGhtkOrder(cfg, req);
    const r = await this.api<{ success?: boolean; message?: string; order?: { label: string; tracking_id?: number | string; fee: number | string; insurance_fee?: number | string; estimated_pick_time?: string; estimated_deliver_time?: string; status_id?: number } }>(cfg, '/services/shipment/order', body, 'Tạo đơn GHTK');
    const o = r.order;
    if (!o?.label) throw new ShippingCarrierError('GHTK không trả về mã vận đơn (label)', r);
    return {
      trackingCode: o.label,
      carrierOrderId: o.tracking_id != null ? String(o.tracking_id) : o.label,
      fee: vnd(o.fee) + vnd(o.insurance_fee),
      serviceName: SERVICES.find((s) => s.code === body.order.deliver_option)?.name ?? null,
      expectedDeliveryAt: parseDate(o.estimated_deliver_time),
      trackingUrl: `https://i.ghtk.vn/${encodeURIComponent(o.label)}`,
      status: o.status_id != null ? mapGhtkStatus(o.status_id) : 'PENDING',
      raw: r,
    };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã GHTK');
    const r = await this.api<{ success?: boolean; order?: { label_id: string; status: number | string; status_text?: string; message?: string; modified?: string; deliver_date?: string; ship_money?: number | string; insurance?: number | string; pick_money?: number | string } }>(cfg, `/services/shipment/v2/${encodeURIComponent(ref.trackingCode)}`, undefined, 'Tra cứu đơn GHTK');
    const o = r.order;
    if (!o) throw new ShippingCarrierError('GHTK không trả về thông tin đơn', r);
    const status = mapGhtkStatus(o.status);
    const at = parseDate(o.modified) ?? new Date();
    return { status, statusCode: String(o.status), message: o.status_text || o.message || null, events: [{ status, statusCode: String(o.status), message: o.status_text || null, at }], expectedDeliveryAt: parseDate(o.deliver_date), fee: o.ship_money != null ? vnd(o.ship_money) + vnd(o.insurance) : null, codCollected: status === 'DELIVERED' ? vnd(o.pick_money) : null, raw: r };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef): Promise<CancelShipmentResult> {
    if (!ref.trackingCode) return { ok: true, message: 'Chưa có mã GHTK, chỉ huỷ trong hệ thống' };
    try {
      const r = await this.api<{ success?: boolean; message?: string }>(cfg, `/services/shipment/cancel/${encodeURIComponent(ref.trackingCode)}`, {}, 'Huỷ đơn GHTK', 'POST');
      return { ok: true, message: r.message ?? null, raw: r };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  /** Nhãn PDF (A6 dọc) — nếu hãng trả JSON tức là lỗi */
  async getLabel(cfg: CarrierConfig, ref: ShipmentRef): Promise<LabelResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã GHTK');
    const res = await call(this.url(cfg, `/services/label/${encodeURIComponent(ref.trackingCode)}?original=portrait&page_size=A6`), { method: 'GET', headers: this.headers(cfg), binary: true, timeoutMs: 60_000 }, 'In nhãn GHTK');
    ensureOk(res, 'In nhãn GHTK');
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('pdf')) {
      let msg = 'GHTK không trả về PDF';
      try {
        msg = extractMessage(JSON.parse(res.buffer?.toString('utf8') ?? '')) || msg;
      } catch {
        /* không phải JSON */
      }
      throw new ShippingCarrierError(msg, res.buffer?.toString('utf8').slice(0, 300));
    }
    return { buffer: res.buffer!, mimeType: 'application/pdf', fileName: `ghtk-${ref.trackingCode}.pdf` };
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://i.ghtk.vn/${encodeURIComponent(ref.trackingCode)}` : null;
  }

  /** Webhook GHTK: form-urlencoded hoặc JSON; label_id + status_id */
  async parseWebhook(_cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const b = bodyObject(input.body, input.rawBody);
    const label = str(b.label_id ?? b.label);
    const partnerId = str(b.partner_id);
    if (!label && !partnerId) return null;
    if (b.status_id === undefined || b.status_id === null || b.status_id === '') return null;
    const status = mapGhtkStatus(b.status_id);
    return [
      {
        trackingCode: label || null,
        carrierOrderId: label || null,
        status,
        statusCode: String(b.status_id),
        message: [str(b.reason_code), str(b.reason)].filter(Boolean).join(' — ') || null,
        at: parseDate(b.action_time) ?? new Date(),
        fee: b.fee != null && b.fee !== '' ? vnd(b.fee) : null,
        codCollected: status === 'DELIVERED' && b.pick_money != null ? vnd(b.pick_money) : null,
        raw: { ...b, partner_id: partnerId },
      },
    ];
  }
}
