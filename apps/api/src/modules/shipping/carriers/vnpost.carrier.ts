/**
 * Adapter VNPost qua EMS Merchant API v2 (MyEMS — https://docs.ems.com.vn, tin cậy B).
 * EMS Việt Nam là công ty thành viên VNPost; API My VNPost (my.vnpost.vn) không công khai nên dùng EMS.
 *
 * - Xác thực: `?merchant_token=` trên mọi request (token tạo trong portal MyEMS).
 * - Địa chỉ: MÃ (/location/province, /location/district?province=, /location/ward?district=).
 * - Không có API tính cước công khai: phí (`total_fee`) và `estimated_delivery_time` trả về khi tạo bưu gửi -> rates = false.
 * - Webhook: không chữ ký, header `ems-transaction`; payload { TrackingCode, OrderCode, StatusCode, StatusName, Location, CreatedAt, Fees[] }.
 */
import type { CancelShipmentResult, CarrierConfig, CarrierLocation, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, NormalizedShipmentStatus, RateQuote, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, codesOf, describeItems, extractMessage, fold, int, parseDate, phoneVN, qs, str, totalQuantity, vnd } from './http.js';

const URLS = { sandbox: 'https://call.ems.com.vn', production: 'https://api.my.ems.com.vn' };

interface EmsEnvelope<T = unknown> {
  code?: string | number;
  message?: string;
  data?: T;
}

/** Mã trạng thái EMS đã biết (lấy đầy đủ từ GET /shipments/status khi tích hợp) */
const CODE_MAP: Record<string, NormalizedShipmentStatus> = { '1000': 'PENDING', '2000': 'PENDING' };

/** Ánh xạ theo mã rồi theo tên trạng thái (tiếng Việt / mã chữ như waitForPick) */
export function mapVnpostStatus(code: unknown, name?: unknown): NormalizedShipmentStatus {
  const c = String(code ?? '').trim();
  if (CODE_MAP[c]) return CODE_MAP[c];
  const n = fold(name ?? code);
  if (!n) return 'PENDING';
  if (n.includes('huy') || n.includes('cancel')) return 'CANCELLED';
  if (n.includes('hoan thanh cong') || n.includes('da hoan') || n.includes('returned')) return 'RETURNED';
  if (n.includes('chuyen hoan') || n.includes('hoan') || n.includes('return')) return 'RETURNING';
  if (n.includes('phat thanh cong') || n.includes('da phat') || n.includes('delivered')) return 'DELIVERED';
  if (n.includes('khong thanh cong') || n.includes('that bai') || n.includes('fail')) return 'FAILED';
  if (n.includes('dang phat') || n.includes('delivering')) return 'DELIVERING';
  if (n.includes('da lay') || n.includes('nhap kho') || n.includes('van chuyen') || n.includes('chap nhan') || n.includes('picked') || n.includes('transit')) return c === '2000' ? 'PENDING' : 'PICKED';
  if (n.includes('dang lay') || n.includes('picking')) return 'PICKING';
  if (n.includes('khoi tao') || n.includes('wait') || n.includes('cho lay')) return 'PENDING';
  return 'PENDING';
}

export class VnpostCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'vnpost',
    name: 'VNPost / EMS (Merchant API)',
    description: 'Bưu điện Việt Nam qua EMS Merchant API v2 (MyEMS): danh mục địa chỉ, tạo/huỷ bưu gửi, tra cứu, webhook. Phí trả về khi tạo bưu gửi.',
    website: 'https://my.ems.com.vn',
    docsUrl: 'https://docs.ems.com.vn',
    fields: [
      { key: 'merchantToken', label: 'Merchant token', type: 'password', required: true, help: 'Tạo trong portal MyEMS (production https://my.ems.com.vn, demo https://sale.ems.com.vn).' },
      { key: 'warehouseCode', label: 'Mã kho gửi (warehouse_code)', type: 'text', required: true, help: 'Kho đã khai báo trong MyEMS.' },
      { key: 'serviceType', label: 'Mã dịch vụ mặc định', type: 'text', default: '0', help: 'GET /services → code ("0" = Dịch vụ thường). Nút Kiểm tra kết nối sẽ liệt kê.' },
      { key: 'flatFee', label: 'Phí hiển thị ở checkout (VND)', type: 'number', default: 0, help: 'EMS không có API tính cước trước; nhập phí ước tính (0 = không báo giá).' },
      { key: 'sandboxUrl', label: 'URL API sandbox', type: 'url', env: 'sandbox', default: URLS.sandbox },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', default: URLS.production },
    ],
    capabilities: { rates: true, services: false, leadtime: false, create: true, track: true, cancel: true, label: false, webhook: true, locations: true, testConnection: true },
    addressLevels: 3,
    notes: [
      'API My VNPost (my.vnpost.vn) không công khai — adapter này dùng EMS Merchant API; VNPost thường cũng có thể đi qua GoShip (vnp/ems).',
      'Webhook cấu hình trong portal MyEMS, không chữ ký → dán URL kèm ?key=<khoá webhook>. EMS mong nhận {"code":"success","transaction":<ems-transaction>} — cần xác minh hệ thống trả 200 là đủ.',
      'Chỉ huỷ được khi bưu gửi còn "Chờ lấy hàng". Không có API in nhãn (in từ portal).',
    ],
  };

  private url(cfg: CarrierConfig, path: string, extra: Record<string, unknown> = {}) {
    return `${baseUrl(cfg, URLS)}${path}${qs({ merchant_token: str(cfg.merchantToken), ...extra })}`;
  }

  private async api<T = unknown>(cfg: CarrierConfig, path: string, opts: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, unknown> } = {}, what = 'Gọi EMS'): Promise<T> {
    const res = await call<EmsEnvelope<T> | T>(this.url(cfg, path, opts.query), { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: opts.body, timeoutMs: 30_000 }, what);
    const env = (res.data ?? {}) as EmsEnvelope<T>;
    if (!res.ok || env.code === 'error') throw new ShippingCarrierError(`${what} thất bại (HTTP ${res.status}): ${extractMessage(res.data) || res.text?.slice(0, 200)}`, res.data, res.status >= 500);
    return (env.data !== undefined ? env.data : res.data) as T;
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      const profile = await this.api<Record<string, unknown>>(cfg, '/profile', {}, 'Lấy hồ sơ MyEMS');
      const services = await this.api<{ code: string; name: string }[]>(cfg, '/services', {}, 'Lấy dịch vụ EMS').catch(() => []);
      return { ok: true, message: `Kết nối EMS thành công${profile?.name ? `: ${str(profile.name)}` : ''}.`, details: { services: Array.isArray(services) ? services : [] } };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listLocations(cfg: CarrierConfig, level: 1 | 2 | 3, parentCode?: string | null): Promise<CarrierLocation[]> {
    const path = level === 1 ? '/location/province' : level === 2 ? '/location/district' : '/location/ward';
    const query = level === 2 ? { province: parentCode } : level === 3 ? { district: parentCode } : {};
    const rows = await this.api<{ code: string | number; name: string }[]>(cfg, path, { query }, 'Lấy danh mục địa chỉ EMS');
    return (Array.isArray(rows) ? rows : []).map((r) => ({ code: String(r.code), name: r.name, parentCode: level === 1 ? null : (parentCode ?? null) }));
  }

  /** Không có API tính cước trước -> phí cố định cấu hình */
  async getRates(cfg: CarrierConfig): Promise<RateQuote[]> {
    const fee = vnd(cfg.flatFee);
    if (fee <= 0) return [];
    return [{ carrier: 'vnpost', serviceCode: str(cfg.serviceType, '0'), serviceName: 'EMS / VNPost', fee, estimatedDays: null }];
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const t = codesOf(req.to, 'vnpost');
    if (!t.province || !t.district || !t.ward) throw new ShippingCarrierError('Địa chỉ nhận chưa có mã tỉnh/quận/phường EMS — hãy đồng bộ danh mục địa chỉ VNPost/EMS.');
    const cod = vnd(req.parcel.codAmount);
    const body = {
      warehouse_code: str(cfg.warehouseCode),
      order_code: clip(req.orderCode, 50),
      to_name: clip(req.to.name, 100),
      to_phone: phoneVN(req.to.phone),
      to_address: clip(addressLine(req.to), 250),
      to_province: t.province,
      to_district: t.district,
      to_ward: t.ward,
      service_type: req.service || str(cfg.serviceType, '0'),
      addition_service: cod > 0 ? ['COD'] : [],
      money_collect: cod,
      payment_config: req.payer === 'customer' ? 1 : 0,
      can_check: req.allowInspection !== 'deny',
      is_fragile: false,
      description: clip([describeItems(req.parcel.items), req.note].filter(Boolean).join('. '), 250),
      is_related_product: false,
      product_name: describeItems(req.parcel.items, 100),
      total_amount: vnd(req.parcel.value),
      total_quantity: totalQuantity(req.parcel.items),
      total_weight: int(req.parcel.weight, 1),
    };
    const d = await this.api<{ code?: string; state?: string | number; status?: string; total_fee?: number | string; estimated_delivery_time?: string }>(cfg, '/shipments', { body }, 'Tạo bưu gửi EMS');
    if (!d?.code) throw new ShippingCarrierError('EMS không trả về mã bưu gửi', d);
    return { trackingCode: String(d.code), carrierOrderId: String(d.code), fee: vnd(d.total_fee), serviceName: 'EMS / VNPost', expectedDeliveryAt: parseDate(d.estimated_delivery_time), trackingUrl: this.trackingUrl(cfg, { id: req.shipmentId, trackingCode: String(d.code) }), status: mapVnpostStatus(d.state, d.status), raw: d };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Bưu gửi chưa có mã EMS');
    const d = await this.api<{ code?: string; status?: string; status_code?: string | number; status_name?: string; total_fee?: number; money_collect?: number; updated_at?: string; created_at?: string }>(cfg, '/shipments/detail', { query: { code: ref.trackingCode } }, 'Tra cứu bưu gửi EMS');
    const status = mapVnpostStatus(d.status_code, d.status_name ?? d.status);
    const at = parseDate(d.updated_at ?? d.created_at) ?? new Date();
    return { status, statusCode: str(d.status_code ?? d.status) || null, message: d.status_name ?? d.status ?? null, events: [{ status, statusCode: str(d.status_code ?? d.status) || null, message: d.status_name ?? d.status ?? null, at }], fee: d.total_fee != null ? vnd(d.total_fee) : null, codCollected: status === 'DELIVERED' ? vnd(d.money_collect) : null, raw: d };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef): Promise<CancelShipmentResult> {
    if (!ref.trackingCode) return { ok: true, message: 'Chưa có mã EMS, chỉ huỷ trong hệ thống' };
    try {
      const r = await this.api<unknown>(cfg, '/shipments/cancel', { method: 'POST', body: {}, query: { code: ref.trackingCode } }, 'Huỷ bưu gửi EMS');
      return { ok: true, raw: r };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://ems.com.vn/tra-cuu-buu-gui?code=${encodeURIComponent(ref.trackingCode)}` : null;
  }

  /** Webhook EMS: PascalCase, không chữ ký */
  async parseWebhook(_cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const b = bodyObject(input.body, input.rawBody);
    const tracking = str(b.TrackingCode ?? b.tracking_code);
    if (!tracking) return null;
    const fees = Array.isArray(b.Fees) ? (b.Fees as { FeeCode?: string; FeeValue?: number | string }[]) : [];
    const total = fees.reduce((s, f) => s + vnd(f.FeeValue), 0);
    const status = mapVnpostStatus(b.StatusCode, b.StatusName);
    return [
      {
        trackingCode: tracking,
        carrierOrderId: tracking,
        status,
        statusCode: b.StatusCode != null ? String(b.StatusCode) : null,
        message: str(b.StatusName) || null,
        location: str(b.Location) || null,
        at: parseDate(b.CreatedAt) ?? new Date(),
        fee: total > 0 ? total : null,
        raw: b,
      },
    ];
  }
}
