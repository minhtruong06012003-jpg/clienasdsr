import { localePrefix } from '@cmsnt/shared';

/**
 * Chuyển bản ghi Order (Prisma, include items) thành biến cho mẫu email.
 * Thuần hàm — không phụ thuộc DI — để module khác (admin gửi lại email, thông báo đơn hàng) dùng được.
 * `MailService.orderVars(order, locale)` là bản tiện lợi đã tự điền webUrl và nhãn phương thức thanh toán.
 */

export const ORDER_STATUS_LABELS: Record<string, { vi: string; en: string }> = {
  PENDING: { vi: 'Chờ xác nhận', en: 'Pending' },
  CONFIRMED: { vi: 'Đã xác nhận', en: 'Confirmed' },
  PROCESSING: { vi: 'Đang xử lý', en: 'Processing' },
  SHIPPING: { vi: 'Đang giao hàng', en: 'Shipping' },
  COMPLETED: { vi: 'Hoàn thành', en: 'Completed' },
  CANCELLED: { vi: 'Đã huỷ', en: 'Cancelled' },
  REFUNDED: { vi: 'Đã hoàn tiền', en: 'Refunded' },
};

export const PAYMENT_STATUS_LABELS: Record<string, { vi: string; en: string }> = {
  UNPAID: { vi: 'Chưa thanh toán', en: 'Unpaid' },
  PAID: { vi: 'Đã thanh toán', en: 'Paid' },
  PARTIALLY_REFUNDED: { vi: 'Hoàn tiền một phần', en: 'Partially refunded' },
  REFUNDED: { vi: 'Đã hoàn tiền', en: 'Refunded' },
  FAILED: { vi: 'Thanh toán thất bại', en: 'Payment failed' },
};

export interface OrderItemVars {
  name: string;
  sku: string;
  quantity: number;
  price: number;
  total: number;
  /** "Màu: Đỏ, Size: L" */
  optionsText: string;
  image: string;
}

export interface OrderVars {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  paymentStatusLabel: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  shippingMethod: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  items: OrderItemVars[];
  itemCount: number;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  total: number;
  refundedTotal: number;
  currency: string;
  couponCode: string;
  note: string;
  /** địa chỉ giao hàng dạng 1 dòng */
  shippingAddress: string;
  shippingAddressLines: string[];
  billingAddress: string;
  createdAt: Date | null;
  paidAt: Date | null;
  trackingUrl: string;
  /** link thanh toán lại (đơn online chưa trả) */
  payUrl: string;
  /** link đơn trong trang quản trị */
  adminUrl: string;
  isPaid: boolean;
  /** lịch sử trạng thái [{ status, statusLabel, note, at }] */
  history: { status: string; statusLabel: string; note: string; at: string }[];
}

export interface OrderVarsOptions {
  locale?: string;
  /** URL storefront (không có / cuối) để tạo trackingUrl/payUrl */
  webUrl?: string;
  /**
   * Ngôn ngữ mặc định của website. Có giá trị thì trackingUrl/payUrl được gắn tiền tố ngôn ngữ
   * theo `linkLocale` (→ order.locale → locale): mặc định không tiền tố, ngôn ngữ khác `/{locale}`.
   */
  defaultLocale?: string;
  /** Ngôn ngữ dùng cho link (mặc định: order.locale, rồi `locale`) */
  linkLocale?: string;
  /** URL trang quản trị (không có / cuối) để tạo adminUrl */
  adminUrl?: string;
  /** nhãn phương thức thanh toán theo key (vd. { cod: 'Thanh toán khi nhận hàng' }) */
  paymentMethodLabels?: Record<string, string>;
  /** nhãn phương thức vận chuyển */
  shippingMethodLabel?: string;
  /** cổng thanh toán online -> tạo payUrl khi chưa thanh toán */
  isOnlinePayment?: boolean;
}

type Address = { fullName?: string; phone?: string; line1?: string; line2?: string; ward?: string; district?: string; city?: string; country?: string } | null | undefined;

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const label = (map: Record<string, { vi: string; en: string }>, key: string, locale: string) => {
  const l = map[key];
  if (!l) return key;
  return (l as Record<string, string>)[locale] ?? l.vi;
};

/** Ghép địa chỉ JSON thành các dòng (bỏ phần trống) */
export function addressLines(addr: Address): string[] {
  if (!addr || typeof addr !== 'object') return [];
  const lines: string[] = [];
  const who = [addr.fullName, addr.phone].filter(Boolean).join(' - ');
  if (who) lines.push(who);
  const street = [addr.line1, addr.line2].filter(Boolean).join(', ');
  if (street) lines.push(street);
  const area = [addr.ward, addr.district, addr.city, addr.country].filter(Boolean).join(', ');
  if (area) lines.push(area);
  return lines;
}

/** Nối chuỗi "Màu: Đỏ, Size: L" từ optionValues */
export function optionsText(values: unknown): string {
  if (!values || typeof values !== 'object') return '';
  if (Array.isArray(values)) return values.map((v) => (typeof v === 'object' && v ? Object.values(v).join(': ') : String(v))).join(', ');
  return Object.entries(values as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
}

/** Biến `order` cho mẫu email */
export function buildOrderVars(order: Record<string, any>, opts: OrderVarsOptions = {}): OrderVars {
  const locale = opts.locale ?? str(order.locale) ?? 'vi';
  // địa chỉ gốc + tiền tố ngôn ngữ của đơn (quy ước chung localePrefix trong @cmsnt/shared)
  const linkLocale = opts.linkLocale || str(order.locale) || locale;
  const rawWeb = (opts.webUrl ?? '').replace(/\/$/, '');
  const webUrl = rawWeb && opts.defaultLocale ? `${rawWeb}${localePrefix(linkLocale, opts.defaultLocale)}` : rawWeb;
  const adminUrl = (opts.adminUrl ?? '').replace(/\/$/, '');
  const items: OrderItemVars[] = ((order.items as any[]) ?? []).map((i) => ({
    name: str(i.name),
    sku: str(i.sku),
    quantity: num(i.quantity),
    price: num(i.price),
    total: num(i.total),
    optionsText: optionsText(i.optionValues),
    image: str(i.image),
  }));
  const status = str(order.status);
  const paymentStatus = str(order.paymentStatus);
  const paymentMethod = str(order.paymentMethod);
  const isPaid = paymentStatus === 'PAID';
  const code = str(order.code);
  const history = ((order.history as any[]) ?? []).map((h) => ({ status: str(h.status), statusLabel: label(ORDER_STATUS_LABELS, str(h.status), locale), note: str(h.note), at: str(h.at) }));
  const shippingLines = addressLines(order.shippingAddress as Address);
  return {
    id: str(order.id),
    code,
    status,
    statusLabel: label(ORDER_STATUS_LABELS, status, locale),
    paymentStatus,
    paymentStatusLabel: label(PAYMENT_STATUS_LABELS, paymentStatus, locale),
    paymentMethod,
    paymentMethodLabel: opts.paymentMethodLabels?.[paymentMethod] ?? paymentMethod,
    shippingMethod: opts.shippingMethodLabel ?? str(order.shippingMethod),
    customerName: str(order.customerName),
    customerEmail: str(order.customerEmail),
    customerPhone: str(order.customerPhone),
    items,
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    subtotal: num(order.subtotal),
    discountTotal: num(order.discountTotal),
    shippingTotal: num(order.shippingTotal),
    taxTotal: num(order.taxTotal),
    total: num(order.total),
    refundedTotal: num(order.refundedTotal),
    currency: str(order.currency) || 'VND',
    couponCode: str(order.couponCode),
    note: str(order.note),
    shippingAddress: shippingLines.join(', '),
    shippingAddressLines: shippingLines,
    billingAddress: addressLines(order.billingAddress as Address).join(', '),
    createdAt: order.createdAt ? new Date(order.createdAt) : null,
    paidAt: order.paidAt ? new Date(order.paidAt) : null,
    trackingUrl: webUrl && code ? `${webUrl}/order-tracking?code=${encodeURIComponent(code)}` : '',
    payUrl: webUrl && code && opts.isOnlinePayment && !isPaid && !['CANCELLED', 'REFUNDED'].includes(status) ? `${webUrl}/order-success?code=${encodeURIComponent(code)}` : '',
    adminUrl: adminUrl && order.id ? `${adminUrl}/orders/${str(order.id)}` : '',
    isPaid,
    history,
  };
}
