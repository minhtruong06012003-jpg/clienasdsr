import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { SearchService } from './search.service.js';

class SiteSearchQueryDto {
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  /** all | page | post | product | entry:<key> */
  @IsOptional() @IsString() @Matches(/^(all|page|post|product|entry(:[a-z][a-z0-9_]{0,39})?)$/) type?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
}

/** Tìm kiếm toàn website cho storefront (trang tìm kiếm, ô tìm nhanh) */
@Controller('public')
@RequireFeature('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('site-search')
  siteSearch(@Query() q: SiteSearchQueryDto) {
    return this.search.search(q);
  }
}
