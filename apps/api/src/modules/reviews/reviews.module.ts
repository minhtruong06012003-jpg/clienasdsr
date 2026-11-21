import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { ReviewsService } from './reviews.service.js';
import { AdminReviewQueryDto, BulkReviewDto, CreateReviewDto, PublicReviewQueryDto, UpdateReviewDto } from './reviews.dto.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

@Controller('admin/reviews')
@RequirePermissions('reviews.manage')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Query() q: AdminReviewQueryDto) {
    return this.reviews.list(q);
  }

  @Post('bulk')
  bulk(@Body() dto: BulkReviewDto, @CurrentUser() user: AuthUser) {
    return this.reviews.bulk(dto, user);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReviewDto, @CurrentUser() user: AuthUser) {
    return this.reviews.update(id, dto, user);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.reviews.remove(id, user);
  }
}

@Controller()
@RequireFeature('shop', 'reviews')
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get('public/products/:id/reviews')
  list(@Param('id', ParseUUIDPipe) id: string, @Query() q: PublicReviewQueryDto) {
    return this.reviews.publicList(id, q);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('public/products/:id/reviews')
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateReviewDto, @CurrentUser() user: AuthUser | undefined, @Req() req: Request) {
    return this.reviews.create(id, dto, user, req.ip);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('public/reviews/:id/helpful')
  helpful(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.reviews.markHelpful(id, req.ip);
  }

  @RequireFeature('accounts')
  @Get('account/reviewable')
  reviewable(@CurrentUser() user: AuthUser) {
    return this.reviews.reviewable(user.id);
  }
}

@Module({ controllers: [AdminReviewsController, PublicReviewsController], providers: [ReviewsService], exports: [ReviewsService] })
export class ReviewsModule {}
