import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { SeoFieldsDto } from '../../common/dto/seo.dto.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const CONTENT_STATUSES = ['DRAFT', 'PUBLISHED', 'SCHEDULED', 'ARCHIVED'] as const;
export type ContentStatusValue = (typeof CONTENT_STATUSES)[number];

export class PageTranslationDto extends SeoFieldsDto {
  @IsString() @MaxLength(10) locale: string;
  @IsString() @MaxLength(255) title: string;
  @IsOptional() @IsString() @MaxLength(255) slug?: string;
  @IsOptional() @IsString() excerpt?: string | null;
  @IsOptional() @IsArray() blocks?: unknown[];
  @IsOptional() @IsBoolean() nofollow?: boolean;
}

export class SavePageDto {
  @IsOptional() @IsEnum(CONTENT_STATUSES) status?: ContentStatusValue;
  @IsOptional() @IsString() template?: string;
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsUUID() featuredImageId?: string | null;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsDateString() publishedAt?: string | null;
  /** Giá trị trường tuỳ chỉnh { [fieldKey]: value } (kiểm tra theo nhóm trường của loại nội dung này) */
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PageTranslationDto)
  translations: PageTranslationDto[];
}

export class PageQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() trashed?: string;
}
