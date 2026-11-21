import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ReorderDto } from '../../common/dto/reorder.dto.js';
import { parseCfQuery } from '../custom-fields/cf-query.util.js';
import { ContentTypesService } from './content-types.service.js';
import { ContentTermsService } from './content-terms.service.js';
import { EntriesService } from './entries.service.js';
import { ContentPublicService } from './content-public.service.js';
import { EntryBulkDto, EntryLookupDto, EntryQueryDto, PublicEntryQueryDto, PublicTermsQueryDto, SaveContentTermDto, SaveContentTypeDto, SaveEntryDto, SaveTaxonomyDto } from './content.dto.js';

// ============================================================================ Admin: loại nội dung

@Controller('admin/content-types')
export class ContentTypesController {
  constructor(private readonly types: ContentTypesService) {}

  /** content_types.manage hoặc entries.read (kiểm trong service) */
  @RequirePermissions('admin.access')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.types.listTypes(user);
  }

  // ---- mẫu có sẵn (khai báo trước ':id') ----
  @RequirePermissions('content_types.manage')
  @Get('presets')
  presets() {
    return this.types.presets();
  }

  @RequirePermissions('content_types.manage')
  @Post('presets/:key')
  installPreset(@Param('key') key: string, @CurrentUser() user: AuthUser) {
    return this.types.installPreset(key, user);
  }

  @RequirePermissions('content_types.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.types.getType(id);
  }

  @RequirePermissions('content_types.manage')
  @Post()
  create(@Body() dto: SaveContentTypeDto, @CurrentUser() user: AuthUser) {
    return this.types.saveType(undefined, dto, user);
  }

  @RequirePermissions('content_types.manage')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveContentTypeDto, @CurrentUser() user: AuthUser) {
    return this.types.saveType(id, dto, user);
  }

  @RequirePermissions('content_types.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.types.removeType(id, user);
  }
}

// ============================================================================ Admin: taxonomy + term

@Controller('admin')
export class TaxonomiesController {
  constructor(
    private readonly types: ContentTypesService,
    private readonly terms: ContentTermsService,
  ) {}

  /** content_types.manage hoặc entries.read (kiểm trong service) */
  @RequirePermissions('admin.access')
  @Get('taxonomies')
  list(@CurrentUser() user: AuthUser) {
    return this.types.listTaxonomies(user);
  }

  @RequirePermissions('content_types.manage')
  @Post('taxonomies')
  create(@Body() dto: SaveTaxonomyDto, @CurrentUser() user: AuthUser) {
    return this.types.saveTaxonomy(undefined, dto, user);
  }

  @RequirePermissions('content_types.manage')
  @Put('taxonomies/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTaxonomyDto, @CurrentUser() user: AuthUser) {
    return this.types.saveTaxonomy(id, dto, user);
  }

  @RequirePermissions('content_types.manage')
  @Delete('taxonomies/:id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.types.removeTaxonomy(id, user);
  }

  // ---- term ----
  @RequirePermissions('entries.read')
  @Get('taxonomies/:key/terms')
  terms_(@Param('key') key: string, @Query('locale') locale?: string) {
    return this.terms.list(key, locale);
  }

  @RequirePermissions('entries.taxonomy')
  @Post('taxonomies/:key/terms/reorder')
  reorder(@Param('key') key: string, @Body() dto: ReorderDto, @CurrentUser() user: AuthUser) {
    return this.terms.reorder(key, dto.items, user);
  }

  @RequirePermissions('entries.taxonomy')
  @Post('taxonomies/:key/terms')
  createTerm(@Param('key') key: string, @Body() dto: SaveContentTermDto, @CurrentUser() user: AuthUser) {
    return this.terms.save(key, undefined, dto, user);
  }

  @RequirePermissions('entries.read')
  @Get('terms/:id')
  getTerm(@Param('id', ParseUUIDPipe) id: string) {
    return this.terms.get(id);
  }

  @RequirePermissions('entries.taxonomy')
  @Put('terms/:id')
  updateTerm(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveContentTermDto, @CurrentUser() user: AuthUser) {
    return this.terms.save(undefined, id, dto, user);
  }

  @RequirePermissions('entries.taxonomy')
  @Delete('terms/:id')
  removeTerm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.terms.remove(id, user);
  }
}

// ============================================================================ Admin: entries

@Controller('admin/entries')
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @RequirePermissions('entries.read')
  @Get()
  list(@Query() q: EntryQueryDto) {
    return this.entries.list(q);
  }

  @RequirePermissions('entries.read')
  @Get('lookup')
  lookup(@Query() q: EntryLookupDto) {
    return this.entries.lookup(q);
  }

  /** quyền chi tiết (publish / delete) kiểm trong service theo action */
  @RequirePermissions('entries.write')
  @Post('bulk')
  bulk(@Body() dto: EntryBulkDto, @CurrentUser() user: AuthUser) {
    return this.entries.bulk(dto.ids, dto.action, user);
  }

  // ---- lịch sử phiên bản ('revisions/:revisionId' trước ':id') ----
  @RequirePermissions('entries.read')
  @Get('revisions/:revisionId')
  revision(@Param('revisionId', ParseUUIDPipe) revisionId: string) {
    return this.entries.revision(revisionId);
  }

  @RequirePermissions('entries.read')
  @Get(':id/revisions')
  revisions(@Param('id', ParseUUIDPipe) id: string, @Query('locale') locale?: string) {
    return this.entries.revisions(id, locale);
  }

  @RequirePermissions('entries.write')
  @Post(':id/revisions/:revisionId/restore')
  restoreRevision(@Param('id', ParseUUIDPipe) id: string, @Param('revisionId', ParseUUIDPipe) revisionId: string, @CurrentUser() user: AuthUser) {
    return this.entries.restoreRevision(id, revisionId, user);
  }

  // ---- thùng rác ----
  @RequirePermissions('entries.delete')
  @Post(':id/trash')
  trash(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.entries.trash(id, user);
  }

  @RequirePermissions('entries.delete')
  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.entries.restore(id, user);
  }

  @RequirePermissions('entries.delete')
  @Delete(':id')
  destroy(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.entries.destroy(id, user);
  }

  @RequirePermissions('entries.write')
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.entries.duplicate(id, user);
  }

  @RequirePermissions('entries.write')
  @Delete(':id/translations/:locale')
  removeTranslation(@Param('id', ParseUUIDPipe) id: string, @Param('locale') locale: string, @CurrentUser() user: AuthUser) {
    return this.entries.removeTranslation(id, locale, user);
  }

  @RequirePermissions('entries.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.entries.get(id);
  }

  @RequirePermissions('entries.write')
  @Post()
  create(@Body() dto: SaveEntryDto, @CurrentUser() user: AuthUser) {
    return this.entries.save(undefined, dto, user);
  }

  @RequirePermissions('entries.write')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveEntryDto, @CurrentUser() user: AuthUser) {
    return this.entries.save(id, dto, user);
  }
}

// ============================================================================ Public

@Controller('public')
export class PublicContentController {
  constructor(
    private readonly content: ContentPublicService,
    private readonly terms: ContentTermsService,
  ) {}

  @Public()
  @Get('content-types')
  types(@Query('locale') locale?: string) {
    return this.content.publicTypes(locale);
  }

  @Public()
  @Get('entries')
  list(@Query() q: PublicEntryQueryDto, @Req() req: Request) {
    // lọc theo trường tuỳ chỉnh ?cf[key]=value (đọc từ query thô vì whitelist bỏ key lạ)
    return this.content.list({ ...q, cf: parseCfQuery(req.query) });
  }

  @Public()
  @Get('entries/:type/:slug')
  detail(@Param('type') type: string, @Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.content.detail(type, slug, locale);
  }

  @Public()
  @Get('taxonomies/:key/terms')
  terms_(@Param('key') key: string, @Query() q: PublicTermsQueryDto) {
    return this.terms.publicList(key, q.locale, q.type);
  }

  @Public()
  @Get('terms/:taxonomy/:slug')
  term(@Param('taxonomy') taxonomy: string, @Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.terms.publicBySlug(taxonomy, slug, locale);
  }

  @Public()
  @Get('resolve')
  resolve(@Query('path') path?: string, @Query('locale') locale?: string) {
    return this.content.resolve(path ?? '', locale);
  }
}
