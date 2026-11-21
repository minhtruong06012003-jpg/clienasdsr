import { Global, Module } from '@nestjs/common';
import { HooksService } from './hooks.service.js';

/** Bus hook nội bộ (action/filter) dùng chung cho mọi module — Global để không phải import ở từng module */
@Global()
@Module({
  providers: [HooksService],
  exports: [HooksService],
})
export class HooksModule {}
