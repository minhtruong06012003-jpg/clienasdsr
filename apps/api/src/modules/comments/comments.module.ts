import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { CommentsService } from './comments.service.js';
import { AdminCommentQueryDto, BulkCommentDto, CreateCommentDto, PublicCommentQueryDto, ReplyCommentDto, UpdateCommentDto } from './comments.dto.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

/** Bình luận bài viết — quản trị (duyệt / trả lời / spam / thùng rác) */
@Controller('admin/comments')
@RequirePermissions('comments.manage')
export class AdminCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(@Query() q: AdminCommentQueryDto) {
    return this.comments.list(q);
  }

  /** Số bình luận theo trạng thái (tab đếm) */
  @Get('counts')
  counts() {
    return this.comments.counts();
  }

  @Post('bulk')
  bulk(@Body() dto: BulkCommentDto, @CurrentUser() user: AuthUser) {
    return this.comments.bulk(dto, user);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCommentDto, @CurrentUser() user: AuthUser) {
    return this.comments.update(id, dto, user);
  }

  @Post(':id/reply')
  reply(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyCommentDto, @CurrentUser() user: AuthUser) {
    return this.comments.reply(id, dto, user);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.comments.remove(id, user);
  }
}

/** Bình luận bài viết — storefront */
@Controller()
@RequireFeature('blog', 'comments')
export class PublicCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Public()
  @Get('public/posts/:id/comments')
  list(@Param('id', ParseUUIDPipe) id: string, @Query() q: PublicCommentQueryDto) {
    return this.comments.publicList(id, q);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('public/posts/:id/comments')
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCommentDto, @CurrentUser() user: AuthUser | undefined, @Req() req: Request) {
    return this.comments.create(id, dto, user, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }
}

@Module({ controllers: [AdminCommentsController, PublicCommentsController], providers: [CommentsService], exports: [CommentsService] })
export class CommentsModule {}
