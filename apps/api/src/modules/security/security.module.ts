import { Global, Module } from '@nestjs/common';
import { CaptchaService } from './captcha.service.js';
import { IpRulesService } from './ip-rules.service.js';
import { LoginAuditService } from './login-audit.service.js';
import { LoginProtectionService } from './login-protection.service.js';
import { PasswordPolicyService } from './password-policy.service.js';
import { SecurityCenterController } from './security-center.controller.js';
import { SessionsService } from './sessions.service.js';
import { TwoFactorService } from './two-factor.service.js';

/**
 * Module bảo mật: captcha cho form công khai, xác thực 2 bước (TOTP), danh sách phiên đăng nhập,
 * Trung tâm bảo mật (nhật ký đăng nhập, quy tắc IP, chống dò mật khẩu theo IP, chính sách mật khẩu).
 * Global để auth / users / forms / reviews / comments dùng trực tiếp không cần import.
 */
@Global()
@Module({
  controllers: [SecurityCenterController],
  providers: [CaptchaService, TwoFactorService, SessionsService, IpRulesService, LoginAuditService, LoginProtectionService, PasswordPolicyService],
  exports: [CaptchaService, TwoFactorService, SessionsService, IpRulesService, LoginAuditService, LoginProtectionService, PasswordPolicyService],
})
export class SecurityModule {}
