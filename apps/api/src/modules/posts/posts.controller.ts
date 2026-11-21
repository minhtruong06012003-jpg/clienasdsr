import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { parseCfQuery } from '../custom-fields/cf-query.util.js';
import { IsArray, IsIn, IsUUID } from 'class-validator';
import { ReorderDto } from '../../common/dto/reorder.dto.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { PostsService } from './posts.service.js';
import { PostTermsService } from './terms.service.js';
import { PostQueryDto, PublicPostQueryDto, SavePostDto, SaveTermDto } from './posts.dto.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

class BulkDto {
  @IsArray() @IsUUID('all', { each: true }) ids: string[];
  @IsIn(['trash', 'restore', 'publish', 'draft', 'destroy']) action: 'trash' | 'restore' | 'publish' | 'draft' | 'destroy';
}

@Controller('admin/posts')
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly terms: PostTermsService,
  ) {}

  // ---- taxonomy (khai báo trước route :id) ----
  @RequirePermissions('posts.read')
  @Get('categories')
  categories() {
    return this.terms.categories();
  }

  @RequirePermissions('posts.taxonomy')
  @Post('categories')
  createCategory(@Body() dto: SaveTermDto, @CurrentUser() user: AuthUser) {
    return this.terms.saveCategory(undefined, dto, user);
  }

  @RequirePermissions('posts.taxonomy')
  @Post('categories/reorder')
  reorder(@Body() dto: ReorderDto) {
    return this.terms.reorderCategories(dto.items);
  }

  @RequirePermissions('posts.read')
  @Get('categories/:id')
  category(@Param('id', ParseUUIDPipe) id: string) {
    return this.terms.category(id);
  }

  @RequirePermissions('posts.taxonomy')
  @Patch('categories/:id')
  updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTermDto, @CurrentUser() user: AuthUser) {
    return this.terms.saveCategory(id, dto, user);
  }

  @RequirePermissions('posts.taxonomy')
  @Delete('categories/:id')
  removeCategory(@Param('id', ParseUUIDPipe) id: string) {
    return this.terms.removeCategory(id);
  }

  @RequirePermissions('posts.read')
  @Get('tags')
  tags(@Query() q: PaginationQueryDto) {
    return this.terms.tags(q);
  }

  @RequirePermissions('posts.taxonomy')
  @Post('tags')
  createTag(@Body() dto: SaveTermDto) {
    return this.terms.saveTag(undefined, dto);
  }

  @RequirePermissions('posts.taxonomy')
  @Patch('tags/:id')
  updateTag(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveTermDto) {
    return this.terms.saveTag(id, dto);
  }

  @RequirePermissions('posts.taxonomy')
  @Delete('tags/:id')
  removeTag(@Param('id', ParseUUIDPipe) id: string) {
    return this.terms.removeTag(id);
  }

  // ---- posts ----
  @RequirePermissions('posts.read')
  @Get()
  list(@Query() q: PostQueryDto) {
    return this.posts.list(q);
  }

  @RequirePermissions('posts.write')
  @Post('bulk')
  bulk(@Body() dto: BulkDto, @CurrentUser() user: AuthUser) {
    return this.posts.bulk(dto.ids, dto.action, user);
  }

  // ---- lịch sử phiên bản (khai báo 'revisions/:revisionId' trước ':id') ----
  @RequirePermissions('posts.read')
  @Get('revisions/:revisionId')
  revision(@Param('revisionId', ParseUUIDPipe) revisionId: string) {
    return this.posts.revision(revisionId);
  }

  @RequirePermissions('posts.read')
  @Get(':id/revisions')
  revisions(@Param('id', ParseUUIDPipe) id: string, @Query('locale') locale?: string) {
    return this.posts.revisions(id, locale);
  }

  @RequirePermissions('posts.write')
  @Post(':id/revisions/:revisionId/restore')
  restoreRevision(@Param('id', ParseUUIDPipe) id: string, @Param('revisionId', ParseUUIDPipe) revisionId: string, @CurrentUser() user: AuthUser) {
    return this.posts.restoreRevision(id, revisionId, user);
  }

  // ---- thùng rác từng bài ----
  @RequirePermissions('posts.delete')
  @Post(':id/trash')
  trash(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.posts.trash(id, user);
  }

  @RequirePermissions('posts.delete')
  @Post(':id/restore')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.posts.restore(id, user);
  }

  @RequirePermissions('posts.delete')
  @Delete(':id')
  destroy(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.posts.destroy(id, user);
  }

  @RequirePermissions('posts.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.posts.get(id);
  }

  @RequirePermissions('posts.write')
  @Post()
  create(@Body() dto: SavePostDto, @CurrentUser() user: AuthUser) {
    return this.posts.save(undefined, dto, user);
  }

  @RequirePermissions('posts.write')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SavePostDto, @CurrentUser() user: AuthUser) {
    return this.posts.save(id, dto, user);
  }

  @RequirePermissions('posts.write')
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.posts.duplicate(id, user);
  }

  @RequirePermissions('posts.write')
  @Delete(':id/translations/:locale')
  removeTranslation(@Param('id', ParseUUIDPipe) id: string, @Param('locale') locale: string) {
    return this.posts.removeTranslation(id, locale);
  }
}

@Controller('public')
@RequireFeature('blog')
export class PublicPostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly terms: PostTermsService,
  ) {}

  @Public()
  @Get('posts')
  list(@Query() q: PublicPostQueryDto, @Req() req: Request) {
    // lọc theo trường tuỳ chỉnh ?cf[key]=value (đọc từ query thô vì whitelist bỏ key lạ)
    return this.posts.publicList({ ...q, cf: parseCfQuery(req.query) });
  }

  /** Chi tiết bài theo slug. Có thể được CDN cache nên KHÔNG tăng lượt xem (dùng POST posts/:id/view). */
  @Public()
  @Get('posts/:slug')
  get(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.posts.publicBySlug(slug, locale);
  }

  /**
   * Đếm 1 lượt xem bài, frontend gọi từ TRÌNH DUYỆT sau khi trang hiển thị (không gọi trong SSR / bot).
   * Không cache (interceptor gắn `private, no-store` cho method ghi), 30 lần/phút/IP, chống trùng IP + bài trong 30 phút.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('posts/:id/view')
  @HttpCode(200)
  view(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.posts.registerView(id, req.ip ?? '');
  }

  @Public()
  @Get('post-categories')
  categories(@Query('locale') locale?: string) {
    return this.terms.publicCategories(locale);
  }

  @Public()
  @Get('post-categories/:slug')
  category(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.terms.publicCategory(slug, locale);
  }

  @Public()
  @Get('post-tags/:slug')
  tag(@Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.terms.publicTag(slug, locale);
  }
}
