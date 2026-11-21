import { IsArray, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const COMMENT_STATUSES = ['PENDING', 'APPROVED', 'SPAM', 'TRASH'] as const;
export type CommentStatusValue = (typeof COMMENT_STATUSES)[number];

export class CreateCommentDto {
  @IsString() @MinLength(2, { message: 'Nội dung bình luận tối thiểu 2 ký tự' }) @MaxLength(3000, { message: 'Nội dung bình luận tối đa 3000 ký tự' }) content: string;
  /** Trả lời bình luận nào (phải cùng bài viết và đã duyệt) */
  @IsOptional() @IsUUID() parentId?: string;
  /** Khách chưa đăng nhập */
  @IsOptional() @IsString() @MaxLength(100) authorName?: string;
  @IsOptional() @IsEmail({}, { message: 'Email không hợp lệ' }) authorEmail?: string;
  @IsOptional() @IsString() @MaxLength(300) authorUrl?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  /** Honeypot chống bot: người thật không điền; bot điền -> lờ đi */
  @IsOptional() @IsString() _hp?: string;
  /** Token captcha (khi bật trong Cài đặt > Bảo mật) */
  @IsOptional() @IsString() _captcha?: string;
}

export class PublicCommentQueryDto extends PaginationQueryDto {}

export class AdminCommentQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(COMMENT_STATUSES) declare status?: string;
  @IsOptional() @IsUUID() postId?: string;
}

export class UpdateCommentDto {
  @IsOptional() @IsIn(COMMENT_STATUSES) status?: CommentStatusValue;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(3000) content?: string;
}

export class ReplyCommentDto {
  @IsString() @MinLength(1, { message: 'Vui lòng nhập nội dung trả lời' }) @MaxLength(3000) content: string;
}

export class BulkCommentDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
  @IsIn([...COMMENT_STATUSES, 'delete']) action: CommentStatusValue | 'delete';
}
