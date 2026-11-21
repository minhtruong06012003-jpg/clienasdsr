import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { SettingsService } from '../settings/settings.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { RevalidateListener } from '../events/revalidate.listener.js';
import { SECTIONS, ToolsService, type ExportBundle, type Section } from './tools.service.js';
import { SiteHealthService } from './site-health.service.js';

class ImportDto {
  @IsObject() bundle: ExportBundle;
  @IsOptional() @IsIn(['skip', 'overwrite']) mode?: 'skip' | 'overwrite';
}

/** Công cụ: xuất/nhập cấu hình, Site Health, xoá cache */
@Controller('admin/tools')
@RequirePermissions('settings.manage')
export class ToolsController {
  constructor(
    private readonly tools: ToolsService,
    private readonly health: SiteHealthService,
    private readonly settings: SettingsService,
    private readonly languages: LanguagesService,
    private readonly revalidate: RevalidateListener,
    private readonly events: EventEmitter2,
  ) {}

  @Get('export')
  export(@Query('sections') sections?: string) {
    const list = (sections ? sections.split(',') : [...SECTIONS]).filter((s): s is Section => (SECTIONS as readonly string[]).includes(s));
    return this.tools.export(list);
  }

  @Post('import')
  @RequirePermissions('pages.write', 'pages.publish', 'blocks.manage', 'menus.manage', 'languages.manage')
  import(@Body() dto: ImportDto, @CurrentUser() user: AuthUser) {
    return this.tools.import(dto.bundle, dto.mode ?? 'skip', user);
  }

  @Get('health')
  siteHealth() {
    return this.health.report();
  }

  /** Xoá cache in-memory của API + yêu cầu frontend riêng (nếu có) làm mới toàn bộ cache ISR */
  @Post('cache/clear')
  @HttpCode(200)
  async clearCache(@CurrentUser() user: AuthUser) {
    this.settings.clearCache();
    this.languages.clearCache();
    const result = await this.revalidate.revalidateAll();
    this.events.emit('activity', { userId: user.id, action: 'cache.clear', entityType: 'tools', meta: { ok: result.ok, tags: result.tags.length, error: result.error } });
    return { cleared: ['settings', 'languages'], revalidate: result };
  }
}
