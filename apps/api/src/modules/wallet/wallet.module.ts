import { Global, Module } from '@nestjs/common';
import { AccountWalletController, AdminWalletController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';

/** Ví thành viên. Global để OrdersService (checkout) và OrdersAdminService (hoàn tiền) dùng chung. */
@Global()
@Module({
  controllers: [AdminWalletController, AccountWalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
