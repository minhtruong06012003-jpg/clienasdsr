import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { MailService } from '../mail/mail.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { TaxService } from '../tax/tax.service.js';
import { OrdersService, generateOrderCode } from './orders.service.js';
import { giveStock, restockOrderItem } from './order-stock.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Prisma, type Order, type OrderItem, type Refund } from '../../generated/prisma/client.js';
import { effectivePrice } from '../products/products.presenter.js';
import { DigitalCodesService } from '../digital-codes/digital-codes.service.js';
import { isVirtualProduct, normalizePurchaseFields, validatePurchaseFields, type PurchaseFieldValue } from '@cmsnt/shared';
import type { AdminOrderItemDto, AdminOrderQueryDto, BulkOrdersDto, CreateAdminOrderDto, CreateRefundDto, OrderExportQueryDto, UpdateOrderDetailsDto, UpdateOrderItemsDto } from './orders-admin.dto.js';
import { RESENDABLE_EMAILS } from './orders-admin.dto.js';

interface CommerceSettings {
  currency: string;
  shippingFlatRate: number;
  freeShippingThreshold: number;
  taxRate: number;
  pricesIncludeTax: boolean;
  /** flat (mặc định) | none | inclusive | rates — xem @cmsnt/shared TaxMode */
  taxMode?: string;
  orderCodePrefix: string;
  paymentMethods: { key: string; enabled: boolean; label?: Record<string, string> }[];
}

interface ResolvedLine {
  productId: string | null;
  variantId: string | null;
  name: string;
  sku: string | null;
  optionValues: Record<string, string>;
  image: string | null;
  price: number;
  quantity: number;
  total: number;
  /** thông tin khách nhập khi mua -> OrderItem.meta */
  meta?: { fields: PurchaseFieldValue[] };
  /** sản phẩm không cần giao hàng (dòng tuỳ ý = false) */
  virtual: boolean;
  /** bán theo kho mã */
  codeDelivery: boolean;
}

/** Dữ liệu ghi OrderItem từ dòng đã chuẩn hoá (bỏ cờ nội bộ virtual / codeDelivery) */
const itemData = ({ virtual: _v, codeDelivery: _c, meta, ...l }: ResolvedLine) => ({ ...l, optionValues: l.optionValues as object, ...(meta ? { meta: meta as object } : {}) });

type OrderWithItems = Order & { items: OrderItem[] };
type StockLine = { productId: string | null; variantId: string | null; quantity: number; name?: string };

const ORDER_SORTABLE = ['createdAt', 'updatedAt', 'total', 'paidAt', 'status', 'paymentStatus'];
/** Đơn ở trạng thái này không được sửa dòng hàng / tiền */
const LOCKED_STATUSES = ['COMPLETED', 'CANCELLED', 'REFUNDED'];
const CLOSED_STATUSES = ['CANCELLED', 'REFUNDED'];

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ xác nhận',
  CONFIRMED: 'Đã xác nhận',
  PROCESSING: 'Đang xử lý',
  SHIPPING: 'Đang giao',
  COMPLETED: 'Hoàn thành',
  CANCELLED: 'Đã huỷ',
  REFUNDED: 'Hoàn tiền',
};
const PAYMENT_LABEL: Record<string, string> = {
  UNPAID: 'Chưa thanh toán',
  PAID: 'Đã thanh toán',
  PARTIALLY_REFUNDED: 'Hoàn một phần',
  REFUNDED: 'Đã hoàn tiền',
  FAILED: 'Thất bại',
};
const SOURCE_LABEL: Record<string, string> = { web: 'Website', admin: 'Admin', pos: 'POS' };
/** Tiêu đề email dự phòng khi MailService chưa có sendTemplate */
const MAIL_SUBJECT: Record<string, string> = {
  'order.placed': 'Xác nhận đặt hàng',
  'order.confirmed': 'Đơn hàng đã được xác nhận',
  'order.paid': 'Đã nhận thanh toán đơn hàng',
  'order.shipping': 'Đơn hàng đang được giao',
  'order.completed': 'Đơn hàng đã hoàn thành',
  'order.cancelled': 'Đơn hàng đã huỷ',
  'order.refunded': 'Đã hoàn tiền đơn hàng',
  'order.invoice': 'Hoá đơn đơn hàng',
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const i18n = (v: unknown, locale: string) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  const o = v as Record<string, string>;
  return o[locale] ?? o.vi ?? Object.values(o).find(Boolean) ?? '';
};
const fmtMoney = (v: unknown, currency = 'VND') => {
  const n = Number(v ?? 0);
  if (currency === 'VND') return `${n.toLocaleString('vi-VN')}₫`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
};
const fmtDate = (d: Date | string) => {
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(x.getDate())}/${p(x.getMonth() + 1)}/${x.getFullYear()} ${p(x.getHours())}:${p(x.getMinutes())}`;
};
const formatAddress = (a: Record<string, unknown> | null | undefined) => (a ? [a.line1, a.line2, a.ward, a.district, a.city, a.country].filter(Boolean).join(', ') : '');
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Điều kiện đơn được phép xoá hẳn: đã huỷ, chưa từng thanh toán, không có bản ghi hoàn tiền,
 * không có giao dịch đã nhận tiền (PAID) hoặc đang cần hoàn tiền (needsRefund).
 */
export const DELETABLE_ORDER_WHERE: Prisma.OrderWhereInput = {
  status: 'CANCELLED',
  paymentStatus: 'UNPAID',
  refunds: { none: {} },
  payments: { none: { OR: [{ status: 'PAID' }, { needsRefund: true }] } },
};

/** Lý do (tiếng Việt) không cho xoá đơn; null = được xoá */
export function deleteBlockReason(o: { status: string; paymentStatus: string; _count: { refunds: number; payments: number } }): string | null {
  if (o.status !== 'CANCELLED') return 'chỉ xoá được đơn đã huỷ';
  if (o._count.payments > 0) return 'có giao dịch đã nhận tiền hoặc đang cần hoàn tiền';
  if (o._count.refunds > 0) return 'đã có bản ghi hoàn tiền';
  if (o.paymentStatus !== 'UNPAID') return `trạng thái thanh toán là "${PAYMENT_LABEL[o.paymentStatus] ?? o.paymentStatus}"`;
  return null;
}

/** Nghiệp vụ quản trị đơn hàng: tạo thủ công, sửa dòng hàng, bulk, CSV, gửi lại email, hoàn tiền, hoá đơn */
@Injectable()
export class OrdersAdminService {
  private readonly logger = new Logger('OrdersAdmin');

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly languages: LanguagesService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly payments: PaymentsService,
    private readonly mail: MailService,
    private readonly wallet: WalletService,
    private readonly tax: TaxService,
    private readonly digitalCodes: DigitalCodesService,
  ) {}

  // ---------------- danh sách / chi tiết ----------------

  private where(q: AdminOrderQueryDto): Prisma.OrderWhereInput {
    const where: Prisma.OrderWhereInput = {};
    if (q.status) where.status = q.status as Prisma.OrderWhereInput['status'];
    if (q.paymentStatus) where.paymentStatus = q.paymentStatus as Prisma.OrderWhereInput['paymentStatus'];
    if (q.userId) where.userId = q.userId;
    if (q.source) where.source = q.source;
    if (q.shippingMethodId) where.shippingMethodId = q.shippingMethodId;
    if (q.codeStatus) where.codeStatus = { in: q.codeStatus.split(',') };
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    if (q.search) {
      where.OR = [
        { code: { contains: q.search, mode: 'insensitive' } },
        { customerName: { contains: q.search, mode: 'insensitive' } },
        { customerPhone: { contains: q.search } },
        { customerEmail: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /** Tên phương thức vận chuyển theo id (bulk) */
  private async shippingNames(ids: (string | null)[], locale = 'vi') {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map<string, string>();
    const rows = await this.prisma.shippingMethod.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, i18n(r.name, locale)]));
  }

  async list(q: AdminOrderQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where = this.where(q);
    const [data, total, counts] = await Promise.all([
      this.prisma.order.findMany({ where, skip, take, orderBy: { [ORDER_SORTABLE.includes(q.sort ?? '') ? q.sort! : 'createdAt']: q.order ?? 'desc' }, include: { _count: { select: { items: true } } } }),
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({ by: ['status'], _count: true }),
    ]);
    const names = await this.shippingNames(data.map((o) => o.shippingMethodId));
    const rows = data.map((o) => ({ ...o, shippingMethodName: o.shippingMethod || names.get(o.shippingMethodId ?? '') || null }));
    return { ...paginate(rows, total, page, limit), statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  async get(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: { select: { type: true } } } }, user: { select: { id: true, name: true, email: true } }, refunds: { orderBy: { createdAt: 'desc' } }, eInvoices: { orderBy: { createdAt: 'desc' }, select: { id: true, status: true, kind: true, invoiceNo: true, serial: true, templateCode: true, taxAuthorityCode: true, lookupCode: true, lookupUrl: true, issuedAt: true, total: true, pdfPath: true, errorMessage: true, provider: true, createdAt: true } }, shipments: { orderBy: { createdAt: 'desc' } } },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const [method, createdBy, refundUsers] = await Promise.all([
      order.shippingMethodId ? this.prisma.shippingMethod.findUnique({ where: { id: order.shippingMethodId }, select: { id: true, name: true, type: true } }) : null,
      order.createdById ? this.prisma.user.findUnique({ where: { id: order.createdById }, select: { id: true, name: true, email: true } }) : null,
      this.prisma.user.findMany({ where: { id: { in: [...new Set(order.refunds.map((r) => r.createdById).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    ]);
    const byId = new Map(refundUsers.map((u) => [u.id, u]));
    return {
      ...order,
      items: order.items.map(({ product, ...it }) => ({ ...it, productType: product?.type ?? null })),
      hasDigital: order.items.some((it) => it.product?.type === 'DIGITAL'),
      shippingMethodName: order.shippingMethod || (method ? i18n(method.name, order.locale ?? 'vi') : null),
      shippingMethodRef: method ? { id: method.id, name: method.name, type: method.type } : null,
      createdBy,
      refunds: order.refunds.map((r) => ({ ...r, createdBy: r.createdById ? (byId.get(r.createdById) ?? null) : null })),
      remainingRefundable: round(Number(order.total) - Number(order.refundedTotal)),
      canRefundViaGateway: this.payments.isOnline(order.paymentMethod) && this.payments.supportsRefund(order.paymentMethod), canRefundViaWallet: !!order.userId,
    };
  }

  // ---------------- tiện ích tính tiền / kho ----------------

  private commerce() {
    return this.settings.get<CommerceSettings>('commerce');
  }

  /**
   * Tính thuế / tổng giống quote(): thuế qua TaxService (taxMode chưa cấu hình = 'flat' = công thức cũ), giảm giá không vượt tạm tính.
   * `ctx` (dòng hàng + địa chỉ giao) chỉ cần cho taxMode = 'rates'; thiếu thì coi cả đơn là một dòng lớp standard.
   */
  private async totals(subtotal: number, discount: number, shipping: number, commerce: CommerceSettings, ctx?: { items?: { productId: string | null; total: number | Prisma.Decimal }[]; address?: unknown }) {
    const discountTotal = Math.min(Math.max(0, discount), subtotal);
    const taxable = subtotal - discountTotal;
    const addr = (ctx?.address ?? {}) as { country?: string; province?: string };
    const items = ctx?.items?.length ? ctx.items.map((i) => ({ productId: i.productId, total: Number(i.total) })) : [{ taxClass: null, total: subtotal }];
    const tax = await this.tax.compute(items, { country: addr.country, province: addr.province }, { discountTotal, shippingTotal: shipping }, commerce);
    const taxTotal = tax.taxTotal;
    const total = taxable + shipping + (tax.inclusive ? 0 : taxTotal);
    return { subtotal: round(subtotal), discountTotal: round(discountTotal), shippingTotal: round(shipping), taxTotal: round(taxTotal), total: round(total) };
  }

  private defaultShipping(subtotal: number, commerce: CommerceSettings) {
    let shipping = subtotal > 0 ? Number(commerce.shippingFlatRate) || 0 : 0;
    if (commerce.freeShippingThreshold && subtotal >= Number(commerce.freeShippingThreshold)) shipping = 0;
    return shipping;
  }

  /** Mã đơn dùng chung bộ sinh với checkout (8 ký tự ngẫu nhiên, khó đoán) */
  private async generateCode(prefix: string) {
    return generateOrderCode(prefix, async (code) => !!(await this.prisma.order.findUnique({ where: { code }, select: { id: true } })));
  }

  /** Admin được chọn mọi phương thức khai báo trong Cài đặt (kể cả đang tắt với khách) + cổng online đang hoạt động */
  private async isValidMethod(key: string, commerce: CommerceSettings) {
    if ((commerce.paymentMethods ?? []).some((m) => m.key === key)) return true;
    return this.payments.isValidMethod(key);
  }

  /** Chuẩn hoá dòng hàng gửi lên: lấy tên / SKU / ảnh / giá từ sản phẩm; dòng tuỳ ý cần name + price */
  private async resolveLines(items: AdminOrderItemDto[], locale: string): Promise<ResolvedLine[]> {
    const fallback = await this.languages.defaultLocale();
    const ids = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
    const products = ids.length
      ? await this.prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, include: { translations: { select: { locale: true, name: true } }, variants: true } })
      : [];
    const media = await this.media.findMany([...products.map((p) => p.featuredImageId), ...products.flatMap((p) => p.variants.map((v) => v.imageId))]);
    return items.map((item, idx) => {
      if (!item.productId) {
        const name = item.name?.trim();
        if (!name) throw new BadRequestException(`Dòng ${idx + 1}: dòng tuỳ ý cần có tên`);
        if (item.price == null) throw new BadRequestException(`Dòng "${name}": cần nhập đơn giá`);
        const price = round(Number(item.price));
        return { productId: null, variantId: null, name, sku: item.sku ?? null, optionValues: {}, image: null, price, quantity: item.quantity, total: round(price * item.quantity), virtual: false, codeDelivery: false };
      }
      const p = products.find((x) => x.id === item.productId);
      if (!p) throw new BadRequestException(`Dòng ${idx + 1}: sản phẩm không tồn tại hoặc đã xoá`);
      const tr = p.translations.find((t) => t.locale === locale) ?? p.translations.find((t) => t.locale === fallback) ?? p.translations[0];
      const variant = item.variantId ? p.variants.find((v) => v.id === item.variantId) : null;
      if (item.variantId && !variant) throw new BadRequestException(`"${tr?.name ?? p.sku}": phân loại không thuộc sản phẩm này`);
      if (p.type === 'VARIABLE' && !variant) throw new BadRequestException(`"${tr?.name ?? p.sku}": vui lòng chọn phân loại sản phẩm`);
      const basePrice = variant ? effectivePrice({ price: variant.price, salePrice: variant.salePrice }).finalPrice : effectivePrice(p).finalPrice;
      const price = round(item.price != null ? Number(item.price) : basePrice);
      const img = media.get(variant?.imageId ?? p.featuredImageId ?? '');
      // thông tin khách nhập khi mua: admin nhập hộ nên không bắt buộc, chỉ kiểm tra định dạng các ô đã điền
      const defs = normalizePurchaseFields(p.purchaseFields).map((f) => ({ ...f, required: false }));
      const checked = validatePurchaseFields(defs, item.fields, locale);
      if (checked.error !== undefined) throw new BadRequestException(`"${tr?.name ?? p.sku}": ${checked.error}`);
      const fieldValues = checked.values;
      return {
        productId: p.id,
        variantId: variant?.id ?? null,
        name: item.name?.trim() || tr?.name || p.sku || 'Sản phẩm',
        sku: item.sku ?? variant?.sku ?? p.sku ?? null,
        optionValues: ((variant?.optionValues as Record<string, string>) ?? {}) as Record<string, string>,
        image: img?.urls.thumb ?? img?.url ?? null,
        price,
        quantity: item.quantity,
        total: round(price * item.quantity),
        ...(fieldValues.length ? { meta: { fields: fieldValues } } : {}),
        virtual: isVirtualProduct(p),
        codeDelivery: p.codeDelivery,
      };
    });
  }

  /**
   * Đơn có cần giao hàng không: còn dòng sản phẩm thật, hoặc dòng tuỳ ý khi admin có nhập địa chỉ
   * (dòng tuỳ ý có thể là dịch vụ -> không tự bắt địa chỉ).
   */
  private needsShipping(lines: Pick<ResolvedLine, 'productId' | 'virtual'>[], hasAddress: boolean) {
    return lines.some((l) => !l.virtual && (!!l.productId || hasAddress));
  }

  /** Trừ kho có điều kiện (giống checkout) + tăng soldCount */
  private async takeStock(tx: Prisma.TransactionClient, line: StockLine) {
    if (!line.productId || line.quantity <= 0) return;
    const product = await tx.product.findUnique({ where: { id: line.productId } });
    if (!product) throw new BadRequestException(`"${line.name ?? 'Sản phẩm'}" không tồn tại`);
    if (product.manageStock) {
      const stockWhere = { OR: [{ stockQuantity: { gte: line.quantity } }, { stockStatus: 'BACKORDER' as const }] };
      if (line.variantId) {
        const res = await tx.productVariant.updateMany({ where: { id: line.variantId, productId: line.productId, ...stockWhere }, data: { stockQuantity: { decrement: line.quantity } } });
        if (!res.count) throw new BadRequestException(`"${line.name ?? 'Sản phẩm'}" không đủ hàng trong kho`);
        await tx.productVariant.updateMany({ where: { id: line.variantId, stockQuantity: { lte: 0 }, stockStatus: 'IN_STOCK' }, data: { stockStatus: 'OUT_OF_STOCK' } });
      } else {
        const res = await tx.product.updateMany({ where: { id: line.productId, ...stockWhere }, data: { stockQuantity: { decrement: line.quantity } } });
        if (!res.count) throw new BadRequestException(`"${line.name ?? 'Sản phẩm'}" không đủ hàng trong kho`);
        await tx.product.updateMany({ where: { id: line.productId, stockQuantity: { lte: 0 }, stockStatus: 'IN_STOCK' }, data: { stockStatus: 'OUT_OF_STOCK' } });
      }
    }
    await tx.product.update({ where: { id: line.productId }, data: { soldCount: { increment: line.quantity } } });
  }

  /** Cộng lại kho khi sửa giảm / xoá dòng hàng (helper chung order-stock.ts; không đụng restockedQty) */
  private async giveStock(tx: Prisma.TransactionClient, line: StockLine) {
    await giveStock(tx, line);
  }

  private historyOf(order: Order) {
    return [...((order.history as object[]) ?? [])];
  }

  private activity(actor: AuthUser, action: string, entityId: string, meta?: Record<string, unknown>) {
    this.events.emit('activity', { userId: actor.id === 'system' ? null : actor.id, action, entityType: 'order', entityId, meta: meta ?? {} });
  }

  // ---------------- tạo đơn thủ công ----------------

  async create(dto: CreateAdminOrderDto, actor: AuthUser) {
    const commerce = await this.commerce();
    const locale = await this.languages.resolve(dto.locale);
    const paymentMethod = dto.paymentMethod ?? 'cod';
    if (!(await this.isValidMethod(paymentMethod, commerce))) throw new BadRequestException('Phương thức thanh toán không hợp lệ');
    if (dto.userId && !(await this.prisma.user.findFirst({ where: { id: dto.userId, deletedAt: null }, select: { id: true } }))) throw new BadRequestException('Khách hàng không tồn tại');

    const lines = await this.resolveLines(dto.items, locale);
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const requiresShipping = this.needsShipping(lines, !!dto.shippingAddress?.line1?.trim());
    if (requiresShipping && !dto.shippingAddress?.line1?.trim()) throw new BadRequestException('Vui lòng nhập địa chỉ giao hàng');
    // đơn toàn hàng ảo: chỉ lưu thông tin liên hệ tối thiểu
    const shippingAddress = requiresShipping
      ? dto.shippingAddress!
      : { fullName: dto.shippingAddress?.fullName?.trim() || dto.customerName.trim(), phone: dto.shippingAddress?.phone?.trim() || dto.customerPhone.trim(), country: (dto.shippingAddress?.country || 'VN').toUpperCase() };

    // phương thức vận chuyển (nếu chọn từ danh sách): lấy tên / phí mặc định
    let shippingName = dto.shippingMethod?.trim() || null;
    let shippingFee: number | null = dto.shippingTotal ?? null;
    if (dto.shippingMethodId) {
      const m = await this.prisma.shippingMethod.findUnique({ where: { id: dto.shippingMethodId } });
      if (!m) throw new BadRequestException('Phương thức vận chuyển không tồn tại');
      shippingName ??= i18n(m.name, locale);
      if (shippingFee == null) shippingFee = m.type === 'FREE' && (m.minOrderTotal == null || subtotal >= Number(m.minOrderTotal)) ? 0 : Number(m.cost);
    }
    // đơn không cần giao hàng: không áp phí cố định mặc định (admin vẫn có thể nhập tay)
    const t = await this.totals(subtotal, dto.discountTotal ?? 0, shippingFee ?? (requiresShipping ? this.defaultShipping(subtotal, commerce) : 0), commerce, { items: lines, address: shippingAddress });
    const status = dto.status ?? 'PENDING';
    const paymentStatus = dto.paymentStatus ?? 'UNPAID';
    const code = await this.generateCode(commerce.orderCodePrefix || 'DH');
    const now = new Date();
    const by = actor.name ?? actor.id;

    const order = await this.prisma.$transaction(async (tx) => {
      for (const line of lines) await this.takeStock(tx, line);
      const created = await tx.order.create({
        data: {
          code,
          userId: dto.userId ?? null,
          status,
          paymentStatus,
          paymentMethod,
          shippingMethod: shippingName,
          shippingMethodId: dto.shippingMethodId ?? null,
          currency: commerce.currency || 'VND',
          ...t,
          customerName: dto.customerName.trim(),
          customerEmail: dto.customerEmail?.trim() || null,
          customerPhone: dto.customerPhone.trim(),
          shippingAddress: shippingAddress as object,
          billingAddress: (dto.billingAddress as object | undefined) ?? undefined,
          requiresShipping,
          codeStatus: lines.some((l) => l.codeDelivery) ? 'pending' : null,
          note: dto.note?.trim() || null,
          adminNote: dto.adminNote?.trim() || null,
          locale,
          source: 'admin',
          createdById: actor.id === 'system' ? null : actor.id,
          paidAt: paymentStatus === 'PAID' ? now : null,
          history: [{ status, note: `Tạo bởi admin${dto.discountTotal ? ` · giảm giá thủ công ${fmtMoney(t.discountTotal, commerce.currency)}` : ''}`, at: now.toISOString(), by }],
          items: { create: lines.map(itemData) },
        },
        include: { items: true },
      });
      // giữ mã trong kho cho dòng bán theo kho mã (thiếu mã -> lỗi, rollback; BACKORDER cho đặt trước)
      await this.digitalCodes.reserveForOrder(tx, created);
      return created;
    });

    this.events.emit('order.created', { order, source: 'admin' });
    await this.hooks.doAction('order.created', order, { source: 'admin', actor: { id: actor.id, name: actor.name } });
    this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    this.activity(actor, 'order.create', order.id, { code: order.code, total: t.total, source: 'admin' });
    let emailSent = false;
    if (dto.sendEmail && order.customerEmail) {
      const r = await this.sendOrderMail('order.placed', order).catch((err: Error) => {
        this.logger.warn(`Gửi email order.placed cho ${order.code} lỗi: ${err.message}`);
        return { status: 'FAILED' as const, logId: null, error: err.message };
      });
      emailSent = r.status === 'SENT';
    }
    return { ...(await this.get(order.id)), emailSent };
  }

  // ---------------- sửa dòng hàng / thông tin ----------------

  async updateItems(id: string, dto: UpdateOrderItemsDto, actor: AuthUser) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (LOCKED_STATUSES.includes(order.status)) throw new BadRequestException('Đơn đã hoàn thành / huỷ / hoàn tiền không thể sửa dòng hàng');
    const commerce = await this.commerce();
    const locale = order.locale ?? (await this.languages.defaultLocale());

    const existingIds = new Set(order.items.map((i) => i.id));
    for (const it of dto.items) if (it.id && !existingIds.has(it.id)) throw new BadRequestException('Dòng hàng không thuộc đơn này');
    const keep = dto.items.filter((i) => i.id);
    const fresh = await this.resolveLines(
      dto.items.filter((i) => !i.id),
      locale,
    );
    const by = actor.name ?? actor.id;
    const changes: string[] = [];

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
      // đọc lại dòng hàng sau khi khoá đơn: restockedQty có thể vừa đổi bởi hoàn tiền / huỷ đơn chạy song song
      const lockedItems = await tx.orderItem.findMany({ where: { orderId: id } });
      const restockedOf = (itemId: string) => lockedItems.find((x) => x.id === itemId)?.restockedQty ?? 0;
      // xoá dòng không còn trong danh sách -> chỉ hoàn phần chưa hoàn kho (tránh cộng kho hai lần sau khi hoàn tiền có hoàn kho)
      for (const it of order.items) {
        if (keep.some((k) => k.id === it.id)) continue;
        await this.giveStock(tx, { productId: it.productId, variantId: it.variantId, quantity: it.quantity - restockedOf(it.id) });
        await tx.orderItem.delete({ where: { id: it.id } });
        changes.push(`xoá "${it.name}"`);
      }
      // dòng cũ: đổi số lượng / giá -> điều chỉnh chênh lệch kho
      for (const k of keep) {
        const it = order.items.find((x) => x.id === k.id)!;
        const price = round(k.price != null ? Number(k.price) : Number(it.price));
        // không giảm dưới số lượng đã hoàn kho (phần đó đã trả về kho rồi)
        if (k.quantity < restockedOf(it.id)) throw new BadRequestException(`"${it.name}": đã hoàn kho ${restockedOf(it.id)} sản phẩm, không thể giảm số lượng xuống ${k.quantity}`);
        const delta = k.quantity - it.quantity;
        if (delta > 0) await this.takeStock(tx, { productId: it.productId, variantId: it.variantId, quantity: delta, name: it.name });
        else if (delta < 0) await this.giveStock(tx, { productId: it.productId, variantId: it.variantId, quantity: -delta });
        if (delta !== 0) changes.push(`"${it.name}" ${it.quantity} → ${k.quantity}`);
        if (price !== Number(it.price)) changes.push(`giá "${it.name}" ${fmtMoney(it.price, order.currency)} → ${fmtMoney(price, order.currency)}`);
        await tx.orderItem.update({ where: { id: it.id }, data: { quantity: k.quantity, price, total: round(price * k.quantity), ...(k.name?.trim() ? { name: k.name.trim() } : {}) } });
      }
      for (const l of fresh) {
        await this.takeStock(tx, l);
        await tx.orderItem.create({ data: { ...itemData(l), orderId: id } });
        changes.push(`thêm "${l.name}" × ${l.quantity}`);
      }
      const items = await tx.orderItem.findMany({ where: { orderId: id }, include: { product: { select: { type: true, isVirtual: true, codeDelivery: true } } } });
      const subtotal = items.reduce((s, i) => s + Number(i.total), 0);
      const t = await this.totals(subtotal, Number(order.discountTotal), Number(order.shippingTotal), commerce, { items, address: order.shippingAddress });
      const history = this.historyOf(order);
      history.push({ status: order.status, note: `Sửa dòng hàng: ${changes.join('; ') || 'không đổi'}${dto.note ? ` — ${dto.note}` : ''}`, at: new Date().toISOString(), by });
      // tính lại cờ giao hàng / giao mã theo dòng hàng mới (giao mã bù cho dòng mới do DigitalCodesService nghe order.itemsChanged)
      const addr = (order.shippingAddress ?? {}) as { line1?: string };
      const requiresShipping = this.needsShipping(items.map((i) => ({ productId: i.productId, virtual: i.product ? isVirtualProduct(i.product) : false })), !!addr.line1);
      const hasCodes = items.some((i) => i.product?.codeDelivery);
      const codeStatus = hasCodes ? (order.codeStatus ?? 'pending') : null;
      return tx.order.update({ where: { id }, data: { ...t, history, requiresShipping, codeStatus }, include: { items: true } });
    });

    this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    this.events.emit('order.itemsChanged', { order: updated, actor });
    await this.hooks.doAction('order.updated', updated, { changes, actor: { id: actor.id, name: actor.name } });
    this.activity(actor, 'order.items', id, { changes, total: Number(updated.total) });
    return this.get(id);
  }

  async updateDetails(id: string, dto: UpdateOrderDetailsDto, actor: AuthUser) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const moneyChange = dto.discountTotal != null || dto.shippingTotal != null;
    if (moneyChange && LOCKED_STATUSES.includes(order.status)) throw new BadRequestException('Đơn đã hoàn thành / huỷ / hoàn tiền không thể sửa giảm giá / phí vận chuyển');
    const data: Prisma.OrderUpdateInput = {};
    const notes: string[] = [];
    if (dto.customerName != null && dto.customerName.trim() !== order.customerName) (data.customerName = dto.customerName.trim()), notes.push('tên khách');
    if (dto.customerEmail !== undefined && (dto.customerEmail?.trim() || null) !== order.customerEmail) (data.customerEmail = dto.customerEmail?.trim() || null), notes.push('email');
    if (dto.customerPhone != null && dto.customerPhone.trim() !== order.customerPhone) (data.customerPhone = dto.customerPhone.trim()), notes.push('SĐT');
    if (dto.billingAddress !== undefined) (data.billingAddress = dto.billingAddress === null ? Prisma.DbNull : (dto.billingAddress as object)), notes.push('địa chỉ thanh toán');
    if (dto.shippingAddress !== undefined) (data.shippingAddress = dto.shippingAddress as object), notes.push('địa chỉ giao hàng');
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.shippingMethodId !== undefined) {
      if (dto.shippingMethodId && !(await this.prisma.shippingMethod.findUnique({ where: { id: dto.shippingMethodId }, select: { id: true } }))) throw new BadRequestException('Phương thức vận chuyển không tồn tại');
      data.shippingMethodId = dto.shippingMethodId;
      notes.push('phương thức vận chuyển');
    }
    if (dto.shippingMethod !== undefined) data.shippingMethod = dto.shippingMethod?.trim() || null;
    if (moneyChange) {
      const commerce = await this.commerce();
      const subtotal = order.items.reduce((s, i) => s + Number(i.total), 0);
      const t = await this.totals(subtotal, dto.discountTotal ?? Number(order.discountTotal), dto.shippingTotal ?? Number(order.shippingTotal), commerce, { items: order.items, address: dto.shippingAddress ?? order.shippingAddress });
      Object.assign(data, t);
      if (dto.discountTotal != null && t.discountTotal !== Number(order.discountTotal)) notes.push(`giảm giá ${fmtMoney(order.discountTotal, order.currency)} → ${fmtMoney(t.discountTotal, order.currency)}`);
      if (dto.shippingTotal != null && t.shippingTotal !== Number(order.shippingTotal)) notes.push(`phí vận chuyển ${fmtMoney(order.shippingTotal, order.currency)} → ${fmtMoney(t.shippingTotal, order.currency)}`);
    }
    if (!Object.keys(data).length) return this.get(id);
    const history = this.historyOf(order);
    history.push({ status: order.status, note: `Cập nhật thông tin đơn: ${notes.join(', ') || 'ghi chú'}`, at: new Date().toISOString(), by: actor.name ?? actor.id });
    const updated = await this.prisma.order.update({ where: { id }, data: { ...data, history } });
    await this.hooks.doAction('order.updated', updated, { changes: notes, actor: { id: actor.id, name: actor.name } });
    this.activity(actor, 'order.details', id, { fields: notes });
    return this.get(id);
  }

  // ---------------- hàng loạt ----------------

  async bulk(dto: BulkOrdersDto, actor: AuthUser) {
    const ids = [...new Set(dto.ids)];
    const failed: { id: string; code?: string; error: string }[] = [];
    let affected = 0;
    if (dto.action === 'delete') {
      // chỉ xoá đơn đã huỷ CHƯA từng có tiền: kho / mã giảm giá đã hoàn khi huỷ, và không làm mất dấu vết tiền của khách
      // (giao dịch đã nhận tiền / cần hoàn tiền, bản ghi hoàn tiền, trạng thái thanh toán khác "Chưa thanh toán")
      const rows = await this.prisma.order.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          code: true,
          status: true,
          paymentStatus: true,
          _count: { select: { refunds: true, payments: { where: { OR: [{ status: 'PAID' }, { needsRefund: true }] } } } },
        },
      });
      const ok: typeof rows = [];
      for (const r of rows) {
        const reason = deleteBlockReason(r);
        if (reason) failed.push({ id: r.id, code: r.code, error: `Đơn ${r.code}: ${reason}` });
        else ok.push(r);
      }
      for (const id of ids) if (!rows.some((r) => r.id === id)) failed.push({ id, error: 'Không tìm thấy đơn hàng' });
      if (ok.length) {
        // lặp lại điều kiện trong câu xoá: webhook / hoàn tiền chen giữa lúc kiểm tra và lúc xoá thì đơn đó không bị xoá
        const res = await this.prisma.order.deleteMany({ where: { id: { in: ok.map((r) => r.id) }, ...DELETABLE_ORDER_WHERE } });
        affected = res.count;
        const left = res.count < ok.length ? await this.prisma.order.findMany({ where: { id: { in: ok.map((r) => r.id) } }, select: { id: true, code: true } }) : [];
        for (const r of left) failed.push({ id: r.id, code: r.code, error: `Đơn ${r.code}: vừa phát sinh thanh toán / hoàn tiền, không xoá` });
        for (const r of ok) if (!left.some((x) => x.id === r.id)) this.activity(actor, 'order.delete', r.id, { code: r.code });
      }
      const skipped = failed.filter((f) => f.code).map((f) => f.code);
      return { success: true, affected, failed, ...(skipped.length ? { message: `Đã bỏ qua ${skipped.length} đơn không được xoá: ${skipped.join(', ')}` } : {}) };
    }
    const [kind, value] = dto.action.split(':') as ['status' | 'paymentStatus', string];
    for (const id of ids) {
      try {
        if (kind === 'status') await this.orders.update(id, { status: value as never, statusNote: dto.note ?? 'Cập nhật hàng loạt' }, actor);
        else {
          const updated = await this.orders.update(id, { paymentStatus: value as never }, actor);
          if (value === 'PAID' && !updated.paidAt) await this.prisma.order.update({ where: { id }, data: { paidAt: new Date() } });
        }
        affected++;
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }
    this.activity(actor, 'order.bulk', ids[0], { action: dto.action, ids, affected, failed: failed.length });
    return { success: true, affected, failed };
  }

  // ---------------- xuất CSV ----------------

  async exportCsv(q: OrderExportQueryDto, actor: AuthUser) {
    const where = this.where(q);
    const rows = await this.prisma.order.findMany({ where, orderBy: { [ORDER_SORTABLE.includes(q.sort ?? '') ? q.sort! : 'createdAt']: q.order ?? 'desc' }, include: { items: true }, take: 10_000 });
    const names = await this.shippingNames(rows.map((o) => o.shippingMethodId));
    // chặn chèn công thức Excel (=, +, -, @) từ dữ liệu khách nhập
    const escCsv = (v: unknown) => {
      let s = v instanceof Date ? v.toISOString() : String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const detail = q.detail === '1';
    const base = (o: (typeof rows)[number]) => [
      o.code,
      fmtDate(o.createdAt),
      STATUS_LABEL[o.status] ?? o.status,
      PAYMENT_LABEL[o.paymentStatus] ?? o.paymentStatus,
      o.paymentMethod,
      SOURCE_LABEL[o.source] ?? o.source,
      o.customerName,
      o.customerEmail ?? '',
      o.customerPhone,
      formatAddress(o.shippingAddress as Record<string, unknown>),
      o.shippingMethod || names.get(o.shippingMethodId ?? '') || '',
      o.currency,
      Number(o.subtotal),
      Number(o.discountTotal),
      o.couponCode ?? '',
      Number(o.shippingTotal),
      Number(o.taxTotal),
      Number(o.total),
      Number(o.refundedTotal),
      o.paidAt ? fmtDate(o.paidAt) : '',
      o.note ?? '',
    ];
    const baseHeader = ['Mã đơn', 'Ngày đặt', 'Trạng thái', 'Thanh toán', 'Phương thức TT', 'Nguồn', 'Khách hàng', 'Email', 'Điện thoại', 'Địa chỉ giao', 'Vận chuyển', 'Tiền tệ', 'Tạm tính', 'Giảm giá', 'Mã giảm giá', 'Phí vận chuyển', 'Thuế', 'Tổng cộng', 'Đã hoàn', 'Ngày thanh toán', 'Ghi chú'];
    const header = detail ? [...baseHeader, 'Sản phẩm', 'SKU', 'Phân loại', 'Đơn giá', 'Số lượng', 'Thành tiền'] : [...baseHeader, 'Số dòng', 'Sản phẩm'];
    const lines: string[] = [];
    for (const o of rows) {
      if (detail) {
        if (!o.items.length) lines.push([...base(o), '', '', '', '', 0, 0].map(escCsv).join(','));
        for (const it of o.items) {
          lines.push([...base(o), it.name, it.sku ?? '', Object.values((it.optionValues as Record<string, string>) ?? {}).join(' / '), Number(it.price), it.quantity, Number(it.total)].map(escCsv).join(','));
        }
      } else {
        lines.push([...base(o), o.items.length, o.items.map((it) => `${it.name}${it.sku ? ` [${it.sku}]` : ''} x${it.quantity}`).join('; ')].map(escCsv).join(','));
      }
    }
    this.activity(actor, 'order.export', 'orders', { count: rows.length, detail, filter: { status: q.status, paymentStatus: q.paymentStatus, source: q.source, from: q.from, to: q.to, search: q.search } });
    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `don-hang-${detail ? 'chi-tiet-' : ''}${stamp}.csv`, content: '﻿' + [header.map(escCsv).join(','), ...lines].join('\n') };
  }

  // ---------------- email ----------------

  /**
   * Gửi email theo mẫu (MailService.sendTemplate). Biến: `order` (MailService.orderVars), `invoiceHtml` (bảng hoá đơn
   * server-render, mẫu dùng {{{invoiceHtml}}} nếu muốn), `refund` ({ amount, reason, method, reference }) khi hoàn tiền,
   * `message` (lời nhắn admin) cho order.invoice.
   */
  private async sendOrderMail(key: (typeof RESENDABLE_EMAILS)[number], order: OrderWithItems, extra: Record<string, unknown> = {}) {
    const to = order.customerEmail;
    if (!to) return { status: 'SKIPPED' as const, logId: null, reason: 'Đơn không có email khách' };
    const locale = order.locale ?? (await this.languages.defaultLocale());
    const [orderVars, invoiceHtml] = await Promise.all([this.mail.orderVars(order, locale, { shippingMethodLabel: order.shippingMethod ?? undefined }), this.invoiceHtml(order, { locale, embedded: true })]);
    return this.mail.sendTemplate({ key, locale, to, vars: { order: orderVars, invoiceHtml, ...extra }, meta: { orderId: order.id, orderCode: order.code, type: 'order' } });
  }

  async resendEmail(id: string, key: (typeof RESENDABLE_EMAILS)[number] | undefined, actor: AuthUser, message?: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (!order.customerEmail) throw new BadRequestException('Đơn hàng không có email khách — hãy cập nhật email trước');
    const k = key ?? 'order.placed';
    if (!RESENDABLE_EMAILS.includes(k)) throw new BadRequestException('Mẫu email không hợp lệ');
    const result = await this.sendOrderMail(k, order, message ? { message } : {});
    if (result.status === 'FAILED') throw new BadRequestException(`Gửi email thất bại: ${result.error}`);
    const skipped = result.status === 'SKIPPED';
    const history = this.historyOf(order);
    history.push({ status: order.status, note: `${skipped ? 'Không gửi được' : 'Đã gửi lại'} email "${MAIL_SUBJECT[k] ?? k}" tới ${order.customerEmail}${skipped ? ` (${result.reason})` : ''}`, at: new Date().toISOString(), by: actor.name ?? actor.id });
    await this.prisma.order.update({ where: { id }, data: { history } });
    this.activity(actor, 'order.resendEmail', id, { key: k, to: order.customerEmail, status: result.status, logId: result.logId });
    return { success: !skipped, skipped, reason: skipped ? result.reason : undefined, key: k, to: order.customerEmail, logId: result.logId };
  }

  // ---------------- hoàn tiền ----------------

  async refunds(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, select: { id: true, total: true, refundedTotal: true, paymentMethod: true, userId: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const data = await this.prisma.refund.findMany({ where: { orderId: id }, orderBy: { createdAt: 'desc' } });
    return { data, total: Number(order.total), refundedTotal: Number(order.refundedTotal), remaining: round(Number(order.total) - Math.max(Number(order.refundedTotal), data.filter((r) => r.status !== 'FAILED').reduce((n, r) => n + Number(r.amount), 0))), canRefundViaGateway: this.payments.isOnline(order.paymentMethod) && this.payments.supportsRefund(order.paymentMethod), canRefundViaWallet: !!order.userId };
  }

  /**
   * Số tiền còn được hoàn = tổng đơn − max(refundedTotal, tổng Refund chưa FAILED).
   * Refund PENDING (đang chờ cổng hoàn) chưa cộng vào refundedTotal nhưng vẫn "giữ chỗ" số tiền -> hai lần hoàn qua cổng
   * song song không thể cùng vượt tổng đơn.
   */
  private async refundRemaining(tx: Prisma.TransactionClient, order: Pick<Order, 'id' | 'total' | 'refundedTotal'>) {
    const agg = await tx.refund.aggregate({ where: { orderId: order.id, status: { not: 'FAILED' } }, _sum: { amount: true } });
    const used = Math.max(Number(order.refundedTotal), Number(agg._sum.amount ?? 0));
    return round(Number(order.total) - used);
  }

  /** Kiểm tra trong khoá đơn: trạng thái thanh toán, số tiền còn hoàn được, số lượng còn hoàn kho được */
  private async assertRefundable(tx: Prisma.TransactionClient, fresh: OrderWithItems, amount: number, items: { orderItemId: string; quantity: number }[], restock: boolean) {
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(fresh.paymentStatus)) throw new BadRequestException('Đơn chưa được thanh toán nên không có gì để hoàn. Hãy đánh dấu "Đã thanh toán" trước nếu khách đã trả tiền.');
    const remaining = await this.refundRemaining(tx, fresh);
    if (amount > remaining + 0.001) throw new BadRequestException(`Số tiền hoàn tối đa còn lại là ${fmtMoney(Math.max(0, remaining), fresh.currency)}`);
    // số lượng hoàn kho: không vượt phần chưa hoàn kho của từng dòng (quantity - restockedQty)
    if (!restock) return;
    for (const it of items) {
      const line = fresh.items.find((x) => x.id === it.orderItemId);
      if (!line) throw new BadRequestException('Dòng hàng hoàn kho không thuộc đơn này');
      const left = line.quantity - line.restockedQty;
      if (it.quantity > left) throw new BadRequestException(left > 0 ? `"${line.name}": chỉ còn ${left} sản phẩm chưa hoàn kho` : `"${line.name}": đã hoàn kho đủ số lượng trước đó`);
    }
  }

  /**
   * Ghi phần "đã hoàn" vào đơn (trong transaction đã khoá đơn): hoàn kho đúng một lần theo restockedQty, cộng ví (method wallet),
   * tăng refundedTotal, đổi trạng thái thanh toán / đơn, ghi lịch sử.
   */
  private async applyRefund(
    tx: Prisma.TransactionClient,
    fresh: OrderWithItems,
    p: { amount: number; dto: CreateRefundDto; items: { orderItemId: string; quantity: number }[]; restock: boolean; providerRef: string | null; actor: AuthUser },
  ) {
    const { amount, dto, actor } = p;
    const restocked: string[] = [];
    if (p.restock) {
      for (const it of p.items) {
        const line = fresh.items.find((x) => x.id === it.orderItemId);
        if (!line) continue;
        const n = await restockOrderItem(tx, line, it.quantity);
        if (n > 0) restocked.push(`${line.name} × ${n}`);
      }
    }
    const refundedNow = round(Number(fresh.refundedTotal) + amount);
    const full = refundedNow >= Number(fresh.total) - 0.001;
    const statusChanged = full && fresh.status !== 'REFUNDED';
    let walletTxn: Awaited<ReturnType<WalletService['apply']>> | null = null;
    // cộng tiền vào ví trong cùng transaction với bản ghi hoàn tiền
    if (dto.method === 'wallet') {
      walletTxn = await this.wallet.apply(tx, { userId: fresh.userId!, type: 'REFUND', amount, orderId: fresh.id, note: `Hoàn tiền đơn hàng ${fresh.code}${dto.reason?.trim() ? `: ${dto.reason.trim()}` : ''}`, createdById: actor.id === 'system' ? null : actor.id });
    }
    const methodText = dto.method === 'gateway' ? `qua cổng ${fresh.paymentMethod.toUpperCase()}${p.providerRef ? `, mã ${p.providerRef}` : ''}` : dto.method === 'wallet' ? 'vào ví thành viên' : 'thủ công';
    const parts = [`Hoàn tiền ${fmtMoney(amount, fresh.currency)} (${methodText})`];
    if (dto.reason?.trim()) parts.push(`lý do: ${dto.reason.trim()}`);
    if (restocked.length) parts.push(`hoàn kho: ${restocked.join(', ')}`);
    const history = this.historyOf(fresh);
    history.push({ status: statusChanged ? 'REFUNDED' : fresh.status, note: parts.join(' · '), at: new Date().toISOString(), by: actor.name ?? actor.id });
    const updated = await tx.order.update({
      where: { id: fresh.id },
      data: { refundedTotal: refundedNow, paymentStatus: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', ...(statusChanged ? { status: 'REFUNDED' } : {}), history },
      include: { items: true },
    });
    return { updated, statusChanged, walletTxn };
  }

  /**
   * Hoàn tiền (thủ công / qua cổng / vào ví), tuỳ chọn hoàn kho các dòng.
   * - Thủ công / vào ví: MỘT transaction khoá dòng đơn (FOR UPDATE), kiểm tra số tiền + số lượng hoàn kho bên trong khoá.
   * - Qua cổng: 3 bước, KHÔNG giữ transaction trong lúc gọi cổng:
   *   (1) transaction có khoá: kiểm tra (tính cả Refund PENDING đang giữ chỗ) + tạo Refund PENDING;
   *   (2) gọi cổng ngoài transaction;
   *   (3) thành công -> transaction cập nhật Refund (COMPLETED/PENDING theo cổng) + hoàn kho + tiền đơn + lịch sử;
   *       thất bại -> Refund FAILED kèm lý do. Bước 3 lỗi DB sau khi cổng đã hoàn -> log + thông báo admin để đối soát.
   */
  async refund(id: string, dto: CreateRefundDto, actor: AuthUser) {
    const before = await this.prisma.order.findUnique({ where: { id }, select: { id: true, status: true, paymentMethod: true, userId: true } });
    if (!before) throw new NotFoundException('Không tìm thấy đơn hàng');
    const amount = round(Number(dto.amount));
    if (amount <= 0) throw new BadRequestException('Số tiền hoàn phải lớn hơn 0');
    const items = (dto.items ?? []).filter((i) => i.quantity > 0);
    const restock = !!dto.restock && items.length > 0;
    if (dto.method === 'gateway' && !this.payments.isOnline(before.paymentMethod)) throw new BadRequestException('Đơn không thanh toán qua cổng online — hãy chọn hoàn thủ công');
    // hoàn vào ví: đơn phải thuộc một thành viên (khách vãng lai không có ví)
    if (dto.method === 'wallet' && !before.userId) throw new BadRequestException('Đơn của khách vãng lai không có ví để hoàn — hãy chọn hoàn thủ công');
    const lock = (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;

    let result: { updated: OrderWithItems; statusChanged: boolean; walletTxn: Awaited<ReturnType<WalletService['apply']>> | null; refund: Refund; fromStatus: string };
    let providerRef: string | null = null;
    if (dto.method !== 'gateway') {
      result = await this.prisma.$transaction(async (tx) => {
        await lock(tx);
        const fresh = await tx.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
        await this.assertRefundable(tx, fresh, amount, items, restock);
        const refund = await tx.refund.create({
          data: { orderId: id, transactionId: null, amount, reason: dto.reason?.trim() || null, method: dto.method, status: 'COMPLETED', providerRef: null, restock, createdById: actor.id === 'system' ? null : actor.id },
        });
        const applied = await this.applyRefund(tx, fresh, { amount, dto, items, restock, providerRef: null, actor });
        return { ...applied, refund, fromStatus: fresh.status };
      });
    } else {
      // (1) giữ chỗ: Refund PENDING trong khoá đơn
      const reserved = await this.prisma.$transaction(async (tx) => {
        await lock(tx);
        const fresh = await tx.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
        await this.assertRefundable(tx, fresh, amount, items, restock);
        const paid = await tx.paymentTransaction.findFirst({ where: { orderId: id, status: 'PAID' }, orderBy: { paidAt: 'desc' } });
        if (!paid) throw new BadRequestException('Không tìm thấy giao dịch đã thanh toán của đơn này');
        // tổng đã hoàn / đang hoàn qua chính giao dịch này (trừ lần thất bại) + lần này không vượt số tiền giao dịch
        const agg = await tx.refund.aggregate({ where: { transactionId: paid.id, status: { not: 'FAILED' } }, _sum: { amount: true } });
        const txLeft = round(Number(paid.amount) - Number(agg._sum.amount ?? 0));
        if (amount > txLeft + 0.001) throw new BadRequestException(`Số tiền hoàn qua cổng không được vượt phần còn lại của giao dịch (${fmtMoney(Math.max(0, txLeft), fresh.currency)})`);
        const refund = await tx.refund.create({
          data: { orderId: id, transactionId: paid.id, amount, reason: dto.reason?.trim() || null, method: 'gateway', status: 'PENDING', providerRef: null, restock, createdById: actor.id === 'system' ? null : actor.id },
        });
        return { refund, order: fresh, paid };
      });
      // (2) gọi cổng ngoài transaction
      let res: Awaited<ReturnType<PaymentsService['refund']>>;
      try {
        res = await this.payments.refund(reserved.order, reserved.paid, amount, dto.reason);
      } catch (err) {
        const msg = (err as Error).message;
        await this.prisma.refund
          .update({ where: { id: reserved.refund.id }, data: { status: 'FAILED', reason: `${dto.reason?.trim() ? `${dto.reason.trim()} — ` : ''}Lỗi cổng: ${msg}`.slice(0, 1000) } })
          .catch((e: Error) => this.logger.error(`Không cập nhật được Refund ${reserved.refund.id} sang FAILED: ${e.message}`));
        throw err;
      }
      providerRef = res.providerRef ?? null;
      // (3) ghi kết quả
      try {
        result = await this.prisma.$transaction(async (tx) => {
          await lock(tx);
          const fresh = await tx.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
          const refund = await tx.refund.update({ where: { id: reserved.refund.id }, data: { status: res.status ?? 'COMPLETED', providerRef } });
          const applied = await this.applyRefund(tx, fresh, { amount, dto, items, restock, providerRef, actor });
          return { ...applied, refund, fromStatus: fresh.status };
        });
      } catch (err) {
        const msg = `Cổng đã hoàn tiền nhưng ghi DB lỗi — đối soát Refund ${reserved.refund.id}, providerRef ${providerRef ?? '(không có)'}`;
        this.logger.error(`${msg}: ${(err as Error).message}`);
        throw new BadRequestException(`${msg}. Vui lòng kiểm tra lại đơn hàng.`);
      }
    }

    const { updated, statusChanged, walletTxn, refund, fromStatus } = result;
    if (statusChanged) {
      if (!CLOSED_STATUSES.includes(fromStatus)) await this.payments.cancelPendingForOrder(id, 'Đơn hàng đã hoàn tiền toàn bộ');
      this.events.emit('order.statusChanged', { order: updated, from: fromStatus, to: 'REFUNDED' });
      await this.hooks.doAction('order.statusChanged', updated, fromStatus);
    }
    if (restock) this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    if (walletTxn) await this.wallet.afterChange(walletTxn, actor);
    this.events.emit('order.refunded', { order: updated, refund, actor });
    await this.hooks.doAction('order.refunded', updated, refund);
    this.activity(actor, 'order.refund', id, { refundId: refund.id, amount, method: dto.method, restock, providerRef, full: statusChanged || updated.paymentStatus === 'REFUNDED' });
    if (dto.sendEmail !== false && updated.customerEmail) {
      await this.sendOrderMail('order.refunded', updated, { refund: { amount, amountText: fmtMoney(amount, updated.currency), reason: dto.reason ?? '', method: dto.method, reference: providerRef ?? '' } }).catch((err: Error) => this.logger.warn(`Gửi email order.refunded cho ${updated.code} lỗi: ${err.message}`));
    }
    return { refund, order: await this.get(id) };
  }

  // ---------------- hoá đơn ----------------

  async invoice(id: string, opts: { autoPrint?: boolean } = {}) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return this.invoiceHtml(order, { locale: order.locale ?? 'vi', autoPrint: opts.autoPrint });
  }

  /** HTML hoá đơn in được: logo / tên / địa chỉ / MST từ Cài đặt, bảng hàng, tổng. `embedded` = chỉ phần thân (nhúng vào email) */
  private async invoiceHtml(order: OrderWithItems, opts: { locale: string; autoPrint?: boolean; embedded?: boolean }) {
    const [general, contact, commerce] = await Promise.all([
      this.settings.get<{ siteName?: unknown; logo?: string | null; siteUrl?: string }>('general'),
      this.settings.get<{ companyName?: string; email?: string; phone?: string; hotline?: string; address?: unknown; taxCode?: string }>('contact'),
      this.commerce(),
    ]);
    const logo = general.logo ? (await this.media.findMany([general.logo])).get(general.logo) : null;
    const logoUrl = logo?.urls?.medium ?? logo?.url ?? null;
    const L = opts.locale;
    const storeName = contact.companyName || i18n(general.siteName, L) || 'Cửa hàng';
    const storeAddress = i18n(contact.address, L);
    const money = (v: unknown) => fmtMoney(v, order.currency);
    const a = order.shippingAddress as Record<string, unknown> | null;
    const b = order.billingAddress as Record<string, unknown> | null;
    const methods = commerce.paymentMethods ?? [];
    const payLabel = i18n(methods.find((m) => m.key === order.paymentMethod)?.label, L) || order.paymentMethod.toUpperCase();
    const cell = (s: string, right = false) => `<td style="border:1px solid #ddd;padding:6px 8px;${right ? 'text-align:right;' : ''}">${s}</td>`;
    const rows = order.items
      .map((it, i) => {
        const opt = Object.values((it.optionValues as Record<string, string>) ?? {}).filter(Boolean).join(' / ');
        return `<tr>${cell(String(i + 1))}${cell(`${esc(it.name)}${opt ? `<div style="color:#666;font-size:11px">${esc(opt)}</div>` : ''}`)}${cell(esc(it.sku ?? ''))}${cell(money(it.price), true)}${cell(String(it.quantity), true)}${cell(money(it.total), true)}</tr>`;
      })
      .join('');
    const sum = (label: string, value: string, bold = false) =>
      `<tr><td style="padding:${bold ? '6px 0' : '3px 0'};${bold ? 'border-top:2px solid #111;font-weight:700;font-size:14px' : ''}">${label}</td><td style="text-align:right;padding:${bold ? '6px 0' : '3px 0'};${bold ? 'border-top:2px solid #111;font-weight:700;font-size:14px' : ''}">${value}</td></tr>`;
    const body = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12px;line-height:1.5;max-width:800px;margin:0 auto">
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px"><tr>
    <td style="vertical-align:top">
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="" style="max-height:56px;max-width:200px;margin-bottom:6px;display:block">` : ''}
      <div style="font-size:18px;font-weight:700">${esc(storeName)}</div>
      ${storeAddress ? `<div>${esc(storeAddress)}</div>` : ''}
      ${contact.hotline || contact.phone ? `<div>ĐT: ${esc(contact.hotline || contact.phone)}</div>` : ''}
      ${contact.email ? `<div>Email: ${esc(contact.email)}</div>` : ''}
      ${contact.taxCode ? `<div>MST: ${esc(contact.taxCode)}</div>` : ''}
    </td>
    <td style="vertical-align:top;text-align:right">
      <div style="font-size:20px;font-weight:700;letter-spacing:1px">HOÁ ĐƠN BÁN HÀNG</div>
      <div>Mã đơn: <b>#${esc(order.code)}</b></div>
      <div>Ngày đặt: ${fmtDate(order.createdAt)}</div>
      <div>Trạng thái: ${esc(STATUS_LABEL[order.status] ?? order.status)}</div>
    </td>
  </tr></table>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px"><tr>
    <td style="vertical-align:top;width:50%;padding-right:12px">
      <div style="font-weight:700;text-transform:uppercase;font-size:11px;color:#555;margin-bottom:4px">Khách hàng</div>
      <div style="font-weight:600">${esc(order.customerName)}</div>
      <div>${esc(order.customerPhone)}</div>
      ${order.customerEmail ? `<div>${esc(order.customerEmail)}</div>` : ''}
      ${b && formatAddress(b) ? `<div style="margin-top:4px;color:#555">Địa chỉ thanh toán: ${esc(formatAddress(b))}</div>` : ''}
    </td>
    <td style="vertical-align:top;width:50%">
      <div style="font-weight:700;text-transform:uppercase;font-size:11px;color:#555;margin-bottom:4px">Giao đến</div>
      <div style="font-weight:600">${esc(a?.fullName || order.customerName)}${a?.phone ? ` · ${esc(a.phone)}` : ''}</div>
      <div>${esc(formatAddress(a))}</div>
      ${order.shippingMethod ? `<div style="color:#555">Vận chuyển: ${esc(order.shippingMethod)}</div>` : ''}
    </td>
  </tr></table>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f3f4f6">
      ${['#', 'Sản phẩm', 'SKU', 'Đơn giá', 'SL', 'Thành tiền'].map((h, i) => `<th style="border:1px solid #ddd;padding:6px 8px;text-align:${i >= 3 ? 'right' : 'left'};font-size:11px">${h}</th>`).join('')}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table style="width:45%;margin-left:auto;margin-top:12px;border-collapse:collapse">
    ${sum('Tạm tính', money(order.subtotal))}
    ${Number(order.discountTotal) > 0 ? sum(`Giảm giá${order.couponCode ? ` (${esc(order.couponCode)})` : ''}`, `-${money(order.discountTotal)}`) : ''}
    ${sum('Phí vận chuyển', Number(order.shippingTotal) > 0 ? money(order.shippingTotal) : 'Miễn phí')}
    ${Number(order.taxTotal) > 0 ? sum(`Thuế${commerce.pricesIncludeTax ? ' (đã gồm)' : ''}`, money(order.taxTotal)) : ''}
    ${sum('Tổng cộng', money(order.total), true)}
    ${Number(order.refundedTotal) > 0 ? sum('Đã hoàn tiền', `-${money(order.refundedTotal)}`) : ''}
  </table>
  <div style="margin-top:16px">Phương thức thanh toán: <b>${esc(payLabel)}</b> · ${esc(PAYMENT_LABEL[order.paymentStatus] ?? order.paymentStatus)}${order.paidAt ? ` (${fmtDate(order.paidAt)})` : ''}</div>
  ${order.note ? `<div style="margin-top:6px">Ghi chú: ${esc(order.note)}</div>` : ''}
  <div style="margin-top:32px;text-align:center;color:#555">Cảm ơn quý khách đã mua hàng!</div>
</div>`;
    if (opts.embedded) return body;
    return `<!doctype html>
<html lang="${esc(L)}"><head><meta charset="utf-8"><title>Hoá đơn #${esc(order.code)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<style>@page{size:A4;margin:14mm}body{margin:0;padding:24px;background:#fff}@media print{body{padding:0}.no-print{display:none!important}}</style>
</head><body>
<div class="no-print" style="max-width:800px;margin:0 auto 16px;text-align:right;font-family:Arial,sans-serif"><button onclick="window.print()" style="padding:8px 14px;border:1px solid #ccc;border-radius:6px;background:#f8f8f8;cursor:pointer">In hoá đơn</button></div>
${body}
${opts.autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},150)})</script>' : ''}
</body></html>`;
  }
}
