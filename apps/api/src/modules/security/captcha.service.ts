import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service.js';

export type CaptchaProvider = 'none' | 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha';
export type CaptchaScope = 'forms' | 'register' | 'review' | 'comment';

export interface SecuritySettings {
  captchaProvider?: CaptchaProvider;
  captchaSiteKey?: string;
  captchaSecretKey?: string;
  captchaOn?: CaptchaScope[];
  recaptchaMinScore?: number;
  maxFailedLogins?: number;
  lockoutMinutes?: number;
  require2faForAdmins?: boolean;
  ipProtection?: boolean;
  ipMaxFailures?: number;
  ipWindowMinutes?: number;
  ipBlockMinutes?: number;
  adminIpAllowlist?: boolean;
  adminIdleTimeoutMinutes?: number;
  adminSessionMaxHours?: number;
  /** false = mỗi tài khoản quản trị chỉ giữ 1 phiên, đăng nhập mới đăng xuất thiết bị khác */
  adminAllowConcurrentSessions?: boolean;
  /** email cảnh báo thiết bị mới: off | admins | all */
  newDeviceAlert?: 'off' | 'admins' | 'all';
  notifyOnLockout?: boolean;
  loginLogRetentionDays?: number;
}

const VERIFY_URL: Record<Exclude<CaptchaProvider, 'none'>, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  'recaptcha-v2': 'https://www.google.com/recaptcha/api/siteverify',
  'recaptcha-v3': 'https://www.google.com/recaptcha/api/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
};

interface VerifyResponse {
  success?: boolean;
  score?: number;
  action?: string;
  'error-codes'?: string[];
}

/** Xác minh captcha (Cloudflare Turnstile / Google reCAPTCHA v2-v3 / hCaptcha) cho các form công khai */
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);

  constructor(private readonly settings: SettingsService) {}

  /** Cấu hình công khai cho storefront (không có secret) */
  async publicConfig() {
    const cfg = await this.settings.get<SecuritySettings>('security');
    const provider = this.provider(cfg);
    return { provider, siteKey: provider === 'none' ? '' : (cfg.captchaSiteKey ?? '').trim(), on: provider === 'none' ? [] : (cfg.captchaOn ?? []) };
  }

  private provider(cfg: SecuritySettings): CaptchaProvider {
    const p = cfg.captchaProvider ?? 'none';
    if (p === 'none' || !cfg.captchaSiteKey?.trim() || !cfg.captchaSecretKey?.trim()) return 'none';
    return p;
  }

  /**
   * Kiểm tra token captcha cho `scope`. Bỏ qua nếu chưa cấu hình provider hoặc scope không bật.
   * Sai / thiếu / không gọi được dịch vụ -> BadRequest "Xác minh captcha thất bại".
   */
  async assert(token: unknown, ip: string | undefined, scope: CaptchaScope): Promise<void> {
    const cfg = await this.settings.get<SecuritySettings>('security');
    const provider = this.provider(cfg);
    if (provider === 'none' || !(cfg.captchaOn ?? []).includes(scope)) return;
    const value = typeof token === 'string' ? token.trim() : '';
    if (!value) throw new BadRequestException('Vui lòng xác minh captcha');

    const body = new URLSearchParams({ secret: cfg.captchaSecretKey!.trim(), response: value });
    if (ip) body.set('remoteip', ip);
    let data: VerifyResponse;
    try {
      const res = await fetch(VERIFY_URL[provider], {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(8000),
      });
      data = (await res.json()) as VerifyResponse;
    } catch (err) {
      this.logger.warn(`Không gọi được dịch vụ captcha ${provider}: ${(err as Error).message}`);
      throw new BadRequestException('Xác minh captcha thất bại');
    }
    if (!data.success) {
      this.logger.debug(`Captcha ${provider} từ chối (${scope}): ${(data['error-codes'] ?? []).join(', ')}`);
      throw new BadRequestException('Xác minh captcha thất bại');
    }
    if (provider === 'recaptcha-v3') {
      const min = Number(cfg.recaptchaMinScore ?? 0.5);
      if (typeof data.score === 'number' && data.score < min) throw new BadRequestException('Xác minh captcha thất bại');
      if (data.action && data.action !== scope) throw new BadRequestException('Xác minh captcha thất bại');
    }
  }
}
