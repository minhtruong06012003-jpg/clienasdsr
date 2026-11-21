import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, StreamableFile } from '@nestjs/common';
import { Equals, IsBoolean, IsOptional } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { BackupService } from './backup.service.js';
import { DenyApiKey } from '../api-keys/deny-api-key.decorator.js';

class CreateBackupDto {
  @IsOptional() @IsBoolean() includeUploads?: boolean;
}

class RestoreDto {
  @Equals('RESTORE', { message: 'Cần xác nhận bằng chuỗi RESTORE' }) confirm: 'RESTORE';
}

/** Sao lưu / khôi phục database và uploads (Công cụ › Sao lưu) */
@Controller('admin/tools/backups')
@RequirePermissions('settings.manage')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get()
  async list() {
    const [data, pgDump, settings, writable] = await Promise.all([this.backup.list(), this.backup.pgDumpStatus(), this.backup.getSettings(), this.backup.writable()]);
    return { data, dir: this.backup.dir, pgDump, settings, writable };
  }

  /** Đưa vào hàng đợi job backup.create, trả jobId để theo dõi */
  @Post()
  async create(@Body() dto: CreateBackupDto, @CurrentUser() user: AuthUser) {
    const pg = await this.backup.pgDumpStatus();
    if (!pg.ok) throw new BadRequestException(`${pg.error}. Cài postgresql-client trên máy chủ API hoặc đặt BACKUP_CMD.`);
    if (!(await this.backup.writable())) throw new BadRequestException(`Không ghi được thư mục sao lưu ${this.backup.dir}`);
    return this.backup.enqueue({ includeUploads: !!dto.includeUploads, actorId: user.id });
  }

  @Get('jobs/:id')
  job(@Param('id') id: string) {
    return this.backup.jobStatus(id);
  }

  // Bản sao lưu chứa hash mật khẩu + secret 2FA của mọi tài khoản; khôi phục ghi đè toàn bộ DB
  // -> chỉ siêu quản trị ('*'), không chỉ settings.manage. Không cho dùng API key.
  @RequirePermissions('*')
  @DenyApiKey()
  @Get(':name/download')
  async download(@Param('name') name: string) {
    const f = await this.backup.download(name);
    return new StreamableFile(f.stream, { type: 'application/gzip', disposition: `attachment; filename="${f.name}"`, length: f.size });
  }

  @Delete(':name')
  remove(@Param('name') name: string, @CurrentUser() user: AuthUser) {
    return this.backup.remove(name, user.id);
  }

  @RequirePermissions('*')
  @DenyApiKey()
  @Post(':name/restore')
  @HttpCode(200)
  restore(@Param('name') name: string, @Body() _dto: RestoreDto, @CurrentUser() user: AuthUser) {
    return this.backup.restore(name, user.id);
  }
}
