import type { CancelShipmentResult, CarrierConfig, CarrierMeta, CarrierTestResult, CreateShipmentRequest, CreateShipmentResult, RateQuote, RateRequest, ShipmentRef, ShippingCarrier, TrackResult } from './carrier.interface.js';

/**
 * Hãng "Nhập tay": không gọi API. Admin tự tạo vận đơn trên app/web của hãng rồi nhập mã vận đơn vào hệ thống
 * (qua PUT /admin/shipments/:id/manual) để khách tra cứu và theo dõi trạng thái tay.
 */
export class ManualCarrier implements ShippingCarrier {
  readonly meta: CarrierMeta = {
    key: 'manual',
    name: 'Nhập tay (hãng khác)',
    description: 'Không kết nối API. Tạo vận đơn trên hệ thống của hãng rồi nhập mã vận đơn, link tra cứu vào đây.',
    fields: [
      { key: 'carrierName', label: 'Tên hãng hiển thị', type: 'text', placeholder: 'VD: Nhất Tín, Kerry, Grab...' },
      { key: 'trackingUrlTemplate', label: 'Mẫu link tra cứu', type: 'text', placeholder: 'https://tracuu.example.vn/{trackingCode}', help: 'Dùng {trackingCode}' },
      { key: 'flatFee', label: 'Phí mặc định (VND)', type: 'number', default: 0, help: 'Dùng khi tính phí ở checkout (0 = không hiện)' },
    ],
    capabilities: { rates: true, create: true, track: false, cancel: true, label: false, webhook: false, locations: false, testConnection: false },
    addressLevels: 3,
  };

  async testConnection(): Promise<CarrierTestResult> {
    return { ok: true, message: 'Chế độ nhập tay không cần kết nối.' };
  }

  async getRates(cfg: CarrierConfig, _req: RateRequest): Promise<RateQuote[]> {
    const fee = Number(cfg.flatFee ?? 0) || 0;
    if (fee <= 0) return [];
    return [{ carrier: 'manual', carrierName: String(cfg.carrierName || this.meta.name), serviceCode: 'standard', serviceName: 'Giao hàng tiêu chuẩn', fee, estimatedDays: null }];
  }

  async createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult> {
    // chưa có mã vận đơn — admin nhập sau
    return { trackingCode: '', fee: Number(cfg.flatFee ?? 0) || 0, serviceName: String(cfg.carrierName || 'Nhập tay'), status: 'PENDING', raw: { manual: true, shipmentId: req.shipmentId } };
  }

  async track(): Promise<TrackResult> {
    return { status: 'PENDING', events: [], message: 'Hãng nhập tay không hỗ trợ tra cứu tự động' };
  }

  async cancel(): Promise<CancelShipmentResult> {
    return { ok: true, message: 'Đã đánh dấu huỷ trong hệ thống (nhớ huỷ trên hệ thống hãng).' };
  }

  trackingUrl(cfg: CarrierConfig, ref: ShipmentRef): string | null {
    const tpl = String(cfg.trackingUrlTemplate ?? '').trim();
    if (!tpl || !ref.trackingCode) return null;
    return tpl.replace('{trackingCode}', encodeURIComponent(ref.trackingCode));
  }
}
