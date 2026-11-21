import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEmail, IsEnum, IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'BANNED', 'PENDING'] as const;

export class CreateUserDto {
  @IsEmail({}, { message: 'Email không hợp lệ' }) email: string;
  @IsString() @MinLength(8, { message: 'Mật khẩu tối thiểu 8 ký tự' }) password: string;
  @IsString() @MaxLength(120) name: string;
  @IsUUID() roleId: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() bio?: string;
  @IsOptional() @IsUUID() avatarId?: string | null;
  @IsOptional() @IsEnum(USER_STATUSES) status?: (typeof USER_STATUSES)[number];
  @IsOptional() @IsString() locale?: string;
  /** Chiết khấu giảm giá (%) áp dụng cho toàn bộ sản phẩm / công cụ AI của thành viên này */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) customDiscount?: number;
  /** Giá trị trường tuỳ chỉnh { [fieldKey]: value } (kiểm tra theo nhóm trường của loại nội dung này) */
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
}

export class UpdateUserDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MinLength(8) password?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() bio?: string;
  @IsOptional() @IsUUID() avatarId?: string | null;
  @IsOptional() @IsEnum(USER_STATUSES) status?: (typeof USER_STATUSES)[number];
  @IsOptional() @IsString() locale?: string;
  /** Chiết khấu giảm giá (%) áp dụng cho toàn bộ sản phẩm / công cụ AI của thành viên này */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) customDiscount?: number;
  /** Giá trị trường tuỳ chỉnh { [fieldKey]: value } (kiểm tra theo nhóm trường của loại nội dung này) */
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
}

export class UserQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() roleId?: string;
  /** 'staff' = có quyền admin, 'customer' = khách hàng */
  @IsOptional() @IsString() type?: 'staff' | 'customer';
}

/** Thao tác hàng loạt trên danh sách thành viên đã tích chọn */
export const USER_BULK_ACTIONS = ['status', 'role', 'revoke-sessions', 'unlock', 'delete'] as const;

export class BulkUserDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids: string[];
  @IsIn(USER_BULK_ACTIONS) action: (typeof USER_BULK_ACTIONS)[number];
  /** bắt buộc khi action = 'status' */
  @IsOptional() @IsEnum(USER_STATUSES) status?: (typeof USER_STATUSES)[number];
  /** bắt buộc khi action = 'role' */
  @IsOptional() @IsUUID() roleId?: string;
}

/** Khoá tạm thời tài khoản tới một thời điểm (admin thao tác) */
export class LockUserDto {
  /** Thời điểm tự mở khoá (ISO) — phải ở tương lai */
  @IsDateString({}, { message: 'Thời điểm mở khoá không hợp lệ' }) until: string;
  /** Lý do khoá — hiện cho thành viên khi họ cố đăng nhập */
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

/**
 * Nhóm dữ liệu tuỳ chọn có thể xoá kèm thành viên (các nhóm còn lại luôn bị xoá theo tài khoản).
 * Không chọn nhóm nào thì dữ liệu đó được giữ lại, chỉ bỏ liên kết tới thành viên.
 */
export const USER_PURGE_OPTIONS = ['orders', 'content', 'media', 'reviews', 'comments', 'activity', 'loginHistory'] as const;
export type UserPurgeOption = (typeof USER_PURGE_OPTIONS)[number];

export class DeleteUserDto {
  @IsOptional() @IsArray() @IsIn(USER_PURGE_OPTIONS, { each: true }) include?: UserPurgeOption[];
  /** Nhập lại email thành viên để xác nhận xoá vĩnh viễn */
  @IsString() confirmEmail: string;
}
