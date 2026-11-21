import { Global, Module } from '@nestjs/common';
import { AccountCreditsController, AdminCreditsController, AdminUserCreditsController, PublicPlansController } from './credits.controller.js';
import { CreditsService } from './credits.service.js';

/** Credits + gói cước (chiết khấu khi nâng cấp gói). Global để module AI trừ / hoàn credits khi chạy tác vụ. */
@Global()
@Module({
  controllers: [PublicPlansController, AccountCreditsController, AdminCreditsController, AdminUserCreditsController],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
