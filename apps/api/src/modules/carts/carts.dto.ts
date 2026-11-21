import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { IsPurchaseFieldsInput } from '../orders/orders.dto.js';

/** Một dòng giỏ gửi từ storefront (giá không gửi — máy chủ tự tính) */
export class SyncCartItemDto {
  @IsUUID() productId: string;

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() variantId?: string | null;

  @Type(() => Number) @IsInt() @Min(1) @Max(999) quantity: number;

  /** thông tin khách nhập khi mua (Product.purchaseFields) — { key: giá trị } */
  @IsOptional() @IsObject() @IsPurchaseFieldsInput() fields?: Record<string, string>;
}

/** PUT /public/cart/:token — ghi đè toàn bộ giỏ (tạo nếu chưa có) */
export class SyncCartDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SyncCartItemDto) items: SyncCartItemDto[];

  /** email khách nhập ở checkout (để nhắc giỏ bỏ dở); chuỗi rỗng = giữ email cũ */
  @IsOptional() @ValidateIf((_o, v) => v !== '' && v !== null) @IsEmail() @MaxLength(200) email?: string | null;

  @IsOptional() @IsString() @MaxLength(10) locale?: string;

  /** true = gộp với giỏ đang lưu (lúc tải trang / vừa đăng nhập) thay vì ghi đè */
  @IsOptional() @IsBoolean() merge?: boolean;
}

export const ABANDONED_STATUSES = ['active', 'abandoned', 'recovered', 'converted', 'expired'] as const;

/** Lọc danh sách giỏ (admin): `status` (kế thừa) = một trong ABANDONED_STATUSES, giá trị khác coi như tất cả */
export class AbandonedCartQueryDto extends PaginationQueryDto {}

export class AbandonedStatsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}
