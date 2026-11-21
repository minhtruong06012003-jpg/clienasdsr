import { Module } from '@nestjs/common';
import { ThemeTemplatesService } from './theme-templates.service.js';
import { ThemeCapabilitiesService } from './theme-capabilities.service.js';
import { WidgetAreasService } from './widget-areas.service.js';
import { PublicThemeTemplatesController, StorefrontStatusController, ThemeTemplatesController, WidgetAreasController } from './theme-templates.controller.js';

/**
 * Theme Builder (mẫu single / archive / header / footer...) + vùng widget.
 * TemplateContextService (dựng record/listing) được cung cấp bởi BlocksModule (global) — xem blocks.module.ts.
 * Kèm endpoint tình trạng storefront (theme, block hỗ trợ) cho Công cụ và Page Builder.
 */
@Module({
  controllers: [ThemeTemplatesController, PublicThemeTemplatesController, WidgetAreasController, StorefrontStatusController],
  providers: [ThemeTemplatesService, ThemeCapabilitiesService, WidgetAreasService],
  exports: [ThemeTemplatesService, ThemeCapabilitiesService],
})
export class ThemeTemplatesModule {}
