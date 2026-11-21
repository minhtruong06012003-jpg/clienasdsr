import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

const TXN_TYPES = ['PURCHASE', 'USAGE', 'REFUND', 'BONUS', 'ADJUST'] as const;

/** Lọc lịch sử credits */
export class CreditTxnQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(TXN_TYPES) type?: (typeof TXN_TYPES)[number];
}

/** Lọc lịch sử mua gói */
export class PurchaseQueryDto extends PaginationQueryDto {}

/** Chu kỳ của gói cước cũ (month / year) — gói credits không còn chu kỳ, giữ để đọc dữ liệu cũ và nhận request cũ */
export const PLAN_CYCLES = ['month', 'year'] as const;
export type PlanCycle = (typeof PLAN_CYCLES)[number];

/** Khách mua một gói credits bằng số dư ví */
export class PurchasePlanDto {
  @IsUUID() planId: string;
  /** Không còn dùng (gói credits không có chu kỳ), chỉ nhận để client cũ không bị lỗi */
  @IsOptional() @IsIn(PLAN_CYCLES) cycle?: PlanCycle;
}

/** Trang thanh toán: trả gói qua cổng (QR / chuyển khoản) — tiền vào ví rồi tự mua gói */
export class CheckoutPlanDto extends PurchasePlanDto {
  /** Khoá cổng thanh toán (lấy từ GET /account/wallet/topup/options) */
  @IsString() @MinLength(1) @MaxLength(40) provider: string;
}

/** Khách nạp credits theo số tiền tự do bằng số dư ví (hạn mức kiểm tra ở service theo cài đặt) */
export class BuyCreditsDto {
  /** Số tiền nạp (VND) */
  @Type(() => Number) @IsInt() @Min(1000) @Max(10_000_000_000) amount: number;
}

/** Nạp credits theo số tiền tự do qua cổng (QR / chuyển khoản) — tiền vào ví rồi tự đổi ra credits */
export class CheckoutTopupDto extends BuyCreditsDto {
  /** Khoá cổng thanh toán (lấy từ GET /account/credits/checkout/options) */
  @IsString() @MinLength(1) @MaxLength(40) provider: string;
  /** Cờ cập nhật trực tiếp mã QR đang chờ khi khách chọn đổi mức tiền trên trang Nạp tiền */
  @IsOptional() @IsBoolean() replacePending?: boolean;
}

/** Admin cộng / trừ credits của một thành viên */
export class AdjustCreditsDto {
  /** add = cộng, subtract = trừ */
  @IsIn(['add', 'subtract']) type: 'add' | 'subtract';
  /** Số credits (luôn dương, dấu do `type` quyết định) */
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000_000) amount: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Khoá chống bấm trùng do client sinh mỗi lần mở form */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) idempotencyKey?: string;
}

/** Admin đặt giảm giá riêng cho một khách */
export class CustomDiscountDto {
  @Type(() => Number) @IsNumber() @Min(0) @Max(100) discount: number;
}

/** Thêm / sửa gói credits */
export class UpsertPlanDto {
  @IsString() @MinLength(1) @MaxLength(60) @Matches(/^[a-z0-9-]+$/i, { message: 'Mã gói chỉ gồm chữ không dấu, số và dấu gạch ngang' }) slug: string;
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  /** Giá bán (VND) */
  @Type(() => Number) @IsNumber() @Min(1000) price: number;
  /** Số credits cộng vĩnh viễn khi mua */
  @Type(() => Number) @IsInt() @Min(1) credits: number;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(200, { each: true }) features?: string[];
  @IsOptional() @IsString() @MaxLength(40) badge?: string;
  @IsOptional() @IsBoolean() highlight?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}
