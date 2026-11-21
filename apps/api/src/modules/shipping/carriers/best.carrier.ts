/**
 * Adapter BEST Express Việt Nam — KHUNG (tin cậy C).
 * BEST VN không công bố Open API; khung này theo mẫu BEST Inc. (partnerID + partnerKey, sign = MD5(bizData + partnerKey),
 * serviceType KD_CREATE_ORDER_NOTIFY / KD_TRACE_QUERY / KD_CANCEL_ORDER). Cần tài liệu đối tác để xác nhận URL, tên trường, bảng trạng thái.
 * Khuyến nghị: dùng BEST qua GoShip (carrier_short_name: best) nếu chưa có hợp đồng trực tiếp.
 */
import type { CancelShipmentResult, CarrierAddress, CarrierConfig, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, NormalizedShipmentStatus, RateQuote, ShipmentEvent, ShipmentRef, ShippingCarrier, TrackResult } from './carrier.interface.js';
import { ShippingCarrierError } from './carrier.interface.js';
import { addressLine, baseUrl, call, clip, extractMessage, fold, formEncode, int, md5Hex, parseDate, phoneVN, str, toKg, vnd } from './http.js';

const URLS = { sandbox: '', production: '' };

/** Trạng thái BEST (chuỗi mô tả) -> chuẩn — so khớp từ khoá, cần đối chiếu bảng gốc */
export function mapBestStatus(text: unknown): NormalizedShipmentStatus {
  const s = fold(text);
  if (!s) return 'PENDING';
  if (s.includes('huy') || s.includes('cancel')) return 'CANCELLED';
  if (s.includes('hoan thanh cong') || s.includes('da hoan') || s.includes('returned')) return 'RETURNED';
  if (s.includes('hoan') || s.includes('return')) return 'RETURNING';
  if (s.includes('giao thanh cong') || s.includes('da giao') || s.includes('signed') || s.includes('delivered')) return 'DELIVERED';
  if (s.includes('that bai') || s.includes('khong thanh cong') || s.includes('problem') || s.includes('fail')) return 'FAILED';
  if (s.includes('dang giao') || s.includes('delivering') || s.includes('dispatch')) return 'DELIVERING';
  if (s.includes('da lay') || s.includes('nhap kho') || s.includes('xuat kho') || s.includes('van chuyen') || s.includes('collected') || s.includes('transit') || s.includes('arrive') || s.includes('depart')) return 'PICKED';
  if (s.includes('dang lay') || s.includes('pickup')) return 'PICKING';
  return 'PENDING';
}

export class BestCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'best',
    name: 'BEST Express',
    description: 'BEST Express Việt Nam — khung tích hợp theo mẫu BEST Inc. (partnerID/partnerKey, ký MD5). Cần tài liệu đối tác từ BEST để hoàn thiện; hoặc dùng qua GoShip.',
    website: 'https://best-inc.vn',
    fields: [
      { key: 'partnerId', label: 'Partner ID', type: 'text', required: true, help: 'Do BEST cấp khi ký hợp đồng (BEST Cloud).' },
      { key: 'partnerKey', label: 'Partner Key (khoá ký MD5)', type: 'password', required: true },
      { key: 'customerCode', label: 'Mã khách hàng / kho gửi', type: 'text' },
      { key: 'flatFee', label: 'Phí hiển thị ở checkout (VND)', type: 'number', default: 0, help: 'Chưa có API tính phí; nhập phí theo hợp đồng (0 = không báo giá).' },
      { key: 'sandboxUrl', label: 'URL API test', type: 'url', env: 'sandbox', required: true, help: 'Do BEST cung cấp trong tài liệu đối tác.' },
      { key: 'productionUrl', label: 'URL API production', type: 'url', env: 'production', required: true },
    ],
    capabilities: { rates: true, services: false, leadtime: false, create: true, track: true, cancel: true, label: false, webhook: false, locations: false, testConnection: false },
    addressLevels: 3,
    notes: [
      'CẦN TÀI LIỆU ĐỐI TÁC: BEST Express VN không công khai Open API. URL, tên trường, bảng trạng thái ở đây chỉ là khung tham chiếu BEST Inc., phải kiểm chứng trước khi dùng thật.',
      'Chưa hỗ trợ webhook/in nhãn. Khuyến nghị dùng BEST qua GoShip (carrier_short_name: best) nếu chưa có hợp đồng trực tiếp.',
    ],
  };

  private url(cfg: CarrierConfig) {
    const u = baseUrl(cfg, URLS);
    if (!u) throw new ShippingCarrierError('Chưa cấu hình URL API BEST Express (lấy từ tài liệu đối tác).');
    return u;
  }

  /** Gọi API BEST: form { partnerID, serviceType, bizData, sign = MD5(bizData + partnerKey) } */
  private async api<T = unknown>(cfg: CarrierConfig, serviceType: string, bizData: Record<string, unknown>, what: string): Promise<T> {
    const json = JSON.stringify(bizData);
    const form = formEncode({ partnerID: str(cfg.partnerId), serviceType, bizData: json, sign: md5Hex(json + str(cfg.partnerKey)) });
    const res = await call<T>(this.url(cfg), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, timeoutMs: 30_000 }, what);
    if (!res.ok) throw new ShippingCarrierError(`${what} thất bại (HTTP ${res.status}): ${extractMessage(res.data) || res.text?.slice(0, 200)}`, res.data, res.status >= 500);
    const d = res.data as { result?: boolean | string; errorCode?: string; errorDescription?: string; remark?: string } | undefined;
    if (d && (d.result === false || String(d.result) === 'false')) throw new ShippingCarrierError(`${what} thất bại: ${d.errorDescription || d.remark || d.errorCode || 'BEST từ chối'}`, res.data);
    return res.data;
  }

  async testConnection(): Promise<CarrierTestResult> {
    return { ok: false, message: 'BEST Express chưa có API kiểm tra kết nối; cần tài liệu đối tác để hoàn thiện adapter.' };
  }

  async getRates(cfg: CarrierConfig): Promise<RateQuote[]> {
    const fee = vnd(cfg.flatFee);
    if (fee <= 0) return [];
    return [{ carrier: 'best', serviceCode: 'standard', serviceName: 'BEST Express', fee, estimatedDays: null }];
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const party = (a: CarrierAddress) => ({ name: clip(a.name, 100), mobile: phoneVN(a.phone), prov: a.provinceName ?? '', city: a.districtName ?? '', county: a.wardName ?? '', address: clip(addressLine(a), 200) });
    const biz = {
      customerCode: str(cfg.customerCode) || undefined,
      txLogisticId: clip(req.orderCode, 50),
      serviceType: req.service || 'standard',
      sender: party(req.from),
      receiver: party(req.to),
      items: (req.parcel.items.length ? req.parcel.items : [{ name: 'Hàng hoá', quantity: 1, price: req.parcel.value }]).map((i) => ({ itemName: clip(i.name, 100), number: int(i.quantity, 1), itemValue: vnd(i.price) })),
      weight: toKg(req.parcel.weight),
      goodsValue: vnd(req.parcel.value),
      codValue: vnd(req.parcel.codAmount),
      payType: req.payer === 'customer' ? 'CC' : 'PP',
      remark: clip(req.note ?? '', 200),
    };
    const data = await this.api<{ mailNo?: string; txLogisticId?: string; sortingCode?: string }>(cfg, 'KD_CREATE_ORDER_NOTIFY', biz, 'Tạo đơn BEST');
    const mailNo = str(data?.mailNo);
    if (!mailNo) throw new ShippingCarrierError('BEST không trả về mã vận đơn (mailNo) — kiểm tra lại tài liệu đối tác', data);
    return { trackingCode: mailNo, carrierOrderId: str(data?.txLogisticId) || mailNo, fee: vnd(cfg.flatFee), serviceName: 'BEST Express', trackingUrl: this.trackingUrl(cfg, { id: req.shipmentId, trackingCode: mailNo }), status: 'PENDING', raw: data };
  }

  async track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult> {
    if (!ref.trackingCode) throw new ShippingCarrierError('Vận đơn chưa có mã BEST');
    const data = await this.api<{ traceLogs?: Record<string, unknown>[]; traces?: Record<string, unknown>[] }>(cfg, 'KD_TRACE_QUERY', { mailNos: [ref.trackingCode] }, 'Tra hành trình BEST');
    const logs = (data?.traceLogs ?? data?.traces ?? []) as Record<string, unknown>[];
    const events: ShipmentEvent[] = logs
      .map((l) => ({ status: mapBestStatus(`${str(l.scanType)} ${str(l.remark ?? l.description)}`), statusCode: str(l.scanType) || null, message: str(l.remark ?? l.description) || null, location: str(l.siteName ?? l.city) || null, at: parseDate(l.acceptTime ?? l.scanTime) ?? new Date() }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const last = events[events.length - 1];
    return { status: last?.status ?? 'PENDING', statusCode: last?.statusCode ?? null, message: last?.message ?? null, events, raw: data };
  }

  async cancel(cfg: CarrierConfig, ref: ShipmentRef, reason?: string): Promise<CancelShipmentResult> {
    if (!ref.trackingCode) return { ok: true, message: 'Chưa có mã BEST, chỉ huỷ trong hệ thống' };
    try {
      const data = await this.api(cfg, 'KD_CANCEL_ORDER', { txLogisticId: ref.carrierOrderId || ref.trackingCode, mailNo: ref.trackingCode, reason: clip(reason || 'Shop huỷ đơn', 200) }, 'Huỷ đơn BEST');
      return { ok: true, raw: data };
    } catch (err) {
      if (err instanceof ShippingCarrierError && !err.retryable) return { ok: false, message: err.message, raw: err.raw };
      throw err;
    }
  }

  trackingUrl(_cfg: CarrierConfig, ref: ShipmentRef): string | null {
    return ref.trackingCode ? `https://best-inc.vn/track?bills=${encodeURIComponent(ref.trackingCode)}` : null;
  }
}
