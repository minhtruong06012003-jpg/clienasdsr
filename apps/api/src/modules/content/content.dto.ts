import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CONTENT_KEY_RE, CONTENT_TYPE_ORDERS, CONTENT_TYPE_SUPPORTS } from '@cmsnt/shared';
import { SeoFieldsDto } from '../../common/dto/seo.dto.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { CONTENT_STATUSES, type ContentStatusValue } from '../pages/pages.dto.js';

// ---------------------------------------------------------------------------- Loại nội dung

/** Tạo / sửa loại nội dung. `key` chỉ nhận khi tạo (không đổi được sau đó). */
export class SaveContentTypeDto {
  @IsOptional() @IsString() @Matches(CONTENT_KEY_RE, { message: 'Mã loại nội dung: chữ thường, số, gạch dưới, bắt đầu bằng chữ (2–40 ký tự)' }) key?: string;
  /** { vi: { singular, plural }, en: {...} } */
  @IsObject() labels: Record<string, { singular?: string; plural?: string }>;
  /** { vi: "du-an", en: "projects" } */
  @IsOptional() @IsObject() slugs?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsString() @MaxLength(60) icon?: string;
  @IsOptional() @IsArray() @IsIn(CONTENT_TYPE_SUPPORTS, { each: true }) supports?: string[];
  @IsOptional() @IsBoolean() isPublic?: boolean;
  @IsOptional() @IsBoolean() hasArchive?: boolean;
  @IsOptional() @IsBoolean() searchable?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) perPage?: number;
  @IsOptional() @IsIn(CONTENT_TYPE_ORDERS) orderBy?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) listColumns?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  /** key taxonomy gắn với loại này (cập nhật Taxonomy.contentTypes) */
  @IsOptional() @IsArray() @IsString({ each: true }) taxonomies?: string[];
}

// ---------------------------------------------------------------------------- Taxonomy

export class SaveTaxonomyDto {
  @IsOptional() @IsString() @Matches(CONTENT_KEY_RE, { message: 'Mã phân loại: chữ thường, số, gạch dưới, bắt đầu bằng chữ (2–40 ký tự)' }) key?: string;
  @IsObject() labels: Record<string, { singular?: string; plural?: string }>;
  @IsOptional() @IsObject() slugs?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsBoolean() hierarchical?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) contentTypes?: string[];
  @IsOptional() @IsBoolean() isPublic?: boolean;
  @IsOptional() @IsBoolean() showInFilter?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}

// ---------------------------------------------------------------------------- Term

export class ContentTermTranslationDto {
  @IsString() @MaxLength(10) locale: string;
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(160) slug?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() @MaxLength(255) seoTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(500) seoDescription?: string | null;
}

export class SaveContentTermDto {
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsUUID() imageId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  /** Giá trị trường tuỳ chỉnh (entity "term", nhóm lọc theo rules.taxonomies) */
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ContentTermTranslationDto)
  translations: ContentTermTranslationDto[];
}

// ---------------------------------------------------------------------------- Entry

export class EntryTranslationDto extends SeoFieldsDto {
  @IsString() @MaxLength(10) locale: string;
  @IsString() @MaxLength(255) title: string;
  @IsOptional() @IsString() @MaxLength(255) slug?: string;
  @IsOptional() @IsString() excerpt?: string | null;
  @IsOptional() @IsString() content?: string;
  /** Nội dung dựng bằng Page Builder (supports "blocks") */
  @IsOptional() @IsArray() blocks?: unknown[];
  @IsOptional() @IsBoolean() nofollow?: boolean;
}

export class SaveEntryDto {
  /** key loại nội dung — bắt buộc khi tạo, bỏ qua khi sửa */
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsEnum(CONTENT_STATUSES) status?: ContentStatusValue;
  @IsOptional() @IsDateString() publishedAt?: string | null;
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsUUID() authorId?: string | null;
  @IsOptional() @IsUUID() featuredImageId?: string | null;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) termIds?: string[];
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => EntryTranslationDto)
  translations: EntryTranslationDto[];
}

export class EntryQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsUUID() termId?: string;
  @IsOptional() @IsUUID() authorId?: string;
  @IsOptional() @IsString() trashed?: string;
  @IsOptional() @IsString() featured?: string;
}

export class EntryLookupDto {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() search?: string;
  /** id cách nhau dấu phẩy (nạp lại nhãn cho giá trị đã chọn) */
  @IsOptional() @IsString() ids?: string;
  @IsOptional() @IsString() locale?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export const ENTRY_BULK_ACTIONS = ['publish', 'draft', 'trash', 'restore', 'delete'] as const;
export type EntryBulkAction = (typeof ENTRY_BULK_ACTIONS)[number];

export class EntryBulkDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
  @IsIn(ENTRY_BULK_ACTIONS) action: EntryBulkAction;
}

/** Danh sách công khai */
export class PublicEntryQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() type?: string;
  /** <taxonomyKey>:<termSlug> — nhiều term cách dấu phẩy (một trong) */
  @IsOptional() @IsString() term?: string;
  @IsOptional() @IsString() featured?: string;
  @IsOptional() @IsString() parent?: string;
  /** id cách dấu phẩy (block chọn tay) */
  @IsOptional() @IsString() ids?: string;
  @IsOptional() @IsString() exclude?: string;
  @IsOptional() @IsObject() cf?: Record<string, string>;
}

export class PublicTermsQueryDto {
  @IsOptional() @IsString() locale?: string;
  /** chỉ đếm bài của loại này */
  @IsOptional() @IsString() type?: string;
}
