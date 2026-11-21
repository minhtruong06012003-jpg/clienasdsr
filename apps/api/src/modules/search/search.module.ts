import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FeatureGuard } from '../../common/guards/feature.guard.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/**
 * Tìm kiếm toàn website tiếng Việt không dấu (unaccent, lùi về ILIKE) + guard toàn cục công tắc tính năng
 * (@RequireFeature — đăng ký APP_GUARD tại đây vì app.module không thuộc phạm vi module này).
 */
@Module({
  controllers: [SearchController],
  providers: [SearchService, { provide: APP_GUARD, useClass: FeatureGuard }],
  exports: [SearchService],
})
export class SearchModule {}
