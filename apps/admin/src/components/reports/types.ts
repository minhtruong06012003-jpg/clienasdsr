/** Kiểu dữ liệu trả về từ GET /admin/reports/* */

export interface ReportPeriod {
  from: string;
  to: string;
  fromAt: string;
  toAt: string;
  timezone: string;
}

export interface OverviewMetrics {
  revenue: number;
  gross: number;
  orders: number;
  allOrders: number;
  aov: number;
  items: number;
  refunds: number;
  discounts: number;
  shipping: number;
  customers: number;
  newCustomers: number;
  cancelled: number;
  cancelRate: number;
}

export interface OverviewReport {
  period: ReportPeriod;
  previousPeriod: { fromAt: string; toAt: string } | null;
  current: OverviewMetrics;
  previous: OverviewMetrics | null;
  change: Record<keyof OverviewMetrics, number> | null;
}

export type ReportInterval = 'day' | 'week' | 'month';

export interface RevenuePoint {
  period: string;
  revenue: number;
  orders: number;
  items: number;
  refunds: number;
}

export interface RevenueReport {
  period: ReportPeriod;
  interval: ReportInterval;
  data: RevenuePoint[];
}

export interface ProductRow {
  id: string;
  productId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  revenue: number;
  orders: number;
  deleted: boolean;
  featuredImage: { url: string; urls: Record<string, string> } | null;
}

export interface ProductsReport {
  period: ReportPeriod;
  totals: { quantity: number; revenue: number };
  data: ProductRow[];
}

export interface CategoryRow {
  id: string;
  name: string;
  revenue: number;
  quantity: number;
  orders: number;
  products: number;
  share: number;
}

export interface CategoriesReport {
  period: ReportPeriod;
  method: string;
  total: number;
  data: CategoryRow[];
}

export interface CustomerRow {
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  phone: string;
  orders: number;
  spent: number;
  items: number;
  aov: number;
  lastOrderAt: string;
  firstOrderAt: string;
}

export interface CustomersReport {
  period: ReportPeriod;
  data: CustomerRow[];
}

export interface NewCustomersReport {
  period: ReportPeriod;
  interval: ReportInterval;
  data: { period: string; newCustomers: number; returning: number }[];
}

export interface PaymentMethodRow {
  id: string;
  method: string;
  orders: number;
  paid: number;
  revenue: number;
  share: number;
}

export interface PaymentMethodsReport {
  period: ReportPeriod;
  total: number;
  data: PaymentMethodRow[];
}

export interface ShippingMethodRow {
  id: string;
  label: string;
  orders: number;
  revenue: number;
  shipping: number;
  share: number;
}

export interface ShippingMethodsReport {
  period: ReportPeriod;
  total: number;
  data: ShippingMethodRow[];
}

export interface CouponRow {
  id: string;
  code: string;
  couponId: string | null;
  type: string | null;
  value: number | null;
  isActive: boolean | null;
  usedCount: number | null;
  usageLimit: number | null;
  uses: number;
  discount: number;
  revenue: number;
}

export interface CouponsReport {
  period: ReportPeriod;
  totals: { uses: number; discount: number; revenue: number };
  data: CouponRow[];
}

export interface StatusRow {
  id: string;
  status: string;
  orders: number;
  total: number;
  share: number;
}

export interface StatusesReport {
  period: ReportPeriod;
  status: StatusRow[];
  payment: StatusRow[];
}

export interface StockRow {
  id: string;
  productId: string;
  variantId: string | null;
  name: string;
  variant: string;
  sku: string | null;
  price: number;
  stockQuantity: number;
  threshold: number;
  stockStatus: string;
  state: 'low' | 'out';
}

export interface StockReport {
  threshold: number;
  summary: { value: number; units: number; tracked: number; products: number; lowStock: number; outOfStock: number };
  data: StockRow[];
}
