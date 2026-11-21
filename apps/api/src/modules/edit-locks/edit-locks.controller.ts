import { Body, Controller, Delete, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { IgnoreAuthHeader, Public } from '../../common/decorators/public.decorator.js';
import { EditLockParamsDto, ReleaseBeaconDto } from './edit-locks.dto.js';
import { EditLocksService } from './edit-locks.service.js';

/**
 * Khoá chỉnh sửa đồng thời cho trình soạn admin.
 * - POST   /admin/edit-locks/:entity/:id          giữ/gia hạn 60 giây (người khác giữ → `{ locked: true, by, expiresAt }`)
 * - POST   /admin/edit-locks/:entity/:id/takeover giành quyền sửa
 * - DELETE /admin/edit-locks/:entity/:id          nhả khoá
 * - POST   /admin/edit-locks/:entity/:id/release  nhả khoá bằng releaseToken (navigator.sendBeacon khi đóng tab)
 */
@Controller('admin/edit-locks')
export class EditLocksController {
  constructor(private readonly locks: EditLocksService) {}

  @RequirePermissions('admin.access')
  @Post(':entity/:id')
  @HttpCode(200)
  acquire(@Param() p: EditLockParamsDto, @CurrentUser() user: AuthUser) {
    return this.locks.acquire(p.entity, p.id, user);
  }

  @RequirePermissions('admin.access')
  @Post(':entity/:id/takeover')
  @HttpCode(200)
  takeover(@Param() p: EditLockParamsDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.locks.takeover(p.entity, p.id, user, req.ip);
  }

  @RequirePermissions('admin.access')
  @Delete(':entity/:id')
  release(@Param() p: EditLockParamsDto, @CurrentUser() user: AuthUser) {
    return this.locks.release(p.entity, p.id, user);
  }

  /** Nhả khoá khi đóng tab: sendBeacon không gửi được Authorization nên xác thực bằng releaseToken trong body */
  @Public()
  @IgnoreAuthHeader()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':entity/:id/release')
  @HttpCode(200)
  releaseBeacon(@Param() p: EditLockParamsDto, @Body() dto: ReleaseBeaconDto) {
    return this.locks.releaseWithToken(p.entity, p.id, dto.token);
  }
}
