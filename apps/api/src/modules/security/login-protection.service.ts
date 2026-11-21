import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isPrivateIp, normalizeIp } from '@cmsnt/shared';
import { SettingsService } from '../settings/settings.service.js';
import { IpRulesService } from './ip-rules.service.js';
import { LoginAuditService } from './login-audit.service.js';

interface ProtectionSettings {
  ipProtection?: boolean;
  ipMaxFailures?: number;
  ipWindowMinutes?: number;
  ipBlockMinutes?: number;
  notifyOnLockout?: boolean;
}

/**
 * Chống dò mật khẩu theo IP (credential stuffing): sau mỗi lượt sai, đếm số lượt sai của IP đó
 * trên MỌI tài khoản trong cửa sổ thời gian; vượt ngưỡng -> tự chặn IP. Khác với khoá tài khoản
 * (theo từng tài khoản), cách này không để kẻ tấn công thử 1 mật khẩu trên hàng nghìn email.
 */
@Injectable()
export class LoginProtectionService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: LoginAuditService,
    private readonly ipRules: IpRulesService,
    private readonly events: EventEmitter2,
  ) {}

  /** Gọi sau khi đã ghi 1 lượt sai vào nhật ký */
  async afterFailure(ipRaw: string | null | undefined) {
    const ip = normalizeIp(ipRaw);
    // IP nội bộ thường là proxy (chưa cấu hình TRUST_PROXY) -> chặn sẽ chặn nhầm mọi người dùng
    if (!ip || isPrivateIp(ip)) return;
    const cfg = await this.settings.get<ProtectionSettings>('security');
    if (cfg.ipProtection === false) return;
    const max = Math.max(3, Number(cfg.ipMaxFailures) || 20);
    const windowMin = Math.max(1, Number(cfg.ipWindowMinutes) || 15);
    const blockMin = Math.max(1, Number(cfg.ipBlockMinutes) || 60);
    const failures = await this.audit.failuresFromIp(ip, windowMin);
    if (failures < max) return;
    const blocked = await this.ipRules.autoBlock(ip, blockMin, `Tự chặn: ${failures} lượt đăng nhập sai trong ${windowMin} phút`);
    if (blocked && cfg.notifyOnLockout !== false) {
      this.events.emit('security.alert', {
        type: 'warning',
        title: `Đã tự chặn IP ${ip}`,
        body: `${failures} lượt đăng nhập sai trong ${windowMin} phút. IP bị chặn ${blockMin} phút.`,
        href: '/security?tab=ips',
      });
    }
  }

  /** Báo quản trị viên khi một tài khoản bị khoá do sai nhiều lần */
  async afterLock(user: { id: string; email: string }, minutes: number, ip?: string | null) {
    const cfg = await this.settings.get<ProtectionSettings>('security');
    if (cfg.notifyOnLockout === false) return;
    this.events.emit('security.alert', {
      type: 'warning',
      title: `Tài khoản ${user.email} bị tạm khoá`,
      body: `Đăng nhập sai nhiều lần${ip ? ` từ IP ${normalizeIp(ip)}` : ''}. Khoá ${minutes} phút.`,
      href: `/users/${user.id}`,
    });
  }
}
