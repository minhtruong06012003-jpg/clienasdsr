import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** Bộ lọc entry của 1 file log (GET /admin/logs/entries) */
export class LogEntriesQuery {
  /** tên file, vd cmsnt-2026-10-04.log; bỏ trống = file mới nhất */
  @IsOptional() @IsString() @Matches(/^cmsnt-\d{4}-\d{2}-\d{2}\.log$/)
  file?: string;

  /** danh sách level cách nhau dấu phẩy, vd error,fatal */
  @IsOptional() @IsString() @MaxLength(100)
  level?: string;

  @IsOptional() @IsString() @MaxLength(50)
  source?: string;

  @IsOptional() @IsString() @MaxLength(200)
  search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}

/**
 * Lỗi do trình duyệt / máy chủ storefront gửi lên. Giới hạn rộng để không mất lỗi
 * (stack trace có thể dài); service tự cắt ngắn khi ghi.
 */
export class ClientErrorDto {
  @IsString() @MaxLength(20_000)
  message: string;

  /** tên lỗi: TypeError, ChunkLoadError... */
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(50_000)
  stack?: string;

  @IsOptional() @IsIn(['error', 'warn'])
  level?: 'error' | 'warn';

  /** trang đang mở khi lỗi */
  @IsOptional() @IsString() @MaxLength(4000)
  url?: string;

  @IsOptional() @IsString() @MaxLength(20)
  method?: string;

  /** mã digest của Next.js (khớp lỗi phía client với log máy chủ) */
  @IsOptional() @IsString() @MaxLength(200)
  digest?: string;

  @IsOptional() @IsString() @MaxLength(20_000)
  componentStack?: string;

  /** Next.js onRequestError: route gây lỗi, loại route (render/route/action/middleware) */
  @IsOptional() @IsString() @MaxLength(500)
  routePath?: string;

  @IsOptional() @IsString() @MaxLength(50)
  routeType?: string;

  /** user-agent của trình duyệt thật (khi máy chủ storefront gửi hộ) */
  @IsOptional() @IsString() @MaxLength(1000)
  userAgent?: string;
}
