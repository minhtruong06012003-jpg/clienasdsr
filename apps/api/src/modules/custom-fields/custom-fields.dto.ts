import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_KEY_RE } from '@cmsnt/shared';

/** Tạo / sửa nhóm trường. `fields` được CustomFieldsService kiểm tra chi tiết (key, type, options...). */
export class SaveFieldGroupDto {
  /** Bỏ trống khi tạo -> tự sinh từ name */
  @IsOptional() @IsString() @Matches(CUSTOM_FIELD_KEY_RE, { message: 'Mã nhóm chỉ gồm chữ thường, số, gạch dưới và bắt đầu bằng chữ' }) key?: string;
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsIn(CUSTOM_FIELD_ENTITIES) entity: (typeof CUSTOM_FIELD_ENTITIES)[number];
  @IsArray() fields: unknown[];
  @IsOptional() @IsObject() rules?: Record<string, unknown>;
  @IsOptional() @IsIn(['main', 'sidebar']) placement?: 'main' | 'sidebar';
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class FieldGroupQueryDto {
  @IsOptional() @IsIn(CUSTOM_FIELD_ENTITIES) entity?: (typeof CUSTOM_FIELD_ENTITIES)[number];
}

class ReorderItemDto {
  @IsString() id: string;
  @Type(() => Number) @IsInt() sortOrder: number;
}

export class ReorderFieldGroupsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReorderItemDto) items: ReorderItemDto[];
}

/** Nhập nhóm trường từ JSON đã xuất (hoặc từ mẫu có sẵn) */
export class ImportFieldGroupsDto {
  @IsArray() groups: unknown[];
  /** true = ghi đè nhóm trùng key; false (mặc định) = bỏ qua nhóm trùng */
  @IsOptional() @IsBoolean() overwrite?: boolean;
}

export class ApplyPresetDto {
  @IsString() preset: string;
  @IsOptional() @IsBoolean() overwrite?: boolean;
}
