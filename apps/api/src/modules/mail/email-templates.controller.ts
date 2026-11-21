import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { EmailTemplatesService } from './email-templates.service.js';
import { EmailLogQueryDto, PreviewEmailTemplateDto, TestEmailTemplateDto, ToggleEmailTemplateDto, UpsertEmailTemplateDto } from './mail.dto.js';

@Controller('admin/email-templates')
@RequirePermissions('settings.emails')
export class EmailTemplatesController {
  constructor(private readonly service: EmailTemplatesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':key')
  get(@Param('key') key: string, @Query('locale') locale?: string) {
    return this.service.get(key, locale);
  }

  @Put(':key')
  upsert(@Param('key') key: string, @Body() dto: UpsertEmailTemplateDto) {
    return this.service.upsert(key, dto);
  }

  @Patch(':key/enabled')
  toggle(@Param('key') key: string, @Body() dto: ToggleEmailTemplateDto) {
    return this.service.toggle(key, dto.enabled);
  }

  @Delete(':key')
  reset(@Param('key') key: string, @Query('locale') locale?: string) {
    return this.service.reset(key, locale);
  }

  @Post(':key/preview')
  @HttpCode(200)
  preview(@Param('key') key: string, @Body() dto: PreviewEmailTemplateDto) {
    return this.service.preview(key, dto);
  }

  @Post(':key/test')
  @HttpCode(200)
  test(@Param('key') key: string, @Body() dto: TestEmailTemplateDto) {
    return this.service.sendTest(key, dto);
  }
}

@Controller('admin/email-logs')
@RequireAnyPermission('settings.emails', 'settings.mail')
export class EmailLogsController {
  constructor(private readonly service: EmailTemplatesService) {}

  @Get()
  list(@Query() q: EmailLogQueryDto) {
    return this.service.logs(q);
  }

  /** Số liệu hàng chờ gửi (đang chờ, đang gửi, đã gửi/thất bại 24h, cấu hình tốc độ) */
  @Get('queue/stats')
  queueStats() {
    return this.service.queueStats();
  }

  /** Đưa mọi email thất bại 7 ngày gần đây trở lại hàng chờ */
  @Post('queue/retry-failed')
  @HttpCode(200)
  retryFailed() {
    return this.service.retryFailed();
  }

  /** Huỷ toàn bộ email đang chờ gửi */
  @Post('queue/cancel-all')
  @HttpCode(200)
  cancelAll() {
    return this.service.cancelAllQueued();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.log(id);
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.resend(id);
  }

  /** Huỷ một email còn trong hàng chờ */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(id);
  }
}
