import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MediaService } from '../media/media.service.js';
import { isValidTimezone, pctChange, periodKeys, resolveRange, toCsv, type Interval, type ResolvedRange } from './reports.util.js';

/**
 * Báo cáo bán hàng (kiểu WooCommerce › Analytics).
 *
 * Quy ước tính toán (áp dụng thống nhất cho mọi báo cáo):
 * - "Đơn hợp lệ" = đơn có status KHÔNG thuộc CANCELLED / REFUNDED. Chỉ các đơn này được tính doanh thu, sản phẩm bán, khách hàng.
 * - Doanh thu thuần = SUM(total - refundedTotal) của đơn hợp lệ (total đã gồm phí ship, thuế, trừ giảm giá; refundedTotal là hoàn một phần).
 * - Hoàn tiền (refunds) = SUM(refundedTotal) của đơn hợp lệ. Đơn REFUNDED (hoàn toàn bộ) bị loại hẳn, không trừ thêm lần nữa.
 * - Đơn được xếp vào ngày/tuần/tháng theo `createdAt` quy đổi sang múi giờ website (settings.general.timezone, mặc định Asia/Ho_Chi_Minh).
 * - Khách hàng nhận diện theo userId, không có thì email (chữ thường), không có nữa thì số điện thoại.
 * - Khách mới = khách có đơn hợp lệ ĐẦU TIÊN nằm trong kỳ.
 * - Tỉ lệ huỷ = đơn CANCELLED / tổng đơn mọi trạng thái trong kỳ.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
  ) {}

  /** Đơn tính doanh thu */
  private readonly VALID = Prisma.sql`o.status NOT IN ('CANCELLED', 'REFUNDED')`;

  private async timezone() {
    const general = await this.settings.get<{ timezone?: string }>('general');
    return isValidTimezone(general.timezone) ? general.timezone : 'Asia/Ho_Chi_Minh';
  }

  async range(q: { from?: string; to?: string }) {
    return resolveRange(q, await this.timezone());
  }

  private inRange(r: { from: Date; to: Date }) {
    return Prisma.sql`o."createdAt" >= ${r.from} AND o."createdAt" < ${r.to}`;
  }

  /** Biểu thức SQL: ngày địa phương (YYYY-MM-DD) của đầu kỳ chứa `createdAt` */
  private periodExpr(interval: Interval, tz: string) {
    return Prisma.sql`to_char(date_trunc(${interval}, (o."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD')`;
  }

  private customerKey = Prisma.sql`COALESCE(o."userId"::text, NULLIF(LOWER(o."customerEmail"), ''), o."customerPhone")`;

  private rangeMeta(r: ResolvedRange) {
    return { from: r.fromDay, to: r.toDay, fromAt: r.from, toAt: r.to, timezone: r.timezone };
  }

  // ------------------------------------------------------------------ Tổng quan

  private async summary(r: { from: Date; to: Date }) {
    const [row] = await this.prisma.$queryRaw<
      { orders: number; revenue: number; refunds: number; discounts: number; shipping: number; gross: number; allOrders: number; cancelled: number; customers: number }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE ${this.VALID})::int AS orders,
        COALESCE(SUM(o.total - o."refundedTotal") FILTER (WHERE ${this.VALID}), 0)::float AS revenue,
        COALESCE(SUM(o.total) FILTER (WHERE ${this.VALID}), 0)::float AS gross,
        COALESCE(SUM(o."refundedTotal") FILTER (WHERE ${this.VALID}), 0)::float AS refunds,
        COALESCE(SUM(o."discountTotal") FILTER (WHERE ${this.VALID}), 0)::float AS discounts,
        COALESCE(SUM(o."shippingTotal") FILTER (WHERE ${this.VALID}), 0)::float AS shipping,
        COUNT(*)::int AS "allOrders",
        COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
        COUNT(DISTINCT ${this.customerKey}) FILTER (WHERE ${this.VALID})::int AS customers
      FROM orders o
      WHERE ${this.inRange(r)}`;
    const [items] = await this.prisma.$queryRaw<{ items: number }[]>`
      SELECT COALESCE(SUM(oi.quantity), 0)::int AS items
      FROM order_items oi JOIN orders o ON o.id = oi."orderId"
      WHERE ${this.VALID} AND ${this.inRange(r)}`;
    const [fresh] = await this.prisma.$queryRaw<{ newCustomers: number }[]>`
      SELECT COUNT(*)::int AS "newCustomers"
      FROM (SELECT ${this.customerKey} AS ck, MIN(o."createdAt") AS first FROM orders o WHERE ${this.VALID} GROUP BY 1) c
      WHERE c.first >= ${r.from} AND c.first < ${r.to}`;
    const orders = Number(row?.orders ?? 0);
    const revenue = Number(row?.revenue ?? 0);
    return {
      revenue,
      gross: Number(row?.gross ?? 0),
      orders,
      allOrders: Number(row?.allOrders ?? 0),
      aov: orders ? Math.round(revenue / orders) : 0,
      items: Number(items?.items ?? 0),
      refunds: Number(row?.refunds ?? 0),
      discounts: Number(row?.discounts ?? 0),
      shipping: Number(row?.shipping ?? 0),
      customers: Number(row?.customers ?? 0),
      newCustomers: Number(fresh?.newCustomers ?? 0),
      cancelled: Number(row?.cancelled ?? 0),
      cancelRate: row?.allOrders ? Math.round((Number(row.cancelled) / Number(row.allOrders)) * 1000) / 10 : 0,
    };
  }

  async overview(q: { from?: string; to?: string; compare?: string }) {
    const r = await this.range(q);
    const compare = q.compare === '1' || q.compare === 'true';
    const current = await this.summary(r);
    const previous = compare ? await this.summary({ from: r.prevFrom, to: r.prevTo }) : null;
    const keys = ['revenue', 'gross', 'orders', 'aov', 'items', 'refunds', 'discounts', 'shipping', 'customers', 'newCustomers', 'cancelled', 'cancelRate'] as const;
    const change = previous ? (Object.fromEntries(keys.map((k) => [k, pctChange(current[k], previous[k])])) as Record<(typeof keys)[number], number>) : null;
    return {
      period: this.rangeMeta(r),
      previousPeriod: previous ? { fromAt: r.prevFrom, toAt: r.prevTo } : null,
      current,
      previous,
      change,
    };
  }

  // ------------------------------------------------------------------ Doanh thu theo kỳ

  async revenue(q: { from?: string; to?: string; interval?: Interval }) {
    const r = await this.range(q);
    const interval: Interval = q.interval ?? 'day';
    const period = this.periodExpr(interval, r.timezone);
    const rows = await this.prisma.$queryRaw<{ period: string; revenue: number; orders: number; refunds: number; items: number }[]>`
      SELECT p.period, p.revenue, p.orders, p.refunds, COALESCE(i.items, 0)::int AS items
      FROM (
        SELECT ${period} AS period,
          COALESCE(SUM(o.total - o."refundedTotal"), 0)::float AS revenue,
          COUNT(*)::int AS orders,
          COALESCE(SUM(o."refundedTotal"), 0)::float AS refunds
        FROM orders o WHERE ${this.VALID} AND ${this.inRange(r)} GROUP BY 1
      ) p
      LEFT JOIN (
        SELECT ${period} AS period, SUM(oi.quantity)::int AS items
        FROM order_items oi JOIN orders o ON o.id = oi."orderId"
        WHERE ${this.VALID} AND ${this.inRange(r)} GROUP BY 1
      ) i ON i.period = p.period
      ORDER BY 1`;
    const map = new Map(rows.map((x) => [x.period, x]));
    const series = periodKeys(r.fromDay, r.toDay, interval).map((key) => {
      const x = map.get(key);
      return { period: key, revenue: Number(x?.revenue ?? 0), orders: Number(x?.orders ?? 0), items: Number(x?.items ?? 0), refunds: Number(x?.refunds ?? 0) };
    });
    return { period: this.rangeMeta(r), interval, data: series };
  }

  // ------------------------------------------------------------------ Sản phẩm

  async products(q: { from?: string; to?: string; limit?: number; sort?: 'revenue' | 'quantity' | 'orders' }) {
    const r = await this.range(q);
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 200);
    const order = q.sort === 'quantity' ? Prisma.sql`quantity DESC, revenue DESC` : q.sort === 'orders' ? Prisma.sql`orders DESC, revenue DESC` : Prisma.sql`revenue DESC, quantity DESC`;
    // gộp theo productId + tên snapshot trên dòng hàng (sản phẩm đã xoá vẫn có mặt nhờ tên snapshot)
    const rows = await this.prisma.$queryRaw<{ productId: string | null; name: string; sku: string | null; quantity: number; revenue: number; orders: number; featuredImageId: string | null; deleted: boolean }[]>`
      SELECT oi."productId"::text AS "productId", oi.name, MIN(oi.sku) AS sku,
        SUM(oi.quantity)::int AS quantity, COALESCE(SUM(oi.total), 0)::float AS revenue, COUNT(DISTINCT oi."orderId")::int AS orders,
        MAX(p."featuredImageId"::text) AS "featuredImageId", BOOL_OR(p.id IS NULL OR p."deletedAt" IS NOT NULL) AS deleted
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      LEFT JOIN products p ON p.id = oi."productId"
      WHERE ${this.VALID} AND ${this.inRange(r)}
      GROUP BY oi."productId", oi.name
      ORDER BY ${order}
      LIMIT ${limit}`;
    const [totals] = await this.prisma.$queryRaw<{ quantity: number; revenue: number }[]>`
      SELECT COALESCE(SUM(oi.quantity), 0)::int AS quantity, COALESCE(SUM(oi.total), 0)::float AS revenue
      FROM order_items oi JOIN orders o ON o.id = oi."orderId"
      WHERE ${this.VALID} AND ${this.inRange(r)}`;
    const data = await this.media.attach(
      rows.map((x, i) => ({
        id: `${x.productId ?? 'deleted'}:${i}`,
        productId: x.productId,
        name: x.name,
        sku: x.sku,
        quantity: Number(x.quantity),
        revenue: Number(x.revenue),
        orders: Number(x.orders),
        deleted: !!x.deleted,
        featuredImageId: x.featuredImageId,
      })),
      ['featuredImageId'],
    );
    return { period: this.rangeMeta(r), totals: { quantity: Number(totals?.quantity ?? 0), revenue: Number(totals?.revenue ?? 0) }, data };
  }

  // ------------------------------------------------------------------ Danh mục

  /**
   * Doanh thu theo danh mục sản phẩm.
   * Cách tính: mỗi dòng hàng được CHIA ĐỀU cho các danh mục mà sản phẩm đang thuộc
   * (sản phẩm có 2 danh mục -> mỗi danh mục nhận 1/2 doanh thu và 1/2 số lượng của dòng đó),
   * nên tổng các danh mục luôn bằng tổng doanh thu sản phẩm. Sản phẩm không có danh mục -> "Chưa phân loại".
   */
  async categories(q: { from?: string; to?: string; locale?: string }) {
    const r = await this.range(q);
    const locale = q.locale || 'vi';
    const rows = await this.prisma.$queryRaw<{ id: string | null; name: string | null; revenue: number; quantity: number; orders: number; products: number }[]>`
      WITH lines AS (
        SELECT oi."productId", oi."orderId", oi.total, oi.quantity
        FROM order_items oi JOIN orders o ON o.id = oi."orderId"
        WHERE ${this.VALID} AND ${this.inRange(r)}
      ),
      cats AS (
        SELECT pc."productId", pc."categoryId", COUNT(*) OVER (PARTITION BY pc."productId") AS n
        FROM product_category_on_product pc
      )
      SELECT c."categoryId"::text AS id,
        (SELECT t.name FROM product_category_translations t WHERE t."categoryId" = c."categoryId" ORDER BY (t.locale = ${locale}) DESC, t.locale LIMIT 1) AS name,
        COALESCE(SUM(l.total / COALESCE(c.n, 1)), 0)::float AS revenue,
        COALESCE(SUM(l.quantity::numeric / COALESCE(c.n, 1)), 0)::float AS quantity,
        COUNT(DISTINCT l."orderId")::int AS orders,
        COUNT(DISTINCT l."productId")::int AS products
      FROM lines l LEFT JOIN cats c ON c."productId" = l."productId"
      GROUP BY c."categoryId"
      ORDER BY revenue DESC`;
    const data = rows.map((x) => ({
      id: x.id ?? 'uncategorized',
      name: x.id ? (x.name ?? '—') : 'Chưa phân loại',
      revenue: Math.round(Number(x.revenue)),
      quantity: Math.round(Number(x.quantity) * 100) / 100,
      orders: Number(x.orders),
      products: Number(x.products),
    }));
    const total = data.reduce((s, x) => s + x.revenue, 0);
    return { period: this.rangeMeta(r), method: 'split-evenly', total, data: data.map((x) => ({ ...x, share: total ? Math.round((x.revenue / total) * 1000) / 10 : 0 })) };
  }

  // ------------------------------------------------------------------ Khách hàng

  async customers(q: { from?: string; to?: string; limit?: number }) {
    const r = await this.range(q);
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 200);
    const rows = await this.prisma.$queryRaw<
      { key: string; userId: string | null; name: string; email: string | null; phone: string; orders: number; spent: number; items: number; lastOrderAt: Date; firstOrderAt: Date }[]
    >`
      SELECT ${this.customerKey} AS key,
        MAX(o."userId"::text) AS "userId",
        (ARRAY_AGG(o."customerName" ORDER BY o."createdAt" DESC))[1] AS name,
        (ARRAY_AGG(o."customerEmail" ORDER BY o."createdAt" DESC))[1] AS email,
        (ARRAY_AGG(o."customerPhone" ORDER BY o."createdAt" DESC))[1] AS phone,
        COUNT(*)::int AS orders,
        COALESCE(SUM(o.total - o."refundedTotal"), 0)::float AS spent,
        COALESCE(SUM(oi.qty), 0)::int AS items,
        MAX(o."createdAt") AS "lastOrderAt",
        MIN(o."createdAt") AS "firstOrderAt"
      FROM orders o
      LEFT JOIN (SELECT "orderId", SUM(quantity) AS qty FROM order_items GROUP BY 1) oi ON oi."orderId" = o.id
      WHERE ${this.VALID} AND ${this.inRange(r)}
      GROUP BY 1
      ORDER BY spent DESC, orders DESC
      LIMIT ${limit}`;
    const data = rows.map((x) => ({
      id: x.key,
      userId: x.userId,
      name: x.name,
      email: x.email,
      phone: x.phone,
      orders: Number(x.orders),
      spent: Number(x.spent),
      items: Number(x.items),
      aov: x.orders ? Math.round(Number(x.spent) / Number(x.orders)) : 0,
      lastOrderAt: x.lastOrderAt,
      firstOrderAt: x.firstOrderAt,
    }));
    return { period: this.rangeMeta(r), data };
  }

  /** Số khách mới (đơn hợp lệ đầu tiên) và khách quay lại theo kỳ */
  async newCustomers(q: { from?: string; to?: string; interval?: Interval }) {
    const r = await this.range(q);
    const interval: Interval = q.interval ?? 'day';
    const period = this.periodExpr(interval, r.timezone);
    const rows = await this.prisma.$queryRaw<{ period: string; newCustomers: number; returning: number }[]>`
      WITH firsts AS (
        SELECT ${this.customerKey} AS ck, MIN(o."createdAt") AS first FROM orders o WHERE ${this.VALID} GROUP BY 1
      )
      SELECT ${period} AS period,
        COUNT(DISTINCT ${this.customerKey}) FILTER (WHERE f.first >= ${r.from})::int AS "newCustomers",
        COUNT(DISTINCT ${this.customerKey}) FILTER (WHERE f.first < ${r.from})::int AS returning
      FROM orders o JOIN firsts f ON f.ck = ${this.customerKey}
      WHERE ${this.VALID} AND ${this.inRange(r)}
      GROUP BY 1 ORDER BY 1`;
    const map = new Map(rows.map((x) => [x.period, x]));
    const data = periodKeys(r.fromDay, r.toDay, interval).map((key) => ({ period: key, newCustomers: Number(map.get(key)?.newCustomers ?? 0), returning: Number(map.get(key)?.returning ?? 0) }));
    return { period: this.rangeMeta(r), interval, data };
  }

  // ------------------------------------------------------------------ Thanh toán / vận chuyển / coupon / trạng thái

  async paymentMethods(q: { from?: string; to?: string }) {
    const r = await this.range(q);
    const rows = await this.prisma.$queryRaw<{ method: string; orders: number; paid: number; revenue: number }[]>`
      SELECT o."paymentMethod" AS method, COUNT(*)::int AS orders,
        COUNT(*) FILTER (WHERE o."paymentStatus" = 'PAID')::int AS paid,
        COALESCE(SUM(o.total - o."refundedTotal"), 0)::float AS revenue
      FROM orders o WHERE ${this.VALID} AND ${this.inRange(r)}
      GROUP BY 1 ORDER BY revenue DESC`;
    const total = rows.reduce((s, x) => s + Number(x.revenue), 0);
    return {
      period: this.rangeMeta(r),
      total,
      data: rows.map((x) => ({ id: x.method, method: x.method, orders: Number(x.orders), paid: Number(x.paid), revenue: Number(x.revenue), share: total ? Math.round((Number(x.revenue) / total) * 1000) / 10 : 0 })),
    };
  }

  async shippingMethods(q: { from?: string; to?: string; locale?: string }) {
    const r = await this.range(q);
    const locale = q.locale || 'vi';
    // ưu tiên tên phương thức trong bảng shipping_methods (theo shippingMethodId), sau đó chuỗi shippingMethod lưu trên đơn
    const rows = await this.prisma.$queryRaw<{ id: string | null; label: string | null; orders: number; revenue: number; shipping: number }[]>`
      SELECT o."shippingMethodId"::text AS id,
        COALESCE(sm.name->>${locale}, sm.name->>'vi', sm.name->>'en', NULLIF(o."shippingMethod", '')) AS label,
        COUNT(*)::int AS orders,
        COALESCE(SUM(o.total - o."refundedTotal"), 0)::float AS revenue,
        COALESCE(SUM(o."shippingTotal"), 0)::float AS shipping
      FROM orders o LEFT JOIN shipping_methods sm ON sm.id = o."shippingMethodId"
      WHERE ${this.VALID} AND ${this.inRange(r)}
      GROUP BY 1, 2 ORDER BY orders DESC`;
    const total = rows.reduce((s, x) => s + Number(x.orders), 0);
    return {
      period: this.rangeMeta(r),
      total,
      data: rows.map((x, i) => ({
        id: x.id ?? x.label ?? `none-${i}`,
        label: x.label ?? 'Chưa xác định',
        orders: Number(x.orders),
        revenue: Number(x.revenue),
        shipping: Number(x.shipping),
        share: total ? Math.round((Number(x.orders) / total) * 1000) / 10 : 0,
      })),
    };
  }

  async coupons(q: { from?: string; to?: string }) {
    const r = await this.range(q);
    const rows = await this.prisma.$queryRaw<{ code: string; couponId: string | null; type: string | null; value: number | null; isActive: boolean | null; usedCount: number | null; usageLimit: number | null; uses: number; discount: number; revenue: number }[]>`
      SELECT o."couponCode" AS code, c.id::text AS "couponId", c.type::text AS type, c.value::float AS value, c."isActive", c."usedCount", c."usageLimit",
        COUNT(*)::int AS uses,
        COALESCE(SUM(o."discountTotal"), 0)::float AS discount,
        COALESCE(SUM(o.total - o."refundedTotal"), 0)::float AS revenue
      FROM orders o LEFT JOIN coupons c ON c.code = o."couponCode"
      WHERE o."couponCode" IS NOT NULL AND ${this.VALID} AND ${this.inRange(r)}
      GROUP BY o."couponCode", c.id
      ORDER BY uses DESC, discount DESC`;
    const data = rows.map((x) => ({
      id: x.code,
      code: x.code,
      couponId: x.couponId,
      type: x.type,
      value: x.value == null ? null : Number(x.value),
      isActive: x.isActive,
      usedCount: x.usedCount == null ? null : Number(x.usedCount),
      usageLimit: x.usageLimit == null ? null : Number(x.usageLimit),
      uses: Number(x.uses),
      discount: Number(x.discount),
      revenue: Number(x.revenue),
    }));
    return {
      period: this.rangeMeta(r),
      totals: { uses: data.reduce((s, x) => s + x.uses, 0), discount: data.reduce((s, x) => s + x.discount, 0), revenue: data.reduce((s, x) => s + x.revenue, 0) },
      data,
    };
  }

  /** Phân bố trạng thái đơn / thanh toán (mọi đơn trong kỳ, kể cả huỷ) */
  async statuses(q: { from?: string; to?: string }) {
    const r = await this.range(q);
    const [status, payment] = await Promise.all([
      this.prisma.$queryRaw<{ key: string; orders: number; total: number }[]>`
        SELECT o.status::text AS key, COUNT(*)::int AS orders, COALESCE(SUM(o.total), 0)::float AS total
        FROM orders o WHERE ${this.inRange(r)} GROUP BY 1`,
      this.prisma.$queryRaw<{ key: string; orders: number; total: number }[]>`
        SELECT o."paymentStatus"::text AS key, COUNT(*)::int AS orders, COALESCE(SUM(o.total), 0)::float AS total
        FROM orders o WHERE ${this.inRange(r)} GROUP BY 1`,
    ]);
    const fill = (keys: string[], rows: { key: string; orders: number; total: number }[]) => {
      const total = rows.reduce((s, x) => s + Number(x.orders), 0);
      return keys.map((k) => {
        const x = rows.find((y) => y.key === k);
        const orders = Number(x?.orders ?? 0);
        return { id: k, status: k, orders, total: Number(x?.total ?? 0), share: total ? Math.round((orders / total) * 1000) / 10 : 0 };
      });
    };
    return {
      period: this.rangeMeta(r),
      status: fill(['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPING', 'COMPLETED', 'CANCELLED', 'REFUNDED'], status),
      payment: fill(['UNPAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED'], payment),
    };
  }

  // ------------------------------------------------------------------ Tồn kho

  /**
   * Tồn kho hiện tại (không phụ thuộc khoảng thời gian).
   * - Giá trị tồn = SUM(giá bán gốc × tồn) với sản phẩm có quản lý kho; sản phẩm có biến thể tính theo từng biến thể.
   * - Sắp hết = tồn > 0 và ≤ ngưỡng (ngưỡng riêng của sản phẩm, không có thì theo cài đặt bán hàng).
   * - Hết hàng = tồn ≤ 0 hoặc trạng thái OUT_OF_STOCK.
   */
  async stock(q: { limit?: number } = {}) {
    const { lowStockThreshold = 5 } = await this.settings.get<{ lowStockThreshold?: number }>('commerce');
    const threshold = Number(lowStockThreshold) || 5;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    // dòng tồn kho: sản phẩm thường = 1 dòng; sản phẩm có biến thể = mỗi biến thể 1 dòng
    const units = Prisma.sql`
      SELECT p.id AS "productId", NULL::uuid AS "variantId", p.sku, p.price, p."stockQuantity", p."stockStatus"::text AS "stockStatus",
        COALESCE(p."lowStockThreshold", ${threshold}) AS threshold, p."manageStock", p.type::text AS type
      FROM products p
      WHERE p."deletedAt" IS NULL AND p.type <> 'VARIABLE'
      UNION ALL
      SELECT p.id, v.id, v.sku, v.price, v."stockQuantity", v."stockStatus"::text,
        COALESCE(p."lowStockThreshold", ${threshold}), p."manageStock", p.type::text
      FROM product_variants v JOIN products p ON p.id = v."productId"
      WHERE p."deletedAt" IS NULL AND p.type = 'VARIABLE' AND v."isActive" = true`;
    const [summary] = await this.prisma.$queryRaw<{ value: number; units: number; tracked: number; lowStock: number; outOfStock: number; products: number }[]>`
      WITH u AS (${units})
      SELECT
        COALESCE(SUM(GREATEST(u."stockQuantity", 0) * u.price) FILTER (WHERE u."manageStock"), 0)::float AS value,
        COALESCE(SUM(GREATEST(u."stockQuantity", 0)) FILTER (WHERE u."manageStock"), 0)::int AS units,
        COUNT(*) FILTER (WHERE u."manageStock")::int AS tracked,
        COUNT(*) FILTER (WHERE u."manageStock" AND u."stockQuantity" > 0 AND u."stockQuantity" <= u.threshold)::int AS "lowStock",
        COUNT(*) FILTER (WHERE (u."manageStock" AND u."stockQuantity" <= 0) OR u."stockStatus" = 'OUT_OF_STOCK')::int AS "outOfStock",
        COUNT(DISTINCT u."productId")::int AS products
      FROM u`;
    const rows = await this.prisma.$queryRaw<{ productId: string; variantId: string | null; name: string | null; sku: string | null; price: number; stockQuantity: number; threshold: number; stockStatus: string; options: unknown }[]>`
      WITH u AS (${units})
      SELECT u."productId"::text AS "productId", u."variantId"::text AS "variantId", u.sku, u.price::float AS price, u."stockQuantity", u.threshold, u."stockStatus",
        (SELECT t.name FROM product_translations t WHERE t."productId" = u."productId" ORDER BY (t.locale = 'vi') DESC, t.locale LIMIT 1) AS name,
        (SELECT v."optionValues" FROM product_variants v WHERE v.id = u."variantId") AS options
      FROM u
      WHERE (u."manageStock" AND u."stockQuantity" <= u.threshold) OR u."stockStatus" = 'OUT_OF_STOCK'
      ORDER BY u."stockQuantity" ASC, name ASC
      LIMIT ${limit}`;
    return {
      threshold,
      summary: {
        value: Number(summary?.value ?? 0),
        units: Number(summary?.units ?? 0),
        tracked: Number(summary?.tracked ?? 0),
        products: Number(summary?.products ?? 0),
        lowStock: Number(summary?.lowStock ?? 0),
        outOfStock: Number(summary?.outOfStock ?? 0),
      },
      data: rows.map((x) => {
        const opts = x.options && typeof x.options === 'object' ? Object.values(x.options as Record<string, unknown>).filter(Boolean).join(' / ') : '';
        return {
          id: x.variantId ?? x.productId,
          productId: x.productId,
          variantId: x.variantId,
          name: x.name ?? '',
          variant: opts,
          sku: x.sku,
          price: Number(x.price),
          stockQuantity: Number(x.stockQuantity),
          threshold: Number(x.threshold),
          stockStatus: x.stockStatus,
          state: Number(x.stockQuantity) <= 0 || x.stockStatus === 'OUT_OF_STOCK' ? 'out' : 'low',
        };
      }),
    };
  }

  // ------------------------------------------------------------------ Xuất CSV

  async exportCsv(q: { report: 'revenue' | 'products' | 'customers' | 'coupons'; from?: string; to?: string; interval?: Interval }) {
    const r = await this.range(q);
    const suffix = `${r.fromDay}_${r.toDay}`;
    const money = (n: number) => Math.round(n);
    if (q.report === 'revenue') {
      const res = await this.revenue({ ...q, interval: q.interval ?? 'day' });
      return {
        filename: `doanh-thu-${res.interval}-${suffix}.csv`,
        content: toCsv(
          ['Kỳ', 'Doanh thu thuần', 'Số đơn', 'Sản phẩm bán', 'Hoàn tiền'],
          res.data.map((x) => [x.period, money(x.revenue), x.orders, x.items, money(x.refunds)]),
        ),
      };
    }
    if (q.report === 'products') {
      const res = await this.products({ ...q, limit: 200, sort: 'revenue' });
      return {
        filename: `san-pham-${suffix}.csv`,
        content: toCsv(
          ['Sản phẩm', 'SKU', 'Số lượng bán', 'Doanh thu', 'Số đơn', 'Mã sản phẩm'],
          res.data.map((x) => [x.name, x.sku ?? '', x.quantity, money(x.revenue), x.orders, x.productId ?? '']),
        ),
      };
    }
    if (q.report === 'customers') {
      const res = await this.customers({ ...q, limit: 200 });
      return {
        filename: `khach-hang-${suffix}.csv`,
        content: toCsv(
          ['Khách hàng', 'Email', 'Điện thoại', 'Số đơn', 'Tổng chi', 'Giá trị đơn TB', 'Mua lần cuối', 'Mua lần đầu'],
          res.data.map((x) => [x.name, x.email ?? '', x.phone, x.orders, money(x.spent), x.aov, x.lastOrderAt, x.firstOrderAt]),
        ),
      };
    }
    const res = await this.coupons(q);
    return {
      filename: `ma-giam-gia-${suffix}.csv`,
      content: toCsv(
        ['Mã', 'Loại', 'Giá trị', 'Lượt dùng trong kỳ', 'Tổng giảm', 'Doanh thu đơn áp dụng', 'Tổng lượt dùng', 'Giới hạn', 'Đang bật'],
        res.data.map((x) => [x.code, x.type ?? '', x.value ?? '', x.uses, money(x.discount), money(x.revenue), x.usedCount ?? '', x.usageLimit ?? '', x.isActive == null ? '' : x.isActive ? 'Có' : 'Không']),
      ),
    };
  }
}
