import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { SeoFieldsDto } from '../../common/dto/seo.dto.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { CONTENT_STATUSES, type ContentStatusValue } from '../pages/pages.dto.js';

export const PRODUCT_TYPES = ['SIMPLE', 'VARIABLE', 'DIGITAL'] as const;
export const STOCK_STATUSES = ['IN_STOCK', 'OUT_OF_STOCK', 'BACKORDER'] as const;

export class ProductTranslationDto extends SeoFieldsDto {
  @IsString() @MaxLength(10) locale: string;
  @IsString() @MaxLength(255) name: string;
  @IsOptional() @IsString() @MaxLength(255) slug?: string;
  @IsOptional() @IsString() shortDescription?: string | null;
  @IsOptional() @IsString() description?: string;
  /** Hướng dẫn sử dụng gửi kèm mã / tài khoản (email giao mã, trang đơn) — sản phẩm bán theo kho mã */
  @IsOptional() @IsString() @MaxLength(5000) deliveryNote?: string | null;
}

export class VariantDto {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsString() sku?: string | null;
  @IsObject() optionValues: Record<string, string>;
  @Type(() => Number) @IsNumber() @Min(0) price: number;
  @IsOptional() @Type(() => Number) @IsNumber() salePrice?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() stockQuantity?: number;
  @IsOptional() @IsEnum(STOCK_STATUSES) stockStatus?: (typeof STOCK_STATUSES)[number];
  @IsOptional() @IsUUID() imageId?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() weight?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** File tải về của sản phẩm số (chọn từ thư viện media hoặc URL ngoài) */
export class ProductDownloadDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(255) name: string;
  @IsOptional() @IsUUID() mediaId?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) url?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) downloadLimit?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expiryDays?: number | null;
}

export class SaveProductDto {
  @IsOptional() @IsEnum(PRODUCT_TYPES) type?: (typeof PRODUCT_TYPES)[number];
  @IsOptional() @IsEnum(CONTENT_STATUSES) status?: ContentStatusValue;
  @IsOptional() @IsString() sku?: string | null;
  @IsOptional() @IsString() barcode?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;
  @IsOptional() @Type(() => Number) @IsNumber() salePrice?: number | null;
  @IsOptional() @IsDateString() saleStart?: string | null;
  @IsOptional() @IsDateString() saleEnd?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() costPrice?: number | null;
  @IsOptional() @IsBoolean() manageStock?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() stockQuantity?: number;
  @IsOptional() @IsEnum(STOCK_STATUSES) stockStatus?: (typeof STOCK_STATUSES)[number];
  @IsOptional() @Type(() => Number) @IsInt() lowStockThreshold?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() weight?: number | null;
  /** Thuế suất GTGT riêng (0,5,8,10; -1 KCT; -2 KKKNT); null = mặc định */
  @IsOptional() @Type(() => Number) @IsInt() @Min(-3) @Max(100) vatRate?: number | null;
  /** Lớp thuế (bảng /admin/tax-rates, dùng khi commerce.taxMode = rates); null = standard */
  @IsOptional() @IsString() @MaxLength(40) taxClass?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() length?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() width?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() height?: number | null;
  @IsOptional() @IsUUID() brandId?: string | null;
  @IsOptional() @IsUUID() featuredImageId?: string | null;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) galleryIds?: string[];
  @IsOptional() @IsArray() options?: unknown[];
  @IsOptional() @IsArray() specs?: unknown[];
  /** Giá trị trường tuỳ chỉnh { [fieldKey]: value } (kiểm tra theo nhóm trường của loại nội dung này) */
  @IsOptional() @IsObject() customFields?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsDateString() publishedAt?: string | null;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) categoryIds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) relatedIds?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VariantDto) variants?: VariantDto[];
  /** Chỉ lưu khi type = DIGITAL; thay thế toàn bộ danh sách (upsert theo id, xoá id không gửi) */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ProductDownloadDto) downloads?: ProductDownloadDto[];
  /** Không cần giao hàng (dịch vụ, khoá học, tài khoản...) — DIGITAL / bán theo kho mã luôn coi là ảo */
  @IsOptional() @IsBoolean() isVirtual?: boolean;
  /** Bán theo kho mã: tồn kho = số mã còn trong kho (tự tính), tự giao mã khi đơn đã thanh toán */
  @IsOptional() @IsBoolean() codeDelivery?: boolean;
  /** Nhãn các phần của mã khi tách bằng "|" [{ key, label:{vi,en}, secret? }] — chuẩn hoá bằng normalizeCodeFields */
  @IsOptional() @IsArray() codeFields?: unknown[];
  /** Số ngày bảo hành (khách được báo lỗi mã); null = không nhận báo lỗi */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650) codeWarrantyDays?: number | null;
  /** Ô khách phải nhập khi mua [{ key, label, type, required, ... }] — chuẩn hoá bằng normalizePurchaseFields */
  @IsOptional() @IsArray() purchaseFields?: unknown[];
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ProductTranslationDto)
  translations: ProductTranslationDto[];
}

export class ProductQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() brandId?: string;
  @IsOptional() @IsEnum(PRODUCT_TYPES) type?: string;
  @IsOptional() @IsEnum(STOCK_STATUSES) stockStatus?: string;
  @IsOptional() @IsString() trashed?: string;
  @IsOptional() @IsString() ids?: string;
  @IsOptional() @IsString() exclude?: string;
}

export class PublicProductQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @Type(() => Number) @IsNumber() minPrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() maxPrice?: number;
  @IsOptional() @IsString() inStock?: string;
  @IsOptional() @IsString() onSale?: string;
  @IsOptional() @IsString() featured?: string;
  @IsOptional() @IsString() ids?: string;
  /** Lọc theo trường tuỳ chỉnh: ?cf[key]=value (a,b = một trong) */
  @IsOptional() @IsObject() cf?: Record<string, string>;
  /** Lọc theo thuộc tính biến thể: ?attr[color]=red,blue (controller đọc từ query thô qua parseAttrQuery) */
  @IsOptional() @IsObject() attr?: Record<string, string[]>;
}

export class SaveBrandDto {
  @IsString() name: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsUUID() logoId?: string | null;
  @IsOptional() @IsString() website?: string | null;
  @IsOptional() @IsString() description?: string | null;
}
