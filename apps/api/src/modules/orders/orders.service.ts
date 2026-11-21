import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomInt } from 'node:crypto';
import { normalizeInvoiceRequest } from '../einvoice/einvoice.request.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { ShippingService, type ShippingOption } from '../shipping/shipping.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { TaxService } from '../tax/tax.service.js';
import { provinceName } from '../shipping/regions.js';
import { OnEvent } from '@nestjs/event-emitter';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Coupon, Prisma } from '../../generated/prisma/client.js';
import { effectivePrice, publishedProductWhere } from '../products/products.presenter.js';
import { DigitalCodesService } from '../digital-codes/digital-codes.service.js';
import { restockOrderItem } from './order-stock.js';
import { isVirtualProduct, localizePurchaseFields, normalizePurchaseFields, readDigitalSettings, readPurchaseInput, validatePurchaseFields, type PublicPurchaseField, type PurchaseFieldValue } from '@cmsnt/shared';
import type { CartItemDto, CheckoutDto, CouponQueryDto, OrderQueryDto, QuoteDto, SaveCouponDto, UpdateOrderDto } from './orders.dto.js';

interface CommerceSettings {
  currency: string;
  shippingFlatRate: number;
  freeShippingThreshold: number;
  taxRate: number;
  pricesIncludeTax: boolean;
  /** flat (mặc định) | none | inclusive | rates — xem @cmsnt/shared TaxMode */
  taxMode?: string;
  orderCodePrefix: string;
  enableGuestCheckout: boolean;
  invoiceRequestEnabled?: boolean;
  invoiceRequireTaxCode?: boolean;
  paymentMethods: { key: string; enabled: boolean }[];
}

export interface QuoteLine {
  productId: string;
  variantId: string | null;
  name: string;
  sku: string | null;
  optionValues: Record<string, string>;
  image: string | null;
  slug: string;
  price: number;
  quantity: number;
  total: number;
  available: boolean;
  error?: string;
  /** id danh mục của sản phẩm (để xét điều kiện mã giảm giá) */
  categoryIds?: string[];
  /** cân nặng cả dòng (gram) — dòng hàng ảo = 0 */
  weight?: number;
  /** giá trị khách đã nhập (chỉ các ô sản phẩm khai báo, đã cắt khoảng trắng) — echo lại cho storefront */
  fields: Record<string, string>;
  /**
   * giá trị khách GỬI LÊN sau khi đọc / chuẩn hoá chuỗi (readPurchaseInput), TRƯỚC khi kiểm tra và KHÔNG lọc theo định nghĩa ô
   * — storefront dùng để khớp dòng giỏ với dòng báo giá (kể cả dòng lỗi thiếu / sai ô nhập)
   */
  inputFields: Record<string, string>;
  /** bản có nhãn của `fields` theo thứ tự ô, lưu vào OrderItem.meta.fields khi đặt hàng */
  fieldValues: PurchaseFieldValue[];
  /** sản phẩm không cần giao hàng (isVirtual / DIGITAL / bán theo kho mã) */
  virtual: boolean;
  /** bán theo kho mã: tự giao mã khi đơn đã thanh toán */
  codeDelivery: boolean;
  /** các ô khách cần nhập khi mua (đã chọn ngôn ngữ) */
  purchaseFields: PublicPurchaseField[];
}

/** Ngữ cảnh người mua khi báo giá / đặt hàng (kiểm tra giới hạn mã giảm giá theo khách) */
export interface QuoteContext {
  userId?: string;
  email?: string;
  /** true (checkout): mã có giới hạn theo khách bắt buộc phải xác định được khách (đăng nhập hoặc email) */
  strict?: boolean;
}

export interface CouponContext {
  subtotal: number;
  items?: { productId: string; categoryIds?: string[]; total: number }[];
  userId?: string;
  email?: string;
  strict?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tổng tiền các dòng hàng đủ điều kiện của mã (productIds / categoryIds là "cho phép", excludeProductIds là "loại trừ").
 * Không đặt điều kiện nào → mọi dòng đều hợp lệ.
 */
export function couponEligibleTotal(coupon: Pick<Coupon, 'productIds' | 'excludeProductIds' | 'categoryIds'>, items: { productId: string; categoryIds?: string[]; total: number }[]) {
  const allowP = new Set(coupon.productIds ?? []);
  const allowC = new Set(coupon.categoryIds ?? []);
  const deny = new Set(coupon.excludeProductIds ?? []);
  const restricted = allowP.size > 0 || allowC.size > 0;
  return items.reduce((sum, it) => {
    if (deny.has(it.productId)) return sum;
    if (restricted && !allowP.has(it.productId) && !(it.categoryIds ?? []).some((c) => allowC.has(c))) return sum;
    return sum + it.total;
  }, 0);
}

const ORDER_SORTABLE = ['createdAt', 'updatedAt', 'total', 'paidAt', 'status', 'paymentStatus'];

/** Bảng ký tự phần ngẫu nhiên của mã đơn: chữ hoa + số, bỏ ký tự dễ nhầm (0/O, 1/I/L) */
const ORDER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** Độ dài phần ngẫu nhiên: 31^8 ≈ 8,5·10^11 khả năng mỗi ngày — không dò được mã đơn bằng cách thử lần lượt */
export const ORDER_CODE_RANDOM_LENGTH = 8;

/**
 * Sinh mã đơn `<tiền tố><yymmdd><8 ký tự ngẫu nhiên>` (crypto.randomInt), thử lại khi trùng.
 * Trước đây phần ngẫu nhiên chỉ 5 chữ số (~90.000 khả năng/ngày) nên dễ đoán mã đơn của người khác.
 */
export async function generateOrderCode(prefix: string, exists: (code: string) => Promise<boolean>, now = new Date()) {
  const datePart = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  for (;;) {
    let rand = '';
    for (let i = 0; i < ORDER_CODE_RANDOM_LENGTH; i++) rand += ORDER_CODE_ALPHABET[randomInt(ORDER_CODE_ALPHABET.length)];
    const code = `${prefix}${datePart}${rand}`;
    if (!(await exists(code))) return code;
  }
}

/** Chuỗi thay cho giá trị ô kiểu password khi trả về cho khách / API công khai */
export const MASKED_FIELD_VALUE = '••••••';

/** Dữ liệu cũ thiếu `type`: nhận diện ô mật khẩu theo khoá / nhãn để che cho chắc */
const PASSWORD_HINT = /(pass|pwd|mat_?khau|matkhau|mật\s*khẩu)/i;

/**
 * Che giá trị các ô kiểu `password` khách nhập lúc mua (OrderItem.meta.fields, xem validatePurchaseFields)
 * trước khi trả ra phản hồi cho khách / tra cứu công khai. Admin xem đơn qua API admin vẫn thấy giá trị gốc.
 */
export function maskItemMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const m = meta as { fields?: unknown };
  if (!Array.isArray(m.fields)) return meta;
  const fields = (m.fields as PurchaseFieldValue[]).map((f) => {
    if (!f || typeof f !== 'object') return f;
    const secret = f.type === 'password' || (!f.type && (PASSWORD_HINT.test(String(f.key ?? '')) || PASSWORD_HINT.test(String(f.label ?? ''))));
    return secret ? { ...f, value: MASKED_FIELD_VALUE } : f;
  });
  return { ...m, fields };
}

/**
 * Chuẩn hoá đơn trả cho khách (tra cứu / tài khoản / checkout):
 * - che ô password trong meta của từng dòng hàng;
 * - hoá đơn điện tử: bỏ `pdfPath` (đường dẫn file thật trong storage) -> chỉ trả cờ `hasPdf`.
 */
function toCustomerOrder<T extends { items?: { meta: unknown }[]; eInvoices?: { pdfPath?: string | null }[] }>(order: T) {
  const { items, eInvoices, ...rest } = order;
  return {
    ...rest,
    ...(items ? { items: items.map((i) => ({ ...i, meta: maskItemMeta(i.meta) })) } : {}),
    ...(eInvoices ? { eInvoices: eInvoices.map(({ pdfPath, ...e }) => ({ ...e, hasPdf: !!pdfPath })) } : {}),
  } as Omit<T, 'items' | 'eInvoices'> & { items: T['items']; eInvoices: (Omit<NonNullable<T['eInvoices']>[number], 'pdfPath'> & { hasPdf: boolean })[] | undefined };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly payments: PaymentsService,
    private readonly shipping: ShippingService,
    private readonly wallet: WalletService,
    private readonly tax: TaxService,
    private readonly digitalCodes: DigitalCodesService,
  ) {}

  // ---------------- giỏ hàng / báo giá ----------------

  /**
   * Tính lại giá giỏ hàng phía server (không tin giá từ client).
   * Trả thêm `shippingMethods` (đã tính phí theo địa chỉ) và method đang chọn (`shippingMethodId`, mặc định method đầu tiên).
   * Giỏ chỉ toàn hàng ảo (isVirtual / DIGITAL / kho mã) -> `requiresShipping=false`: không cần địa chỉ, không phí vận chuyển.
   * Sản phẩm có `purchaseFields` (ID game, email cần nâng cấp...) -> kiểm tra `item.fields`, thiếu/sai -> dòng `available:false`.
   */
  async quote(dto: QuoteDto, ctx: QuoteContext = {}) {
    const locale = await this.languages.resolve(dto.locale);
    const fallback = await this.languages.defaultLocale();
    const commerce = await this.settings.get<CommerceSettings>('commerce');
    const ids = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, ...publishedProductWhere() },
      include: { translations: { select: { locale: true, name: true, slug: true } }, variants: true, categories: { select: { categoryId: true } } },
    });
    const media = await this.media.findMany([...products.map((p) => p.featuredImageId), ...products.flatMap((p) => p.variants.map((v) => v.imageId))]);

    // phần chung của dòng không bán được (sản phẩm đã gỡ / chưa chọn phân loại)
    const noFields = { fields: {}, fieldValues: [], virtual: false, codeDelivery: false, purchaseFields: [] };
    const lines: QuoteLine[] = dto.items.map((item: CartItemDto) => {
      // giá trị khách gửi lên (đã chuẩn hoá chuỗi, chưa lọc theo định nghĩa ô) — echo lại để storefront khớp dòng giỏ
      const inputFields = readPurchaseInput(item.fields) ?? {};
      const p = products.find((x) => x.id === item.productId);
      if (!p) return { productId: item.productId, variantId: item.variantId ?? null, name: '', sku: null, optionValues: {}, image: null, slug: '', price: 0, quantity: item.quantity, total: 0, available: false, error: 'Sản phẩm không còn bán', ...noFields, fields: inputFields, inputFields };
      const tr = p.translations.find((t) => t.locale === locale) ?? p.translations.find((t) => t.locale === fallback) ?? p.translations[0];
      const variant = item.variantId ? p.variants.find((v) => v.id === item.variantId && v.isActive) : null;
      const virtual = isVirtualProduct(p);
      const fieldDefs = normalizePurchaseFields(p.purchaseFields);
      const digital = { virtual, codeDelivery: p.codeDelivery, purchaseFields: localizePurchaseFields(fieldDefs, locale) };
      if (p.type === 'VARIABLE' && !variant) {
        return { productId: p.id, variantId: item.variantId ?? null, name: tr?.name ?? '', sku: p.sku, optionValues: {}, image: null, slug: tr?.slug ?? '', price: 0, quantity: item.quantity, total: 0, available: false, error: 'Vui lòng chọn phân loại sản phẩm', ...noFields, ...digital, fields: inputFields, inputFields };
      }
      // thông tin khách nhập khi mua: kiểm tra theo định nghĩa ô của sản phẩm (bỏ khoá lạ)
      const checked = validatePurchaseFields(fieldDefs, item.fields, locale);
      const fieldValues = checked.values ?? [];
      const price = variant ? effectivePrice({ price: variant.price, salePrice: variant.salePrice }).finalPrice : effectivePrice(p).finalPrice;
      const stockStatus = variant?.stockStatus ?? p.stockStatus;
      const stockQty = variant ? variant.stockQuantity : p.stockQuantity;
      let error: string | undefined;
      if (stockStatus === 'OUT_OF_STOCK') error = 'Hết hàng';
      else if (p.manageStock && stockStatus !== 'BACKORDER' && stockQty < item.quantity) error = `Chỉ còn ${stockQty} sản phẩm`;
      else if (checked.error) error = checked.error;
      const imageId = variant?.imageId ?? p.featuredImageId;
      const img = media.get(imageId ?? '');
      // cân nặng lưu theo kg -> gram; hàng ảo không tính cân nặng vận chuyển
      const unitWeight = virtual ? 0 : Number(variant?.weight ?? p.weight ?? 0) * 1000;
      return {
        productId: p.id,
        variantId: variant?.id ?? null,
        name: tr?.name ?? '',
        sku: variant?.sku ?? p.sku,
        optionValues: (variant?.optionValues as Record<string, string>) ?? {},
        image: img?.urls.thumb ?? img?.url ?? null,
        slug: tr?.slug ?? '',
        price,
        quantity: item.quantity,
        total: price * item.quantity,
        available: !error,
        error,
        categoryIds: p.categories.map((c) => c.categoryId),
        weight: Math.round(unitWeight * item.quantity),
        fields: Object.fromEntries(fieldValues.map((f) => [f.key, f.value])),
        inputFields,
        fieldValues,
        ...digital,
      };
    });

    const valid = lines.filter((l) => l.available);
    const subtotal = valid.reduce((s, l) => s + l.total, 0);
    const weight = valid.reduce((s, l) => s + (l.weight ?? 0), 0);
    // cần giao hàng khi còn ít nhất 1 dòng hàng thật (xét dòng hợp lệ; giỏ toàn dòng lỗi thì xét mọi dòng)
    const requiresShipping = (valid.length ? valid : lines).some((l) => !l.virtual);
    // phần hàng cần giao: phí / ngưỡng miễn phí / rules theo giá của vùng và giá trị khai báo với hãng
    // chỉ xét dòng hàng thật — hàng ảo (mã, tài khoản, file) không làm tăng tiền hàng vận chuyển
    const shippableLines = valid.filter((l) => !l.virtual);
    const shippableSubtotal = shippableLines.reduce((s, l) => s + l.total, 0);
    const shippableWeight = shippableLines.reduce((s, l) => s + (l.weight ?? 0), 0);

    // ---- vận chuyển: các phương thức khả dụng theo địa chỉ; chọn method khách gửi lên, mặc định method đầu tiên (thứ tự admin xếp) ----
    // giỏ toàn hàng ảo: bỏ qua hoàn toàn (không gọi API hãng, không phí, không báo "chưa hỗ trợ khu vực")
    const address = dto.shippingAddress;
    const shippingMethods: ShippingOption[] = requiresShipping && subtotal > 0
      ? await this.shipping.resolveMethods({
          province: address?.province,
          country: address?.country,
          subtotal: shippableSubtotal,
          weight: shippableWeight,
          locale,
          address: address ? { province: address.province, country: address.country, city: address.city, district: address.district, ward: address.ward, districtCode: address.districtCode, wardCode: address.wardCode } : null,
          items: shippableLines.map((l) => ({ name: l.name, quantity: l.quantity, weight: l.weight, price: l.price, sku: l.sku })),
          paymentMethod: (dto as Partial<CheckoutDto>).paymentMethod ?? null,
        })
      : [];
    const selected = (dto.shippingMethodId && shippingMethods.find((m) => m.id === dto.shippingMethodId)) || shippingMethods[0] || null;
    let shippingTotal = selected ? selected.cost : 0;
    // đã cấu hình vùng nhưng không vùng nào phục vụ địa chỉ này (hoặc chưa chọn tỉnh/thành mà vùng chỉ theo tỉnh)
    const shippingUnavailable = requiresShipping && subtotal > 0 && shippingMethods.length === 0;

    let discountTotal = 0;
    let coupon: Coupon | null = null;
    let couponError: string | undefined;
    if (dto.couponCode) {
      try {
        const res = await this.validateCoupon(dto.couponCode, { subtotal, items: valid, userId: ctx.userId, email: dto.customerEmail ?? ctx.email, strict: ctx.strict });
        // đơn không cần giao hàng (toàn hàng ảo): mã miễn phí vận chuyển vô nghĩa -> báo lỗi, không áp dụng mã
        if (res.coupon.type === 'FREE_SHIPPING' && !requiresShipping) throw new BadRequestException('Mã miễn phí vận chuyển không áp dụng cho đơn không cần giao hàng');
        coupon = res.coupon;
        const base = res.eligibleSubtotal;
        if (coupon.type === 'PERCENT') discountTotal = (base * Number(coupon.value)) / 100;
        else if (coupon.type === 'FIXED') discountTotal = Math.min(Number(coupon.value), base);
        else if (coupon.type === 'FREE_SHIPPING') shippingTotal = 0;
        if (coupon.maxDiscount != null) discountTotal = Math.min(discountTotal, Number(coupon.maxDiscount));
        discountTotal = Math.min(discountTotal, subtotal);
      } catch (e) {
        couponError = (e as Error).message;
      }
    }
    // Chiết khấu giảm giá (%) riêng của thành viên áp dụng trên toàn bộ sản phẩm của web
    if (ctx.userId && subtotal > discountTotal) {
      const u = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { customDiscount: true } });
      const pct = Math.max(0, Math.min(100, Number(u?.customDiscount ?? 0)));
      if (pct > 0) {
        const memberCut = ((subtotal - discountTotal) * pct) / 100;
        discountTotal = Math.min(subtotal, discountTotal + memberCut);
      }
    }
    // ---- thuế (TaxService): taxMode chưa cấu hình = 'flat' -> đúng công thức cũ (taxRate + pricesIncludeTax);
    //      'rates' -> theo lớp thuế sản phẩm + tỉnh/quốc gia giao hàng. Chỉ ảnh hưởng báo giá / đơn MỚI.
    const taxable = subtotal - discountTotal;
    const tax = await this.tax.compute(
      valid.map((l) => ({ productId: l.productId, taxClass: products.find((p) => p.id === l.productId)?.taxClass ?? null, total: l.total })),
      { country: address?.country, province: address?.province },
      { discountTotal, shippingTotal },
      commerce,
    );
    const taxTotal = tax.taxTotal;
    const total = taxable + shippingTotal + (tax.inclusive ? 0 : taxTotal);
    const result = {
      currency: commerce.currency,
      items: lines,
      subtotal,
      discountTotal: Math.round(discountTotal),
      shippingTotal,
      taxTotal: Math.round(taxTotal),
      /** chi tiết thuế theo mức (để storefront hiển thị), true = giá đã gồm thuế */
      taxBreakdown: tax.breakdown.map((b) => ({ ...b, amount: Math.round(b.amount) })),
      taxInclusive: tax.inclusive,
      total: Math.round(total),
      coupon: coupon ? { code: coupon.code, type: coupon.type, value: Number(coupon.value) } : null,
      couponError,
      hasErrors: lines.some((l) => !l.available),
      /** tổng cân nặng (gram) */
      weight,
      shippingMethods,
      shippingMethodId: selected?.id ?? null,
      shippingMethodName: selected?.name ?? null,
      /** hãng/dịch vụ khi phí lấy từ API hãng (lưu vào Order.shippingMeta) */
      shippingMeta: selected?.carrier ? { carrier: selected.carrier, carrierName: selected.carrierName, service: selected.service, serviceName: selected.serviceName, quotedFee: selected.cost, estimatedDays: selected.estimatedDays ?? null, expectedDeliveryAt: selected.expectedDeliveryAt ?? null } : null,
      shippingUnavailable,
      /** false = giỏ toàn hàng ảo: storefront ẩn form địa chỉ / phương thức vận chuyển */
      requiresShipping,
      /** true = khách chưa đăng nhập và giỏ có hàng ảo hợp lệ -> storefront bắt buộc ô email (để nhận mã / tài khoản) */
      emailRequired: !ctx.userId && valid.some((l) => l.virtual),
    };
    return this.hooks.applyFilters('cart.quote', result, { dto });
  }

  /**
   * Kiểm tra mã giảm giá. Trả `eligibleSubtotal` = tổng các dòng hàng đủ điều kiện (sản phẩm/danh mục) để tính giảm.
   * `ctx` có thể là số (tạm tính) để tương thích cũ.
   */
  async validateCoupon(code: string, ctx: number | CouponContext): Promise<{ coupon: Coupon; eligibleSubtotal: number }> {
    const c: CouponContext = typeof ctx === 'number' ? { subtotal: ctx } : ctx;
    const coupon = await this.prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    const now = new Date();
    if (!coupon || !coupon.isActive) throw new BadRequestException('Mã giảm giá không tồn tại');
    if (coupon.startsAt && coupon.startsAt > now) throw new BadRequestException('Mã giảm giá chưa có hiệu lực');
    if (coupon.endsAt && coupon.endsAt < now) throw new BadRequestException('Mã giảm giá đã hết hạn');
    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) throw new BadRequestException('Mã giảm giá đã hết lượt sử dụng');
    if (coupon.minOrderTotal != null && c.subtotal < Number(coupon.minOrderTotal)) {
      throw new BadRequestException(`Đơn hàng tối thiểu ${Number(coupon.minOrderTotal).toLocaleString('vi-VN')} để dùng mã này`);
    }

    // điều kiện sản phẩm / danh mục
    const restricted = coupon.productIds.length > 0 || coupon.categoryIds.length > 0 || coupon.excludeProductIds.length > 0;
    const eligibleSubtotal = c.items && restricted ? couponEligibleTotal(coupon, c.items) : c.subtotal;
    if (restricted && c.items && eligibleSubtotal <= 0) throw new BadRequestException('Mã giảm giá không áp dụng cho sản phẩm trong giỏ hàng');

    // giới hạn theo khách / đơn đầu tiên
    const email = c.email?.trim().toLowerCase() || undefined;
    const needIdentity = coupon.perUserLimit != null || coupon.firstOrderOnly;
    if (needIdentity && !c.userId && !email) {
      if (c.strict) throw new BadRequestException('Vui lòng đăng nhập hoặc nhập email để dùng mã giảm giá này');
      return { coupon, eligibleSubtotal }; // chưa biết khách là ai (giỏ hàng) -> kiểm tra lại lúc đặt hàng
    }
    const who: Prisma.CouponUsageWhereInput[] = [];
    if (c.userId) who.push({ userId: c.userId });
    if (email) who.push({ email });
    if (coupon.perUserLimit != null) {
      const used = await this.prisma.couponUsage.count({ where: { couponId: coupon.id, OR: who } });
      if (used >= coupon.perUserLimit) throw new BadRequestException(coupon.perUserLimit === 1 ? 'Bạn đã sử dụng mã giảm giá này' : `Mỗi khách chỉ được dùng mã này ${coupon.perUserLimit} lần`);
    }
    if (coupon.firstOrderOnly) {
      const ownOrders: Prisma.OrderWhereInput[] = [];
      if (c.userId) ownOrders.push({ userId: c.userId });
      if (email) ownOrders.push({ customerEmail: { equals: email, mode: 'insensitive' } });
      const count = await this.prisma.order.count({ where: { OR: ownOrders, status: { not: 'CANCELLED' } } });
      if (count > 0) throw new BadRequestException('Mã giảm giá chỉ áp dụng cho đơn hàng đầu tiên');
    }
    return { coupon, eligibleSubtotal };
  }

  private async generateCode(prefix: string) {
    return generateOrderCode(prefix, async (code) => !!(await this.prisma.order.findUnique({ where: { code }, select: { id: true } })));
  }

  async checkout(dto: CheckoutDto, user: AuthUser | undefined, ip?: string) {
    const commerce = await this.settings.get<CommerceSettings & { enableCart?: boolean; autoConfirmPaidOrders?: boolean }>('commerce');
    if (commerce.enableCart === false) throw new BadRequestException('Website hiện không nhận đặt hàng trực tuyến');
    if (!user && !commerce.enableGuestCheckout) throw new BadRequestException('Vui lòng đăng nhập để đặt hàng');
    // yêu cầu xuất hoá đơn điện tử (chỉ nhận khi bật trong cài đặt bán hàng)
    const invoiceRequest = commerce.invoiceRequestEnabled ? normalizeInvoiceRequest(dto.invoiceRequest, commerce.invoiceRequireTaxCode !== false) : null;
    const paymentMethod = dto.paymentMethod ?? 'cod';
    if (!(await this.payments.isValidMethod(paymentMethod))) throw new BadRequestException('Phương thức thanh toán không hợp lệ');
    // thanh toán bằng ví: bắt buộc đăng nhập (ví gắn với tài khoản)
    const payByWallet = this.payments.isWallet(paymentMethod);
    if (payByWallet && !user) throw new BadRequestException('Vui lòng đăng nhập để thanh toán bằng số dư ví');

    const quote = await this.quote(dto, { userId: user?.id, email: dto.customerEmail, strict: true });
    if (quote.hasErrors) throw new BadRequestException({ message: 'Giỏ hàng có sản phẩm không hợp lệ', items: quote.items.filter((i) => !i.available) });
    if (!quote.items.length) throw new BadRequestException('Giỏ hàng trống');
    if (dto.couponCode && quote.couponError) throw new BadRequestException(quote.couponError);
    if (quote.shippingUnavailable) throw new BadRequestException('Chưa hỗ trợ giao hàng tới khu vực này, vui lòng chọn địa chỉ khác');
    // giỏ toàn hàng ảo không có phương thức vận chuyển -> bỏ qua shippingMethodId client gửi kèm
    if (quote.requiresShipping && dto.shippingMethodId && quote.shippingMethodId !== dto.shippingMethodId) throw new BadRequestException('Phương thức vận chuyển không còn khả dụng, vui lòng chọn lại');
    const locale = await this.languages.resolve(dto.locale);
    const email = dto.customerEmail?.trim().toLowerCase() || undefined;
    // hàng cần giao -> bắt buộc địa chỉ (họ tên, SĐT, địa chỉ); giỏ toàn hàng ảo thì không
    if (quote.requiresShipping && !dto.shippingAddress?.line1?.trim()) throw new BadRequestException('Vui lòng nhập địa chỉ giao hàng');
    // hàng ảo (mã / tài khoản / file) gửi qua email hoặc trang tài khoản -> khách vãng lai phải có email
    if (!user && quote.items.some((l) => l.virtual)) {
      // sản phẩm giao mã: cửa hàng tắt cả "xem mã khi chưa đăng nhập" lẫn "gửi mã trong email" -> khách vãng lai
      // không có cách nào nhận được mã sau khi trả tiền -> bắt đăng nhập trước khi mua
      if (quote.items.some((l) => l.codeDelivery)) {
        const digital = readDigitalSettings(await this.settings.get('digital'));
        if (!digital.guestAccess && !digital.emailCodes) throw new BadRequestException('Vui lòng đăng nhập để mua sản phẩm giao mã');
      }
      if (!email) throw new BadRequestException('Vui lòng nhập email để nhận mã / tài khoản');
    }
    // Sản phẩm giao mã tự động giữ mã (RESERVED) ngay khi đặt; đơn COD không bao giờ tự huỷ khi chưa trả tiền
    // (sweep chỉ huỷ đơn cổng online) -> mã bị giữ vô thời hạn. Mã giao qua mạng, không có "nhận hàng" để thu tiền,
    // nên không cho chọn COD với giỏ có sản phẩm giao mã.
    if (paymentMethod === 'cod' && quote.items.some((l) => l.codeDelivery)) {
      throw new BadRequestException('Sản phẩm giao mã tự động không hỗ trợ thanh toán khi nhận hàng (COD), vui lòng chọn phương thức thanh toán khác');
    }
    const addr = dto.shippingAddress;
    const shippingAddress = quote.requiresShipping && addr
      ? {
          ...addr,
          country: (addr.country || 'VN').toUpperCase(),
          province: addr.province?.toUpperCase() || undefined,
          // city = tên tỉnh/thành hiển thị (giữ tương thích với dữ liệu cũ)
          city: addr.city?.trim() || provinceName(addr.province?.toUpperCase(), locale) || undefined,
        }
      : // đơn toàn hàng ảo: chỉ lưu thông tin liên hệ tối thiểu (mẫu email / hoá đơn vẫn đọc được fullName, phone)
        { fullName: addr?.fullName?.trim() || dto.customerName, phone: addr?.phone?.trim() || dto.customerPhone, country: (addr?.country || 'VN').toUpperCase() };

    const code = await this.generateCode(commerce.orderCodePrefix || 'DH');
    // ví: đơn đã trả tiền ngay -> tự xác nhận như thanh toán online (theo cài đặt autoConfirmPaidOrders)
    const walletConfirm = payByWallet && commerce.autoConfirmPaidOrders !== false;
    let walletTxn: Awaited<ReturnType<WalletService['apply']>> | null = null;
    const order = await this.prisma.$transaction(async (tx) => {
      let couponId: string | null = null;
      // trừ kho có điều kiện để tránh bán vượt tồn (race condition)
      for (const line of quote.items) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: line.productId } });
        if (product.manageStock) {
          if (line.variantId) {
            const res = await tx.productVariant.updateMany({
              where: { id: line.variantId, OR: [{ stockQuantity: { gte: line.quantity } }, { stockStatus: 'BACKORDER' }] },
              data: { stockQuantity: { decrement: line.quantity } },
            });
            if (!res.count) throw new BadRequestException(`"${line.name}" không đủ hàng`);
            await tx.productVariant.updateMany({ where: { id: line.variantId, stockQuantity: { lte: 0 }, stockStatus: 'IN_STOCK' }, data: { stockStatus: 'OUT_OF_STOCK' } });
          } else {
            const res = await tx.product.updateMany({
              where: { id: line.productId, OR: [{ stockQuantity: { gte: line.quantity } }, { stockStatus: 'BACKORDER' }] },
              data: { stockQuantity: { decrement: line.quantity } },
            });
            if (!res.count) throw new BadRequestException(`"${line.name}" không đủ hàng`);
            await tx.product.updateMany({ where: { id: line.productId, stockQuantity: { lte: 0 }, stockStatus: 'IN_STOCK' }, data: { stockStatus: 'OUT_OF_STOCK' } });
          }
        }
        await tx.product.update({ where: { id: line.productId }, data: { soldCount: { increment: line.quantity } } });
      }
      if (quote.coupon) {
        const now = new Date();
        const c = await tx.coupon.findUniqueOrThrow({ where: { code: quote.coupon.code } });
        couponId = c.id;
        // tăng lượt dùng có điều kiện: nhiều đơn song song không thể vượt usageLimit
        const used = await tx.coupon.updateMany({
          where: {
            id: c.id,
            isActive: true,
            ...(c.usageLimit != null ? { usedCount: { lt: c.usageLimit } } : {}),
            AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
          },
          data: { usedCount: { increment: 1 } },
        });
        if (!used.count) throw new BadRequestException('Mã giảm giá đã hết lượt sử dụng hoặc hết hạn');
        // giới hạn mỗi khách: đếm lại trong transaction để 2 đơn song song không cùng lọt
        if (c.perUserLimit != null && (user?.id || email)) {
          const who: Prisma.CouponUsageWhereInput[] = [];
          if (user?.id) who.push({ userId: user.id });
          if (email) who.push({ email });
          const n = await tx.couponUsage.count({ where: { couponId: c.id, OR: who } });
          if (n >= c.perUserLimit) throw new BadRequestException('Bạn đã dùng hết lượt của mã giảm giá này');
        }
      }

      const created = await tx.order.create({
        data: {
          code,
          userId: user?.id,
          paymentMethod,
          currency: quote.currency,
          subtotal: quote.subtotal,
          discountTotal: quote.discountTotal,
          shippingTotal: quote.shippingTotal,
          taxTotal: quote.taxTotal,
          total: quote.total,
          couponCode: quote.coupon?.code,
          shippingMethodId: (() => {
            const base = quote.shippingMethodId?.split('|')[0] ?? null;
            return base && UUID_RE.test(base) ? base : null;
          })(),
          shippingMethod: quote.shippingMethodName,
          shippingMeta: quote.shippingMeta ? (quote.shippingMeta as object) : undefined,
          customerName: dto.customerName,
          customerEmail: dto.customerEmail,
          customerPhone: dto.customerPhone,
          shippingAddress: shippingAddress as object,
          note: dto.note,
          locale: dto.locale,
          ip,
          requiresShipping: quote.requiresShipping,
          // có sản phẩm bán theo kho mã -> chờ giao mã (DigitalCodesService cập nhật khi thanh toán / giao bù)
          codeStatus: quote.items.some((l) => l.codeDelivery) ? 'pending' : null,
          invoiceRequest: invoiceRequest ? (invoiceRequest as object) : undefined,
          ...(payByWallet ? { paymentStatus: 'PAID' as const, paidAt: new Date(), ...(walletConfirm ? { status: 'CONFIRMED' as const } : {}) } : {}),
          history: [
            { status: 'PENDING', note: 'Đơn hàng được tạo', at: new Date().toISOString() },
            ...(payByWallet ? [{ status: 'PENDING', note: `Đã thanh toán ${Number(quote.total).toLocaleString('vi-VN')}đ bằng số dư ví`, at: new Date().toISOString(), by: 'system' }] : []),
            ...(walletConfirm ? [{ status: 'CONFIRMED', note: 'Tự động xác nhận sau khi thanh toán', at: new Date().toISOString(), by: 'system' }] : []),
          ],
          items: {
            create: quote.items.map((l) => ({
              productId: l.productId,
              variantId: l.variantId,
              name: l.name,
              sku: l.sku,
              optionValues: l.optionValues,
              image: l.image,
              price: l.price,
              quantity: l.quantity,
              total: l.total,
              // thông tin khách nhập khi mua (ID game, email cần nâng cấp...)
              meta: l.fieldValues.length ? ({ fields: l.fieldValues } as unknown as Prisma.InputJsonObject) : undefined,
            })),
          },
        },
        include: { items: true },
      });
      // giữ mã trong kho cho các dòng bán theo kho mã (thiếu mã -> ném lỗi, rollback cả đơn; BACKORDER thì cho đặt trước)
      await this.digitalCodes.reserveForOrder(tx, created);
      // ghi lượt dùng theo khách (perUserLimit / thống kê)
      if (couponId) await tx.couponUsage.create({ data: { couponId, orderId: created.id, userId: user?.id, email } });
      // trừ ví cuối cùng trong transaction: không đủ số dư -> ném lỗi, toàn bộ đơn/kho/coupon được rollback
      if (payByWallet) {
        walletTxn = await this.wallet.apply(tx, { userId: user!.id, type: 'PAYMENT', amount: -Number(quote.total), orderId: created.id, note: `Thanh toán đơn hàng ${code}` });
      }
      return created;
    });
    this.events.emit('order.created', { order });
    await this.hooks.doAction('order.created', order);
    this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    if (payByWallet && walletTxn) {
      // cùng chuỗi sự kiện như thanh toán qua cổng để email/tải xuống/thông báo chạy bình thường
      await this.wallet.afterChange(walletTxn, user);
      this.events.emit('order.paid', { order, transactionId: null });
      await this.hooks.doAction('order.paid', order, null);
      return { ...toCustomerOrder(order), payment: null };
    }
    if (!this.payments.isOnline(paymentMethod)) return { ...toCustomerOrder(order), payment: null };
    // thanh toán online: tạo giao dịch ngay; lỗi cổng không làm mất đơn (khách thanh toán lại sau)
    try {
      return { ...toCustomerOrder(order), payment: await this.payments.start(order) };
    } catch (err) {
      return { ...toCustomerOrder(order), payment: null, paymentError: (err as Error).message };
    }
  }

  async lookup(code: string, phone: string) {
    const order = await this.prisma.order.findFirst({ where: { code, customerPhone: phone }, include: { items: true, eInvoices: { where: { status: { in: ['ISSUING', 'ISSUED', 'CANCELLED', 'REPLACED', 'ADJUSTED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, kind: true, invoiceNo: true, serial: true, templateCode: true, taxAuthorityCode: true, lookupCode: true, lookupUrl: true, issuedAt: true, total: true, pdfPath: true } }, shipments: { where: { status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, carrier: true, serviceName: true, trackingCode: true, trackingUrl: true, status: true, statusMessage: true, expectedDeliveryAt: true, deliveredAt: true, events: true, createdAt: true } } } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const { ip: _ip, adminNote: _n, ...rest } = order;
    return toCustomerOrder(rest);
  }

  async myOrders(userId: string, q: { page?: number; limit?: number }) {
    const { skip, take, page, limit } = pageArgs(q);
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({ where: { userId }, skip, take, orderBy: { createdAt: 'desc' }, include: { items: true, eInvoices: { where: { status: { in: ['ISSUING', 'ISSUED', 'CANCELLED', 'REPLACED', 'ADJUSTED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, kind: true, invoiceNo: true, serial: true, templateCode: true, taxAuthorityCode: true, lookupCode: true, lookupUrl: true, issuedAt: true, total: true, pdfPath: true } }, shipments: { where: { status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, carrier: true, serviceName: true, trackingCode: true, trackingUrl: true, status: true, statusMessage: true, expectedDeliveryAt: true, deliveredAt: true, events: true, createdAt: true } } }, omit: { adminNote: true, ip: true } }),
      this.prisma.order.count({ where: { userId } }),
    ]);
    return paginate(data.map((o) => toCustomerOrder(o)), total, page, limit);
  }

  async myOrder(userId: string, code: string) {
    const order = await this.prisma.order.findFirst({ where: { userId, code }, include: { items: true, eInvoices: { where: { status: { in: ['ISSUING', 'ISSUED', 'CANCELLED', 'REPLACED', 'ADJUSTED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, kind: true, invoiceNo: true, serial: true, templateCode: true, taxAuthorityCode: true, lookupCode: true, lookupUrl: true, issuedAt: true, total: true, pdfPath: true } }, shipments: { where: { status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: { id: true, carrier: true, serviceName: true, trackingCode: true, trackingUrl: true, status: true, statusMessage: true, expectedDeliveryAt: true, deliveredAt: true, events: true, createdAt: true } } }, omit: { adminNote: true, ip: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return toCustomerOrder(order);
  }

  async cancelMyOrder(userId: string, code: string) {
    const order = await this.myOrder(userId, code);
    if (order.status !== 'PENDING') throw new BadRequestException('Chỉ có thể huỷ đơn hàng đang chờ xác nhận');
    if (order.paymentStatus !== 'UNPAID') throw new BadRequestException('Đơn hàng đã thanh toán, vui lòng liên hệ cửa hàng để huỷ và hoàn tiền');
    await this.update(order.id, { status: 'CANCELLED', statusNote: 'Khách hàng huỷ đơn' }, { id: userId, name: 'Khách hàng' } as AuthUser, { status: 'PENDING', paymentStatus: 'UNPAID' });
    return this.myOrder(userId, code);
  }

  // ---------------- admin ----------------

  async list(q: OrderQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.OrderWhereInput = {};
    if (q.status) where.status = q.status as Prisma.OrderWhereInput['status'];
    if (q.paymentStatus) where.paymentStatus = q.paymentStatus as Prisma.OrderWhereInput['paymentStatus'];
    if (q.userId) where.userId = q.userId;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    if (q.search) {
      where.OR = [
        { code: { contains: q.search, mode: 'insensitive' } },
        { customerName: { contains: q.search, mode: 'insensitive' } },
        { customerPhone: { contains: q.search } },
        { customerEmail: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [data, total, counts] = await Promise.all([
      this.prisma.order.findMany({ where, skip, take, orderBy: { [ORDER_SORTABLE.includes(q.sort ?? '') ? q.sort! : 'createdAt']: q.order ?? 'desc' }, include: { _count: { select: { items: true } } } }),
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({ by: ['status'], _count: true }),
    ]);
    return { ...paginate(data, total, page, limit), statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  get(id: string) {
    return this.prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true, user: { select: { id: true, name: true, email: true } } } });
  }

  /**
   * @param guard điều kiện bổ sung khi "giành" chuyển trạng thái (vd tự huỷ chỉ khi đơn vẫn PENDING + UNPAID),
   *              tránh chạy chen với webhook thanh toán.
   */
  async update(id: string, dto: UpdateOrderDto, actor: AuthUser, guard?: Prisma.OrderWhereInput) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
    const changing = !!dto.status && dto.status !== order.status;
    const closed = ['CANCELLED', 'REFUNDED'];
    if (changing && closed.includes(order.status) && !closed.includes(dto.status!)) {
      throw new BadRequestException('Đơn đã huỷ / hoàn tiền không thể mở lại (kho và mã giảm giá đã được hoàn). Hãy tạo đơn mới.');
    }
    const history = [...((order.history as object[]) ?? [])];
    if (changing) history.push({ status: dto.status, note: dto.statusNote ?? '', at: new Date().toISOString(), by: actor.name ?? actor.id });

    const updated = await this.prisma.$transaction(async (tx) => {
      if (changing) {
        // "giành" chuyển trạng thái có điều kiện -> 2 request song song không thể cùng hoàn kho
        if (closed.includes(dto.status!)) await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
        const claimed = await tx.order.updateMany({ where: { id, status: order.status, ...(guard ?? {}) }, data: { status: dto.status } });
        if (!claimed.count) throw new ConflictException('Trạng thái đơn vừa được thay đổi, vui lòng tải lại');
        if (closed.includes(dto.status!) && !closed.includes(order.status)) {
          await this.restock(tx, order.items);
          if (order.couponCode) {
            await tx.coupon.updateMany({ where: { code: order.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
            // bỏ lượt dùng của đơn này để không tính vào giới hạn mỗi khách
            await tx.couponUsage.deleteMany({ where: { orderId: order.id } });
          }
        }
      }
      return tx.order.update({
        where: { id },
        data: {
          paymentStatus: dto.paymentStatus,
          // admin đánh dấu đã thanh toán (COD/chuyển khoản thủ công) -> ghi thời điểm như webhook
          ...(dto.paymentStatus === 'PAID' && order.paymentStatus !== 'PAID' && !order.paidAt ? { paidAt: new Date() } : {}),
          adminNote: dto.adminNote,
          shippingMethod: dto.shippingMethod,
          shippingAddress: dto.shippingAddress as object | undefined,
          history,
        },
        include: { items: true },
      });
    });
    if (changing && closed.includes(dto.status!)) await this.payments.cancelPendingForOrder(id, `Đơn hàng chuyển sang ${dto.status}`);
    // admin đổi trạng thái thanh toán sang "Đã thanh toán" (COD...) -> cùng sự kiện với webhook để cấp file tải về, email...
    if (dto.paymentStatus === 'PAID' && order.paymentStatus !== 'PAID') {
      this.events.emit('order.paid', { order: updated, transactionId: null });
      await this.hooks.doAction('order.paid', updated, null);
    }
    if (changing) {
      this.events.emit('order.statusChanged', { order: updated, from: order.status, to: dto.status });
      await this.hooks.doAction('order.statusChanged', updated, order.status);
    }
    this.events.emit('activity', { userId: actor.id, action: 'order.update', entityType: 'order', entityId: id, meta: { status: dto.status, paymentStatus: dto.paymentStatus } });
    if (changing) this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    return updated;
  }

  /**
   * Hoàn kho khi huỷ / hoàn tiền đơn: mỗi dòng chỉ hoàn phần chưa hoàn (quantity - restockedQty) — xem restockOrderItem.
   * Đơn đã được admin hoàn kho một phần qua "Hoàn tiền" trước đó sẽ không bị cộng kho lần hai.
   */
  private async restock(tx: Prisma.TransactionClient, items: { id: string; productId: string | null; variantId: string | null }[]) {
    for (const it of items) await restockOrderItem(tx, it);
  }

  /** Tự huỷ đơn thanh toán online quá hạn chưa trả tiền (Cài đặt > Bán hàng) */
  @OnEvent('order.autoCancel', { async: true })
  async autoCancel({ orderId }: { orderId: string }) {
    await this.update(orderId, { status: 'CANCELLED', statusNote: 'Tự động huỷ do quá hạn thanh toán online' }, { id: 'system', name: 'Hệ thống' } as AuthUser, {
      status: 'PENDING',
      paymentStatus: 'UNPAID',
    }).catch(() => undefined);
  }

  // ---------------- coupons ----------------

  /** Điều kiện lọc theo trạng thái hiệu lực của mã */
  private couponStatusWhere(status: string | undefined, now = new Date()): Prisma.CouponWhereInput {
    switch (status) {
      case 'active':
        return { isActive: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] };
      case 'scheduled':
        return { isActive: true, startsAt: { gt: now } };
      case 'expired':
        return { endsAt: { lt: now } };
      case 'inactive':
        return { isActive: false };
      default:
        return {};
    }
  }

  async coupons(q: CouponQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const search: Prisma.CouponWhereInput = q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { description: { contains: q.search, mode: 'insensitive' } }] } : {};
    const now = new Date();
    const where: Prisma.CouponWhereInput = { ...search, ...this.couponStatusWhere(q.status, now) };
    const statuses = ['active', 'scheduled', 'expired', 'inactive'] as const;
    const [data, total, ...counts] = await Promise.all([
      this.prisma.coupon.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { _count: { select: { usages: true } } } }),
      this.prisma.coupon.count({ where }),
      ...statuses.map((st) => this.prisma.coupon.count({ where: { ...search, ...this.couponStatusWhere(st, now) } })),
    ]);
    return { ...paginate(data, total, page, limit), statusCounts: Object.fromEntries(statuses.map((st, i) => [st, counts[i]])) };
  }

  saveCoupon(id: string | undefined, dto: SaveCouponDto) {
    if (dto.type === 'PERCENT' && dto.value > 100) throw new BadRequestException('Phần trăm giảm tối đa 100');
    const exclude = new Set(dto.excludeProductIds ?? []);
    const data = {
      ...dto,
      code: dto.code.trim().toUpperCase(),
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      // sản phẩm vừa "áp dụng" vừa "loại trừ" -> loại trừ thắng
      productIds: (dto.productIds ?? []).filter((id) => !exclude.has(id)),
      excludeProductIds: [...exclude],
      categoryIds: dto.categoryIds ?? [],
      perUserLimit: dto.perUserLimit ?? null,
      firstOrderOnly: dto.firstOrderOnly ?? false,
    };
    return id ? this.prisma.coupon.update({ where: { id }, data }) : this.prisma.coupon.create({ data });
  }

  async removeCoupon(id: string) {
    await this.prisma.coupon.delete({ where: { id } });
    return { success: true };
  }
}
