import { Global, Module } from '@nestjs/common';
import { AccountAffiliateController, AdminAffiliateController } from './affiliate.controller.js';
import { AffiliateService } from './affiliate.service.js';

/** Tiếp thị liên kết. Global để AuthService gắn người giới thiệu khi đăng ký. */
@Global()
@Module({
  controllers: [AccountAffiliateController, AdminAffiliateController],
  providers: [AffiliateService],
  exports: [AffiliateService],
})
export class AffiliateModule {}
