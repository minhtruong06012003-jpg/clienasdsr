/**
 * Adapter GoShip — cổng tổng hợp nhiều hãng (Viettel Post, EMS, VNPost, GHTK, GHN, SPX, BEST, J&T...) — https://doc.goship.io (tin cậy A).
 *
 * - Đăng nhập: POST /login { username, password, client_id, client_secret } -> Bearer (hiệu lực dài), cache theo tài khoản.
 * - Địa chỉ: MÃ GoShip (/cities, /cities/{id}/districts, /districts/{id}/wards).
 * - Tính phí: POST /rates -> mỗi rate (hãng + dịch vụ) một báo giá; `id` của rate dùng để tạo đơn.
 * - Tạo đơn bất đồng bộ: mã hãng (tracking_number) có thể đến sau qua webhook; status 1000 = lỗi gửi hãng.
 * - Webhook: HMAC-SHA256 trên body, header `x-goship-hmac-sha256`.
 */
import type { CancelShipmentResult, CarrierConfig, CarrierLocation, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, NormalizedShipmentStatus, RateQuote, RateRequest, ShipmentEvent, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, codesOf, describeItems, extractMessage, headerOf, hmacSha256Base64, hmacSha256Hex, hoursFromNow, int, parseDate, parseEstimatedDays, phoneVN, safeEqual, str, TokenCache, vnd } from './http.js';

const URLS = { sandbox: 'https://sandbox.goship.io/api/v2', production: 'https://api.goship.io/api/v2' };
const tokens = new TokenCache<string>();

interface GsEnvelope<T = unknown> {
  code?: number;
  status?: string;
  message?: string;
  data?: T;
}

/** Mã trạng thái GoShip -> chuẩn */
const STATUS_MAP: Record<string, NormalizedShipmentStatus> = {
  '900': 'PENDING',
  '901': 'PENDING',
  '902': 'PENDING',
  '903': 'PICKING',
  '904': 'PICKED',
  '905': 'DELIVERING',
  '906': 'DELIVERED',
  '910': 'DELIVERED',
  '907': 'FAILED',
  '908': 'RETURNING',
  '909': 'RETURNED',
  '911': 'CANCELLED',
  '1000': 'FAILED',
};

export function mapGoshipStatus(code: unknown): NormalizedShipmentStatus {
  return STATUS_MAP[String(code ?? '').trim()] ?? 'PENDING';
}

/** Xác minh HMAC webhook GoShip: chấp nhận base64 hoặc hex của HMAC-SHA256(body, secret) */
export function verifyGoshipHmac(rawBody: string, secret: string, header: string | null | undefined): boolean {
  if (!header || !secret) return false;
  const h = header.trim();
  return safeEqual(h, hmacSha256Base64(rawBody, secret)) || safeEqual(h.toLowerCase(), hmacSha256Hex(rawBody, secret));
}

interface GsRate {
  id: string;
  carrier_name?: string;
  carrier_short_name?: string;
  carrier_logo?: string;
  service?: string;
  expected?: string;
  total_fee?: number | string;
  total_amount?: number | string;
  cod_fee?: number | string;
  service_fee?: number | string;
  insurance_fee?: number | string;
  own_account?: number;
}

export class GoshipCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'goship',
    name: 'GoShip (tổng hợp nhiều hãng)',
    description: 'Một tài khoản GoShip để tạo đơn qua Viettel Post, EMS/VNPost, GHTK, GHN, SPX, BEST, J&T... So giá nhiều hãng trong một lần tính phí.',
    website: 'https://goship.io',
    docsUrl: 'https://doc.goship.io',
    fields: [
      { key: 'username', label: 'Tên đăng nhập (email)', type: 'text', required: true, help: 'Tài khoản GoShip (production: https://shop.goship.io, sandbox: https://dev-shop.goship.io).' },
      { key: 'password', label: 'Mật khẩu', type: 'password', required: true },
      { key: 'clientId', label: 'Client ID', type: 'text', required: true, help: 'Developer Dashboard › API Credentials.' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
      { key: 'webhookSecret', label: 'Secret ký webhook', type: 'password', help: 'Secret trong mục Webhooks của Developer Dashboard. Để trống → dùng Client Secret để xác minh x-goship-hmac-sha256.' },
      { key: 'carriers', label: 'Chỉ hiện các hãng (mã, phẩy)', type: 'text', placeholder: 'vtp,ghtk,ghnv3,jnt', help: 'Lọc carrier_short_name: vtp, ems, vnp, ghtk, ghnv3, shopee, best, tikinow, jnt, jnt2. Trống = tất cả.' },
      { key: 'sandboxUrl', label: 'URL API sandbox', type: 'url', env: 'sandbox', default: URLS.sandbox },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', default: URLS.production },
    ],
    capabilities: { rates: true, services: true, leadtime: true, create: true, track: true, cancel: true, label: false, webhook: true, locations: true, testConnection: true },
    addressLevels: 3,
    notes: [
      'Mã dịch vụ (serviceCode) là id của rate do GoShip trả về khi tính phí, vì vậy luôn tính phí ngay trước khi tạo đơn.',
      'Sandbox không bắn webhook. Webhook đăng ký ở https://dev-shop.goship.io/developers hoặc API POST /webhooks; dán URL kèm ?key=<khoá webhook>.',
      'Không có API in nhãn: in trên portal GoShip hoặc dùng mã của hãng. Cần xác minh định dạng (base64/hex) của header x-goship-hmac-sha256.',
    ],
  };

  private url(cfg: CarrierConfig, path: string) {
    return `${baseUrl(cfg, URLS)}${path}`;
  }

  private cacheKey(cfg: CarrierConfig) {
    return `${str(cfg.username)}|${str(cfg.clientId)}|${baseUrl(cfg, URLS)}`;
  }

  private async login(cfg: CarrierConfig): Promise<string> {
    const res = await call<{ access_token?: string; expires_in?: number; message?: string }>(this.url(cfg, '/login'), { method: 'POST', headers: { Accept: 'application/json' }, body: { username: str(cfg.username), password: str(cfg.password), client_id: str(cfg.clientId), client_secret: str(cfg.clientSecret) } }, 'Đăng nhập GoShip');
    if (!res.ok || !res.data?.access_token) throw new ShippingCarrierError(`Đăng nhập GoShip thất bại: ${extractMessage(res.data) || `HTTP ${res.status}`}`, res.data, res.status >= 500);
    const ttl = Math.min(30 * 86_400_000, Math.max(3600_000, (Number(res.data.expires_in) || 86_400) * 1000 - 60_000));
    return tokens.set(this.cacheKey(cfg), res.data.access_token, ttl);
  }

  private async api<T = unknown>(cfg: CarrierConfig, path: string, opts: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {}, what = 'Gọi GoShip', retry = true): Promise<T> {
    const token = tokens.get(this.cacheKey(cfg)) ?? (await this.login(cfg));
    const res = await call<GsEnvelope<T>>(this.url(cfg, path), { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: opts.body, timeoutMs: 30_000 }, what);
    if (res.status === 401 && retry) {
      tokens.clear(this.cacheKey(cfg));
      return this.api<T>(cfg, path, opts, what, false);
    }
    const env = (res.data ?? {}) as GsEnvelope<T>;
    if (!res.ok || (env.code !== undefined && Number(env.code) >= 400) || env.status === 'error') throw new ShippingCarrierError(`${what} thất bại: ${extractMessage(env) || res.text?.slice(0, 200) || `HTTP ${res.status}`}`, env, res.status >= 500);
    return (env.data !== undefined ? env.data : res.data) as T;
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      tokens.clear(this.cacheKey(cfg));
      await this.login(cfg);
      const cities = await this.api<{ id: string; name: string }[]>(cfg, '/cities', {}, 'Lấy danh sách tỉnh GoShip');
      return { ok: true, message: `Đăng nhập GoShip thành công (${Array.isArray(cities) ? cities.length : 0} tỉnh/thành).` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listLocations(cfg: CarrierConfig, level: 1 | 2 | 3, parentCode?: string | null): Promise<CarrierLocation[]> {
    const path = level === 1 ? '/cities' : level === 2 ? `/cities/${encodeURIComponent(str(parentCode))}/districts` : `/districts/${encodeURIComponent(str(parentCode))}/wards`;
    const rows = await this.api<{ id: string | number; name: string }[]>(cfg, path, {}, 'Lấy danh mục địa chỉ GoShip');
    return (Array.isArray(rows) ? rows : []).map((r) => ({ code: String(r.id), name: r.name, parentCode: level === 1 ? null : (parentCode ?? null) }));
  }

  private shipmentBody(req: RateRequest) {
    const f = codesOf(req.from, 'goship');
    const t = codesOf(req.to, 'goship');
    if (!t.province) throw new ShippingCarrierError('Địa chỉ nhận chưa có mã GoShip — hãy đồng bộ danh mục địa chỉ GoShip.');
    if (!f.province) throw new ShippingCarrierError('Địa chỉ kho chưa có mã GoShip.');
    return {
      address_from: { district: f.district, city: f.province },
      address_to: { district: t.district, city: t.province },
      parcel: { cod: vnd(req.parcel.codAmount), amount: vnd(req.parcel.value), width: int(req.parcel.width, 1), height: int(req.parcel.height, 1), length: int(req.parcel.length, 1), weight: int(req.parcel.weight, 1) },
    };
  }

  private async rates(cfg: CarrierConfig, req: RateRequest): Promise<GsRate[]> {
    const data = await this.api<GsRate[]>(cfg, '/rates', { body: { shipment: this.shipmentBody(req) } }, 'Tính phí GoShip');
    const filter = str(cfg.carriers)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return (Array.isArray(data) ? data : []).filter((r) => r.id && (!filter.length || filter.includes(String(r.carrier_short_name ?? '').toLowerCase())));
  }

  private toQuote(r: GsRate): RateQuote {
    const days = parseEstimatedDays(r.expected);
    return {
      carrier: 'goship',
      carrierName: r.carrier_name ? `${r.carrier_name} (qua GoShip)` : undefined,
      serviceCode: String(r.id),
      serviceName: [r.carrier_name, r.service].filter(Boolean).join(' — ') || 'Dịch vụ',
      fee: vnd(r.total_fee ?? r.total_amount),
      breakdown: { base: vnd(r.service_fee), cod: vnd(r.cod_fee), insurance: vnd(r.insurance_fee) },
      estimatedDays: days,
      expectedDeliveryAt: days ? hoursFromNow(days * 24) : null,
      raw: r,
    };
  }

  async getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    const rates = await this.rates(cfg, req);
    const list = req.service ? rates.filter((r) => String(r.id) === req.service || `${r.carrier_short_name}:${r.service}` === req.service) : rates;
    return list.map((r) => this.toQuote(r));
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    let rateId = req.service;
    let rate: GsRate | undefined;
    // serviceCode dạng "hãng:dịch vụ" (hoặc rate cũ) -> tính phí lại để lấy rate id mới
    if (!rateId || rateId.includes(':')) {
      const rates = await this.rates(cfg, req);
      rate = rates.find((r) => `${r.carrier_short_name}:${r.service}` === rateId) ?? rates.sort((a, b) => vnd(a.total_fee) - vnd(b.total_fee))[0];
      if (!rate) throw new ShippingCarrierError('GoShip không có dịch vụ nào cho tuyến này');
      rateId = String(rate.id);
    }
    const base = this.shipmentBody(req);
    const f = codesOf(req.from, 'goship');
    const t = codesOf(req.to, 'goship');
    const body = {
      shipment: {
        rate: rateId,
        payer: req.payer === 'customer' ? 0 : 1,
        order_id: clip(req.orderCode, 50),
        is_recall: 0,
        address_from: { name: clip(req.from.name, 100), phone: phoneVN(req.from.phone), street: clip(addressLine(req.from), 200), ward: f.ward, district: f.district, city: f.province },
        address_to: { name: clip(req.to.name, 100), phone: phoneVN(req.to.phone), street: clip(addressLine(req.to), 200), ward: t.ward, district: t.district, city: t.province },
        parcel: { ...base.parcel, metadata: clip([describeItems(req.parcel.items), req.note].filter(Boolean).join('. '), 250) },
      },
    };
    const d = await this.api<{ id: string; shipment_status?: number; shipment_status_txt?: string; fee?: number | string; tracking_number?: string | null; carrier?: string; carrier_short_name?: string; sorting_code?: string }>(cfg, '/shipments', { body }, 'Tạo đơn GoShip');
    if (!d?.id) throw new ShippingCarrierError('GoShip không trả về mã đơn', d);
    return {
      trackingCode: d.tracking_number || d.id,
      carrierOrderId: d.id,
      fee: vnd(d.fee ?? rate?.total_fee),
      serviceName: rate ? [rate.carrier_name, rate.service].filter(Boolean).join(' — ') : d.carrier ? `${d.carrier} (qua GoShip)` : null,
      status: d.shipment_status != null ? mapGoshipStatus(d.shipment_status) : 'PENDING',
      raw: d,
    };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    const code = ref.carrierOrderId || ref.trackingCode;
    if (!code) throw new ShippingCarrierError('Vận đơn chưa có mã GoShip');
    const data = await this.api<unknown>(cfg, `/shipments/search?code=${encodeURIComponent(code)}`, {}, 'Tra cứu đơn GoShip');
    const o = (Array.isArray(data) ? data[0] : data) as { id?: string; status?: number; shipment_status?: number; status_text?: string; shipment_status_txt?: string; tracking_number?: string; fee?: number; cod?: number; updated_at?: string | number } | undefined;
    if (!o) throw new ShippingCarrierError('GoShip không tìm thấy đơn', data);
    const code2 = o.status ?? o.shipment_status;
    const status = mapGoshipStatus(code2);
    const at = parseDate(o.updated_at) ?? new Date();
    const events: ShipmentEvent[] = [{ status, statusCode: code2 != null ? String(code2) : null, message: o.status_text ?? o.shipment_status_txt ?? null, at }];
    return { status, statusCode: code2 != null ? String(code2) : null, message: o.status_text ?? o.shipment_status_txt ?? null, events, fee: o.fee != null ? vnd(o.fee) : null, codCollected: status === 'DELIVERED' && o.cod != null ? vnd(o.cod) : null, raw: o };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef): Promise<CancelShipmentResult> {
    const id = ref.carrierOrderId || ref.trackingCode;
    if (!id) return { ok: true, message: 'Chưa có mã GoShip, chỉ huỷ trong hệ thống' };
    try {
      const r = await this.api<unknown>(cfg, `/shipments/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Huỷ đơn GoShip');
      return { ok: true, raw: r };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    const fromWebhook = (ref.meta?.lastWebhook as { tracking_url?: string } | undefined)?.tracking_url;
    return fromWebhook || null;
  }

  /** Webhook GoShip: HMAC-SHA256 header x-goship-hmac-sha256 (secret webhook hoặc client secret) */
  async parseWebhook(cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const secret = str(cfg.webhookSecret) || str(cfg.clientSecret);
    const sig = headerOf(input.headers, 'x-goship-hmac-sha256');
    if (sig || secret) {
      const raw = input.rawBody ?? (typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {}));
      if (!verifyGoshipHmac(raw, secret, sig)) return null;
    }
    const b = bodyObject(input.body, input.rawBody);
    const gcode = str(b.gcode);
    const carrierCode = str(b.code);
    if (!gcode && !carrierCode) return null;
    const status = mapGoshipStatus(b.status);
    return [
      {
        trackingCode: carrierCode || gcode,
        carrierOrderId: gcode || null,
        status,
        statusCode: b.status != null ? String(b.status) : null,
        message: [str(b.status_text), b.is_lost ? 'Thất lạc' : '', b.is_return ? 'Hoàn hàng' : ''].filter(Boolean).join(' — ') || null,
        at: parseDate(b.update_time) ?? new Date(),
        fee: b.fee != null && b.fee !== '' ? vnd(b.fee) : null,
        codCollected: status === 'DELIVERED' && b.cod != null ? vnd(b.cod) : null,
        raw: b,
      },
    ];
  }
}
