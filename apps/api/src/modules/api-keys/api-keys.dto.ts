import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Tạo API key: tên, quyền (tập con quyền của chủ; rỗng = toàn bộ quyền chủ có), hạn dùng tuỳ chọn */
export class CreateApiKeyDto {
  @IsString() @MinLength(1) @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @IsOptional() @IsArray() @ArrayMaxSize(300)
  @IsString({ each: true }) @Matches(/^(\*|[a-z0-9_-]+(\.[a-z0-9_-]+)*)$/i, { each: true, message: 'Mã quyền không hợp lệ' })
  permissions?: string[];

  /** ISO datetime; bỏ trống = không hết hạn */
  @IsOptional() @IsDateString()
  expiresAt?: string;
}

/** Khách tự tạo API key (web › Tài khoản › API): chỉ đặt tên và hạn dùng, quyền luôn theo tài khoản */
export class CreateAccountApiKeyDto {
  @IsString() @MinLength(1) @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  /** ISO datetime; bỏ trống = không hết hạn */
  @IsOptional() @IsDateString()
  expiresAt?: string;
}

/** Lọc danh sách: all=1 xem key của mọi người (cần roles.manage) */
export class ApiKeysQueryDto {
  @IsOptional() @IsIn(['0', '1', 'true', 'false'])
  all?: string;

  @IsOptional() @IsIn(['active', 'expired', 'revoked', 'all'])
  status?: 'active' | 'expired' | 'revoked' | 'all';
}
