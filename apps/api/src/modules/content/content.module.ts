import { Module } from '@nestjs/common';
import { ContentPublicService } from './content-public.service.js';
import { ContentMetaService } from './content-meta.service.js';
import { ContentTypesService } from './content-types.service.js';
// đồng bộ loại nội dung khai báo trong config/content-types.config.ts lúc khởi động
import { ContentTypesSyncService } from './content-types-sync.service.js';
import { ContentTermsService } from './content-terms.service.js';
import { EntriesService } from './entries.service.js';
import { EntriesScheduledService } from './entries-scheduled.service.js';
import { ContentTypesController, EntriesController, PublicContentController, TaxonomiesController } from './content.controller.js';

/**
 * Loại nội dung tuỳ biến (Custom Post Type) + Taxonomy + Entry.
 * - Admin: /admin/content-types, /admin/taxonomies, /admin/terms, /admin/entries
 * - Public: /public/content-types, /public/entries, /public/taxonomies/:key/terms, /public/terms/:tax/:slug, /public/resolve
 * CustomFieldsService và BlockResolverService là provider global nên không cần import module.
 */
@Module({
  controllers: [ContentTypesController, TaxonomiesController, EntriesController, PublicContentController],
  providers: [ContentPublicService, ContentMetaService, ContentTypesService, ContentTypesSyncService, ContentTermsService, EntriesService, EntriesScheduledService],
  exports: [ContentPublicService, ContentMetaService, ContentTermsService, EntriesService],
})
export class ContentModule {}
