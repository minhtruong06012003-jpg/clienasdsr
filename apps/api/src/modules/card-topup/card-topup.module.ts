import { Module } from '@nestjs/common';
import { AccountCardTopupController, AdminCardTopupController, PublicCardTopupController } from './card-topup.controller.js';
import { CardTopupService } from './card-topup.service.js';

/**
 * Nạp thẻ cào vào ví thành viên. Cấu hình ở Cài đặt › Cổng thanh toán › Nạp thẻ cào (nhóm cài đặt `card_topup`).
 * Nhà cung cấp đổi thẻ khai báo trong `providers/index.ts`. WalletService / SettingsService / PrismaService là Global.
 */
@Module({
  controllers: [PublicCardTopupController, AccountCardTopupController, AdminCardTopupController],
  providers: [CardTopupService],
})
export class CardTopupModule {}
