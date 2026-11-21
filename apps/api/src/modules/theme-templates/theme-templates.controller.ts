import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TEMPLATE_KINDS } from '@cmsnt/shared';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { ThemeCapabilitiesService } from './theme-capabilities.service.js';
import { ThemeTemplatesService } from './theme-templates.service.js';
import { WidgetAreasService } from './widget-areas.service.js';

class TemplateTranslationDto {
  @IsString() @MaxLength(10) locale: string;
  @IsArray() blocks: unknown[];
}

class SaveTemplateDto {
  @IsString() @MaxLength(120) name: string;
  @IsIn(TEMPLATE_KINDS as unknown as string[]) kind: string;
  @IsOptional() @IsString() @MaxLength(80) target?: string;
  /** { ids?, termIds?, excludeIds? } — làm sạch trong service */
  @IsOptional() @IsObject() conditions?: Record<string, unknown>;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TemplateTranslationDto) translations?: TemplateTranslationDto[];
}

class PreviewContextDto {
  @IsString() @MaxLength(80) target: string;
  @IsOptional() @IsString() @MaxLength(80) id?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional() @IsString() @MaxLength(20) kind?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}

@Controller('admin/theme-templates')
export class ThemeTemplatesController {
  constructor(private readonly templates: ThemeTemplatesService) {}

  @RequirePermissions('templates.manage')
  @Get()
  list(@Query('kind') kind?: string) {
    return this.templates.list(kind || undefined);
  }

  /** Đối tượng áp dụng cho ô chọn (core + loại nội dung + taxonomy) */
  @RequirePermissions('templates.manage')
  @Get('targets')
  targets(@Query('kind') kind?: string) {
    return this.templates.targets(kind || undefined);
  }

  /** Dữ liệu mẫu cho canvas builder */
  @RequirePermissions('templates.manage')
  @Post('preview-context')
  previewContext(@Body() dto: PreviewContextDto) {
    return this.templates.previewContext(dto);
  }

  @RequirePermissions('templates.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(id);
  }

  @RequirePermissions('templates.manage')
  @Post()
  create(@Body() dto: SaveTemplateDto, @CurrentUser() user: AuthUser) {
    return this.templates.create(dto, user);
  }

  @RequirePermissions('templates.manage')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTemplateDto, @CurrentUser() user: AuthUser) {
    return this.templates.update(id, dto, user);
  }

  @RequirePermissions('templates.manage')
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.templates.duplicate(id, user);
  }

  @RequirePermissions('templates.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.templates.remove(id, user.id);
  }
}

@Controller('public/theme-templates')
export class PublicThemeTemplatesController {
  constructor(private readonly templates: ThemeTemplatesService) {}

  /**
   * Mẫu khớp trang đang xem (đã resolve blocks) hoặc `null`.
   * Trả JSON tường minh để `null` vẫn là body hợp lệ (Nest mặc định gửi body rỗng).
   */
  @Public()
  @Get('render')
  async render(
    @Res() res: Response,
    @Query('kind') kind: string,
    @Query('target') target?: string,
    @Query('id') id?: string,
    @Query('slug') slug?: string,
    @Query('locale') locale?: string,
    @Query('page') page?: string,
    @Query('termSlug') termSlug?: string,
    @Query('q') q?: string,
  ) {
    res.json(await this.templates.render({ kind, target, id, slug, locale, page, termSlug, q }));
  }
}

@Controller('admin/widget-areas')
export class WidgetAreasController {
  constructor(private readonly areas: WidgetAreasService) {}

  @RequirePermissions('templates.manage')
  @Get()
  list() {
    return this.areas.list();
  }

  @RequirePermissions('templates.manage')
  @Post(':key/ensure')
  ensure(@Param('key') key: string) {
    return this.areas.ensure(key);
  }
}

/** Tình trạng storefront đang chạy (lõi lúc build, theme, block hỗ trợ) — Công cụ › Giao diện website và Page Builder dùng. */
@Controller('admin/storefront')
export class StorefrontStatusController {
  constructor(private readonly caps: ThemeCapabilitiesService) {}

  @RequirePermissions('settings.manage')
  @Get('status')
  status() {
    return this.caps.storefront();
  }
}
