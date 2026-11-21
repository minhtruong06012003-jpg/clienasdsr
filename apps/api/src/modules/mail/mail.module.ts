import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service.js';
import { MailQueueService } from './mail-queue.service.js';
import { EmailTemplatesService } from './email-templates.service.js';
import { EmailLogsController, EmailTemplatesController } from './email-templates.controller.js';

@Global()
@Module({
  controllers: [EmailTemplatesController, EmailLogsController],
  // MailQueueService: worker gửi nền các email trong hàng chờ (email_logs.status = QUEUED)
  providers: [MailService, MailQueueService, EmailTemplatesService],
  exports: [MailService, MailQueueService, EmailTemplatesService],
})
export class MailModule {}
