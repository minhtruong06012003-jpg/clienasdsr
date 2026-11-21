import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsIn, IsUUID } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { hasPermission } from '@cmsnt/shared';
import { PagesService } from './pages.service.js';
import { PageQueryDto, SavePageDto } from './pages.dto.js';

const BULK = ['trash', 'restore', 'publish', 'draft', 'destroy'] as const;

class BulkDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
  @IsIn(BULK) action: (typeof BULK)[number];
}

@Controller('admin/pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @RequirePermissions('pages.read')
  @Get()
  list(@Query() q: PageQueryDto) {
    return this.pages.list(q);
  }

  @RequirePermissions('pages.write')
  @Post('bulk')
  bulk(@Body() dto: BulkDto, @CurrentUser() user: AuthUser) {
    return this.pages.bulk(dto.ids, dto.action, user);
  }

  // khai báo trước route ':id' để không bị bắt nhầm
  @RequirePermissions('pages.read')
  @Get('revisions/:revisionId')
  revision(@Param('revisionId', ParseUUIDPipe) revisionId: string) {
    return this.pages.revision(revisionId);
  }

  @RequirePermissions('pages.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.pages.get(id);
  }

  @RequirePermissions('pages.write')
  @Post()
  create(@Body() dto: SavePageDto, @CurrentUser() user: AuthUser) {
    return this.pages.create(dto, user);
  }

  @RequirePermissions('pages.write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SavePageDto, @CurrentUser() user: AuthUser) {
    return this.pages.update(id, dto, user);
  }

  @RequirePermissions('pages.write')
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.pages.duplicate(id, user);
  }

  @RequirePermissions('pages.write')
  @Delete(':id/translations/:locale')
  removeTranslation(@Param('id', ParseUUIDPipe) id: string, @Param('locale') locale: string) {
    return this.pages.removeTranslation(id, locale);
  }

  @RequirePermissions('pages.publish', 'settings.general')
  @Post(':id/set-homepage')
  setHomepage(@Param('id', ParseUUIDPipe) id: string) {
    return this.pages.setHomepage(id);
  }

  @RequirePermissions('pages.read')
  @Get(':id/revisions')
  revisions(@Param('id', ParseUUIDPipe) id: string, @Query('locale') locale?: string) {
    return this.pages.revisions(id, locale);
  }

  @RequirePermissions('pages.write')
  @Post(':id/revisions/:revisionId/restore')
  restoreRevision(@Param('id', ParseUUIDPipe) id: string, @Param('revisionId', ParseUUIDPipe) revisionId: string, @CurrentUser() user: AuthUser) {
    return this.pages.restoreRevision(id, revisionId, user);
  }

  @RequirePermissions('pages.delete')
  @Post(':id/trash')
  trash(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.pages.trash(id, user);
  }

  @RequirePermissions('pages.delete')
  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.pages.restore(id, user);
  }

  @RequirePermissions('pages.delete')
  @Delete(':id')
  destroy(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.pages.destroy(id, user);
  }
}

@Controller('public/pages')
export class PublicPagesController {
  constructor(private readonly pages: PagesService) {}

  @Public()
  @Get('home')
  home(@Query('locale') locale?: string, @Query('preview') preview?: string, @CurrentUser() user?: AuthUser) {
    return this.pages.publicBySlug('__home__', locale, preview === '1' && hasPermission(user?.permissions, 'pages.read'));
  }

  @Public()
  @Get('by-slug/:slug')
  bySlug(@Param('slug') slug: string, @Query('locale') locale?: string, @Query('preview') preview?: string, @CurrentUser() user?: AuthUser) {
    return this.pages.publicBySlug(slug, locale, preview === '1' && hasPermission(user?.permissions, 'pages.read'));
  }
}
