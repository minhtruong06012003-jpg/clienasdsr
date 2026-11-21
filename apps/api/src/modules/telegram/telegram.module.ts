import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AccountTelegramController, AdminTelegramController } from './telegram.controller.js';
import { TelegramListener } from './telegram.listener.js';
import { TelegramService } from './telegram.service.js';
import { ProviderBalanceMonitor } from './provider-balance.monitor.js';
import { ProviderCatalogMonitor } from './provider-catalog.monitor.js';

/**
 * Bot Telegram: bot báo khách (liên kết ở trang Tài khoản) và bot báo quản trị
 * (sự kiện hệ thống + cảnh báo số dư nguồn API AI hết tiền / chạm ngưỡng + nguồn thêm / gỡ model). Cấu hình ở nhóm `telegram_user` / `telegram_admin`.
 */
@Module({
  imports: [AiModule],
  controllers: [AccountTelegramController, AdminTelegramController],
  providers: [TelegramService, TelegramListener, ProviderBalanceMonitor, ProviderCatalogMonitor],
  exports: [TelegramService],
})
export class TelegramModule {}
