/**
 * Chuyển giá trị số từ API về number. Hỗ trợ cả Decimal bị serialize thành { s, e, d }
 * (trường hợp interceptor chưa nhận diện được Prisma.Decimal).
 */
export function toNum(value: unknown): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  if (typeof value === 'object' && 'd' in value && 'e' in value) {
    const { s = 1, e, d } = value as { s?: number; e: number; d: number[] | null };
    if (!d || !d.length) return 0;
    const digits = String(d[0]) + d.slice(1).map((x) => String(x).padStart(7, '0')).join('');
    return s * Number(`${digits[0]}.${digits.slice(1) || '0'}e${e}`);
  }
  return Number(value) || 0;
}

export const toNumOrNull = (value: unknown): number | null => (value == null || value === '' ? null : toNum(value));

/** ISO -> giá trị cho input datetime-local */
export const toLocalInput = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

/** datetime-local -> ISO (hoặc null) */
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export const PRODUCT_TYPES = [
  { value: 'SIMPLE', label: 'Sản phẩm thường' },
  { value: 'VARIABLE', label: 'Sản phẩm có biến thể' },
  { value: 'DIGITAL', label: 'Sản phẩm số' },
] as const;

export const STOCK_STATUSES = [
  { value: 'IN_STOCK', label: 'Còn hàng' },
  { value: 'OUT_OF_STOCK', label: 'Hết hàng' },
  { value: 'BACKORDER', label: 'Cho phép đặt trước' },
] as const;

export const ORDER_STATUSES = [
  { value: 'PENDING', label: 'Chờ xác nhận' },
  { value: 'CONFIRMED', label: 'Đã xác nhận' },
  { value: 'PROCESSING', label: 'Đang xử lý' },
  { value: 'SHIPPING', label: 'Đang giao' },
  { value: 'COMPLETED', label: 'Hoàn thành' },
  { value: 'CANCELLED', label: 'Đã huỷ' },
  { value: 'REFUNDED', label: 'Hoàn tiền' },
] as const;

export const PAYMENT_STATUSES = [
  { value: 'UNPAID', label: 'Chưa thanh toán' },
  { value: 'PAID', label: 'Đã thanh toán' },
  { value: 'PARTIALLY_REFUNDED', label: 'Hoàn một phần' },
  { value: 'REFUNDED', label: 'Đã hoàn tiền' },
  { value: 'FAILED', label: 'Thất bại' },
] as const;

export const PAYMENT_METHODS: Record<string, string> = {
  cod: 'Thanh toán khi nhận hàng (COD)',
  bank_transfer: 'Chuyển khoản ngân hàng',
  wallet: 'Số dư ví',
};

/** Tên hiển thị cổng thanh toán online (dự phòng khi chưa tải được danh sách cổng từ API) */
export const ONLINE_PAYMENT_LABELS: Record<string, string> = {
  web2m: 'Web2M',
  usdt: 'USDT',
  payos: 'PayOS',
  sepay: 'SePay',
  pay2s: 'Pay2S',
};

export const COUPON_TYPES = [
  { value: 'PERCENT', label: 'Giảm theo %' },
  { value: 'FIXED', label: 'Giảm số tiền cố định' },
  { value: 'FREE_SHIPPING', label: 'Miễn phí vận chuyển' },
] as const;

export interface Address {
  fullName?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  ward?: string;
  district?: string;
  city?: string;
  country?: string;
}

export const formatAddress = (a: Address | null | undefined) => (a ? [a.line1, a.line2, a.ward, a.district, a.city, a.country].filter(Boolean).join(', ') : '');

/** Sắp xếp danh sách phẳng có parentId thành thứ tự cây kèm độ sâu */
export function flattenTree<T extends { id: string; parentId: string | null }>(rows: T[]): (T & { depth: number })[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, T[]>();
  for (const r of rows) {
    const key = r.parentId && ids.has(r.parentId) ? r.parentId : null;
    children.set(key, [...(children.get(key) ?? []), r]);
  }
  const out: (T & { depth: number })[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
