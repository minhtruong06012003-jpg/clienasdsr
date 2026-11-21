import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { AccountAiController, AdminAiController, PublicAiCategoriesController, PublicAiCommunityController, PublicAiController, PublicAiDownloadController, PublicAiOutputController, PublicAiVoicePreviewController } from './ai.controller.js';
import { AdminAiModelApiController, AiModelApiController } from './ai-model-api.controller.js';
import { AiModelApiService } from './ai-model-api.service.js';
import { AiCleanupService } from './ai-cleanup.service.js';
import { AiFilesService } from './ai-files.service.js';
import { AiCategoriesService } from './ai-categories.service.js';
import { AiService } from './ai.service.js';
import { TavtavvideoBridgeService } from './tavtavvideo-bridge.service.js';
import { TavtavvideoWorkerController } from './tavtavvideo-worker.controller.js';
import { PublicAiTikTokController } from './tiktok-downloader.controller.js';
import { PublicAiBulkDownloadController } from './bulk-downloader.controller.js';

/** AI Studio: công cụ AI theo adapter nhà cung cấp (providers/), tác vụ, trừ / hoàn credits */
@Module({
  imports: [MediaModule],
  controllers: [PublicAiController, PublicAiVoicePreviewController, PublicAiOutputController, PublicAiDownloadController, PublicAiCategoriesController, PublicAiCommunityController, PublicAiTikTokController, PublicAiBulkDownloadController, AccountAiController, AdminAiController, AiModelApiController, AdminAiModelApiController, TavtavvideoWorkerController],
  providers: [AiService, AiModelApiService, AiFilesService, AiCategoriesService, AiCleanupService, TavtavvideoBridgeService],
  exports: [AiService],
})
export class AiModule {}
