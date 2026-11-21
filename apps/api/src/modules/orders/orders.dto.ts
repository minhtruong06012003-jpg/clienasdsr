import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateBy, ValidateNested, type ValidationOptions } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { InvoiceRequestDto } from '../einvoice/einvoice.dto.js';

export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPING', 'COMPLETED', 'CANCELLED', 'REFUNDED'] as const;
export const PAYMENT_STATUSES = ['UNPAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED'] as const;
export const COUPON_TYPES = ['PERCENT', 'FIXED', 'FREE_SHIPPING'] as const;

/**
 * Giá trị khách nhập khi mua (Product.purchaseFields): object phẳng { key: chuỗi/số }, tối đa 10 khoá,
 * khoá dạng a-z0-9_ (≤ 40 ký tự), mỗi giá trị ≤ 2000 ký tự. Kiểm tra theo định nghĩa ô ở quote (validatePurchaseFields).
 */
export function IsPurchaseFieldsInput(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isPurchaseFieldsInput',
      validator: {
        validate: (v: unknown) => {
          if (v == null) return true;
          if (typeof v !== 'object' || Array.isArray(v)) return false;
          const entries = Object.entries(v as Record<string, unknown>);
          if (entries.length > 10) return false;
          return entries.every(([k, x]) => /^[a-z][a-z0-9_]{0,39}$/.test(k) && (x == null || ((typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') && String(x).length <= 2000)));
        },
        defaultMessage: () => 'Thông tin nhập khi mua không hợp lệ (tối đa 10 ô, mỗi ô ≤ 2000 ký tự)',
      },
    },
    options,
  );
}

export class CartItemDto {
  @IsUUID() productId: string;
  @IsOptional() @IsUUID() variantId?: string | null;
  @Type(() => Number) @IsInt() @Min(1) @Max(999) quantity: number;
  /** thông tin khách nhập khi mua (ID game, email cần nâng cấp...) — { key: giá trị } theo Product.purchaseFields */
  @IsOptional() @IsObject() @IsPurchaseFieldsInput() fields?: Record<string, string>;
}

/** Phần địa chỉ cần để tính phí vận chuyển khi báo giá (chưa cần họ tên/SĐT) */
export class QuoteAddressDto {
  /** mã tỉnh/thành "VN-HN" (GET /public/shipping/regions) */
  @IsOptional() @IsString() @MaxLength(10) province?: string;
  /** tên tỉnh/thành hiển thị (giữ cho tương thích) */
  @IsOptional() @IsString() city?: string;
  /** mã quốc gia, mặc định VN */
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  /** mã quận/huyện & phường/xã trong danh mục ShippingLocation (để lấy phí từ hãng vận chuyển) */
  @IsOptional() @IsString() @MaxLength(40) districtCode?: string;
  @IsOptional() @IsString() @MaxLength(60) wardCode?: string;
  @IsOptional() @IsString() @MaxLength(120) district?: string;
  @IsOptional() @IsString() @MaxLength(120) ward?: string;
}

/** Số dòng hàng tối đa mỗi lần báo giá / đặt hàng (chặn payload khổng lồ làm nặng truy vấn báo giá) */
export const MAX_ORDER_LINES = 100;

export class QuoteDto {
  // không đặt ArrayMinSize: storefront có thể báo giá giỏ rỗng; checkout bắt buộc ≥ 1 dòng (CheckoutDto)
  @IsArray() @ArrayMaxSize(MAX_ORDER_LINES) @ValidateNested({ each: true }) @Type(() => CartItemDto) items: CartItemDto[];
  @IsOptional() @IsString() couponCode?: string;
  @IsOptional() @IsString() locale?: string;
  /** phương thức vận chuyển khách chọn (id ShippingMethod hoặc 'default'); bỏ trống = rẻ nhất */
  @IsOptional() @IsString() @MaxLength(40) shippingMethodId?: string;
  @IsOptional() @ValidateNested() @Type(() => QuoteAddressDto) shippingAddress?: QuoteAddressDto;
  /** email khách (để kiểm tra giới hạn mã giảm giá theo khách / đơn đầu tiên khi chưa đăng nhập) */
  @IsOptional() @IsEmail() customerEmail?: string;
}

export class AddressDto extends QuoteAddressDto {
  @IsString() @MaxLength(120) fullName: string;
  @IsString() @MaxLength(30) phone: string;
  @IsString() @MaxLength(255) line1: string;
  @IsOptional() @IsString() line2?: string;
}

export class CheckoutDto extends QuoteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_ORDER_LINES) @ValidateNested({ each: true }) @Type(() => CartItemDto) declare items: CartItemDto[];
  @IsString() @MaxLength(120) customerName: string;
  @IsString() @MaxLength(30) customerPhone: string;
  /** bắt buộc khi giỏ có hàng cần giao (quote.requiresShipping); giỏ toàn hàng ảo có thể bỏ trống */
  @IsOptional() @ValidateNested() @Type(() => AddressDto) declare shippingAddress?: AddressDto;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsString() paymentMethod?: string;
  /** Yêu cầu xuất hoá đơn điện tử (bật ở Cài đặt › Bán hàng › invoiceRequestEnabled) */
  @IsOptional() @ValidateNested() @Type(() => InvoiceRequestDto) invoiceRequest?: InvoiceRequestDto;
}

export class OrderQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(PAYMENT_STATUSES) paymentStatus?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class UpdateOrderDto {
  @IsOptional() @IsEnum(ORDER_STATUSES) status?: (typeof ORDER_STATUSES)[number];
  @IsOptional() @IsEnum(PAYMENT_STATUSES) paymentStatus?: (typeof PAYMENT_STATUSES)[number];
  @IsOptional() @IsString() adminNote?: string;
  @IsOptional() @IsString() statusNote?: string;
  @IsOptional() @IsString() shippingMethod?: string;
  @IsOptional() @IsObject() shippingAddress?: Record<string, unknown>;
}

export class CouponQueryDto extends PaginationQueryDto {
  /** all | active | scheduled | expired | inactive */
  @IsOptional() @IsIn(['all', 'active', 'scheduled', 'expired', 'inactive']) declare status?: string;
}

export class SaveCouponDto {
  @IsString() @MaxLength(50) code: string;
  @IsOptional() @IsString() description?: string;
  @IsEnum(COUPON_TYPES) type: (typeof COUPON_TYPES)[number];
  @Type(() => Number) @IsNumber() @Min(0) value: number;
  @IsOptional() @Type(() => Number) @IsNumber() minOrderTotal?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() maxDiscount?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() usageLimit?: number | null;
  @IsOptional() @IsDateString() startsAt?: string | null;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** chỉ giảm trên các sản phẩm này (trống = mọi sản phẩm) */
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) productIds?: string[];
  /** không giảm cho các sản phẩm này */
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) excludeProductIds?: string[];
  /** chỉ giảm trên sản phẩm thuộc các danh mục này */
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) categoryIds?: string[];
  /** số lần mỗi khách (theo tài khoản hoặc email) được dùng */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) perUserLimit?: number | null;
  /** chỉ áp dụng cho đơn đầu tiên của khách */
  @IsOptional() @IsBoolean() firstOrderOnly?: boolean;
}
