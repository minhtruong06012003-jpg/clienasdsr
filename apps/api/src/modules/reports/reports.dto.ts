import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Khoảng thời gian: `YYYY-MM-DD` (theo múi giờ website) hoặc ISO datetime */
export class ReportRangeDto {
  @IsOptional() @IsString() @Matches(DATE_RE, { message: 'from phải là YYYY-MM-DD hoặc ISO datetime' })
  from?: string;

  @IsOptional() @IsString() @Matches(DATE_RE, { message: 'to phải là YYYY-MM-DD hoặc ISO datetime' })
  to?: string;

  /** Ngôn ngữ lấy tên danh mục / phương thức vận chuyển */
  @IsOptional() @IsString()
  locale?: string;
}

export class OverviewQueryDto extends ReportRangeDto {
  /** `1` -> tính thêm kỳ trước và % thay đổi */
  @IsOptional() @IsIn(['0', '1', 'true', 'false'])
  compare?: string;
}

export class SeriesQueryDto extends ReportRangeDto {
  @IsOptional() @IsIn(['day', 'week', 'month'])
  interval?: 'day' | 'week' | 'month' = 'day';
}

export class TopQueryDto extends ReportRangeDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 10;

  @IsOptional() @IsIn(['revenue', 'quantity', 'orders'])
  sort?: 'revenue' | 'quantity' | 'orders' = 'revenue';
}

export class ExportQueryDto extends ReportRangeDto {
  @IsIn(['revenue', 'products', 'customers', 'coupons'])
  report: 'revenue' | 'products' | 'customers' | 'coupons';

  @IsOptional() @IsIn(['day', 'week', 'month'])
  interval?: 'day' | 'week' | 'month' = 'day';
}
