import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';

export const SHIPMENT_STATUSES = ['PENDING', 'PICKING', 'PICKED', 'DELIVERING', 'DELIVERED', 'RETURNING', 'RETURNED', 'CANCELLED', 'FAILED'] as const;

export class TestCarrierDto {
  @IsString() @MaxLength(40) carrier: string;
  /** Cấu hình thử (chưa lưu); bỏ trống = dùng cấu hình đã lưu */
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsIn(['sandbox', 'production']) environment?: 'sandbox' | 'production';
}

export class SyncLocationsDto {
  @IsString() @MaxLength(40) carrier: string;
}

/** Ghi đè kiện hàng / địa chỉ khi báo giá hoặc tạo vận đơn cho đơn hàng */
export class ParcelOverrideDto {
  /** gram */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) weight?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) length?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) width?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) height?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) codAmount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) insuranceValue?: number;
}

export class RateOrderDto extends ParcelOverrideDto {
  @IsUUID() orderId: string;
  /** Chỉ hãng này (bỏ trống = mọi hãng đã bật) */
  @IsOptional() @IsString() @MaxLength(40) carrier?: string;
}

export class CreateShipmentDto extends ParcelOverrideDto {
  @IsUUID() orderId: string;
  @IsString() @MaxLength(40) carrier: string;
  @IsString() @MaxLength(60) service: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** allow | deny | try */
  @IsOptional() @IsIn(['allow', 'deny', 'try']) allowInspection?: 'allow' | 'deny' | 'try';
  @IsOptional() @IsIn(['pickup', 'dropoff']) pickupMode?: 'pickup' | 'dropoff';
  @IsOptional() @IsIn(['shop', 'customer']) payer?: 'shop' | 'customer';
  @IsOptional() @IsDateString() pickupAt?: string;
  /** Mã vận đơn nhập tay (hãng manual hoặc đã tạo ngoài hệ thống) */
  @IsOptional() @IsString() @MaxLength(60) trackingCode?: string;
}

export class ShipmentQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() declare status?: string;
  @IsOptional() @IsString() carrier?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class CancelShipmentDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Chỉ đánh dấu huỷ trong hệ thống */
  @IsOptional() @IsBoolean() localOnly?: boolean;
}

/** Nhập tay mã vận đơn / trạng thái (hãng manual hoặc khi không có API) */
export class ManualShipmentDto {
  @IsOptional() @IsString() @MaxLength(60) trackingCode?: string;
  @IsOptional() @IsIn(SHIPMENT_STATUSES) status?: (typeof SHIPMENT_STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(500) message?: string;
  @IsOptional() @IsString() @MaxLength(500) trackingUrl?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) fee?: number;
}

export class BulkShipmentActionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) ids: string[];
}

export class LocationsQueryDto {
  @IsOptional() @IsString() @MaxLength(60) parent?: string;
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) level?: number;
}
