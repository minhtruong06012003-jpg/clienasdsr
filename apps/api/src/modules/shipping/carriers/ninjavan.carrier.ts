/**
 * Adapter Ninja Van Việt Nam — https://api-docs.ninjavan.co (tin cậy B).
 *
 * - Xác thực: OAuth2 client_credentials POST /2.0/oauth/access_token -> Bearer (cache đến trước hạn 5 phút).
 * - Base URL đã gồm mã quốc gia: production https://api.ninjavan.co/VN; sandbox chỉ chạy country SG.
 * - Địa chỉ: TÊN (area = phường, city = quận, state = tỉnh). Không có API danh mục.
 * - Tính phí: API Tariff cần l1/l2 tier code của NV (không có danh mục công khai) -> capabilities.rates = false.
 * - Tạo đơn POST /4.2/orders (kg); huỷ DELETE /2.2/orders/{tn}; nhãn GET /2.0/reports/waybill (PDF).
 * - Webhook: header X-Ninjavan-Hmac-Sha256 = base64(HMAC-SHA256(body, client_secret)).
 */
import type { CancelShipmentResult, CarrierAddress, CarrierConfig, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, LabelResult, NormalizedShipmentStatus, RateQuote, RateRequest, ShipmentEvent, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, ensureOk, extractMessage, fold, headerOf, hmacSha256Base64, int, parseDate, phoneVN, safeEqual, str, TokenCache, toKg, vnd } from './http.js';

const URLS = { sandbox: 'https://api-sandbox.ninjavan.co/SG', production: 'https://api.ninjavan.co/VN' };
const tokens = new TokenCache<string>();

/** Chữ ký webhook Ninja Van */
export function signNinjaVan(rawBody: string, clientSecret: string): string {
  return hmacSha256Base64(rawBody, clientSecret);
}
export function verifyNinjaVanHmac(rawBody: string, clientSecret: string, header: string | null | undefined): boolean {
  return !!header && !!clientSecret && safeEqual(header.trim(), signNinjaVan(rawBody, clientSecret));
}

/** Event/status Ninja Van -> chuẩn (so khớp theo từ khoá vì tên event khá dài) */
export function mapNinjaVanStatus(status: unknown, onRtsLeg = false): NormalizedShipmentStatus {
  const s = fold(status);
  if (!s) return 'PENDING';
  if (s.includes('cancel')) return 'CANCELLED';
  if (s.includes('lost') || s.includes('damage') || s.includes('dispose')) return 'FAILED';
  if (s.includes('returned to sender') && !s.includes('transit') && !s.includes('trigger')) return 'RETURNED';
  if (s.includes('return')) return 'RETURNING';
  if (s.includes('successful delivery') || s === 'completed' || s === 'delivered') return 'DELIVERED';
  if (onRtsLeg) return 'RETURNING';
  if (s.includes('delivery exception') || s.includes('reattempt')) return 'FAILED';
  if (s.includes('on vehicle for delivery') || s.includes('out for delivery')) return 'DELIVERING';
  if (s.includes('pickup exception') || s.includes('pending pickup, reschedule')) return 'PICKING';
  if (s.includes('pending pickup') || s.includes('pending')) return 'PENDING';
  if (s.includes('pickup') || s.includes('picked up') || s.includes('hub') || s.includes('transit') || s.includes('sorting')) return 'PICKED';
  return 'PENDING';
}

/** Dựng body tạo đơn Ninja Van 4.2 (export để test) */
export function buildNinjaVanOrder(cfg: CarrierConfig, req: CreateShipmentRequest): Record<string, unknown> {
  const addr = (a: CarrierAddress) => ({
    address1: clip(addressLine(a), 255),
    address2: '',
    area: a.wardName ?? '',
    city: a.districtName ?? '',
    state: a.provinceName ?? '',
    address_type: 'home',
    country: cfg.environment === 'production' ? 'VN' : str(cfg.countryCode, 'SG'),
    postcode: str(cfg.postcode, '100000'),
  });
  const pickup = req.pickupAt ? new Date(req.pickupAt) : new Date(Date.now() + 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const deliveryStart = new Date(pickup.getTime() + 86_400_000);
  return {
    service_type: 'Parcel',
    service_level: req.service || str(cfg.serviceLevel, 'Standard'),
    reference: { merchant_order_number: clip(req.orderCode, 50) },
    from: { name: clip(req.from.name, 255), phone_number: phoneVN(req.from.phone, true), email: req.from.email || undefined, address: addr(req.from) },
    to: { name: clip(req.to.name, 255), phone_number: phoneVN(req.to.phone, true), email: req.to.email || undefined, address: addr(req.to) },
    parcel_job: {
      is_pickup_required: req.pickupMode !== 'dropoff',
      pickup_service_type: 'Scheduled',
      pickup_service_level: 'Standard',
      pickup_date: day(pickup),
      pickup_timeslot: { start_time: '09:00', end_time: '22:00', timezone: 'Asia/Ho_Chi_Minh' },
      pickup_instructions: '',
      delivery_instructions: clip([req.note, req.allowInspection === 'deny' ? 'Không cho xem hàng' : ''].filter(Boolean).join('. '), 500),
      delivery_start_date: day(deliveryStart),
      delivery_timeslot: { start_time: '09:00', end_time: '22:00', timezone: 'Asia/Ho_Chi_Minh' },
      cash_on_delivery: vnd(req.parcel.codAmount) || undefined,
      insured_value: cfg.insure !== false ? vnd(req.parcel.value) || undefined : undefined,
      dimensions: { weight: toKg(req.parcel.weight), length: int(req.parcel.length, 1), width: int(req.parcel.width, 1), height: int(req.parcel.height, 1) },
      items: (req.parcel.items.length ? req.parcel.items : [{ name: 'Hàng hoá', quantity: 1 }]).map((i) => ({ item_description: clip(i.name, 255), quantity: int(i.quantity, 1), is_dangerous_good: false })),
    },
  };
}

export class NinjaVanCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'ninjavan',
    name: 'Ninja Van',
    description: 'Ninja Van Việt Nam — tạo đơn theo tên tỉnh/quận/phường, huỷ, in vận đơn PDF, webhook HMAC. Tính phí theo hợp đồng (không có API giá công khai theo địa chỉ).',
    website: 'https://www.ninjavan.co/vi-vn',
    docsUrl: 'https://api-docs.ninjavan.co',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true, help: 'Ninja Dashboard › Settings › IT Settings. Sandbox dùng tài khoản tại https://aaa-sandbox.ninjavan.co/SG (chỉ country SG).' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, help: 'Cũng dùng để xác minh chữ ký webhook X-Ninjavan-Hmac-Sha256.' },
      { key: 'serviceLevel', label: 'Mức dịch vụ mặc định', type: 'select', default: 'Standard', options: [{ value: 'Standard', label: 'Standard' }, { value: 'Express', label: 'Express' }, { value: 'Nextday', label: 'Nextday' }, { value: 'Sameday', label: 'Sameday' }] },
      { key: 'flatFee', label: 'Phí hiển thị ở checkout (VND)', type: 'number', default: 0, help: 'Ninja Van không có API tính phí theo địa chỉ; nhập phí cố định theo hợp đồng (0 = không báo giá).' },
      { key: 'insure', label: 'Khai giá bảo hiểm theo giá trị đơn', type: 'boolean', default: true },
      { key: 'postcode', label: 'Mã bưu chính mặc định', type: 'text', default: '100000' },
      { key: 'countryCode', label: 'Mã quốc gia sandbox', type: 'text', env: 'sandbox', default: 'SG' },
      { key: 'sandboxUrl', label: 'URL API sandbox', type: 'url', env: 'sandbox', default: URLS.sandbox },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', default: URLS.production },
    ],
    capabilities: { rates: true, services: false, leadtime: false, create: true, track: true, cancel: true, label: true, webhook: true, locations: false, testConnection: true },
    addressLevels: 3,
    notes: [
      'Trước khi lên production phải nộp 3 đơn test qua audit portal của Ninja Van (1–3 tuần).',
      'Tính phí: API Tariff cần l1/l2 tier code nội bộ của Ninja Van nên chưa dùng; báo giá ở checkout dùng "Phí hiển thị" cố định.',
      'Webhook đăng ký ở Ninja Dashboard › IT Settings › Webhooks; hệ thống xác minh HMAC bằng Client Secret. Cần xác minh định dạng response API tracking-events.',
    ],
  };

  private url(cfg: CarrierConfig, path: string) {
    return `${baseUrl(cfg, URLS)}${path}`;
  }

  private cacheKey(cfg: CarrierConfig) {
    return `${str(cfg.clientId)}|${baseUrl(cfg, URLS)}`;
  }

  private async login(cfg: CarrierConfig): Promise<string> {
    const res = await call<{ access_token?: string; expires_in?: number; error?: unknown }>(this.url(cfg, '/2.0/oauth/access_token'), { method: 'POST', body: { client_id: str(cfg.clientId), client_secret: str(cfg.clientSecret), grant_type: 'client_credentials' } }, 'Lấy token Ninja Van');
    if (!res.ok || !res.data?.access_token) throw new ShippingCarrierError(`Lấy token Ninja Van thất bại: ${extractMessage(res.data) || `HTTP ${res.status}`}`, res.data, res.status >= 500);
    const ttl = Math.max(60_000, (Number(res.data.expires_in) || 3600) * 1000 - 5 * 60_000);
    return tokens.set(this.cacheKey(cfg), res.data.access_token, ttl);
  }

  private async token(cfg: CarrierConfig) {
    return tokens.get(this.cacheKey(cfg)) ?? (await this.login(cfg));
  }

  private async api<T = unknown>(cfg: CarrierConfig, path: string, opts: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {}, what = 'Gọi Ninja Van', retry = true): Promise<T> {
    const token = await this.token(cfg);
    const res = await call<T>(this.url(cfg, path), { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: opts.body, timeoutMs: 30_000 }, what);
    if (res.status === 401 && retry) {
      tokens.clear(this.cacheKey(cfg));
      return this.api<T>(cfg, path, opts, what, false);
    }
    if (!res.ok) {
      const details = (res.data as { error?: { details?: { message?: string }[] } })?.error?.details?.map((d) => d.message).filter(Boolean).join('; ');
      throw new ShippingCarrierError(`${what} thất bại (HTTP ${res.status}): ${[extractMessage(res.data), details].filter(Boolean).join(' — ') || res.text?.slice(0, 200)}`, res.data, res.status >= 500 || res.status === 429);
    }
    return res.data;
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      tokens.clear(this.cacheKey(cfg));
      await this.login(cfg);
      return { ok: true, message: 'Lấy token Ninja Van thành công.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /** Không có API giá theo địa chỉ -> phí cố định cấu hình (0 = không báo giá) */
  async getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    const fee = vnd(cfg.flatFee);
    if (fee <= 0) return [];
    const level = req.service || str(cfg.serviceLevel, 'Standard');
    return [{ carrier: 'ninjavan', serviceCode: level, serviceName: `Ninja Van ${level}`, fee, estimatedDays: level === 'Sameday' ? 1 : level === 'Nextday' ? 1 : level === 'Express' ? 2 : 3 }];
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = buildNinjaVanOrder(cfg, req);
    const d = await this.api<{ tracking_number?: string; granular_status?: string; service_level?: string }>(cfg, '/4.2/orders', { body }, 'Tạo đơn Ninja Van');
    if (!d?.tracking_number) throw new ShippingCarrierError('Ninja Van không trả về mã vận đơn', d);
    return { trackingCode: d.tracking_number, carrierOrderId: d.tracking_number, fee: vnd(cfg.flatFee), serviceName: `Ninja Van ${str(d.service_level ?? body.service_level)}`, trackingUrl: this.trackingUrl(cfg, { id: req.shipmentId, trackingCode: d.tracking_number }), status: mapNinjaVanStatus(d.granular_status), raw: d };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã Ninja Van');
    const d = await this.api<unknown>(cfg, `/1.0/orders/tracking-events/${encodeURIComponent(ref.trackingCode)}`, {}, 'Tra cứu Ninja Van');
    // response có thể là mảng event hoặc { events: [] } / { data: [] }
    const list = (Array.isArray(d) ? d : ((d as { events?: unknown[]; data?: unknown[] })?.events ?? (d as { data?: unknown[] })?.data ?? [])) as Record<string, unknown>[];
    const events: ShipmentEvent[] = list
      .map((e) => ({ status: mapNinjaVanStatus(e.status ?? e.event ?? e.event_type, e.is_parcel_on_rts_leg === true), statusCode: str(e.status ?? e.event ?? e.event_type) || null, message: str(e.comments ?? e.description) || null, location: str(e.hub_name ?? e.location) || null, at: parseDate(e.timestamp ?? e.created_at ?? e.time) ?? new Date() }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const last = events[events.length - 1];
    return { status: last?.status ?? 'PENDING', statusCode: last?.statusCode ?? null, message: last?.message ?? null, events, raw: d };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef): Promise<CancelShipmentResult> {
    if (!ref.trackingCode) return { ok: true, message: 'Chưa có mã Ninja Van, chỉ huỷ trong hệ thống' };
    try {
      const r = await this.api<{ status?: string }>(cfg, `/2.2/orders/${encodeURIComponent(ref.trackingCode)}`, { method: 'DELETE' }, 'Huỷ đơn Ninja Van');
      return { ok: true, message: r?.status ?? null, raw: r };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  async getLabel(cfg: CarrierConfig, ref: ShipmentRef): Promise<LabelResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã Ninja Van');
    const token = await this.token(cfg);
    const res = await call(this.url(cfg, `/2.0/reports/waybill?tid=${encodeURIComponent(ref.trackingCode)}&h=0&orientation=portrait`), { method: 'GET', headers: { Authorization: `Bearer ${token}` }, binary: true, timeoutMs: 60_000 }, 'In vận đơn Ninja Van');
    ensureOk(res, 'In vận đơn Ninja Van');
    return { buffer: res.buffer!, mimeType: 'application/pdf', fileName: `ninjavan-${ref.trackingCode}.pdf` };
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://www.ninjavan.co/vi-vn/tracking?id=${encodeURIComponent(ref.trackingCode)}` : null;
  }

  /** Webhook: xác minh HMAC rồi ánh xạ event/status */
  async parseWebhook(cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const raw = input.rawBody ?? (typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {}));
    if (!verifyNinjaVanHmac(raw, str(cfg.clientSecret), headerOf(input.headers, 'x-ninjavan-hmac-sha256'))) return null;
    const b = bodyObject(input.body, input.rawBody);
    const tracking = str(b.tracking_id ?? b.tracking_number);
    if (!tracking) return null;
    const rts = b.is_parcel_on_rts_leg === true;
    const statusText = str(b.status ?? b.event);
    const status = mapNinjaVanStatus(statusText, rts);
    const exception = b.delivery_exception as { failure_reason?: string } | undefined;
    return [
      {
        trackingCode: tracking,
        carrierOrderId: tracking,
        status,
        statusCode: statusText || null,
        message: [str(b.event), exception?.failure_reason, str(b.comments)].filter(Boolean).join(' — ') || null,
        at: parseDate(b.timestamp) ?? new Date(),
        raw: b,
      },
    ];
  }
}
