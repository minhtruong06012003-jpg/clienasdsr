import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** Chuẩn hoá chuỗi mã: cắt khoảng trắng, rỗng → "*" */
const code = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() || '*' : value);

/** Tạo / sửa một dòng thuế suất (`/admin/tax-rates`) */
export class SaveTaxRateDto {
  @IsString() @MaxLength(120) name: string;
  /** lớp thuế: standard | reduced | zero | tuỳ chọn (a-z0-9_-) */
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() || 'standard' : value)) @IsString() @Matches(/^[a-z0-9_-]{1,40}$/, { message: 'Lớp thuế chỉ gồm a-z, 0-9, _ , -' }) taxClass?: string;
  /** mã quốc gia ISO 2 ký tự hoặc "*" */
  @IsOptional() @Transform(code) @IsString() @Matches(/^(\*|[A-Z]{2})$/, { message: 'Quốc gia phải là mã ISO 2 ký tự hoặc *' }) country?: string;
  /** mã tỉnh ("VN-HN") hoặc "*" */
  @IsOptional() @Transform(code) @IsString() @MaxLength(20) province?: string;
  /** phần trăm 0–100 */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(100) rate: number;
  @IsOptional() @IsBoolean() shipping?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() priority?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** Thử tính thuế từ trang cài đặt: một dòng hàng giả định theo lớp thuế + địa chỉ */
export class PreviewTaxDto {
  @IsOptional() @IsString() @MaxLength(40) taxClass?: string;
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  @IsOptional() @IsString() @MaxLength(20) province?: string;
  @Type(() => Number) @IsNumber() @Min(0) amount: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) shipping?: number;
}
