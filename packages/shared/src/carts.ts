/**
 * Kiểu dùng chung cho giỏ hàng lưu máy chủ, nhắc giỏ bỏ dở và danh sách yêu thích (wishlist).
 * API: modules/carts, modules/wishlist. Admin: Đơn hàng › Giỏ hàng bỏ dở. Storefront: lib/cart-store, lib/wishlist-store.
 */

/** Cấu hình nhắc giỏ bỏ dở — settings nhóm `commerce`, khoá `abandonedCart` */
export interface AbandonedCartSettings {
  /** bật gửi email nhắc tự động (cron 15 phút) */
  enabled: boolean;
  /** gửi lần 1 sau bao nhiêu giờ không hoạt động */
  firstDelayHours: number;
  /** gửi lần 2 sau bao nhiêu giờ không hoạt động (0 = không gửi lần 2) */
  secondDelayHours: number;
  /** giỏ cũ hơn số ngày này thì không nhắc nữa */
  maxAgeDays: number;
}

export const DEFAULT_ABANDONED_CART: AbandonedCartSettings = { enabled: false, firstDelayHours: 1, secondDelayHours: 24, maxAgeDays: 7 };

/** Gộp cấu hình đã lưu với mặc định (settings chỉ merge nông nên object con có thể thiếu khoá) */
export function readAbandonedCartSettings(raw: unknown): AbandonedCartSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<AbandonedCartSettings>;
  const num = (x: unknown, d: number, min: number, max: number) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  return {
    enabled: v.enabled === true,
    firstDelayHours: num(v.firstDelayHours, DEFAULT_ABANDONED_CART.firstDelayHours, 0.25, 720),
    secondDelayHours: num(v.secondDelayHours, DEFAULT_ABANDONED_CART.secondDelayHours, 0, 2160),
    maxAgeDays: num(v.maxAgeDays, DEFAULT_ABANDONED_CART.maxAgeDays, 1, 90),
  };
}

/** Một dòng giỏ lưu trên máy chủ (Cart.items) */
export interface ServerCartItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  /**
   * Thông tin khách nhập khi mua (Product.purchaseFields: ID game, email cần nâng cấp...).
   * Cùng sản phẩm + biến thể nhưng khác `fields` là 2 dòng khác nhau (so bằng purchaseFieldsKey).
   */
  fields?: Record<string, string>;
}

/** Dòng giỏ đã gắn thông tin sản phẩm (giá hiện tại, ảnh, slug) */
export interface CartLine extends ServerCartItem {
  name: string;
  slug: string;
  image: string | null;
  price: number;
  total: number;
  optionValues: Record<string, string>;
  /** sản phẩm còn bán (đã xuất bản, biến thể còn hoạt động) */
  available: boolean;
}

/** Giỏ trả cho storefront: GET/PUT /public/cart/:token */
export interface PublicCart {
  /** mã giỏ — trình duyệt phải lưu lại nếu khác mã đã gửi (giỏ mới / gộp theo tài khoản) */
  token: string;
  items: CartLine[];
  subtotal: number;
  email: string | null;
  /** true khi máy chủ vừa gộp giỏ (đăng nhập) -> client thay giỏ local bằng `items` */
  merged: boolean;
}

/** Trạng thái giỏ trong trang quản trị */
export type AbandonedCartStatus = 'active' | 'abandoned' | 'recovered' | 'converted' | 'expired';

export const ABANDONED_CART_STATUS_LABELS: Record<AbandonedCartStatus, string> = {
  active: 'Đang mua',
  abandoned: 'Bỏ dở',
  recovered: 'Đã khôi phục',
  converted: 'Đã đặt hàng',
  expired: 'Quá hạn nhắc',
};

/** Dòng danh sách admin GET /admin/abandoned-carts */
export interface AbandonedCartRow {
  id: string;
  token: string;
  email: string | null;
  locale: string | null;
  user: { id: string; name: string; email: string } | null;
  itemCount: number;
  subtotal: number;
  lastActivityAt: string;
  reminderCount: number;
  lastReminderAt: string | null;
  convertedOrderCode: string | null;
  status: AbandonedCartStatus;
  createdAt: string;
}

export interface AbandonedCartDetail extends AbandonedCartRow {
  items: CartLine[];
  recoverUrl: string;
}

/** Thống kê GET /admin/abandoned-carts/stats?days= */
export interface AbandonedCartStats {
  days: number;
  /** giỏ có email tạo trong khoảng */
  total: number;
  abandoned: number;
  abandonedValue: number;
  /** giỏ đã được gửi nhắc ít nhất 1 lần */
  reminded: number;
  /** giỏ đã nhắc rồi thành đơn */
  recovered: number;
  recoveredValue: number;
  /** recovered / reminded (0..1) */
  recoveryRate: number;
  /** giỏ thành đơn (có hoặc không nhắc) */
  converted: number;
  settings: AbandonedCartSettings;
}

/** GET /account/wishlist */
export interface WishlistResponse {
  ids: string[];
  /** thẻ sản phẩm (chỉ sản phẩm đang bán) */
  data: Array<Record<string, unknown> & { id: string; name: string; slug: string }>;
}
