import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Thêm / sửa một thông báo bảng tin (content là HTML từ trình soạn thảo, hoặc chữ thuần ở thông báo cũ) */
export class UpsertAnnouncementDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsString() @MinLength(1) @MaxLength(20000) content: string;
  /** Ghim lên đầu bảng tin */
  @IsOptional() @IsBoolean() pinned?: boolean;
  /** false = ẩn khỏi trang khách */
  @IsOptional() @IsBoolean() active?: boolean;
}
