/**
 * Kiểu + hàm dùng chung cho sản phẩm ảo / kho mã số (key, tài khoản, acc game, thẻ cào, gift card...).
 * API: modules/digital-codes (kho mã), orders (giữ mã khi đặt), products (cấu hình sản phẩm).
 * Admin: /digital-codes, tab "Kho mã" của sản phẩm, thẻ "Mã đã giao" trong đơn. Storefront: trang đơn, tài khoản › Mã đã mua.
 */
import type { I18nText } from './types.js';

export const DIGITAL_CODE_STATUSES = ['AVAILABLE', 'RESERVED', 'SOLD', 'DISABLED', 'REVOKED'] as const;
export type DigitalCodeStatus = (typeof DIGITAL_CODE_STATUSES)[number];

export const DIGITAL_CODE_STATUS_LABELS: Record<DigitalCodeStatus, string> = {
  AVAILABLE: 'Còn trong kho',
  RESERVED: 'Đang giữ cho đơn',
  SOLD: 'Đã giao',
  DISABLED: 'Tạm khoá',
  REVOKED: 'Đã thu hồi',
};

/** Trạng thái giao mã của đơn (Order.codeStatus); null = đơn không có sản phẩm bán theo kho mã */
export type OrderCodeStatus = 'pending' | 'partial' | 'delivered';
export const ORDER_CODE_STATUS_LABELS: Record<OrderCodeStatus, string> = { pending: 'Chờ giao mã', partial: 'Giao thiếu mã', delivered: 'Đã giao mã' };

/** Trạng thái báo lỗi (bảo hành) của một mã */
export type CodeReportStatus = 'OPEN' | 'RESOLVED' | 'REJECTED';
export const CODE_REPORT_STATUS_LABELS: Record<CodeReportStatus, string> = { OPEN: 'Chờ xử lý', RESOLVED: 'Đã xử lý', REJECTED: 'Từ chối' };

/** Ký tự tách các phần của một mã ("user|pass|2fa") */
export const CODE_PART_SEPARATOR = '|';

/** Nhãn một phần của mã (Product.codeFields) */
export interface CodeFieldDef {
  key: string;
  label: I18nText;
  /** che khi hiển thị (mật khẩu, PIN), khách bấm mới hiện */
  secret?: boolean;
}

export const PURCHASE_FIELD_TYPES = ['text', 'email', 'tel', 'number', 'textarea', 'select', 'password'] as const;
export type PurchaseFieldType = (typeof PURCHASE_FIELD_TYPES)[number];

/** Thông tin khách phải nhập khi mua (Product.purchaseFields) — vd ID game, server, email cần nâng cấp */
export interface PurchaseFieldDef {
  key: string;
  label: I18nText;
  type: PurchaseFieldType;
  required?: boolean;
  placeholder?: I18nText;
  /** gợi ý dưới ô nhập */
  help?: I18nText;
  options?: { value: string; label: I18nText }[];
  maxLength?: number;
}

/** Bản đã chọn ngôn ngữ để storefront hiển thị */
export interface PublicPurchaseField {
  key: string;
  label: string;
  type: PurchaseFieldType;
  required: boolean;
  placeholder: string | null;
  help: string | null;
  options: { value: string; label: string }[];
  maxLength: number;
}

/** Giá trị khách đã nhập, lưu ở OrderItem.meta.fields */
export interface PurchaseFieldValue {
  key: string;
  label: string;
  value: string;
  /** loại ô (để giao diện che ô password); dữ liệu cũ có thể thiếu */
  type?: PurchaseFieldType;
}

/** Cấu hình nhóm settings `digital` */
export interface DigitalSettings {
  emailCodes: boolean;
  autoCompleteOrders: boolean;
  autoFulfillBackorders: boolean;
  lowStockAlert: number;
  allowReports: boolean;
  guestAccess: boolean;
}
export const DEFAULT_DIGITAL_SETTINGS: DigitalSettings = { emailCodes: true, autoCompleteOrders: true, autoFulfillBackorders: true, lowStockAlert: 5, allowReports: true, guestAccess: true };

export function readDigitalSettings(raw: unknown): DigitalSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<DigitalSettings>;
  const n = Number(v.lowStockAlert);
  return {
    emailCodes: v.emailCodes !== false,
    autoCompleteOrders: v.autoCompleteOrders !== false,
    autoFulfillBackorders: v.autoFulfillBackorders !== false,
    lowStockAlert: Number.isFinite(n) ? Math.max(0, Math.min(100000, Math.floor(n))) : DEFAULT_DIGITAL_SETTINGS.lowStockAlert,
    allowReports: v.allowReports !== false,
    guestAccess: v.guestAccess !== false,
  };
}

// ---------------------------------------------------------------------------
// Hàm tiện ích (dùng ở cả API lẫn giao diện)
// ---------------------------------------------------------------------------

/** Chọn chữ theo ngôn ngữ, rơi về vi / giá trị đầu tiên */
export function pickText(t: I18nText | string | null | undefined, locale = 'vi'): string {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t[locale] ?? t.vi ?? Object.values(t).find((x) => !!x) ?? '';
}

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Chuẩn hoá danh sách nhãn phần mã từ JSON tuỳ ý (bỏ phần tử hỏng, tối đa 10) */
export function normalizeCodeFields(raw: unknown): CodeFieldDef[] {
  if (!Array.isArray(raw)) return [];
  const out: CodeFieldDef[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const key = String(r.key ?? '').trim();
    if (!KEY_RE.test(key) || out.some((f) => f.key === key)) continue;
    out.push({ key, label: toI18n(r.label, key), ...(r.secret ? { secret: true } : {}) });
    if (out.length >= 10) break;
  }
  return out;
}

/** Chuẩn hoá danh sách ô khách nhập khi mua (tối đa 10) */
export function normalizePurchaseFields(raw: unknown): PurchaseFieldDef[] {
  if (!Array.isArray(raw)) return [];
  const out: PurchaseFieldDef[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const key = String(r.key ?? '').trim();
    if (!KEY_RE.test(key) || out.some((f) => f.key === key)) continue;
    const type = (PURCHASE_FIELD_TYPES as readonly string[]).includes(String(r.type)) ? (r.type as PurchaseFieldType) : 'text';
    const options = type === 'select' && Array.isArray(r.options)
      ? (r.options as Record<string, unknown>[]).filter((o) => o && String(o.value ?? '').trim()).slice(0, 50).map((o) => ({ value: String(o.value).trim(), label: toI18n(o.label, String(o.value)) }))
      : undefined;
    const maxLength = Math.max(1, Math.min(2000, Math.floor(Number(r.maxLength) || (type === 'textarea' ? 1000 : 255))));
    out.push({
      key,
      label: toI18n(r.label, key),
      type,
      ...(r.required ? { required: true } : {}),
      ...(r.placeholder ? { placeholder: toI18n(r.placeholder, '') } : {}),
      ...(r.help ? { help: toI18n(r.help, '') } : {}),
      ...(options ? { options } : {}),
      maxLength,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** Bản hiển thị của ô nhập theo ngôn ngữ */
export function localizePurchaseFields(fields: PurchaseFieldDef[], locale: string): PublicPurchaseField[] {
  return fields.map((f) => ({
    key: f.key,
    label: pickText(f.label, locale) || f.key,
    type: f.type,
    required: !!f.required,
    placeholder: pickText(f.placeholder, locale) || null,
    help: pickText(f.help, locale) || null,
    options: (f.options ?? []).map((o) => ({ value: o.value, label: pickText(o.label, locale) || o.value })),
    maxLength: f.maxLength ?? 255,
  }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Kiểm tra giá trị khách nhập theo định nghĩa ô. Trả `{ values }` (đã cắt khoảng trắng, đúng thứ tự định nghĩa)
 * hoặc `{ error }` (thông báo tiếng Việt / tiếng Anh theo locale).
 */
export function validatePurchaseFields(
  fields: PurchaseFieldDef[],
  input: Record<string, unknown> | null | undefined,
  locale = 'vi',
): { values: PurchaseFieldValue[]; error?: undefined } | { error: string; values?: undefined } {
  const en = locale !== 'vi';
  const values: PurchaseFieldValue[] = [];
  for (const f of fields) {
    const label = pickText(f.label, locale) || f.key;
    const raw = input?.[f.key];
    const value = raw == null ? '' : String(raw).trim();
    if (!value) {
      if (f.required) return { error: en ? `Please enter "${label}"` : `Vui lòng nhập "${label}"` };
      continue;
    }
    if (value.length > (f.maxLength ?? 255)) return { error: en ? `"${label}" is too long` : `"${label}" quá dài` };
    if (f.type === 'email' && !EMAIL_RE.test(value)) return { error: en ? `"${label}" is not a valid email` : `"${label}" không phải email hợp lệ` };
    if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) return { error: en ? `"${label}" must be a number` : `"${label}" phải là số` };
    if (f.type === 'tel' && !/^[0-9+\-\s().]{6,20}$/.test(value)) return { error: en ? `"${label}" is not a valid phone number` : `"${label}" không phải số điện thoại hợp lệ` };
    if (f.type === 'select' && !(f.options ?? []).some((o) => o.value === value)) return { error: en ? `Please choose "${label}"` : `Vui lòng chọn "${label}"` };
    values.push({ key: f.key, label, value, type: f.type });
  }
  return { values };
}

/**
 * Đọc giá trị ô nhập khách gửi lên (giỏ hàng / báo giá) an toàn, KHÔNG lọc theo định nghĩa ô của sản phẩm:
 * tối đa 10 khoá dạng `a-z0-9_`, giá trị nguyên thuỷ đổi sang chuỗi + cắt khoảng trắng, ≤ 2000 ký tự; bỏ giá trị rỗng.
 * Không còn khoá nào -> undefined. Dùng chung cho Cart.items và QuoteLine.inputFields để hai bên khớp dòng.
 */
export function readPurchaseInput(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 10) break;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || v == null || typeof v === 'object') continue;
    const value = String(v).trim().slice(0, 2000);
    if (value) out[k] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Khoá so sánh 2 dòng giỏ cùng sản phẩm: khác thông tin nhập -> 2 dòng khác nhau */
export function purchaseFieldsKey(fields: Record<string, string> | null | undefined): string {
  if (!fields) return '';
  return Object.keys(fields)
    .filter((k) => fields[k] != null && String(fields[k]).trim() !== '')
    .sort()
    .map((k) => `${k}=${String(fields[k]).trim()}`)
    .join('&');
}

/** Tách nội dung mã thành các phần có nhãn (theo Product.codeFields); không có nhãn -> 1 phần nguyên văn */
export function splitCodeParts(content: string, fields: CodeFieldDef[], locale = 'vi'): { label: string; value: string; secret: boolean }[] {
  if (!fields.length) return [{ label: '', value: content, secret: false }];
  const parts = content.split(CODE_PART_SEPARATOR).map((p) => p.trim());
  const out = fields.map((f, i) => ({ label: pickText(f.label, locale) || f.key, value: parts[i] ?? '', secret: !!f.secret }));
  // phần dư (nhiều hơn số nhãn) gộp vào phần cuối để không mất dữ liệu
  if (parts.length > fields.length && out.length) out[out.length - 1].value = parts.slice(fields.length - 1).join(` ${CODE_PART_SEPARATOR} `);
  return out.filter((p) => p.value !== '');
}

/** Ký hiệu che cố định (không lộ độ dài chuỗi gốc) */
const MASK = '••••';

/**
 * Che một chuỗi để hiển thị trong danh sách admin, lộ càng ít càng tốt:
 * - email -> 2 ký tự đầu + "***" + "@tên-miền";
 * - chuỗi dài >= 8 -> "••••" + 4 ký tự cuối (phần che cố định, không lộ độ dài);
 * - chuỗi ngắn hơn -> "••••".
 */
export function maskSecret(value: string): string {
  const v = value.trim();
  if (!v) return '';
  const at = v.indexOf('@');
  if (at > 0) return `${v.slice(0, Math.min(2, at))}***${v.slice(at)}`;
  if (v.length >= 8) return `${MASK}${v.slice(-4)}`;
  return MASK;
}

/**
 * Bản che của cả mã để admin nhận diện trong danh sách: chỉ phần ĐẦU (thường là serial / tài khoản) che một phần theo maskSecret,
 * mọi phần sau dấu "|" (mật khẩu, mã PIN...) luôn che hết, bất kể cấu hình codeFields. Giới hạn 120 ký tự.
 * `fields` giữ lại cho tương thích chữ ký cũ: phần đầu đánh dấu secret thì che hết.
 */
export function codePreview(content: string, fields: CodeFieldDef[] = []): string {
  const parts = content.split(CODE_PART_SEPARATOR).map((p) => p.trim());
  return parts
    .map((p, i) => (i === 0 && !fields[0]?.secret ? maskSecret(p) : MASK))
    .join(` ${CODE_PART_SEPARATOR} `)
    .slice(0, 120);
}

function toI18n(v: unknown, fallback: string): I18nText {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string' && x.trim()) o[k] = x.trim().slice(0, 200);
    if (Object.keys(o).length) return o as I18nText;
  }
  if (typeof v === 'string' && v.trim()) return { vi: v.trim().slice(0, 200) } as I18nText;
  return { vi: fallback } as I18nText;
}

// ---------------------------------------------------------------------------
// Dữ liệu API trả về
// ---------------------------------------------------------------------------

/** Một mã khách đã mua (đã giải mã) — GET account/codes, account/orders/:code/codes, POST public/orders/codes */
export interface CustomerCode {
  id: string;
  orderCode: string;
  orderItemId: string | null;
  productId: string;
  productName: string;
  /** "Gói: 1 tháng" (biến thể) */
  variantLabel: string | null;
  /** nội dung nguyên văn; rỗng khi đã thu hồi */
  content: string;
  parts: { label: string; value: string; secret: boolean }[];
  /** hướng dẫn sử dụng (ProductTranslation.deliveryNote) */
  deliveryNote: string | null;
  status: 'SOLD' | 'REVOKED';
  revokeReason: string | null;
  soldAt: string | null;
  /** hạn dùng của mã */
  expiresAt: string | null;
  /** hạn bảo hành = soldAt + codeWarrantyDays */
  warrantyUntil: string | null;
  canReport: boolean;
  report: { status: CodeReportStatus; note: string | null; reply: string | null; reportedAt: string | null } | null;
  /** mã này thay cho mã lỗi nào */
  replacesId: string | null;
}

/** Mã của một đơn, gom theo dòng hàng */
export interface OrderCodesView {
  orderCode: string;
  /** đơn đã thanh toán chưa (chưa -> mã chưa hiện; đã mà codeStatus pending/partial -> đang chuẩn bị mã) */
  paid: boolean;
  codeStatus: OrderCodeStatus | null;
  items: {
    orderItemId: string;
    productName: string;
    variantLabel: string | null;
    quantity: number;
    /** số mã đã giao (SOLD) */
    delivered: number;
    codes: CustomerCode[];
  }[];
}

/** Một dòng trong danh sách kho (admin) — không có nội dung, chỉ bản che */
export interface AdminDigitalCode {
  id: string;
  productId: string;
  productName: string;
  variantId: string | null;
  variantLabel: string | null;
  preview: string;
  status: DigitalCodeStatus;
  batch: string | null;
  note: string | null;
  costPrice: number | null;
  expiresAt: string | null;
  source: string;
  orderId: string | null;
  orderCode: string | null;
  orderItemId: string | null;
  reservedAt: string | null;
  soldAt: string | null;
  viewedAt: string | null;
  reportStatus: CodeReportStatus | null;
  reportNote: string | null;
  reportedAt: string | null;
  reportReply: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  replacesId: string | null;
  createdAt: string;
}

/** Thống kê kho theo sản phẩm / biến thể */
export interface DigitalStockRow {
  productId: string;
  productName: string;
  sku: string | null;
  variantId: string | null;
  variantLabel: string | null;
  available: number;
  reserved: number;
  sold: number;
  disabled: number;
  revoked: number;
  /** mã còn trong kho sắp hết hạn (30 ngày) */
  expiringSoon: number;
  /** đã hết hạn nhưng vẫn AVAILABLE (không bán được) */
  expired: number;
  lowStock: boolean;
}

export interface DigitalStockSummary {
  rows: DigitalStockRow[];
  totals: { available: number; reserved: number; sold: number; disabled: number; revoked: number };
  openReports: number;
  /** đơn đã thanh toán còn thiếu mã */
  pendingOrders: number;
}

/** Kết quả nhập mã */
export interface DigitalImportResult {
  created: number;
  /** trùng với mã đã có trong kho (hoặc trùng trong chính file) */
  duplicates: number;
  /** dòng rỗng / quá dài */
  invalid: number;
  /** số đơn đang thiếu mã vừa được giao bù */
  fulfilledOrders: number;
}

/** Mã của một đơn cho admin (thẻ "Mã đã giao" trong chi tiết đơn) */
export interface AdminOrderCodes {
  orderId: string;
  orderCode: string;
  codeStatus: OrderCodeStatus | null;
  paid: boolean;
  items: {
    orderItemId: string;
    productId: string | null;
    variantId: string | null;
    productName: string;
    variantLabel: string | null;
    quantity: number;
    codeDelivery: boolean;
    /** số mã đã giao của dòng theo đúng quy tắc backend: SOLD + REVOKED, không tính mã thay thế (replacesId) */
    delivered: number;
    /** thông tin khách nhập khi mua */
    fields: PurchaseFieldValue[];
    codes: AdminDigitalCode[];
  }[];
}
