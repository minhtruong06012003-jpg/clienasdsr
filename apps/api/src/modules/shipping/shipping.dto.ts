import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';

export const SHIPPING_METHOD_TYPES = ['FLAT', 'FREE', 'WEIGHT', 'PRICE', 'PICKUP', 'CARRIER'] as const;
export type ShippingMethodTypeValue = (typeof SHIPPING_METHOD_TYPES)[number];

export class SaveZoneDto {
  @IsString() @MaxLength(120) name: string;
  /** "VN-HN" | "VN" | "*" */
  @IsArray() @IsString({ each: true }) @MaxLength(10, { each: true }) regions: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateZoneDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(10, { each: true }) regions?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ShippingRuleDto {
  /** null = phần còn lại */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) upTo: number | null;
  @Type(() => Number) @IsNumber() @Min(0) cost: number;
}

export class SaveMethodDto {
  @IsIn(SHIPPING_METHOD_TYPES) type: ShippingMethodTypeValue;
  @IsObject() name: Record<string, string>;
  @IsOptional() @IsObject() description?: Record<string, string> | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) cost?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minOrderTotal?: number | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ShippingRuleDto) rules?: ShippingRuleDto[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** CARRIER: key hãng; null = mọi hãng đã bật */
  @IsOptional() @IsString() @MaxLength(40) carrier?: string | null;
  /** CARRIER: mã dịch vụ của hãng; null = mọi dịch vụ */
  @IsOptional() @IsString() @MaxLength(60) carrierService?: string | null;
  /** CARRIER: điều chỉnh phí { type: fixed|percent, value } */
  @IsOptional() @IsObject() feeAdjust?: { type: 'fixed' | 'percent'; value: number } | null;
  /** CARRIER: phí dự phòng khi API hãng lỗi */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) fallbackCost?: number | null;
}

export class ReorderIdsDto {
  @IsArray() @ArrayMinSize(1) @IsUUID('all', { each: true }) ids: string[];
}
