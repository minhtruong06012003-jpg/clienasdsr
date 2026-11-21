import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { DIGITAL_CODE_STATUSES } from '@cmsnt/shared';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

/** Số mã tối đa mỗi lần nhập */
export const MAX_IMPORT_CODES = 10_000;
/** Độ dài tối đa một mã nhập từ kho */
export const MAX_CODE_LENGTH = 2000;
/** Độ dài tối đa nội dung giao tay / thay thế (có thể kèm hướng dẫn dài hơn) */
export const MAX_MANUAL_LENGTH = 5000;

/** Bộ lọc danh sách kho (GET admin/digital-codes, export.csv) */
export class DigitalCodeQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() variantId?: string;
  @IsOptional() @IsIn(DIGITAL_CODE_STATUSES as unknown as string[]) declare status?: string;
  @IsOptional() @IsString() @MaxLength(100) batch?: string;
  @IsOptional() @IsIn(['OPEN', 'RESOLVED', 'REJECTED']) reportStatus?: string;
  @IsOptional() @IsUUID() orderId?: string;
}

/** Lọc theo sản phẩm (summary, batches) */
export class DigitalProductFilterDto {
  @IsOptional() @IsUUID() productId?: string;
}

/** Danh sách lô nhập: lọc theo sản phẩm, tìm theo tên lô, giới hạn số lô trả về (mới nhất trước) */
export class DigitalBatchQueryDto extends DigitalProductFilterDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(500) limit?: number;
}

/** Tìm sản phẩm để gắn kho */
export class DigitalProductSearchDto {
  @IsOptional() @IsString() @MaxLength(200) search?: string;
}

/** Nhập mã hàng loạt: `text` mỗi dòng 1 mã (giữ "|" để tách phần) và/hoặc mảng `codes` */
export class ImportDigitalCodesDto {
  @IsUUID() productId: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() variantId?: string | null;
  @IsOptional() @IsString() @MaxLength(25_000_000) text?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_IMPORT_CODES) @IsString({ each: true }) codes?: string[];
  @IsOptional() @IsString() @MaxLength(100) batch?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsNumber() @Min(0) costPrice?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() expiresAt?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Sửa một mã (content chỉ khi mã còn trong kho / đang khoá) */
export class UpdateDigitalCodeDto {
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(1000) note?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(100) batch?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsNumber() @Min(0) costPrice?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() expiresAt?: string | null;
  @IsOptional() @IsIn(['AVAILABLE', 'DISABLED']) status?: 'AVAILABLE' | 'DISABLED';
  @IsOptional() @IsString() @MinLength(1) @MaxLength(MAX_CODE_LENGTH) content?: string;
}

/** Thao tác hàng loạt */
export class BulkDigitalCodesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsUUID('all', { each: true }) ids: string[];
  @IsIn(['disable', 'enable', 'delete', 'setBatch']) action: 'disable' | 'enable' | 'delete' | 'setBatch';
  @IsOptional() @IsString() @MaxLength(100) batch?: string;
}

/** Giao mã ngay cho đơn (force: kể cả khi đơn chưa thanh toán) */
export class DeliverOrderCodesDto {
  @IsOptional() @IsBoolean() force?: boolean;
}

/** Admin giao tay nội dung cho một dòng hàng (dịch vụ nâng cấp, nạp game...) */
export class ManualCodeDto {
  @IsUUID() orderItemId: string;
  @IsString() @MinLength(1) @MaxLength(MAX_MANUAL_LENGTH) content: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsBoolean() notify?: boolean;
}

/** Đổi mã (bảo hành): lấy mã mới từ kho hoặc nhập tay `content` */
export class ReplaceCodeDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(MAX_MANUAL_LENGTH) content?: string;
  @IsOptional() @IsBoolean() notify?: boolean;
}

/** Thu hồi mã của đơn (mã đã giao luôn thành REVOKED) */
export class RevokeCodeDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
  /** chỉ áp dụng cho mã đang giữ (RESERVED, chưa giao): trả về kho (AVAILABLE) thay vì REVOKED; mã đã giao bỏ qua cờ này */
  @IsOptional() @IsBoolean() restock?: boolean;
}

/** Xử lý báo lỗi của khách */
export class ResolveReportDto {
  @IsIn(['RESOLVED', 'REJECTED']) status: 'RESOLVED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(2000) reply?: string;
}

/** Khách báo lỗi mã (thành viên) */
export class ReportCodeDto {
  @IsString() @MinLength(3) @MaxLength(2000) note: string;
}

/** Khách vãng lai xem mã: mã đơn + SĐT đặt hàng */
export class GuestCodesDto {
  @IsString() @MaxLength(40) code: string;
  @IsString() @MaxLength(30) phone: string;
}

/** Khách vãng lai báo lỗi mã */
export class GuestReportCodeDto extends GuestCodesDto {
  @IsString() @MinLength(3) @MaxLength(2000) note: string;
}
