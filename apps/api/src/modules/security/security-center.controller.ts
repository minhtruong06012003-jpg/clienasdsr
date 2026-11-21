import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import type { IpRuleType } from '@cmsnt/shared';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { IpRulesService } from './ip-rules.service.js';
import { LoginAuditService } from './login-audit.service.js';

class LoginAttemptsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsIn(['success', 'failed']) result?: string;
  @IsOptional() @IsIn(['admin', 'site']) area?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsString() @MaxLength(40) userId?: string;
}

class CreateIpRuleDto {
  @IsIn(['block', 'allow_admin']) type: IpRuleType;
  /** một hoặc nhiều IP / CIDR, cách nhau bởi xuống dòng, dấu phẩy hoặc khoảng trắng */
  @IsString() @MaxLength(5000) value: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  /** thời hạn (phút); bỏ trống = vĩnh viễn */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(525_600) durationMinutes?: number;
}

class AllowlistDto {
  @IsBoolean() enabled: boolean;
}

/**
 * Trung tâm bảo mật (Admin › Bảo mật): tổng quan + điểm bảo mật, nhật ký đăng nhập,
 * danh sách IP chặn / cho phép vào trang quản trị.
 */
@Controller('admin/security')
@RequirePermissions('settings.security')
export class SecurityCenterController {
  constructor(
    private readonly audit: LoginAuditService,
    private readonly ipRules: IpRulesService,
  ) {}

  @Get('overview')
  overview(@Req() req: Request) {
    return this.audit.overview(req.ip ?? null);
  }

  @Get('login-attempts')
  loginAttempts(@Query() q: LoginAttemptsQueryDto) {
    return this.audit.list(q);
  }

  @Get('ip-rules')
  async listIpRules(@Query('type') type: string | undefined, @Req() req: Request) {
    const t = type === 'block' || type === 'allow_admin' ? type : undefined;
    return { rules: await this.ipRules.list(t), adminAllowlistEnabled: await this.ipRules.adminAllowlistActive(), yourIp: req.ip ?? null };
  }

  /** Thêm nhiều IP một lúc; trả danh sách đã thêm và dòng lỗi (không dừng giữa chừng) */
  @Post('ip-rules')
  @HttpCode(200)
  async addIpRules(@Body() dto: CreateIpRuleDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const values = [...new Set(dto.value.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))];
    if (!values.length) throw new BadRequestException('Nhập ít nhất một IP hoặc dải CIDR');
    if (values.length > 100) throw new BadRequestException('Tối đa 100 IP mỗi lần thêm');
    const added: string[] = [];
    const errors: { value: string; message: string }[] = [];
    for (const value of values) {
      try {
        added.push((await this.ipRules.create({ type: dto.type, value, note: dto.note, durationMinutes: dto.durationMinutes }, { id: user.id, ip: req.ip })).value);
      } catch (err) {
        errors.push({ value, message: (err as Error).message });
      }
    }
    if (!added.length && errors.length === 1) throw new BadRequestException(errors[0].message);
    return { added, errors };
  }

  @Delete('ip-rules/:id')
  removeIpRule(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.ipRules.remove(id, { id: user.id, ip: req.ip });
  }

  /** Bật / tắt "chỉ IP trong danh sách được vào trang quản trị" (kiểm tra IP hiện tại để không tự khoá mình) */
  @Put('admin-allowlist')
  setAllowlist(@Body() dto: AllowlistDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.ipRules.setAdminAllowlist(dto.enabled, { id: user.id, ip: req.ip });
  }
}
