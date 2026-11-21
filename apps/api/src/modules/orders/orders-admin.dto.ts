import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AddressDto, IsPurchaseFieldsInput, ORDER_STATUSES, OrderQueryDto, PAYMENT_STATUSES } from './orders.dto.js';

export const ORDER_SOURCES = ['web', 'admin', 'pos'] as const;
/** Trạng thái được phép khi tạo đơn thủ công (không tạo thẳng đơn đã huỷ / hoàn tiền) */
export const CREATABLE_STATUSES = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPING', 'COMPLETED'] as const;
/** Mẫu email có thể gửi lại cho khách (key của MailService.sendTemplate) */
export const RESENDABLE_EMAILS = ['order.placed', 'order.confirmed', 'order.paid', 'order.shipping', 'order.completed', 'order.cancelled', 'order.refunded', 'order.invoice'] as const;

/** Danh sách đơn: thêm lọc theo nguồn và phương thức vận chuyển */
export class AdminOrderQueryDto extends OrderQueryDto {
  @IsOptional() @IsEnum(ORDER_SOURCES) source?: (typeof ORDER_SOURCES)[number];
  @IsOptional() @IsUUID() shippingMethodId?: string;
  /** lọc trạng thái giao mã (kho mã số), nhiều giá trị cách nhau dấu phẩy: pending,partial,delivered */
  @IsOptional() @Matches(/^(pending|partial|delivered)(,(pending|partial|delivered))*$/) codeStatus?: string;
}

export class OrderExportQueryDto extends AdminOrderQueryDto {
  /** '1' = mỗi dòng hàng một dòng CSV */
  @IsOptional() @IsIn(['1', '0']) detail?: string;
}

/**
 * Dòng hàng trong đơn tạo / sửa thủ công:
 * - có productId: lấy tên/SKU/ảnh từ sản phẩm, giá mặc định theo sản phẩm (price = ghi đè);
 * - không có productId: dòng tuỳ ý, bắt buộc name + price.
 */
export class AdminOrderItemDto {
  /** id OrderItem có sẵn (khi sửa dòng hàng) */
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsUUID() productId?: string | null;
  @IsOptional() @IsUUID() variantId?: string | null;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(100) sku?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number | null;
  @Type(() => Number) @IsInt() @Min(1) @Max(9999) quantity: number;
  /** thông tin khách nhập khi mua (Product.purchaseFields) — admin nhập hộ; không kiểm tra bắt buộc */
  @IsOptional() @IsObject() @IsPurchaseFieldsInput() fields?: Record<string, string>;
}

export class CreateAdminOrderDto {
  @IsOptional() @IsUUID() userId?: string | null;
  @IsString() @MaxLength(120) customerName: string;
  @IsOptional() @IsEmail() customerEmail?: string | null;
  @IsString() @MaxLength(30) customerPhone: string;
  /** bắt buộc khi đơn có hàng cần giao; đơn toàn hàng ảo (sản phẩm số / kho mã / isVirtual) có thể bỏ trống */
  @IsOptional() @ValidateNested() @Type(() => AddressDto) shippingAddress?: AddressDto;
  @IsOptional() @IsObject() billingAddress?: Record<string, unknown> | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AdminOrderItemDto) items: AdminOrderItemDto[];
  /** Giảm giá thủ công (số tiền) */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discountTotal?: number;
  /** Phí vận chuyển thủ công; bỏ trống = tính theo cài đặt (phí cố định / miễn phí từ ngưỡng) */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) shippingTotal?: number | null;
  @IsOptional() @IsUUID() shippingMethodId?: string | null;
  /** Tên phương thức vận chuyển hiển thị (vd "Giao hàng tiết kiệm") */
  @IsOptional() @IsString() @MaxLength(120) shippingMethod?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) adminNote?: string | null;
  @IsOptional() @IsEnum(CREATABLE_STATUSES) status?: (typeof CREATABLE_STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(50) paymentMethod?: string;
  @IsOptional() @IsEnum(PAYMENT_STATUSES) paymentStatus?: (typeof PAYMENT_STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  /** Gửi email "đặt hàng thành công" cho khách (cần customerEmail) */
  @IsOptional() @IsBoolean() sendEmail?: boolean;
}

export class UpdateOrderItemsDto {
  /** Danh sách dòng hàng mong muốn: có `id` = dòng cũ (đổi SL/giá), không có = dòng mới; dòng cũ không gửi lên = xoá */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AdminOrderItemDto) items: AdminOrderItemDto[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Sửa thông tin khách / địa chỉ thanh toán / giảm giá & phí ship thủ công (PATCH /admin/orders/:id/details) */
export class UpdateOrderDetailsDto {
  @IsOptional() @IsString() @MaxLength(120) customerName?: string;
  @IsOptional() @IsEmail() customerEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(30) customerPhone?: string;
  @IsOptional() @IsObject() billingAddress?: Record<string, unknown> | null;
  @IsOptional() @IsObject() shippingAddress?: Record<string, unknown>;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discountTotal?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) shippingTotal?: number;
  @IsOptional() @IsUUID() shippingMethodId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) shippingMethod?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
}

export class BulkOrdersDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids: string[];
  /** status:<OrderStatus> | paymentStatus:<PaymentStatus> | delete */
  @IsString() @Matches(new RegExp(`^(status:(${ORDER_STATUSES.join('|')})|paymentStatus:(${PAYMENT_STATUSES.join('|')})|delete)$`), { message: 'Thao tác không hợp lệ' }) action: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ResendEmailDto {
  @IsOptional() @IsEnum(RESENDABLE_EMAILS) key?: (typeof RESENDABLE_EMAILS)[number];
  /** Lời nhắn thêm của admin (mẫu order.invoice hiển thị {{{message}}}) */
  @IsOptional() @IsString() @MaxLength(2000) message?: string;
}

export class RefundItemDto {
  @IsUUID() orderItemId: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(9999) quantity: number;
}

export class CreateRefundDto {
  @Type(() => Number) @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** manual = trả tay, gateway = qua cổng, wallet = cộng vào ví thành viên */
  @IsIn(['manual', 'gateway', 'wallet']) method: 'manual' | 'gateway' | 'wallet';
  /** Hoàn kho các dòng trong `items` */
  @IsOptional() @IsBoolean() restock?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RefundItemDto) items?: RefundItemDto[];
  /** Gửi email "đã hoàn tiền" cho khách (mặc định có) */
  @IsOptional() @IsBoolean() sendEmail?: boolean;
}
