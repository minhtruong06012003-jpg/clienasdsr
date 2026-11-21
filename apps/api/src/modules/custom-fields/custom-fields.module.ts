import { Global, Module } from '@nestjs/common';
import { CustomFieldsController, PublicCustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';

/**
 * Trường tuỳ chỉnh (giống ACF). Global để các module nội dung (pages, posts, products, users, taxonomy)
 * dùng được mà không cần import lẫn nhau.
 */
@Global()
@Module({
  controllers: [CustomFieldsController, PublicCustomFieldsController],
  providers: [CustomFieldsService],
  exports: [CustomFieldsService],
})
export class CustomFieldsModule {}
