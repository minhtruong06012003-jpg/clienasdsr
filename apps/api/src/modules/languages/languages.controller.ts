import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { DEFAULT_UI_STRINGS, UI_STRING_DEFS } from '@cmsnt/shared';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { LanguagesService } from './languages.service.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';

class LanguageDto {
  @IsString() @MaxLength(10) code: string;
  @IsString() name: string;
  @IsOptional() @IsString() nativeName?: string;
  @IsOptional() @IsString() flag?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsString() direction?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

/** Bản dịch chuỗi giao diện của một ngôn ngữ: { khoá: bản dịch } */
class UiStringsDto {
  @IsObject() values: Record<string, string>;
}

/** Khoá chuỗi riêng do admin thêm */
class UiStringKeyDto {
  @IsString() @MaxLength(80) key: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
}

@Controller()
export class LanguagesController {
  constructor(private readonly languages: LanguagesService) {}

  @Public()
  @Get('public/languages')
  publicList() {
    return this.languages.list(true);
  }

  @RequirePermissions('admin.access')
  @Get('admin/languages')
  list() {
    return this.languages.list();
  }

  @RequirePermissions('languages.manage')
  @Post('admin/languages')
  upsert(@Body() dto: LanguageDto, @CurrentUser() user: AuthUser) {
    return this.languages.upsert(dto, user.id);
  }

  @RequirePermissions('languages.manage')
  @Delete('admin/languages/:code')
  remove(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    return this.languages.remove(code, user.id);
  }

  // ------------------------------------------------------------
  // Bản dịch chuỗi giao diện
  // ------------------------------------------------------------

  /** Frontend lấy bảng chuỗi đã dịch của một ngôn ngữ (cũng có sẵn trong /public/bootstrap → uiStrings) */
  @Public()
  @Get('public/ui-strings')
  async publicUiStrings(@Query('locale') locale?: string) {
    const resolved = await this.languages.resolve(locale);
    return { locale: resolved, strings: await this.languages.uiStringsFor(resolved) };
  }

  /** Dữ liệu cho màn dịch: danh sách khoá có sẵn, bản gốc trong code và bản admin đã nhập */
  @RequirePermissions('admin.access')
  @Get('admin/ui-strings')
  async uiStrings() {
    return { definitions: UI_STRING_DEFS, defaults: DEFAULT_UI_STRINGS, ...(await this.languages.uiStrings()) };
  }

  @RequirePermissions('languages.manage')
  @Put('admin/ui-strings/:locale')
  saveUiStrings(@Param('locale') locale: string, @Body() dto: UiStringsDto, @CurrentUser() user: AuthUser) {
    return this.languages.saveUiStrings(locale, dto.values, user.id);
  }

  @RequirePermissions('languages.manage')
  @Post('admin/ui-strings/keys')
  upsertUiStringKey(@Body() dto: UiStringKeyDto, @CurrentUser() user: AuthUser) {
    return this.languages.upsertUiStringKey(dto.key, dto.description, user.id);
  }

  @RequirePermissions('languages.manage')
  @Delete('admin/ui-strings/keys/:key')
  removeUiStringKey(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.languages.removeUiStringKey(key, user.id);
  }
}
