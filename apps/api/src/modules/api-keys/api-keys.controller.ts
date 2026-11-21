import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { ApiKeysService } from './api-keys.service.js';
import { ApiKeysQueryDto, CreateAccountApiKeyDto, CreateApiKeyDto } from './api-keys.dto.js';
import { DenyApiKey } from './deny-api-key.decorator.js';

/**
 * API key cá nhân (Hồ sơ › API key). Mỗi người quản lý key của mình;
 * người có roles.manage xem/thu hồi key của mọi người (`?all=1`).
 * Tạo/thu hồi chỉ bằng phiên đăng nhập, không bằng chính API key.
 */
@Controller('admin/api-keys')
@RequirePermissions('admin.access')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ApiKeysQueryDto) {
    return this.keys.list(user, q);
  }

  @DenyApiKey()
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApiKeyDto, @Req() req: Request) {
    return this.keys.create(user, dto, req.ip);
  }

  @DenyApiKey()
  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.keys.revoke(user, id, req.ip);
  }
}

/** Số API key còn hiệu lực tối đa của một khách (mở rộng 60 luồng/key theo T-420 & T-421) */
const MAX_ACTIVE_KEYS_PER_CUSTOMER = 60;

/**
 * API key của khách (web › API): tích hợp AI Studio vào hệ thống riêng của khách.
 * Key luôn mang quyền của tài khoản; guard chỉ cho key của khách gọi nhóm route AI (isCustomerApiKeyRoute).
 * Chỉ xem/thu hồi key của chính mình; tạo/thu hồi chỉ bằng phiên đăng nhập.
 */
@Controller('account/api-keys')
export class AccountApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ApiKeysQueryDto) {
    return this.keys.list(user, { status: q.status });
  }

  @DenyApiKey()
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAccountApiKeyDto, @Req() req: Request) {
    return this.keys.create(user, { name: dto.name, expiresAt: dto.expiresAt }, req.ip, MAX_ACTIVE_KEYS_PER_CUSTOMER);
  }

  @DenyApiKey()
  @Delete(':id')
  async revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    // chặn người có roles.manage thu hồi key người khác qua route khách: chỉ key của chính mình
    const own = await this.keys.list(user, {});
    if (!own.data.some((k) => k.id === id)) throw new NotFoundException('Không tìm thấy API key');
    return this.keys.revoke(user, id, req.ip);
  }
}
