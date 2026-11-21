import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { ReportRangeDto } from '../reports/reports.dto.js';

/** Lượt xem trang storefront gửi lên (POST /public/track). Giới hạn rộng để không mất lượt xem; service tự cắt độ dài khi lưu */
export class TrackDto {
  /** location.pathname (không gồm query) */
  @IsString() @MaxLength(2000)
  path: string;

  @IsOptional() @IsString() @MaxLength(1000)
  title?: string;

  @IsOptional() @IsString() @MaxLength(20)
  locale?: string;

  /** document.referrer — chỉ gửi ở lượt đầu phiên và khi khác tên miền */
  @IsOptional() @IsString() @MaxLength(2000)
  referrer?: string;

  /** mã phiên ngẫu nhiên (sessionStorage) */
  @IsString() @MaxLength(64)
  sid: string;

  /** lượt đầu tiên của phiên */
  @IsOptional() @IsBoolean()
  entry?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  utmSource?: string;

  @IsOptional() @IsString() @MaxLength(500)
  utmMedium?: string;

  @IsOptional() @IsString() @MaxLength(500)
  utmCampaign?: string;
}

export class SiteSeriesDto extends ReportRangeDto {
  @IsOptional() @IsIn(['day', 'week', 'month'])
  interval?: 'day' | 'week' | 'month' = 'day';
}

export class SitePagesDto extends ReportRangeDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number = 50;

  @IsOptional() @IsString() @MaxLength(200)
  search?: string;
}

export class SiteExportDto extends ReportRangeDto {
  @IsIn(['traffic', 'pages', 'sources'])
  report: 'traffic' | 'pages' | 'sources';

  @IsOptional() @IsIn(['day', 'week', 'month'])
  interval?: 'day' | 'week' | 'month' = 'day';
}
