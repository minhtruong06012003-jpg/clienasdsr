/**
 * Adapter Giao Hàng Nhanh (GHN) — API `shiip/public-api` (tài liệu: https://developer.ghn.vn, tin cậy A).
 *
 * - Xác thực: header `Token` + `ShopId`. Token lấy ở Developer Portal (Manage token); sandbox & production độc lập.
 * - Địa chỉ: mô hình cũ 3 cấp dùng MÃ (ProvinceID/DistrictID/WardCode); mô hình mới 2 cấp (2025) dùng TÊN
 *   (`is_new_to_address: true`, tỉnh -> phường). Bật `useNewAddress` để dùng mô hình mới.
 * - Tính phí: available-services -> fee + leadtime từng dịch vụ (song song); mô hình mới dùng `preview`.
 * - Webhook: không có chữ ký, GHN gửi JSON PascalCase; bảo vệ bằng `?key=<webhookSecret>` trên URL.
 */
import type { CancelShipmentResult, CarrierConfig, CarrierLocation, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, LabelResult, NormalizedShipmentStatus, RateQuote, RateRequest, ShipmentEvent, ShipmentRef, ShippingCarrier, TrackResult, WebhookEvent } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, bodyObject, call, clip, codesOf, describeItems, int, parseDate, phoneVN, qs, str, vnd } from './http.js';

const URLS = { sandbox: 'https://dev-online-gateway.ghn.vn/shiip/public-api', production: 'https://online-gateway.ghn.vn/shiip/public-api' };

/** Response chuẩn của GHN */
interface GhnEnvelope<T = unknown> {
  code?: number;
  message?: string;
  message_display?: string;
  code_message?: string;
  data?: T;
}

/** Bảng trạng thái GHN (master-data/order-status) -> trạng thái chuẩn */
const STATUS_MAP: Record<string, NormalizedShipmentStatus> = {
  ready_to_pick: 'PENDING',
  picking: 'PICKING',
  money_collect_picking: 'PICKING',
  picked: 'PICKED',
  storing: 'PICKED',
  sorting: 'PICKED',
  transporting: 'PICKED',
  delivering: 'DELIVERING',
  money_collect_delivering: 'DELIVERING',
  delivered: 'DELIVERED',
  delivery_fail: 'FAILED',
  waiting_to_return: 'RETURNING',
  return: 'RETURNING',
  return_transporting: 'RETURNING',
  return_sorting: 'RETURNING',
  returning: 'RETURNING',
  return_fail: 'RETURNING',
  returned: 'RETURNED',
  cancel: 'CANCELLED',
  exception: 'FAILED',
  lost: 'FAILED',
  damage: 'FAILED',
  scrap: 'FAILED',
};

/** Ánh xạ trạng thái GHN -> chuẩn (mã lạ -> PENDING) */
export function mapGhnStatus(status: unknown): NormalizedShipmentStatus {
  return STATUS_MAP[String(status ?? '').toLowerCase()] ?? 'PENDING';
}

/** required_note của GHN theo tuỳ chọn cho xem hàng */
export function ghnRequiredNote(allow: CreateShipmentRequest['allowInspection']): 'CHOTHUHANG' | 'CHOXEMHANGKHONGTHU' | 'KHONGCHOXEMHANG' {
  if (allow === 'try') return 'CHOTHUHANG';
  if (allow === 'deny') return 'KHONGCHOXEMHANG';
  return 'CHOXEMHANGKHONGTHU';
}

/** service_type_id: 2 = hàng nhẹ (<20kg), 5 = hàng nặng */
function serviceTypeId(service: string | null | undefined, weight: number): number {
  const n = Number(service);
  if (n === 2 || n === 5) return n;
  return weight >= 20_000 ? 5 : 2;
}

/** Dựng body tạo đơn GHN từ request chuẩn (export để test) */
export function buildGhnOrder(cfg: CarrierConfig, req: CreateShipmentRequest): Record<string, unknown> {
  const { from, to, parcel } = req;
  const useNew = cfg.useNewAddress === true;
  const toCodes = codesOf(to, 'ghn');
  const fromCodes = codesOf(from, 'ghn');
  const insure = cfg.insure !== false;
  const body: Record<string, unknown> = {
    client_order_code: clip(req.orderCode, 50),
    to_name: clip(to.name, 1024),
    to_phone: phoneVN(to.phone),
    to_address: clip(addressLine(to), 1024),
    to_province_name: to.provinceName ?? undefined,
    to_ward_name: to.wardName ?? undefined,
    weight: Math.min(50_000, int(parcel.weight, 1)),
    length: Math.min(200, int(parcel.length, 1)),
    width: Math.min(200, int(parcel.width, 1)),
    height: Math.min(200, int(parcel.height, 1)),
    service_type_id: serviceTypeId(req.service, parcel.weight),
    payment_type_id: req.payer === 'customer' ? 2 : 1,
    required_note: ghnRequiredNote(req.allowInspection),
    cod_amount: Math.min(50_000_000, vnd(parcel.codAmount)),
    insurance_value: insure ? Math.min(5_000_000, vnd(parcel.value)) : 0,
    order_value: vnd(parcel.value),
    note: clip(req.note ?? '', 5000) || undefined,
    content: describeItems(parcel.items),
    items: parcel.items.map((i) => ({
      name: clip(i.name, 200),
      code: i.sku ?? undefined,
      quantity: int(i.quantity, 1),
      price: vnd(i.price),
      weight: i.weight ? int(i.weight, 1) : undefined,
      length: i.length ? int(i.length, 1) : undefined,
      width: i.width ? int(i.width, 1) : undefined,
      height: i.height ? int(i.height, 1) : undefined,
    })),
  };
  if (req.pickupMode === 'dropoff') body.pick_station_id = Number(cfg.pickStationId) || undefined;
  if (useNew) {
    // mô hình 2 cấp: chỉ cần tên tỉnh + tên phường
    body.is_new_to_address = true;
  } else {
    body.to_district_name = to.districtName ?? undefined;
    if (toCodes.district) body.to_district_id = Number(toCodes.district);
    if (toCodes.ward) body.to_ward_code = String(toCodes.ward);
  }
  // địa chỉ lấy hàng: bỏ trống = địa chỉ shop đã đăng ký; truyền khi có đủ thông tin
  if (from?.name && from.phone && from.line1) {
    body.from_name = clip(from.name, 1024);
    body.from_phone = phoneVN(from.phone);
    body.from_address = clip(addressLine(from), 1024);
    body.from_province_name = from.provinceName ?? undefined;
    body.from_ward_name = from.wardName ?? undefined;
    if (useNew) body.is_new_from_address = true;
    else {
      body.from_district_name = from.districtName ?? undefined;
      if (fromCodes.district) body.from_district_id = Number(fromCodes.district);
      if (fromCodes.ward) body.from_ward_code = String(fromCodes.ward);
    }
  }
  return body;
}

export class GhnCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'ghn',
    name: 'Giao Hàng Nhanh',
    description: 'GHN — tạo vận đơn, tính phí, thời gian giao dự kiến, in nhãn A5, webhook trạng thái. Hỗ trợ địa chỉ 3 cấp (mã) và 2 cấp mới (tên).',
    website: 'https://ghn.vn',
    docsUrl: 'https://developer.ghn.vn',
    fields: [
      { key: 'token', label: 'Token API', type: 'password', required: true, help: 'Developer Portal (https://developer.ghn.vn, sandbox: https://developer.ghn.dev) › menu tài khoản › Manage token. Token sandbox và production khác nhau.' },
      { key: 'shopId', label: 'Shop ID', type: 'text', required: true, placeholder: '123456', help: 'Mã cửa hàng trên GHN (số). Sai Shop ID → danh sách dịch vụ trống.' },
      { key: 'useNewAddress', label: 'Dùng mô hình địa chỉ 2 cấp (tỉnh → phường, 2025)', type: 'boolean', default: false, help: 'Bật khi shop đã chuyển sang địa chỉ mới sau sáp nhập. Khi bật, đồng bộ danh mục sẽ tạo 1 "quận" giả "(Toàn tỉnh)" cho mỗi tỉnh và vận đơn gửi theo tên tỉnh/phường.' },
      { key: 'insure', label: 'Khai giá bảo hiểm theo giá trị đơn', type: 'boolean', default: true, help: 'insurance_value = giá trị hàng (tối đa 5.000.000đ)' },
      { key: 'pickStationId', label: 'Bưu cục gửi hàng (pick_station_id)', type: 'text', help: 'Chỉ dùng khi chọn "Shop mang ra bưu cục"' },
      { key: 'sandboxUrl', label: 'URL API sandbox', type: 'url', env: 'sandbox', default: URLS.sandbox },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', default: URLS.production },
    ],
    capabilities: { rates: true, services: true, leadtime: true, create: true, track: true, cancel: true, label: true, webhook: true, locations: true, testConnection: true },
    addressLevels: 3,
    notes: [
      'Tài khoản sandbox: https://5sao.ghn.dev (tạo shop test) → token tại https://developer.ghn.dev.',
      'Webhook: Developer Portal › menu tài khoản › Webhook configuration › tab Order. GHN không ký HMAC → dán URL kèm ?key=<khoá webhook>. Retry 11 lần khi nhận 5xx.',
      'Ở mô hình địa chỉ 2 cấp, tính phí dùng API preview (dry-run) theo tên tỉnh/phường — cần xác minh với tài khoản thật.',
    ],
  };

  private headers(cfg: CarrierConfig): Record<string, string> {
    return { Token: str(cfg.token), ShopId: str(cfg.shopId), 'Content-Type': 'application/json' };
  }

  /** Gọi API GHN, kiểm tra HTTP + `code` trong envelope, trả `data` */
  private async api<T = unknown>(cfg: CarrierConfig, path: string, body?: unknown, what = 'Gọi GHN', method?: 'GET' | 'POST'): Promise<T> {
    const res = await call<GhnEnvelope<T>>(`${baseUrl(cfg, URLS)}${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: this.headers(cfg), body, timeoutMs: 30_000 }, what);
    const env = (res.data ?? {}) as GhnEnvelope<T>;
    if (!res.ok || (env.code !== undefined && env.code !== 200)) {
      const msg = env.message_display || env.message || res.text?.slice(0, 200) || `HTTP ${res.status}`;
      throw new ShippingCarrierError(`${what} thất bại: ${msg}${env.code_message ? ` (${env.code_message})` : ''}`, env, res.status >= 500 || env.code_message === 'SERVER_ERROR_COMMON');
    }
    return env.data as T;
  }

  async testConnection(cfg: CarrierConfig): Promise<CarrierTestResult> {
    try {
      const shops = await this.api<{ shops?: { _id: number; name: string }[] }>(cfg, '/v2/shop/all', { offset: 0, limit: 50 }, 'Lấy danh sách shop');
      const found = shops?.shops?.find((s) => String(s._id) === str(cfg.shopId));
      if (!found) return { ok: false, message: `Token hợp lệ nhưng không thấy Shop ID ${str(cfg.shopId)} trong tài khoản (${shops?.shops?.length ?? 0} shop).`, details: { shops: shops?.shops?.map((s) => ({ id: s._id, name: s.name })) } };
      return { ok: true, message: `Kết nối GHN thành công: shop "${found.name}" (#${found._id}).` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listLocations(cfg: CarrierConfig, level: 1 | 2 | 3, parentCode?: string | null): Promise<CarrierLocation[]> {
    if (cfg.useNewAddress === true) return this.listLocationsV3(cfg, level, parentCode);
    if (level === 1) {
      const rows = await this.api<{ ProvinceID: number; ProvinceName: string }[]>(cfg, '/master-data/province', undefined, 'Lấy danh sách tỉnh');
      return (rows ?? []).map((r) => ({ code: String(r.ProvinceID), name: r.ProvinceName }));
    }
    if (level === 2) {
      const rows = await this.api<{ DistrictID: number; DistrictName: string; ProvinceID: number; SupportType?: number }[]>(cfg, `/master-data/district${qs({ province_id: parentCode })}`, undefined, 'Lấy danh sách quận/huyện');
      return (rows ?? []).map((r) => ({ code: String(r.DistrictID), name: r.DistrictName, parentCode: String(r.ProvinceID) }));
    }
    const rows = await this.api<{ WardCode: string; WardName: string; DistrictID: number }[]>(cfg, `/master-data/ward${qs({ district_id: parentCode })}`, undefined, 'Lấy danh sách phường/xã');
    return (rows ?? []).map((r) => ({ code: String(r.WardCode), name: r.WardName, parentCode: String(r.DistrictID) }));
  }

  /**
   * Danh mục mô hình mới (v3, 2 cấp). Vì ShippingLocationsService đồng bộ theo 3 cấp,
   * level 2 trả về 1 "quận" giả `P<provinceId>` "(Toàn tỉnh)" rồi level 3 trả phường của tỉnh đó.
   */
  private async listLocationsV3(cfg: CarrierConfig, level: 1 | 2 | 3, parentCode?: string | null): Promise<CarrierLocation[]> {
    type Row = { _id: number | string; name: string; parent_id?: number | string; status?: number };
    const page = async (path: string): Promise<Row[]> => {
      const out: Row[] = [];
      for (let offset = 0; offset < 20_000; offset += 200) {
        const rows = await this.api<Row[]>(cfg, `${path}${path.includes('?') ? '&' : '?'}offset=${offset}&limit=200`, undefined, 'Lấy danh mục địa chỉ (v3)');
        if (!rows?.length) break;
        out.push(...rows);
        if (rows.length < 200) break;
      }
      return out.filter((r) => r.status === undefined || r.status === 1);
    };
    if (level === 1) return (await page('/v3/master-data/province/all')).map((r) => ({ code: String(r._id), name: r.name }));
    if (level === 2) return [{ code: `P${parentCode}`, name: '(Toàn tỉnh)', parentCode: parentCode ?? null }];
    const provinceId = String(parentCode ?? '').replace(/^P/, '');
    return (await page(`/v3/master-data/ward/all-by-province-id?province_id=${encodeURIComponent(provinceId)}`)).map((r) => ({ code: String(r._id), name: r.name, parentCode: `P${provinceId}` }));
  }

  async getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    if (cfg.useNewAddress === true) return this.ratesByPreview(cfg, req);
    const fromCodes = codesOf(req.from, 'ghn');
    const toCodes = codesOf(req.to, 'ghn');
    if (!toCodes.district) throw new ShippingCarrierError('Địa chỉ nhận chưa có mã quận/huyện GHN — hãy đồng bộ danh mục địa chỉ GHN ở Cài đặt › Vận chuyển.');
    if (!fromCodes.district) throw new ShippingCarrierError('Địa chỉ kho chưa có mã quận/huyện GHN — kiểm tra địa chỉ lấy hàng ở Cài đặt › Vận chuyển.');
    const services = await this.api<{ service_id: number; short_name: string; service_type_id: number }[]>(cfg, '/v2/shipping-order/available-services', { shop_id: Number(cfg.shopId), from_district: Number(fromCodes.district), to_district: Number(toCodes.district) }, 'Lấy dịch vụ GHN');
    if (!services?.length) throw new ShippingCarrierError('GHN không trả về dịch vụ nào (kiểm tra Shop ID hoặc tuyến chưa hỗ trợ).', services);
    const wanted = req.service ? services.filter((s) => String(s.service_type_id) === String(req.service) || String(s.service_id) === String(req.service)) : services;
    const common = {
      from_district_id: Number(fromCodes.district),
      from_ward_code: fromCodes.ward || undefined,
      to_district_id: Number(toCodes.district),
      to_ward_code: toCodes.ward || undefined,
      weight: int(req.parcel.weight, 1),
      length: int(req.parcel.length, 1),
      width: int(req.parcel.width, 1),
      height: int(req.parcel.height, 1),
    };
    const quotes = await Promise.all(
      wanted.map(async (s): Promise<RateQuote | null> => {
        try {
          const [fee, lead] = await Promise.all([
            this.api<{ total: number; service_fee: number; insurance_fee: number; cod_fee: number; pick_remote_areas_fee: number; deliver_remote_areas_fee: number }>(cfg, '/v2/shipping-order/fee', { ...common, service_type_id: s.service_type_id, insurance_value: cfg.insure !== false ? Math.min(5_000_000, vnd(req.parcel.value)) : 0, cod_value: vnd(req.parcel.codAmount), items: [] }, 'Tính phí GHN'),
            this.api<{ leadtime: number; leadtime_order?: { from_estimate_date?: string; to_estimate_date?: string } }>(cfg, '/v2/shipping-order/leadtime', { ...common, service_type_id: s.service_type_id }, 'Lấy thời gian giao GHN').catch(() => null),
          ]);
          const expected = lead ? parseDate(lead.leadtime_order?.to_estimate_date ?? lead.leadtime) : null;
          return {
            carrier: 'ghn',
            serviceCode: String(s.service_type_id),
            serviceName: s.short_name || (s.service_type_id === 5 ? 'Hàng nặng' : 'Hàng nhẹ'),
            fee: vnd(fee.total),
            breakdown: { base: vnd(fee.service_fee), insurance: vnd(fee.insurance_fee), cod: vnd(fee.cod_fee), remote: vnd(fee.pick_remote_areas_fee) + vnd(fee.deliver_remote_areas_fee) },
            estimatedDays: expected ? Math.max(1, Math.ceil((expected.getTime() - Date.now()) / 86_400_000)) : null,
            expectedDeliveryAt: expected,
            raw: { service: s, fee, leadtime: lead },
          };
        } catch (err) {
          // tuyến không hỗ trợ loại dịch vụ này -> bỏ qua, nhưng nếu không còn dịch vụ nào thì ném lỗi ở dưới
          return { carrier: 'ghn', serviceCode: `error:${s.service_type_id}`, serviceName: (err as Error).message, fee: -1 };
        }
      }),
    );
    const ok = quotes.filter((q): q is RateQuote => !!q && q.fee >= 0);
    if (!ok.length) throw new ShippingCarrierError(quotes.find((q) => q && q.fee < 0)?.serviceName || 'GHN không tính được phí');
    return ok;
  }

  /** Tính phí theo mô hình địa chỉ mới bằng API preview (không tạo đơn) */
  private async ratesByPreview(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]> {
    if (!req.to.provinceName || !req.to.wardName) throw new ShippingCarrierError('Địa chỉ nhận cần tên tỉnh và tên phường/xã (mô hình 2 cấp GHN).');
    const types = req.service ? [serviceTypeId(req.service, req.parcel.weight)] : req.parcel.weight >= 20_000 ? [5] : [2, 5];
    const fake: CreateShipmentRequest = { ...req, orderCode: `PREVIEW-${Date.now()}`, service: '', shipmentId: 'preview', payer: req.payer };
    const quotes = await Promise.all(
      types.map(async (t): Promise<RateQuote | null> => {
        try {
          const body = { ...buildGhnOrder(cfg, { ...fake, service: String(t) }), client_order_code: undefined };
          const data = await this.api<{ total_fee: number; expected_delivery_time?: string; fee?: Record<string, number> }>(cfg, '/v2/shipping-order/preview', body, 'Xem trước phí GHN');
          const expected = parseDate(data.expected_delivery_time);
          return { carrier: 'ghn', serviceCode: String(t), serviceName: t === 5 ? 'Hàng nặng' : 'Hàng nhẹ', fee: vnd(data.total_fee), breakdown: { base: vnd(data.fee?.main_service), insurance: vnd(data.fee?.insurance), cod: vnd(data.fee?.cod_fee) }, expectedDeliveryAt: expected, estimatedDays: expected ? Math.max(1, Math.ceil((expected.getTime() - Date.now()) / 86_400_000)) : null, raw: data };
        } catch (err) {
          if (types.length === 1) throw err;
          return null;
        }
      }),
    );
    return quotes.filter((q): q is RateQuote => !!q);
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const body = buildGhnOrder(cfg, req);
    const data = await this.api<{ order_code: string; total_fee: number; expected_delivery_time?: string; fee?: Record<string, number> }>(cfg, '/v2/shipping-order/create', body, 'Tạo vận đơn GHN');
    if (!data?.order_code) throw new ShippingCarrierError('GHN không trả về mã vận đơn', data);
    return {
      trackingCode: data.order_code,
      carrierOrderId: data.order_code,
      fee: vnd(data.total_fee),
      serviceName: Number(body.service_type_id) === 5 ? 'Hàng nặng' : 'Hàng nhẹ',
      expectedDeliveryAt: parseDate(data.expected_delivery_time),
      trackingUrl: `https://donhang.ghn.vn/?order_code=${encodeURIComponent(data.order_code)}`,
      status: 'PENDING',
      raw: data,
    };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã GHN');
    const d = await this.api<{ status: string; log?: { status: string; updated_date: string }[]; leadtime?: string; cod_amount?: number; cod_transfer_date?: string; updated_date?: string; total_fee?: number }>(cfg, `/v2/shipping-order/detail${qs({ order_code: ref.trackingCode })}`, undefined, 'Tra cứu vận đơn GHN');
    const events: ShipmentEvent[] = (d.log ?? []).map((l) => ({ status: mapGhnStatus(l.status), statusCode: l.status, at: parseDate(l.updated_date) ?? new Date() }));
    return { status: mapGhnStatus(d.status), statusCode: d.status, message: d.status, events, expectedDeliveryAt: parseDate(d.leadtime), fee: d.total_fee != null ? vnd(d.total_fee) : null, codCollected: d.cod_transfer_date ? vnd(d.cod_amount) : null, raw: d };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef, reason?: string): Promise<CancelShipmentResult> {
    if (!ref.trackingCode) return { ok: true, message: 'Chưa có mã GHN, chỉ huỷ trong hệ thống' };
    const rows = await this.api<{ order_code: string; result: boolean; message: string }[]>(cfg, '/v2/switch-status/cancel', { order_codes: [ref.trackingCode], reason_code: 'GHN-CANCEL-OTHER', reason: clip(reason || 'Shop huỷ đơn', 500) }, 'Huỷ vận đơn GHN');
    const r = rows?.[0];
    return { ok: !!r?.result, message: r?.message ?? null, raw: rows };
  }

  async getLabel(cfg: CarrierConfig, ref: ShipmentRef): Promise<LabelResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã GHN');
    const data = await this.api<{ token: string }>(cfg, '/v2/a5/gen-token', { order_codes: [ref.trackingCode] }, 'Lấy token in nhãn GHN');
    const host = baseUrl(cfg, URLS).replace(/\/shiip\/public-api$/, '');
    return { url: `${host}/a5/public-api/printA5?token=${encodeURIComponent(data.token)}` };
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://donhang.ghn.vn/?order_code=${encodeURIComponent(ref.trackingCode)}` : null;
  }

  /** Webhook GHN: JSON PascalCase, không chữ ký (đã kiểm `?key=` ở controller) */
  async parseWebhook(_cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string }): Promise<WebhookEvent[] | null> {
    const b = bodyObject(input.body, input.rawBody);
    const orderCode = str(b.OrderCode ?? b.order_code);
    if (!orderCode) return null;
    const type = str(b.Type ?? b.type);
    const status = str(b.Status ?? b.status);
    const ev: WebhookEvent = {
      trackingCode: orderCode,
      carrierOrderId: orderCode,
      status: mapGhnStatus(status),
      statusCode: status || null,
      message: [str(b.Description), str(b.Reason)].filter(Boolean).join(' — ') || type || null,
      location: str(b.Warehouse) || null,
      at: parseDate(b.Time) ?? new Date(),
      fee: b.TotalFee != null ? vnd(b.TotalFee) : null,
      codCollected: type === 'cod' || b.CODTransferDate ? vnd(b.CODAmount) : null,
      raw: b,
    };
    return [ev];
  }
}
