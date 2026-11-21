import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { AuthService, type LoginResult, type SessionMeta } from './auth.service.js';
import { SessionsService } from '../security/sessions.service.js';
import { TRUST_DAYS, TwoFactorService } from '../security/two-factor.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { frontendBaseUrl } from '../../common/utils/frontend-url.js';
import { verifyHubTicket } from '../../common/utils/tenant.js';
import { ChangePasswordDto, Disable2faDto, ForgotPasswordDto, GoogleLoginDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto, TwoFactorCodeDto, UpdateProfileDto, Verify2faDto, VerifyEmailDto } from './auth.dto.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';
import { PasswordPolicyService } from '../security/password-policy.service.js';
import { describePasswordPolicy } from '@cmsnt/shared';

const COOKIE = 'cmsnt_rt';
/** Cookie "tin cậy thiết bị" — bỏ qua bước 2FA trong 30 ngày */
const TRUST_COOKIE = 'cmsnt_2fa_trust';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly twoFactor: TwoFactorService,
    private readonly sessions: SessionsService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly settings: SettingsService,
  ) {}

  private meta(req: Request): SessionMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  /**
   * URL website khách để dựng link trong email. Không tin header Origin (có thể bị giả mạo) — chỉ nhận origin trong whitelist;
   * còn lại dùng địa chỉ cấu hình (WEB_URL / Cài đặt › Chung). Chưa cấu hình -> chuỗi rỗng (nơi gọi bỏ link).
   */
  private async siteUrl(req: Request) {
    const allowed = [this.config.get<string>('web.url'), ...(this.config.get<string[]>('corsOrigins') ?? [])].filter(Boolean) as string[];
    if (allowed.includes(req.headers.origin as string)) return req.headers.origin as string;
    return frontendBaseUrl(this.config, this.settings);
  }

  /** Ngôn ngữ khách đang xem (query `?locale=`), dùng gắn tiền tố ngôn ngữ vào link trong email */
  private reqLocale(req: Request): string | null {
    const q = req.query?.locale;
    return typeof q === 'string' && q.trim() ? q.trim() : null;
  }

  private setCookie(res: Response, token: string, days: number) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('env') === 'production',
      path: '/api/auth',
      maxAge: days * 86400_000,
    });
  }

  private setTrustCookie(res: Response, token: string) {
    res.cookie(TRUST_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get('env') === 'production',
      path: '/api/auth',
      maxAge: TRUST_DAYS * 86400_000,
    });
  }

  /** Đặt cookie refresh cho trang quản trị; trả nguyên kết quả */
  private finishAdmin(res: Response, result: LoginResult) {
    if ('refreshToken' in result) this.setCookie(res, result.refreshToken, result.refreshExpiresInDays);
    return result;
  }

  private isAdminClient(req: Request, fromCookie = false): boolean {
    return fromCookie || req.headers['x-admin-client'] === '1';
  }

  /**
   * Web con: vào admin một chạm từ novai-hub. Hub gửi form POST (vé ký bằng HUB_SSO_SECRET, dùng một lần, hạn 60 giây)
   * -> đặt cookie phiên như đăng nhập admin rồi chuyển về /admin. Web chính không có HUB_SSO_SECRET nên luôn 404.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('hub-sso')
  async hubSso(@Body('t') ticket: string, @Req() req: Request, @Res() res: Response) {
    const email = verifyHubTicket(ticket);
    if (!email) throw new NotFoundException();
    const result = await this.auth.loginFromHub(email, this.meta(req));
    this.setCookie(res, result.refreshToken, result.refreshExpiresInDays);
    return res.redirect(303, '/admin');
  }

  /**
   * Đăng nhập trang quản trị (yêu cầu quyền admin.access).
   * Tài khoản bật 2FA -> `{ requires2fa: true, challenge }` (chưa có token) -> gọi tiếp POST /auth/2fa/verify.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('admin/login')
  @HttpCode(200)
  async adminLogin(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // trả kèm cả cookie httpOnly lẫn refreshToken dự phòng trong localStorage của trang quản trị
    return this.finishAdmin(res, await this.auth.login(dto.email, dto.password, this.meta(req), true, req.cookies?.[TRUST_COOKIE]));
  }

  /** Đăng nhập thành viên (storefront) — KHÔNG ghi đè cookie phiên của trang quản trị */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, this.meta(req), false, req.cookies?.[TRUST_COOKIE]);
  }

  /**
   * Đăng nhập bằng Google cho khách: body `{ idToken }` (credential từ Google Identity Services).
   * KHÔNG ghi đè cookie phiên của trang quản trị.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireFeature('accounts')
  @Post('google')
  @HttpCode(200)
  async google(@Body() dto: GoogleLoginDto, @Req() req: Request) {
    return this.auth.loginWithGoogle(dto.idToken, this.meta(req), req.cookies?.[TRUST_COOKIE], dto.referralCode || dto.ref);
  }

  /** Chính sách mật khẩu hiện hành (công khai) — form đăng ký / đổi mật khẩu hiển thị gợi ý */
  @Public()
  @Get('password-policy')
  async passwordPolicy() {
    const policy = await this.passwordPolicyService.policy();
    return { ...policy, description: describePasswordPolicy(policy) };
  }

  /** Bước 2 đăng nhập: mã TOTP / mã dự phòng + challenge -> cấp token như đăng nhập thường */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('2fa/verify')
  @HttpCode(200)
  async verify2fa(@Body() dto: Verify2faDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.verify2fa(dto.challenge, { code: dto.code, recoveryCode: dto.recoveryCode }, this.meta(req), dto.target === 'admin');
    if (dto.target === 'admin') this.setCookie(res, result.refreshToken, result.refreshExpiresInDays);
    if (dto.remember) this.setTrustCookie(res, await this.twoFactor.issueTrustToken(result.user.id));
    return result;
  }

  // ---- Quản lý 2FA của chính mình (cần đăng nhập) ----

  /** Tạo secret + URL otpauth để vẽ QR (chưa bật cho tới khi xác minh mã) */
  @Post('2fa/setup')
  @HttpCode(200)
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.twoFactor.setup(user.id);
  }

  /** Xác minh mã từ app -> bật 2FA, trả 10 mã dự phòng (chỉ hiển thị 1 lần) */
  @Post('2fa/enable')
  @HttpCode(200)
  enable2fa(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.twoFactor.enable(user.id, dto.code);
  }

  /** Tắt 2FA bằng mã xác thực hoặc mật khẩu; xoá cookie tin cậy thiết bị */
  // nhận mật khẩu hiện tại -> giới hạn chặt để phiên bị lộ không dò được mật khẩu
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('2fa/disable')
  @HttpCode(200)
  async disable2fa(@CurrentUser() user: AuthUser, @Body() dto: Disable2faDto, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(TRUST_COOKIE, { path: '/api/auth' });
    return this.twoFactor.disable(user.id, dto);
  }

  @Post('2fa/recovery-codes/regenerate')
  @HttpCode(200)
  regenerateRecovery(@CurrentUser() user: AuthUser, @Body() dto: TwoFactorCodeDto) {
    return this.twoFactor.regenerateRecoveryCodes(user.id, dto.code);
  }

  // ---- Phiên đăng nhập của chính mình ----

  @Get('sessions')
  async mySessions(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.sessions.list(user.id, await this.auth.currentSessionId(req.headers.authorization));
  }

  /** Thu hồi mọi phiên khác (giữ phiên hiện tại) */
  @Delete('sessions')
  async revokeOtherSessions(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.sessions.revokeOthers(user.id, await this.auth.currentSessionId(req.headers.authorization));
  }

  @Delete('sessions/:id')
  revokeSession(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.revoke(user.id, id);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequireFeature('accounts')
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, this.meta(req), await this.siteUrl(req), this.reqLocale(req));
  }

  @Public()
  @RequireFeature('accounts')
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    return this.auth.verifyEmail(dto.token, this.meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @RequireFeature('accounts')
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.auth.resendVerification(dto.email, await this.siteUrl(req), this.reqLocale(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const fromCookie = !dto.refreshToken;
    const isAdmin = this.isAdminClient(req, fromCookie);
    if (fromCookie && this.config.get('env') === 'production') {
      const origin = req.headers.origin;
      if (origin && !this.adminOrigins().includes(origin)) throw new ForbiddenException('Origin không được phép làm mới phiên bằng cookie');
    }
    const token = dto.refreshToken || req.cookies?.[COOKIE] || '';
    const result = await this.auth.refresh(token, this.meta(req));
    if (isAdmin && result.refreshToken) this.setCookie(res, result.refreshToken, result.refreshExpiresInDays);
    return result;
  }

  /**
   * Origin hợp lệ của trang quản trị (ADMIN_URL) và của chính API (admin gọi qua proxy cùng origin).
   * Web con thêm HUB_ADMIN_ORIGIN: tên miền phụ novai-hub dùng để nhúng admin web con vào trang Hub.
   */
  private adminOrigins() {
    const out: string[] = [];
    for (const u of [this.config.get<string>('adminUrl'), this.config.get<string>('apiPublicUrl'), process.env.HUB_ADMIN_ORIGIN]) {
      try {
        if (u) out.push(new URL(u).origin);
      } catch {
        /* URL cấu hình sai -> bỏ qua */
      }
    }
    return out;
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const fromCookie = !dto.refreshToken;
    if (this.isAdminClient(req, fromCookie)) {
      res.clearCookie(COOKIE, { path: '/api/auth' });
    }
    return this.auth.logout(dto.refreshToken || req.cookies?.[COOKIE]);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user.id, dto);
  }

  // nhận mật khẩu hiện tại -> giới hạn chặt để phiên bị lộ không dò được mật khẩu
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  async forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    const base = (dto.target === 'admin' ? this.config.get<string>('adminUrl') || '' : await this.siteUrl(req)).replace(/\/$/, '');
    // chưa cấu hình địa chỉ -> truyền rỗng để service bỏ qua email (không gửi link tương đối "/reset-password")
    // website khách: service tự gắn tiền tố ngôn ngữ (/en/reset-password); trang quản trị giữ nguyên
    const site = dto.target === 'admin' || !base ? undefined : { baseUrl: base, locale: this.reqLocale(req) };
    return this.auth.forgotPassword(dto.email, base ? `${base}/reset-password` : '', site);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }
}
