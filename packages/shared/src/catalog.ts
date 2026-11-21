/**
 * Kiểu dùng chung cho danh mục bán hàng: thuộc tính sản phẩm dùng chung (màu, size...) và thuế theo vùng.
 * Dùng ở API (modules/products/attributes.*, modules/tax), admin và storefront.
 */

import type { I18nText } from './types.js';

/* ---------------- Thuộc tính sản phẩm dùng chung ---------------- */

/** Kiểu hiển thị ô chọn ở storefront: select = dropdown, color = ô màu, button = nút chữ, image = ảnh nhỏ */
export const PRODUCT_ATTRIBUTE_TYPES = ['select', 'color', 'button', 'image'] as const;
export type ProductAttributeType = (typeof PRODUCT_ATTRIBUTE_TYPES)[number];

export const PRODUCT_ATTRIBUTE_TYPE_LABELS: Record<ProductAttributeType, string> = {
  select: 'Danh sách thả xuống',
  color: 'Ô màu (swatch)',
  button: 'Nút chữ',
  image: 'Ảnh nhỏ',
};

/** Một giá trị của thuộc tính; `value` khớp với Product.options[].values[].value và ProductVariant.optionValues[key] */
export interface ProductAttributeValue {
  value: string;
  label: I18nText;
  /** mã màu hex (type = color), vd "#ff0000" */
  color?: string | null;
  /** media id ảnh (type = image) */
  imageId?: string | null;
  /** URL ảnh (API public/admin gắn kèm khi có imageId) */
  image?: { url: string; thumb?: string | null } | null;
}

/** Thuộc tính dùng chung (bảng product_attributes); `key` khớp với Product.options[].key */
export interface ProductAttribute {
  id: string;
  key: string;
  name: I18nText;
  type: ProductAttributeType;
  values: ProductAttributeValue[];
  /** hiện làm bộ lọc ở trang danh sách sản phẩm (?attr_<key>=v1,v2) */
  filterable: boolean;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Mã thuộc tính hợp lệ: a-z, 0-9, _ (dùng trong query ?attr[key]=) */
export const ATTRIBUTE_KEY_RE = /^[a-z0-9_]{1,50}$/;

/* ---------------- Thuế ---------------- */

/**
 * Cách tính thuế (cài đặt `commerce.taxMode`):
 * - `flat` (mặc định, giữ hành vi cũ): một thuế suất chung `commerce.taxRate`, `pricesIncludeTax` quyết định đã gồm thuế hay cộng thêm.
 * - `none`: không tính thuế (taxTotal = 0).
 * - `inclusive`: thuế suất chung `taxRate`, giá luôn được coi là ĐÃ gồm thuế (chỉ tách ra để hiển thị).
 * - `rates`: dùng bảng thuế suất theo lớp thuế sản phẩm + quốc gia/tỉnh (`/admin/tax-rates`); `pricesIncludeTax` quyết định gộp/cộng.
 * Chưa cấu hình `taxMode` = `flat` → đơn hàng tính như trước khi có tính năng này.
 */
export const TAX_MODES = ['flat', 'none', 'inclusive', 'rates'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export const TAX_MODE_LABELS: Record<TaxMode, string> = {
  flat: 'Thuế suất chung (một mức cho mọi đơn)',
  none: 'Không tính thuế',
  inclusive: 'Thuế suất chung — giá đã gồm thuế',
  rates: 'Theo bảng thuế suất (lớp thuế + vùng)',
};

/** Lớp thuế gợi ý (Product.taxClass; null = standard) */
export const DEFAULT_TAX_CLASSES: { key: string; label: string }[] = [
  { key: 'standard', label: 'Tiêu chuẩn' },
  { key: 'reduced', label: 'Giảm' },
  { key: 'zero', label: 'Không chịu thuế (0%)' },
];

/** Một dòng thuế suất (bảng tax_rates) */
export interface TaxRateItem {
  id: string;
  name: string;
  taxClass: string;
  /** mã quốc gia ISO ("VN") hoặc "*" */
  country: string;
  /** mã tỉnh ("VN-HN") hoặc "*" */
  province: string;
  /** phần trăm, vd 10 */
  rate: number;
  /** áp cả phí vận chuyển */
  shipping: boolean;
  priority: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Kết quả tính thuế cho một đơn/báo giá */
export interface TaxBreakdownLine {
  rateId: string | null;
  name: string;
  rate: number;
  /** số tiền thuế */
  amount: number;
}

export interface TaxComputation {
  mode: TaxMode;
  /** true: giá đã gồm thuế (thuế không cộng thêm vào tổng) */
  inclusive: boolean;
  taxTotal: number;
  /** phần thuế trên phí vận chuyển (đã nằm trong taxTotal) */
  shippingTax: number;
  breakdown: TaxBreakdownLine[];
}

/* ---------------- Sản phẩm ảo ---------------- */

/**
 * Sản phẩm không cần giao hàng: bật `isVirtual`, loại DIGITAL (file tải về) hoặc bán theo kho mã (`codeDelivery`).
 * Giỏ chỉ toàn sản phẩm ảo -> không cần địa chỉ, không tính phí vận chuyển (quote.requiresShipping = false).
 */
export function isVirtualProduct(p: { type?: string | null; isVirtual?: boolean | null; codeDelivery?: boolean | null }): boolean {
  return !!p.isVirtual || !!p.codeDelivery || p.type === 'DIGITAL';
}
