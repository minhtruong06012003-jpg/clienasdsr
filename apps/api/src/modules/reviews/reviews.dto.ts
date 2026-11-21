import { Type } from 'class-transformer';
import { IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SPAM'] as const;

export class CreateReviewDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(5) rating: number;
  @IsOptional() @IsString() @MaxLength(150) title?: string;
  @IsString() @MinLength(5, { message: 'Nội dung đánh giá tối thiểu 5 ký tự' }) @MaxLength(3000) content: string;
  /** Khách chưa đăng nhập */
  @IsOptional() @IsString() @MaxLength(100) authorName?: string;
  @IsOptional() @IsEmail({}, { message: 'Email không hợp lệ' }) authorEmail?: string;
  @IsOptional() @IsString() locale?: string;
  /** Token captcha (khi bật trong Cài đặt > Bảo mật) */
  @IsOptional() @IsString() _captcha?: string;
}

export class PublicReviewQueryDto extends PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsIn(['newest', 'oldest', 'highest', 'lowest', 'helpful']) declare sort?: string;
}

export class AdminReviewQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(REVIEW_STATUSES) declare status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsUUID() productId?: string;
}

export class UpdateReviewDto {
  @IsOptional() @IsIn(REVIEW_STATUSES) status?: (typeof REVIEW_STATUSES)[number];
  /** Phản hồi của cửa hàng; chuỗi rỗng = xoá phản hồi */
  @IsOptional() @IsString() @MaxLength(3000) reply?: string;
}

export class BulkReviewDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
  @IsIn(['APPROVED', 'REJECTED', 'SPAM', 'PENDING', 'delete']) action: string;
}
