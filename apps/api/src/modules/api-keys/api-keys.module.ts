import { Global, Module } from '@nestjs/common';
import { AccountApiKeysController, ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { ApiKeyAuthService } from './api-key-auth.service.js';

/** Module API key: @Global để guard toàn cục (JwtAuthGuard) inject được ApiKeyAuthService */
@Global()
@Module({
  controllers: [ApiKeysController, AccountApiKeysController],
  providers: [ApiKeysService, ApiKeyAuthService],
  exports: [ApiKeyAuthService],
})
export class ApiKeysModule {}
