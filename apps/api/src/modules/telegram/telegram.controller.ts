import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { hasPermission } from '@cmsnt/shared';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequireAnyPermission, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { getMe } from './telegram.api.js';
import { ProviderBalanceMonitor } from './provider-balance.monitor.js';
import { parseChatIds, TelegramService } from './telegram.service.js';

class TelegramPrefsDto {
  /** { taskSucceeded: false, ... } — khoá lạ bị bỏ qua ở service */
  @IsObject() events: Record<string, boolean>;
}

class TelegramTestDto {
  @IsIn(['user', 'admin']) bot: 'user' | 'admin';
}

class BalanceQueryDto {
  @IsOptional() @IsIn(['true', 'false', '1', '0']) refresh?: string;
}

/** Khách: liên kết bot Telegram ở trang Tài khoản, chọn loại thông báo */
@Controller('account/telegram')
export class AccountTelegramController {
  constructor(private readonly tg: TelegramService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.tg.myStatus(user.id);
  }

  /** Link `t.me/<bot>?start=<mã>` (hết hạn 30 phút) */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('link')
  @HttpCode(200)
  link(@CurrentUser() user: AuthUser) {
    return this.tg.createLink(user.id);
  }

  @Put('prefs')
  prefs(@CurrentUser() user: AuthUser, @Body() dto: TelegramPrefsDto) {
    return this.tg.updatePrefs(user.id, dto.events);
  }

  @Delete()
  unlink(@CurrentUser() user: AuthUser) {
    return this.tg.unlink(user.id);
  }
}

/** Admin: trạng thái hai bot, gửi tin thử, số dư nguồn API (Cài đặt › Bot Telegram) */
@Controller('admin/telegram')
@RequireAnyPermission('settings.telegram_user', 'settings.telegram_admin')
export class AdminTelegramController {
  constructor(
    private readonly tg: TelegramService,
    private readonly balances: ProviderBalanceMonitor,
  ) {}

  /** Kiểm tra token (getMe), lỗi vòng nhận lệnh, số khách đã liên kết */
  @Get('status')
  async status() {
    const [u, a, linked] = await Promise.all([this.tg.userSettings(), this.tg.adminSettings(), this.tg.linkedCount()]);
    const probe = async (token?: string) => {
      if (!token?.trim()) return { ok: false, error: 'Chưa nhập token' };
      try {
        const me = await getMe(token.trim());
        return { ok: true, username: me.username, name: me.first_name };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    };
    const [ub, ab] = await Promise.all([probe(u.botToken), probe(a.botToken)]);
    return {
      polling: this.tg.pollingEnabled,
      user: { enabled: !!u.enabled, ...ub, pollError: this.tg.pollErrors.user, linkedUsers: linked },
      admin: { enabled: !!a.enabled, ...ab, pollError: this.tg.pollErrors.admin, chats: parseChatIds(a.chatIds).length, sharedToken: !!a.botToken && a.botToken.trim() === u.botToken?.trim() },
    };
  }

  /** Gửi tin thử: bot admin -> mọi chat đã khai báo; bot khách -> chat Telegram của chính admin (nếu đã liên kết) */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser, @Body() dto: TelegramTestDto) {
    const need = dto.bot === 'admin' ? 'settings.telegram_admin' : 'settings.telegram_user';
    if (!hasPermission(user.permissions, need)) throw new ForbiddenException('Bạn không có quyền gửi thử bot này');
    return this.tg.sendTest(dto.bot, user.id);
  }

  /** Số dư các nguồn API (lần kiểm tra gần nhất; `refresh=true` đọc lại ngay) */
  @RequirePermissions('settings.telegram_admin')
  @Get('balances')
  balancesList(@Query() q: BalanceQueryDto) {
    return this.balances.snapshot(q.refresh === 'true' || q.refresh === '1');
  }
}
