/**
 * Adapter Viettel Post — Partner API v2 (https://partner.viettelpost.vn/v2; tài liệu https://partner2.viettelpost.vn/document, tin cậy B).
 *
 * - Đăng nhập: POST /user/Login (token ngắn) -> POST /user/ownerconnect (token dài hạn ~1 năm); cache theo username + môi trường.
 * - Header: `Token: <token>` (không phải Bearer). Response `{ status, error, message, data }` — HTTP có thể 200 nhưng `error: true`.
 * - Địa chỉ: MÃ số của VTP (PROVINCE_ID / DISTRICT_ID / WARDS_ID) từ /categories/*.
 * - Tính phí: POST /order/getPriceAll -> mỗi MA_DV_CHINH một dịch vụ.
 * - Tra cứu: không có API pull công khai -> capabilities.track = false, dựa vào webhook.
 */
import type { CancelShipmentResult, CarrierConfig, CarrierLocation, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, LabelResult, NormalizedShipmentStatus, RateQuote, RateRequest, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, codesOf, describeItems, headerOf, hoursFromNow, int, parseDate, parseEstimatedDays, phoneVN, qs, safeEqual, str, TokenCache, vnd } from './http.js';

const URLS = { sandbox: 'https://partnerdev.viettelpost.vn/v2', production: 'https://partner.viettelpost.vn/v2' };

/** Token dài hạn cache theo "username|env|url" (24h, ownerconnect thực tế ~1 năm) */
const tokens = new TokenCache<string>();
const TOKEN_TTL = 24 * 3600_000;

interface VtpEnvelope<T = unknown> {
  status?: number;
  error?: boolean;
  message?: string;
  data?: T;
}

/** ORDER_STATUS Viettel Post -> chuẩn (theo tài liệu webhook + tài liệu TMĐT) */
const STATUS_MAP: Record<string, NormalizedShipmentStatus> = {
  '-100': 'PENDING',
  '100': 'PENDING',
  '103': 'PICKING',
  '104': 'PICKING',
  '102': 'FAILED',
  '101': 'CANCELLED',
  '107': 'CANCELLED',
  '201': 'CANCELLED',
  '200': 'PICKED',
  '202': 'PICKED',
  '300': 'PICKED',
  '400': 'PICKED',
  '500': 'DELIVERING',
  '507': 'DELIVERING',
  '508': 'DELIVERING',
  '550': 'DELIVERING',
  '509': 'PICKED',
  '506': 'FAILED',
  '501': 'DELIVERED',
  '505': 'RETURNING',
  '515': 'RETURNING',
  '504': 'RETURNED',
  '503': 'FAILED',
};

/** Ánh xạ mã VTP -> chuẩn; mã lạ suy theo nhóm trăm (1xx lấy, 3xx/4xx vận chuyển, 5xx phát) */
export function mapViettelPostStatus(code: unknown): NormalizedShipmentStatus {
  const s = String(code ?? '').trim();
  if (STATUS_MAP[s]) return STATUS_MAP[s];
  const n = Number(s);
  if (!Number.isFinite(n)) return 'PENDING';
  if (n < 100) return 'PENDING';
  if (n < 200) return 'PICKING';
  if (n < 500) return 'PICKED';
  if (n < 600) return 'DELIVERING';
  return 'PENDING';
}

/** ORDER_PAYMENT: 1 không thu, 2 thu tiền hàng + cước, 3 chỉ thu tiền hàng, 4 chỉ thu cước */
export function vtpOrderPayment(codAmount: number, payer: 'shop' | 'customer' | undefined): 1 | 2 | 3 | 4 {
  const cod = codAmount > 0;
  if (cod) return payer === 'customer' ? 2 : 3;
  return payer === 'customer' ? 4 : 1;
}

/** "dd/MM/yyyy HH:mm:ss" theo giờ VN */
function vtpDate(d: Date): string {
  const vn = new Date(d.getTime() + 7 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(vn.getUTCDate())}/${p(vn.getUTCMonth() + 1)}/${vn.getUTCFullYear()} ${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}:${p(vn.getUTCSeconds())}`;
}

/** Dựng body createOrder (export để test) */
export function buildViettelPostOrder(cfg: CarrierConfig, req: CreateShipmentRequest, fee = 0): Record<string, unknown> {
  const { from, to, parcel } = req;
  const f = codesOf(from, 'viettelpost');
  const t = codesOf(to, 'viettelpost');
  const items = parcel.items.length ? parcel.items : [{ name: 'Hàng hoá', quantity: 1, price: parcel.value, weight: parcel.weight }];
  return {
    ORDER_NUMBER: clip(req.orderCode, 50),
    GROUPADDRESS_ID: Number(cfg.groupAddressId) || undefined,
    CUS_ID: Number(cfg.cusId) || undefined,
    DELIVERY_DATE: vtpDate(req.pickupAt ? new Date(req.pickupAt) : new Date()),
    SENDER_FULLNAME: clip(from.name, 100),
    SENDER_ADDRESS: clip(addressLine(from, true), 250),
    SENDER_PHONE: phoneVN(from.phone),
    SENDER_EMAIL: from.email || undefined,
    SENDER_PROVINCE: Number(f.province) || undefined,
    SENDER_DISTRICT: Number(f.district) || undefined,
    SENDER_WARD: Number(f.ward) || undefined,
    RECEIVER_FULLNAME: clip(to.name, 100),
    RECEIVER_ADDRESS: clip(addressLine(to, true), 250),
    RECEIVER_PHONE: phoneVN(to.phone),
    RECEIVER_EMAIL: to.email || undefined,
    RECEIVER_PROVINCE: Number(t.province) || undefined,
    RECEIVER_DISTRICT: Number(t.district) || undefined,
    RECEIVER_WARD: Number(t.ward) || undefined,
    PRODUCT_NAME: describeItems(items, 100),
    PRODUCT_DESCRIPTION: describeItems(items, 250),
    PRODUCT_QUANTITY: items.reduce((s, i) => s + int(i.quantity, 1), 0),
    PRODUCT_PRICE: vnd(parcel.value),
    PRODUCT_WEIGHT: int(parcel.weight, 1),
    PRODUCT_LENGTH: int(parcel.length, 0),
    PRODUCT_WIDTH: int(parcel.width, 0),
    PRODUCT_HEIGHT: int(parcel.height, 0),
    PRODUCT_TYPE: 'HH',
    ORDER_PAYMENT: vtpOrderPayment(vnd(parcel.codAmount), req.payer),
    ORDER_SERVICE: req.service || str(cfg.defaultService, 'VCN'),
    ORDER_SERVICE_ADD: '',
    ORDER_VOUCHER: '',
    ORDER_NOTE: clip([req.note, req.allowInspection === 'deny' ? 'Không cho xem hàng' : req.allowInspection === 'try' ? 'Cho thử hàng' : 'Cho xem hàng'].filter(Boolean).join('. '), 250),
    MONEY_COLLECTION: vnd(parcel.codAmount),
    MONEY_TOTALFEE: vnd(fee),
    MONEY_FEECOD: 0,
    MONEY_FEEVAS: 0,
    MONEY_FEEINSURRANCE: 0,
    MONEY_FEE: vnd(fee),
    MONEY_FEEOTHER: 0,
    MONEY_TOTALVAT: 0,
    MONEY_TOTAL: vnd(fee),
    LIST_ITEM: items.map((i) => ({ PRODUCT_NAME: clip(i.name, 100), PRODUCT_PRICE: vnd(i.price), PRODUCT_WEIGHT: int(i.weight ?? 0, 0), PRODUCT_QUANTITY: int(i.quantity, 1) })),
  };
}

export class ViettelPostCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'viettelpost',
    name: 'Viettel Post',
    description: 'Viettel Post Partner API v2 — danh mục địa chỉ VTP, tính phí mọi dịch vụ (VCN, VTK, VHT...), tạo/huỷ vận đơn, in vận đơn, webhook trạng thái.',
    website: 'https://viettelpost.vn',
    docsUrl: 'https://partner2.viettelpost.vn/document',
    fields: [
      { key: 'username', label: 'Tên đăng nhập (số điện thoại/email)', type: 'text', required: true, help: 'Tài khoản ViettelPost đã đăng ký đối tác API (https://partner.viettelpost.vn). Sandbox: tài khoản test do VTP cấp cho partnerdev.' },
      { key: 'password', label: 'Mật khẩu', type: 'password', required: true },
      { key: 'groupAddressId', label: 'Mã kho gửi (GROUPADDRESS_ID)', type: 'text', help: 'Lấy từ GET /user/listInventory sau khi đăng nhập (nút Kiểm tra kết nối liệt kê kho). Để trống sẽ dùng kho đầu tiên.' },
      { key: 'cusId', label: 'Mã khách hàng (CUS_ID)', type: 'text', help: 'Cũng có trong /user/listInventory; để trống sẽ tự lấy.' },
      { key: 'defaultService', label: 'Mã dịch vụ mặc định', type: 'text', default: 'VCN', help: 'VCN nhanh, VTK tiết kiệm, VHT hoả tốc, PHS/PTN nội tỉnh...' },
      { key: 'webhookToken', label: 'Token webhook (TOKEN trong payload)', type: 'password', help: 'Chuỗi bí mật bạn khai báo khi cấu hình webhook trên portal; để trống thì không đối chiếu.' },
      { key: 'sandboxUrl', label: 'URL API dev', type: 'url', env: 'sandbox', default: URLS.sandbox },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', default: URLS.production },
    ],
    capabilities: { rates: true, services: true, leadtime: true, create: true, track: false, cancel: true, label: true, webhook: true, locations: true, testConnection: true },
    addressLevels: 3,
    notes: [
      'Viettel Post không có API tra cứu trạng thái công khai: trạng thái cập nhật qua webhook (1 URL/tài khoản, cấu hình trên portal Partner). Dán URL kèm ?key=<khoá webhook>.',
      'Tính phí yêu cầu cả kho và người nhận đã có mã tỉnh/quận VTP → bấm "Đồng bộ địa chỉ" từ Viettel Post.',
      'Cần xác minh với tài khoản thật: định dạng response /order/printing-code (url/token) và link tra cứu công khai.',
    ],
  };

  private url(cfg: CarrierConfig, path: string) {
    return `${baseUrl(cfg, URLS)}${path}`;
  }

  private cacheKey(cfg: CarrierConfig) {
    return `${str(cfg.username)}|${cfg.environment}|${baseUrl(cfg, URLS)}`;
  }

  /** Đăng nhập lấy token dài hạn (ownerconnect); fallback token ngắn nếu ownerconnect lỗi */
  private async login(cfg: CarrierConfig): Promise<string> {
    const creds = { USERNAME: str(cfg.username), PASSWORD: str(cfg.password) };
    const res = await call<VtpEnvelope<{ token?: string; expired?: number }>>(this.url(cfg, '/user/Login'), { method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: creds }, 'Đăng nhập Viettel Post');
    const short = res.data?.data?.token;
    if (!res.ok || res.data?.error || !short) throw new ShippingCarrierError(`Đăng nhập Viettel Post thất bại: ${res.data?.message || `HTTP ${res.status}`}`, res.data, res.status >= 500);
    let token = short;
    try {
      const own = await call<VtpEnvelope<{ token?: string }>>(this.url(cfg, '/user/ownerconnect'), { method: 'POST', headers: { Token: short, 'Content-Type': 'application/json;charset=UTF-8' }, body: creds }, 'Lấy token dài hạn Viettel Post');
      if (own.ok && !own.data?.error && own.data?.data?.token) token = own.data.data.token;
    } catch {
      /* dùng token ngắn */
    }
    return tokens.set(this.cacheKey(cfg), token, TOKEN_TTL);
  }

  private async token(cfg: CarrierConfig): Promise<string> {
    return tokens.get(this.cacheKey(cfg)) ?? (await this.login(cfg));
  }

  /** Gọi API có token; lỗi token -> đăng nhập lại 1 lần */
  private async api<T = unknown>(cfg: CarrierConfig, path: string, body?: unknown, what = 'Gọi Viettel Post', retry = true): Promise<T> {
    const token = await this.token(cfg);
    const res = await call<VtpEnvelope<T> | T>(this.url(cfg, path), { method: body ? 'POST' : 'GET', headers: { Token: token, 'Content-Type': 'application/json;charset=UTF-8' }, body, timeoutMs: 30_000 }, what);
    const env = (res.data ?? {}) as VtpEnvelope<T>;
    const tokenInvalid = res.status === 401 || res.status === 403 || /token/i.test(str(env.message));
    if (tokenInvalid && retry) {
      tokens.clear(this.cacheKey(cfg));
      return this.api<T>(cfg, path, body, what, false);
    }
    if (!res.ok || env.error === true) throw new ShippingCarrierError(`${what} thất bại: ${env.message || res.text?.slice(0, 200) || `HTTP ${res.status}`}`, res.data, res.status >= 500);
    // một số endpoint (categories, getPriceAll) trả thẳng mảng, không bọc envelope
    if (Array.isArray(res.data)) return res.data as T;
    return (env.data !== undefined ? env.data : res.data) as T;
  }

  /** Kho gửi hàng của tài khoản */
  private async inventories(cfg: CarrierConfig) {
    const rows = await this.api<{ groupaddressId: number; cusId: number; name: string; phone: string; address: string; provinceId: number; districtId: number; wardsId: number }[]>(cfg, '/user/listInventory', undefined, 'Lấy danh sách kho Viettel Post');
    return Array.isArray(rows) ? rows : [];
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      tokens.clear(this.cacheKey(cfg));
      await this.login(cfg);
      const inv = await this.inventories(cfg);
      return { ok: true, message: `Đăng nhập Viettel Post thành công. ${inv.length} kho gửi hàng.`, details: { inventories: inv.map((i) => ({ groupAddressId: i.groupaddressId, cusId: i.cusId, name: i.name, address: i.address })) } };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listLocations(cfg: CarrierConfig, level: 1 | 2 | 3, parentCode?: string | null): Promise<CarrierLocation[]> {
    if (level === 1) {
      const rows = await this.api<{ PROVINCE_ID: number; PROVINCE_NAME: string }[]>(cfg, '/categories/listProvince?provinceId=-1', undefined, 'Lấy tỉnh Viettel Post');
      return rows.map((r) => ({ code: String(r.PROVINCE_ID), name: r.PROVINCE_NAME }));
    }
    if (level === 2) {
      const rows = await this.api<{ DISTRICT_ID: number; DISTRICT_NAME: string; PROVINCE_ID: number }[]>(cfg, `/categories/listDistrict${qs({ provinceId: parentCode })}`, undefined, 'Lấy quận/huyện Viettel Post');
      return rows.map((r) => ({ code: String(r.DISTRICT_ID), name: r.DISTRICT_NAME, parentCode: String(r.PROVINCE_ID) }));
    }
    const rows = await this.api<{ WARDS_ID: number; WARDS_NAME: string; DISTRICT_ID: number }[]>(cfg, `/categories/listWards${qs({ districtId: parentCode })}`, undefined, 'Lấy phường/xã Viettel Post');
    return rows.map((r) => ({ code: String(r.WARDS_ID), name: r.WARDS_NAME, parentCode: String(r.DISTRICT_ID) }));
  }

  async getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    const f = codesOf(req.from, 'viettelpost');
    const t = codesOf(req.to, 'viettelpost');
    if (!t.province || !t.district) throw new ShippingCarrierError('Địa chỉ nhận chưa có mã tỉnh/quận Viettel Post — hãy đồng bộ danh mục địa chỉ Viettel Post.');
    if (!f.province || !f.district) throw new ShippingCarrierError('Địa chỉ kho chưa có mã tỉnh/quận Viettel Post.');
    const body = {
      SENDER_PROVINCE: Number(f.province),
      SENDER_DISTRICT: Number(f.district),
      RECEIVER_PROVINCE: Number(t.province),
      RECEIVER_DISTRICT: Number(t.district),
      PRODUCT_TYPE: 'HH',
      PRODUCT_WEIGHT: int(req.parcel.weight, 1),
      PRODUCT_PRICE: vnd(req.parcel.value),
      PRODUCT_LENGTH: int(req.parcel.length, 0),
      PRODUCT_WIDTH: int(req.parcel.width, 0),
      PRODUCT_HEIGHT: int(req.parcel.height, 0),
      MONEY_COLLECTION: vnd(req.parcel.codAmount),
      TYPE: 1,
    };
    const rows = await this.api<{ MA_DV_CHINH: string; TEN_DICHVU: string; GIA_CUOC: number; THOI_GIAN?: string; EXCHANGE_WEIGHT?: number }[]>(cfg, '/order/getPriceAll', body, 'Tính phí Viettel Post');
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r.MA_DV_CHINH && (!req.service || r.MA_DV_CHINH === req.service));
    if (!list.length) throw new ShippingCarrierError('Viettel Post không trả về dịch vụ nào cho tuyến này', rows);
    return list.map((r) => {
      const days = parseEstimatedDays(r.THOI_GIAN);
      return { carrier: 'viettelpost', serviceCode: r.MA_DV_CHINH, serviceName: r.TEN_DICHVU || r.MA_DV_CHINH, fee: vnd(r.GIA_CUOC), estimatedDays: days, expectedDeliveryAt: days ? hoursFromNow(days * 24) : null, raw: r };
    });
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = buildViettelPostOrder(cfg, req);
    // thiếu kho/khách hàng -> lấy kho đầu tiên của tài khoản
    if (!body.GROUPADDRESS_ID || !body.CUS_ID) {
      const inv = (await this.inventories(cfg))[0];
      if (!inv) throw new ShippingCarrierError('Tài khoản Viettel Post chưa có kho gửi hàng (GROUPADDRESS_ID). Tạo kho trên portal rồi nhập mã kho vào cấu hình.');
      body.GROUPADDRESS_ID ||= inv.groupaddressId;
      body.CUS_ID ||= inv.cusId;
    }
    const d = await this.api<{ ORDER_NUMBER: string; MONEY_TOTAL?: number; MONEY_TOTAL_FEE?: number; MONEY_FEE?: number; KPI_HT?: number; EXCHANGE_WEIGHT?: number }>(cfg, '/order/createOrder', body, 'Tạo vận đơn Viettel Post');
    if (!d?.ORDER_NUMBER) throw new ShippingCarrierError('Viettel Post không trả về mã vận đơn', d);
    const hours = Number(d.KPI_HT);
    return {
      trackingCode: String(d.ORDER_NUMBER),
      carrierOrderId: String(d.ORDER_NUMBER),
      fee: vnd(d.MONEY_TOTAL ?? d.MONEY_TOTAL_FEE ?? d.MONEY_FEE),
      serviceName: str(body.ORDER_SERVICE) || null,
      expectedDeliveryAt: Number.isFinite(hours) && hours > 0 ? hoursFromNow(hours) : null,
      trackingUrl: this.trackingUrl(cfg, { id: req.shipmentId, trackingCode: String(d.ORDER_NUMBER) }),
      status: 'PENDING',
      raw: d,
    };
  }

  /** Không có API pull công khai — trạng thái đến qua webhook */
  async track(): Promise<TrackResult> {
    throw new ShippingCarrierError('Viettel Post không cung cấp API tra cứu trạng thái; hệ thống nhận cập nhật qua webhook.');
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef, reason?: string): Promise<CancelShipmentResult> {
    if (!ref.trackingCode) return { ok: true, message: 'Chưa có mã Viettel Post, chỉ huỷ trong hệ thống' };
    try {
      const r = await this.api<unknown>(cfg, '/order/UpdateOrder', { TYPE: 4, ORDER_NUMBER: ref.trackingCode, NOTE: clip(reason || 'Shop huỷ đơn', 250), DATE: vtpDate(new Date()) }, 'Huỷ vận đơn Viettel Post');
      return { ok: true, raw: r };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  async getLabel(cfg: CarrierConfig, ref: ShipmentRef): Promise<LabelResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã Viettel Post');
    const d = await this.api<{ token?: string; url?: string } | string>(cfg, '/order/printing-code', { ORDER_ARRAY: [ref.trackingCode], EXPIRY_TIME: Date.now() + 3600_000, PRINT_TYPE: 1 }, 'Lấy link in vận đơn Viettel Post');
    if (typeof d === 'string') return { url: d.startsWith('http') ? d : `${baseUrl(cfg, URLS)}/order/print/${d}?A5` };
    if (d?.url) return { url: d.url };
    if (d?.token) return { url: `${baseUrl(cfg, URLS)}/order/print/${d.token}?A5` };
    throw new ShippingCarrierError('Viettel Post không trả về link in', d);
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://viettelpost.vn/tra-cuu-hanh-trinh-don/?peopleTracking=sender&orderNumber=${encodeURIComponent(ref.trackingCode)}` : null;
  }

  /** Webhook: { DATA: {...}, TOKEN } (+ header Authorization). Đối chiếu TOKEN với webhookToken nếu cấu hình. */
  async parseWebhook(cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const b = bodyObject(input.body, input.rawBody);
    const data = (b.DATA && typeof b.DATA === 'object' ? b.DATA : b) as Record<string, unknown>;
    const expected = str(cfg.webhookToken);
    if (expected) {
      const got = str(b.TOKEN) || headerOf(input.headers, 'authorization')?.replace(/^Bearer\s+/i, '') || '';
      if (!safeEqual(got, expected)) return null;
    }
    const orderNumber = str(data.ORDER_NUMBER);
    if (!orderNumber) return null;
    const code = data.ORDER_STATUS;
    return [
      {
        trackingCode: orderNumber,
        carrierOrderId: orderNumber,
        status: mapViettelPostStatus(code),
        statusCode: code != null ? String(code) : null,
        message: [str(data.STATUS_NAME), str(data.NOTE)].filter(Boolean).join(' — ') || null,
        location: str(data.LOCATION_CURRENTLY) || null,
        at: parseDate(data.ORDER_STATUSDATE) ?? new Date(),
        fee: data.MONEY_TOTAL != null ? vnd(data.MONEY_TOTAL) : null,
        codCollected: String(code) === '501' ? vnd(data.MONEY_COLLECTION) : null,
        raw: data,
      },
    ];
  }
}
