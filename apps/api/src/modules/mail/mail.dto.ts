import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export class UpsertEmailTemplateDto {
  @IsString() @MaxLength(10) locale: string;
  @IsString() @MaxLength(500) subject: string;
  @IsString() html: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class ToggleEmailTemplateDto {
  @IsBoolean() enabled: boolean;
}

export class PreviewEmailTemplateDto {
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional() @IsString() @MaxLength(500) subject?: string;
  @IsOptional() @IsString() html?: string;
}

export class TestEmailTemplateDto extends PreviewEmailTemplateDto {
  @IsEmail({}, { message: 'Email nhận không hợp lệ' }) to: string;
}

export class EmailLogQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED']) declare status?: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
  @IsOptional() @IsString() templateKey?: string;
}
