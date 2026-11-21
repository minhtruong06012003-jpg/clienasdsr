/**
 * Adapter Ahamove — giao nội thành theo quãng đường, API v3 (https://developers.ahamove.com, tin cậy A).
 *
 * - Xác thực: POST /accounts { api_key, mobile, name, address } -> token Bearer (cache theo api_key + môi trường).
 * - Không dùng danh mục tỉnh/quận: địa chỉ truyền dạng chuỗi đầy đủ trong `path[]`, Ahamove tự geocode khi không có lat/lng.
 * - Dịch vụ theo thành phố: `{CITY}-BIKE`, `{CITY}-POOL`... với city_id suy từ mã tỉnh nội bộ (VN-SG -> SGN, VN-HN -> HAN...).
 * - Tính phí: POST /orders/estimates (nhiều dịch vụ một lần) -> leadtime = duration.
 * - Webhook: payload là object đơn đầy đủ; xác thực bằng header apikey / Authorization Bearer do đối tác chọn.
 */
import type { CancelShipmentResult, CarrierAddress, CarrierConfig, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, NormalizedShipmentStatus, RateQuote, RateRequest, ShipmentEvent, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, extractMessage, headerOf, int, parseDate, phoneVN, safeEqual, str, TokenCache, toKg, vnd } from './http.js';

const URLS = { sandbox: 'https://partner-apistg.ahamove.com/v3', production: 'https://partner-api.ahamove.com/v3' };
const tokens = new TokenCache<string>();

/** Mã tỉnh nội bộ -> city_id Ahamove (các thành phố Ahamove đang phục vụ) */
const CITY_BY_PROVINCE: Record<string, string> = {
  'VN-SG': 'SGN',
  'VN-HN': 'HAN',
  'VN-DN': 'DAD',
  'VN-CT': 'VCA',
  'VN-HP': 'HPH',
  'VN-57': 'BDG', // Bình Dương
  'VN-39': 'DNA', // Đồng Nai
  'VN-34': 'NHA', // Khánh Hoà (Nha Trang)
  'VN-43': 'VTU', // Bà Rịa - Vũng Tàu
  'VN-BV': 'VTU',
  'VN-35': 'DLI', // Lâm Đồng (Đà Lạt)
  'VN-26': 'HUI', // Huế
  'VN-TH': 'HUI',
  'VN-56': 'BNI', // Bắc Ninh
  'VN-61': 'HDG', // Hải Dương
  'VN-22': 'VII', // Nghệ An (Vinh)
  'VN-21': 'THO', // Thanh Hoá
  'VN-13': 'HLG', // Quảng Ninh (Hạ Long)
};

/** Suy city_id Ahamove từ địa chỉ; null nếu thành phố chưa hỗ trợ */
export function ahamoveCityId(addr: CarrierAddress, override?: Record<string, string>): string | null {
  const map = { ...CITY_BY_PROVINCE, ...override };
  return (addr.provinceCode && map[addr.provinceCode]) || null;
}

/** Trạng thái Ahamove (status + sub_status) -> chuẩn */
export function mapAhamoveStatus(status: unknown, subStatus?: unknown): NormalizedShipmentStatus {
  const s = String(status ?? '').toUpperCase().replace(/\s+/g, '_');
  const sub = String(subStatus ?? '').toUpperCase().replace(/\s+/g, '_');
  if (sub === 'IN_RETURN' || sub === 'RETURNING') return 'RETURNING';
  if (sub === 'RETURNED') return 'RETURNED';
  switch (s) {
    case 'IDLE':
    case 'ASSIGNING':
    case 'CONFIRMING':
    case 'PAYING':
      return 'PENDING';
    case 'ACCEPTED':
      return 'PICKING';
    case 'IN_PROCESS':
      return 'DELIVERING';
    case 'COMPLETED':
      return 'DELIVERED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

export class AhamoveCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'ahamove',
    name: 'Ahamove',
    description: 'Giao nhanh nội thành (xe máy, xe tải nhỏ) theo quãng đường; tính phí tức thì, theo dõi tài xế qua link chia sẻ. Không cần danh mục tỉnh/quận.',
    website: 'https://ahamove.com',
    docsUrl: 'https://developers.ahamove.com',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'password', required: true, help: 'Đăng ký qua Integration Form của Ahamove; staging cấp key test, sau UAT cấp key production.' },
      { key: 'mobile', label: 'Số điện thoại tài khoản', type: 'text', required: true, placeholder: '84912345678', help: 'Số điện thoại đăng ký tài khoản đối tác (định dạng 84…).' },
      { key: 'accountName', label: 'Tên tài khoản/shop', type: 'text', required: true },
      { key: 'accountAddress', label: 'Địa chỉ shop (đăng ký tài khoản)', type: 'text' },
      { key: 'services', label: 'Dịch vụ dùng (phẩy, bỏ tiền tố thành phố)', type: 'text', default: 'BIKE', help: 'VD: BIKE,POOL,TRICYCLE. Hệ thống tự ghép thành SGN-BIKE, HAN-BIKE theo tỉnh của kho.' },
      { key: 'paymentMethod', label: 'Phương thức trả phí ship', type: 'select', default: 'BALANCE', options: [{ value: 'BALANCE', label: 'Ví đối tác (BALANCE)' }, { value: 'CASH', label: 'Tiền mặt người gửi (CASH)' }, { value: 'CASH_BY_RECIPIENT', label: 'Tiền mặt người nhận' }] },
      { key: 'cityMap', label: 'Ghi đè mã thành phố (JSON)', type: 'textarea', placeholder: '{"VN-SG":"SGN"}', help: 'Chỉ cần khi Ahamove mở thêm thành phố chưa có trong bảng mặc định.' },
      { key: 'webhookToken', label: 'Token xác thực webhook', type: 'password', help: 'Giá trị header apikey hoặc Bearer bạn đăng ký với Ahamove; để trống thì không đối chiếu.' },
      { key: 'sandboxUrl', label: 'URL API staging', type: 'url', env: 'sandbox', default: URLS.sandbox },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', default: URLS.production },
    ],
    capabilities: { rates: true, services: true, leadtime: true, create: true, track: true, cancel: true, label: false, webhook: true, locations: false, testConnection: true },
    addressLevels: 3,
    notes: [
      'Chỉ giao nội thành: kho và người nhận phải cùng thành phố Ahamove hỗ trợ (SGN, HAN, DAD...). Tính phí trả lỗi nếu khác thành phố.',
      'Hệ thống không có toạ độ: địa chỉ gửi dạng chuỗi đầy đủ để Ahamove geocode — nên nhập địa chỉ đầy đủ số nhà, đường, phường, quận.',
      'Webhook gửi URL cho đội Ahamove; dán URL kèm ?key=<khoá webhook>. Cần xác minh mã city_id ngoài SGN/HAN/DAD với Ahamove.',
    ],
  };

  private url(cfg: CarrierConfig, path: string) {
    return `${baseUrl(cfg, URLS)}${path}`;
  }

  private cacheKey(cfg: CarrierConfig) {
    return `${str(cfg.apiKey).slice(-8)}|${str(cfg.mobile)}|${baseUrl(cfg, URLS)}`;
  }

  private async login(cfg: CarrierConfig): Promise<string> {
    const body = { api_key: str(cfg.apiKey), mobile: phoneVN(cfg.mobile, true).replace(/^\+/, ''), name: str(cfg.accountName), address: str(cfg.accountAddress) || str(cfg.accountName) };
    const res = await call<{ token?: string; refresh_token?: string; title?: string; description?: string }>(this.url(cfg, '/accounts'), { method: 'POST', body }, 'Đăng nhập Ahamove');
    if (!res.ok || !res.data?.token) throw new ShippingCarrierError(`Đăng nhập Ahamove thất bại: ${extractMessage(res.data) || `HTTP ${res.status}`}`, res.data, res.status >= 500);
    return tokens.set(this.cacheKey(cfg), res.data.token, 6 * 3600_000);
  }

  private async api<T = unknown>(cfg: CarrierConfig, path: string, opts: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {}, what = 'Gọi Ahamove', retry = true): Promise<T> {
    const token = tokens.get(this.cacheKey(cfg)) ?? (await this.login(cfg));
    const res = await call<T>(this.url(cfg, path), { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: opts.body, timeoutMs: 30_000 }, what);
    if (res.status === 401 && retry) {
      tokens.clear(this.cacheKey(cfg));
      return this.api<T>(cfg, path, opts, what, false);
    }
    if (!res.ok) throw new ShippingCarrierError(`${what} thất bại (HTTP ${res.status}): ${extractMessage(res.data) || res.text?.slice(0, 200)}`, res.data, res.status >= 500 || res.status === 429);
    return res.data;
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      tokens.clear(this.cacheKey(cfg));
      await this.login(cfg);
      return { ok: true, message: 'Đăng nhập Ahamove thành công.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private cityMap(cfg: CarrierConfig): Record<string, string> {
    try {
      const o = JSON.parse(str(cfg.cityMap) || '{}');
      return o && typeof o === 'object' ? (o as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /** Danh sách service_id theo thành phố của kho */
  private serviceIds(cfg: CarrierConfig, req: RateRequest): string[] {
    const city = ahamoveCityId(req.from, this.cityMap(cfg));
    if (!city) throw new ShippingCarrierError(`Ahamove chưa hỗ trợ tỉnh/thành của kho (${req.from.provinceName ?? req.from.provinceCode ?? 'chưa rõ'}).`);
    const toCity = ahamoveCityId(req.to, this.cityMap(cfg));
    if (toCity && toCity !== city) throw new ShippingCarrierError('Ahamove chỉ giao nội thành: địa chỉ nhận khác thành phố với kho.');
    if (req.service) return [req.service.includes('-') ? req.service : `${city}-${req.service}`];
    return str(cfg.services, 'BIKE')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .map((s) => (s.includes('-') ? s : `${city}-${s}`));
  }

  private point(addr: CarrierAddress, extra: Record<string, unknown> = {}) {
    return { address: addressLine(addr, true), name: clip(addr.name, 100), mobile: phoneVN(addr.phone), ...extra };
  }

  private packageDetail(req: RateRequest) {
    return [{ weight: toKg(req.parcel.weight), length: int(req.parcel.length, 1), width: int(req.parcel.width, 1), height: int(req.parcel.height, 1) }];
  }

  async getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    const services = this.serviceIds(cfg, req);
    const body = { order_time: 0, path: [this.point(req.from), this.point(req.to, { cod: vnd(req.parcel.codAmount), item_value: vnd(req.parcel.value) })], services, payment_method: str(cfg.paymentMethod, 'BALANCE'), package_detail: this.packageDetail(req) };
    const rows = await this.api<{ service_id: string; total_price?: number; total_fee?: number; distance_fee?: number; request_fee?: number; distance?: number; duration?: number; vat?: number }[]>(cfg, '/orders/estimates', { body }, 'Tính phí Ahamove');
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      carrier: 'ahamove',
      serviceCode: r.service_id,
      serviceName: `Ahamove ${r.service_id.split('-').slice(1).join(' ') || r.service_id}${r.distance ? ` (~${Math.round(r.distance * 10) / 10} km)` : ''}`,
      fee: vnd(r.total_price ?? r.total_fee),
      breakdown: { base: vnd(r.distance_fee), other: vnd(r.request_fee) },
      estimatedDays: r.duration ? 1 : null,
      expectedDeliveryAt: r.duration ? new Date(Date.now() + r.duration * 1000) : null,
      raw: r,
    }));
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const [serviceId] = this.serviceIds(cfg, req);
    const body = {
      order_time: req.pickupAt ? Math.floor(new Date(req.pickupAt).getTime() / 1000) : 0,
      path: [this.point(req.from, { remarks: clip(req.note ?? '', 500) || undefined }), this.point(req.to, { cod: vnd(req.parcel.codAmount), item_value: vnd(req.parcel.value), tracking_number: clip(req.orderCode, 50), remarks: clip(req.note ?? '', 500) || undefined })],
      service_id: serviceId,
      requests: [] as unknown[],
      payment_method: str(cfg.paymentMethod, 'BALANCE'),
      items: req.parcel.items.map((i) => ({ _id: i.sku || clip(i.name, 50), num: int(i.quantity, 1), name: clip(i.name, 100), price: vnd(i.price) })),
      remarks: clip(req.note ?? '', 500) || undefined,
      package_detail: this.packageDetail(req),
    };
    const d = await this.api<{ order_id: string; status?: string; shared_link?: string; total_pay?: number; distance?: number; duration?: number }>(cfg, '/orders', { body }, 'Tạo đơn Ahamove');
    if (!d?.order_id) throw new ShippingCarrierError('Ahamove không trả về mã đơn', d);
    return { trackingCode: d.order_id, carrierOrderId: d.order_id, fee: vnd(d.total_pay), serviceName: `Ahamove ${serviceId}`, expectedDeliveryAt: d.duration ? new Date(Date.now() + d.duration * 1000) : null, trackingUrl: d.shared_link ?? null, status: mapAhamoveStatus(d.status), raw: d };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    const id = ref.carrierOrderId || ref.trackingCode;
    if (!id) throw new ShippingCarrierError('Vận đơn chưa có mã Ahamove');
    const o = await this.api<Record<string, unknown>>(cfg, `/orders/${encodeURIComponent(id)}`, {}, 'Tra cứu đơn Ahamove');
    const status = mapAhamoveStatus(o.status, o.sub_status);
    const events: ShipmentEvent[] = [];
    const push = (st: NormalizedShipmentStatus, code: string, t: unknown) => {
      const at = parseDate(t);
      if (at) events.push({ status: st, statusCode: code, at });
    };
    push('PENDING', 'create_time', o.create_time);
    push('PICKING', 'accept_time', o.accept_time);
    push('DELIVERING', 'pickup_time', o.pickup_time);
    push('DELIVERED', 'complete_time', o.complete_time);
    push('CANCELLED', 'cancel_time', o.cancel_time);
    const paths = Array.isArray(o.path) ? (o.path as { cod?: number; status?: string }[]) : [];
    return { status, statusCode: [o.status, o.sub_status].filter(Boolean).join('/') || null, message: str(o.cancel_comment) || str(o.supplier_name) || null, events, fee: o.total_pay != null ? vnd(o.total_pay) : null, codCollected: status === 'DELIVERED' ? vnd(paths[1]?.cod) : null, raw: o };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef, reason?: string): Promise<CancelShipmentResult> {
    const id = ref.carrierOrderId || ref.trackingCode;
    if (!id) return { ok: true, message: 'Chưa có mã Ahamove, chỉ huỷ trong hệ thống' };
    try {
      const r = await this.api<unknown>(cfg, `/orders/${encodeURIComponent(id)}`, { method: 'DELETE', body: { comment: clip(reason || 'Shop huỷ đơn', 200) } }, 'Huỷ đơn Ahamove');
      return { ok: true, raw: r };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    const link = (ref.meta?.createResult as { shared_link?: string } | undefined)?.shared_link ?? (ref.meta?.lastTrack as { shared_link?: string } | undefined)?.shared_link;
    return link || null;
  }

  /** Webhook: object đơn đầy đủ; `_id` có thể là "{order_id}-{stop_index}" với đơn nhiều điểm */
  async parseWebhook(cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const expected = str(cfg.webhookToken);
    if (expected) {
      const got = headerOf(input.headers, 'apikey') || headerOf(input.headers, 'authorization')?.replace(/^(Bearer|Basic)\s+/i, '') || '';
      if (!safeEqual(got, expected)) return null;
    }
    const b = bodyObject(input.body, input.rawBody);
    const rawId = str(b._id ?? b.order_id);
    if (!rawId) return null;
    const orderId = rawId.replace(/-\d+$/, '');
    const status = mapAhamoveStatus(b.status, b.sub_status);
    return [
      {
        trackingCode: orderId,
        carrierOrderId: orderId,
        status,
        statusCode: [b.status, b.sub_status].filter(Boolean).join('/') || null,
        message: str(b.cancel_comment) || (b.supplier_name ? `Tài xế: ${str(b.supplier_name)} ${str(b.supplier_id)}` : null),
        at: parseDate(b.complete_time ?? b.cancel_time ?? b.pickup_time ?? b.accept_time ?? b.create_time) ?? new Date(),
        fee: b.total_pay != null ? vnd(b.total_pay) : null,
        codCollected: status === 'DELIVERED' && Array.isArray(b.path) ? vnd((b.path as { cod?: number }[])[1]?.cod) : null,
        raw: b,
      },
    ];
  }
}
