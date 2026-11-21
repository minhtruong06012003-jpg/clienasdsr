import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { SeoFieldsDto } from '../../common/dto/seo.dto.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { CONTENT_STATUSES, type ContentStatusValue } from '../pages/pages.dto.js';

export class PostTranslationDto extends SeoFieldsDto {
  @IsString() @MaxLength(10) locale: string;
  @IsString() @MaxLength(255) title: string;
  @IsOptional() @IsString() @MaxLength(255) slug?: string;
  @IsOptional() @IsString() excerpt?: string | null;
  @IsOptional() @IsString() content?: string;
  @IsOptional() @IsBoolean() nofollow?: boolean;
}

export class SavePostDto {
  @IsOptional() @IsEnum(CONTENT_STATUSES) status?: ContentStatusValue;
  @IsOptional() @IsUUID() featuredImageId?: string | null;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsBoolean() allowComments?: boolean;
  @IsOptional() @IsDateString() publishedAt?: string | null;
  @IsOptional() @IsUUID() authorId?: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) categoryIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) tagIds?: string[];
  /** Tạo thẻ mới theo tên (ngôn ngữ mặc định) */
  @IsOptional() @IsArray() @IsString({ each: true }) newTags?: string[];
  /** Giá trị trường tuỳ chỉnh { [fieldKey]: value } (kiểm tra theo nhóm trường của loại nội dung này) */
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PostTranslationDto)
  translations: PostTranslationDto[];
}

export class PostQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() tagId?: string;
  @IsOptional() @IsUUID() authorId?: string;
  @IsOptional() @IsString() trashed?: string;
}

export class PublicPostQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() featured?: string;
  /** Lọc theo trường tuỳ chỉnh: ?cf[key]=value (a,b = một trong) */
  @IsOptional() @IsObject() cf?: Record<string, string>;
}

export class TermTranslationDto {
  @IsString() locale: string;
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() seoTitle?: string | null;
  @IsOptional() @IsString() seoDescription?: string | null;
}

export class SaveTermDto {
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsUUID() imageId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Giá trị trường tuỳ chỉnh { [fieldKey]: value } (kiểm tra theo nhóm trường của loại nội dung này) */
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TermTranslationDto)
  translations: TermTranslationDto[];
}
