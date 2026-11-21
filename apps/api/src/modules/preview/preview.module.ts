import { Module } from '@nestjs/common';
import { PagesModule } from '../pages/pages.module.js';
import { PostsModule } from '../posts/posts.module.js';
import { ProductsModule } from '../products/products.module.js';
import { ContentModule } from '../content/content.module.js';
import { PreviewController, PublicPreviewController } from './preview.controller.js';
import { PreviewService } from './preview.service.js';

/** Xem trước bản nháp bằng token ngắn hạn: POST /admin/preview/token, GET /public/preview/:type/:id */
@Module({
  imports: [PagesModule, PostsModule, ProductsModule, ContentModule],
  controllers: [PreviewController, PublicPreviewController],
  providers: [PreviewService],
})
export class PreviewModule {}
