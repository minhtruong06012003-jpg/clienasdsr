import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, ValidateBy, ValidateIf } from 'class-validator';

/** JSON-LD: object hoặc mảng object */
const IsJsonLd = () =>
  ValidateBy({
    name: 'isJsonLd',
    validator: {
      validate: (v: unknown) => (Array.isArray(v) ? v.every((x) => x && typeof x === 'object' && !Array.isArray(x)) : !!v && typeof v === 'object'),
      defaultMessage: () => 'schemaJson phải là object hoặc mảng object JSON-LD',
    },
  });

/** Các trường SEO dùng chung cho bản dịch page/post/product */
export class SeoFieldsDto {
  @IsOptional() @IsString() @MaxLength(255) seoTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(500) seoDescription?: string | null;
  @IsOptional() @IsString() @MaxLength(500) seoKeywords?: string | null;
  @IsOptional() @IsString() @MaxLength(500) canonicalUrl?: string | null;
  @IsOptional() @IsUUID() ogImageId?: string | null;
  @IsOptional() @IsBoolean() noindex?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsJsonLd() schemaJson?: Record<string, unknown> | Record<string, unknown>[] | null;
}
