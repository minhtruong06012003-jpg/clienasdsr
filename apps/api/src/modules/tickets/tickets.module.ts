import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AccountTicketsController, AdminTicketsController, InternalHubTicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';

@Module({
  imports: [AiModule, WalletModule, AuthModule],
  controllers: [AccountTicketsController, AdminTicketsController, InternalHubTicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
