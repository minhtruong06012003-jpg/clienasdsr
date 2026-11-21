import { BadRequestException, Injectable } from '@nestjs/common';
import { checkPassword, readPasswordPolicy, type PasswordPolicy } from '@cmsnt/shared';
import { SettingsService } from '../settings/settings.service.js';

/** Chính sách mật khẩu (Cài đặt › Bảo mật) — kiểm tra mọi lần đặt mật khẩu mới */
@Injectable()
export class PasswordPolicyService {
  constructor(private readonly settings: SettingsService) {}

  async policy(): Promise<PasswordPolicy> {
    return readPasswordPolicy(await this.settings.get('security'));
  }

  /** Ném 400 kèm danh sách điều kiện chưa đạt nếu mật khẩu không hợp chính sách */
  async assert(password: string, ctx: { email?: string | null; name?: string | null } = {}) {
    const errors = checkPassword(password, await this.policy(), ctx);
    if (errors.length) throw new BadRequestException(`Mật khẩu chưa đạt yêu cầu: ${errors.join(', ')}`);
  }
}
