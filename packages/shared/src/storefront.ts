/**
 * Hợp đồng (tuỳ chọn) giữa API và FRONTEND riêng của từng dự án.
 * CMSNT Panel không kèm giao diện website khách; frontend tự dựng có thể mở
 * `GET <WEB_URL>/api/capabilities` trả về `StorefrontCapabilities` để admin biết
 * nó render được block nào, khai báo vị trí menu / vùng widget gì.
 * Không có frontend hoặc frontend không trả lời → admin coi như không khai báo thêm.
 */

/**
 * Khả năng của frontend đang chạy (`GET <web>/api/capabilities`), để admin
 * biết frontend build với phiên bản nào và render được block gì.
 */
export interface StorefrontCapabilities {
  /** Phiên bản CMSNT Panel frontend build cùng (nếu frontend khai báo). */
  coreVersion: string | null;
  /** Các loại block frontend render được. */
  blocks: string[];
  /** Thời điểm build (ISO) nếu biết. */
  builtAt: string | null;
  /** Phiên bản riêng của frontend (tuỳ chọn). */
  storefrontVersion?: string | null;
  /** Thông tin theme frontend khai báo (tuỳ chọn). */
  theme?: StorefrontThemeInfo | null;
}

/** Thông tin theme frontend báo cho admin (qua GET <web>/api/capabilities) */
export interface StorefrontThemeInfo {
  name: string;
  label?: string;
  version: string;
  /** dải phiên bản lõi tương thích, vd ">=1.2.0 <2.0.0" */
  requiresCore?: string;
  /** tên component lõi theme đã thay thế */
  components: string[];
  /** vị trí menu theme khai báo thêm */
  menuLocations: { key: string; label: string }[];
  /** vùng widget theme hỗ trợ */
  widgetAreas: { key: string; label: string; description?: string }[];
  /** loại nội dung theme có giao diện riêng */
  contentTypes: string[];
}

/** Kết quả `GET /admin/storefront/status`: capabilities + trạng thái kết nối. */
export interface StorefrontStatusView {
  reachable: boolean;
  url: string;
  error: string | null;
  /** Phiên bản lõi (package.json gốc) API đang chạy, để so với phiên bản frontend khai báo. */
  coreVersion: string;
  capabilities: StorefrontCapabilities | null;
}
