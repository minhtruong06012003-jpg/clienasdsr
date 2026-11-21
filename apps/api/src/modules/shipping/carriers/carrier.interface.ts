/**
 * Giao diện adapter đơn vị vận chuyển (GHN, GHTK, Viettel Post, J&T, VNPost, Ahamove, Ninja Van, Best, GoShip...).
 *
 * Mỗi hãng cài một class implements `ShippingCarrier`, nhận `CarrierConfig` (admin nhập ở Cài đặt › Vận chuyển › Đơn vị vận chuyển)
 * và các request đã chuẩn hoá (địa chỉ, cân nặng gram, kích thước cm, tiền VND).
 * Thêm hãng mới: viết class trong thư mục này rồi đăng ký trong `index.ts` / `registry.ts` của carriers.
 */
import type { ProviderField } from '../../einvoice/providers/provider.interface.js';

export type { ProviderField as CarrierField };

export interface CarrierCapabilities {
  /** Tính phí trước khi tạo đơn */
  rates: boolean;
  /** Danh sách dịch vụ (nhanh / tiêu chuẩn / tiết kiệm) */
  services?: boolean;
  /** Thời gian giao dự kiến */
  leadtime?: boolean;
  create: boolean;
  track: boolean;
  cancel: boolean;
  /** In nhãn / phiếu giao */
  label: boolean;
  /** Nhận webhook cập nhật trạng thái */
  webhook: boolean;
  /** Cung cấp danh mục tỉnh / quận / phường để đồng bộ địa chỉ */
  locations: boolean;
  testConnection: boolean;
}

export interface CarrierMeta {
  key: string;
  name: string;
  description: string;
  website?: string;
  docsUrl?: string;
  /** Logo (URL tuyệt đối hoặc đường dẫn public của admin) */
  logo?: string;
  fields: ProviderField[];
  capabilities: CarrierCapabilities;
  /** Số cấp địa chỉ hãng dùng: 3 (tỉnh/quận/phường) hoặc 2 (tỉnh/phường, sau sáp nhập 2025) */
  addressLevels?: 2 | 3;
  notes?: string[];
}

export interface CarrierConfig {
  environment: 'sandbox' | 'production';
  [key: string]: unknown;
}

/** Địa chỉ đã chuẩn hoá cho hãng */
export interface CarrierAddress {
  name: string;
  phone: string;
  /** Số nhà, đường */
  line1: string;
  line2?: string | null;
  /** Mã nội bộ "VN-HN" */
  provinceCode?: string | null;
  provinceName?: string | null;
  districtCode?: string | null;
  districtName?: string | null;
  wardCode?: string | null;
  wardName?: string | null;
  /** Mã của từng hãng lấy từ danh mục đã đồng bộ: { ghn: { province: "201", district: "1442", ward: "21211" } } */
  carrierCodes?: Record<string, Record<string, string>>;
  email?: string | null;
  country?: string | null;
}

export interface ParcelItem {
  name: string;
  quantity: number;
  /** gram / 1 đơn vị */
  weight?: number;
  price?: number;
  sku?: string | null;
  /** cm */
  length?: number;
  width?: number;
  height?: number;
}

/** Thông tin kiện hàng dùng chung cho tính phí & tạo đơn */
export interface Parcel {
  /** Tổng cân nặng (gram) */
  weight: number;
  /** cm */
  length?: number;
  width?: number;
  height?: number;
  /** Giá trị hàng (để mua bảo hiểm / khai giá) */
  value: number;
  /** Tiền thu hộ (0 = không COD) */
  codAmount: number;
  items: ParcelItem[];
}

export interface RateRequest {
  from: CarrierAddress;
  to: CarrierAddress;
  parcel: Parcel;
  /** Chỉ lấy dịch vụ này (mã của hãng); bỏ trống = mọi dịch vụ */
  service?: string | null;
  /** Người trả phí: shop | customer (ảnh hưởng COD) */
  payer?: 'shop' | 'customer';
}

export interface RateQuote {
  carrier: string;
  /** Tên hãng hiển thị (ghi đè meta.name — vd hãng nhập tay đặt tên riêng) */
  carrierName?: string;
  serviceCode: string;
  serviceName: string;
  /** Tổng phí khách/shop phải trả (đã gồm phụ phí) */
  fee: number;
  /** Chi tiết (nếu hãng tách) */
  breakdown?: { base?: number; insurance?: number; cod?: number; remote?: number; other?: number };
  /** Số ngày giao dự kiến */
  estimatedDays?: number | null;
  expectedDeliveryAt?: Date | null;
  raw?: unknown;
}

export interface CreateShipmentRequest extends RateRequest {
  /** Mã đơn hàng của shop (hãng lưu làm client_order_code) */
  orderCode: string;
  service: string;
  note?: string | null;
  /** Cho xem hàng: allow | deny | try */
  allowInspection?: 'allow' | 'deny' | 'try';
  /** Yêu cầu lấy hàng tại kho hay shop mang ra bưu cục */
  pickupMode?: 'pickup' | 'dropoff';
  /** Thời điểm mong muốn lấy hàng */
  pickupAt?: Date | null;
  /** Hãng cần id vận đơn nội bộ để idempotent */
  shipmentId: string;
}

export interface CreateShipmentResult {
  trackingCode: string;
  carrierOrderId?: string | null;
  fee: number;
  serviceName?: string | null;
  expectedDeliveryAt?: Date | null;
  labelUrl?: string | null;
  trackingUrl?: string | null;
  /** Trạng thái ban đầu (mặc định PENDING) */
  status?: NormalizedShipmentStatus;
  raw?: unknown;
}

export type NormalizedShipmentStatus = 'PENDING' | 'PICKING' | 'PICKED' | 'DELIVERING' | 'DELIVERED' | 'RETURNING' | 'RETURNED' | 'CANCELLED' | 'FAILED';

export interface ShipmentEvent {
  status: NormalizedShipmentStatus;
  statusCode?: string | null;
  message?: string | null;
  location?: string | null;
  at: Date;
}

export interface ShipmentRef {
  id: string;
  trackingCode?: string | null;
  carrierOrderId?: string | null;
  meta?: Record<string, unknown>;
}

export interface TrackResult {
  status: NormalizedShipmentStatus;
  statusCode?: string | null;
  message?: string | null;
  events: ShipmentEvent[];
  expectedDeliveryAt?: Date | null;
  /** Phí thực tế hãng tính (nếu đổi) */
  fee?: number | null;
  /** Tiền COD đã thu (nếu hãng báo) */
  codCollected?: number | null;
  raw?: unknown;
}

export interface CancelShipmentResult {
  ok: boolean;
  message?: string | null;
  raw?: unknown;
}

export interface LabelResult {
  /** URL nhãn (hãng host) */
  url?: string | null;
  /** hoặc nội dung file */
  buffer?: Uint8Array;
  mimeType?: string;
  fileName?: string;
}

export interface WebhookEvent {
  /** Mã vận đơn để tìm Shipment */
  trackingCode?: string | null;
  carrierOrderId?: string | null;
  /** id vận đơn nội bộ nếu hãng trả lại client_order_code */
  shipmentId?: string | null;
  status: NormalizedShipmentStatus;
  statusCode?: string | null;
  message?: string | null;
  location?: string | null;
  at: Date;
  fee?: number | null;
  codCollected?: number | null;
  raw?: unknown;
}

export interface CarrierLocation {
  /** Mã của hãng */
  code: string;
  name: string;
  parentCode?: string | null;
}

export interface CarrierTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** Adapter đơn vị vận chuyển */
export interface ShippingCarrier {
  readonly meta: CarrierMeta;
  testConnection(cfg: CarrierConfig): Promise<CarrierTestResult>;
  /** Danh mục địa chỉ của hãng (level 1 tỉnh, 2 quận, 3 phường; parentCode = mã hãng của cấp trên) */
  listLocations?(cfg: CarrierConfig, level: 1 | 2 | 3, parentCode?: string | null): Promise<CarrierLocation[]>;
  /** Tính phí các dịch vụ khả dụng */
  getRates(cfg: CarrierConfig, req: RateRequest): Promise<RateQuote[]>;
  createShipment(cfg: CarrierConfig, req: CreateShipmentRequest): Promise<CreateShipmentResult>;
  track(cfg: CarrierConfig, ref: ShipmentRef): Promise<TrackResult>;
  cancel(cfg: CarrierConfig, ref: ShipmentRef, reason?: string): Promise<CancelShipmentResult>;
  getLabel?(cfg: CarrierConfig, ref: ShipmentRef): Promise<LabelResult>;
  /** URL tra cứu công khai cho khách */
  trackingUrl?(cfg: CarrierConfig, ref: ShipmentRef): string | null;
  /**
   * Đọc webhook của hãng. Trả null nếu không phải webhook hợp lệ (sai chữ ký / không có mã vận đơn).
   * `rawBody` là chuỗi gốc để xác minh chữ ký.
   */
  parseWebhook?(cfg: CarrierConfig, input: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody?: string; query?: Record<string, unknown> }): Promise<WebhookEvent[] | null>;
}

/** Lỗi từ hãng — message hiển thị cho admin, raw ghi log */
export class ShippingCarrierError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
    /** Lỗi tạm thời (timeout, 5xx) -> thử lại được */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ShippingCarrierError';
  }
}
