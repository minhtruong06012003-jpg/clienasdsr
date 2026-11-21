import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { PRODUCT_ATTRIBUTE_TYPES, type ProductAttributeType } from '@cmsnt/shared';

/** Một giá trị của thuộc tính */
export class AttributeValueDto {
  @IsString() @MaxLength(100) value: string;
  /** { vi, en } */
  @IsObject() label: Record<string, string>;
  @IsOptional() @IsString() @Matches(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i, { message: 'Mã màu phải dạng #rrggbb' }) color?: string | null;
  @IsOptional() @IsUUID() imageId?: string | null;
}

/** Tạo / sửa thuộc tính dùng chung (`/admin/product-attributes`) */
export class SaveAttributeDto {
  /** mã a-z0-9_, khớp Product.options[].key */
  @IsOptional() @IsString() @MaxLength(50) key?: string;
  @IsObject() name: Record<string, string>;
  @IsOptional() @IsIn(PRODUCT_ATTRIBUTE_TYPES) type?: ProductAttributeType;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AttributeValueDto) values?: AttributeValueDto[];
  @IsOptional() @IsBoolean() filterable?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}
