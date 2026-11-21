import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MAIL_PRIORITY, MailService } from '../mail/mail.service.js';
import { MediaService } from '../media/media.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CaptchaService, type SecuritySettings } from '../security/captcha.service.js';
import { TwoFactorService } from '../security/two-factor.service.js';
import { LoginAuditService } from '../security/login-audit.service.js';
import { LoginProtectionService } from '../security/login-protection.service.js';
import { PasswordPolicyService } from '../security/password-policy.service.js';
import { parseUserAgent, SessionsService } from '../security/sessions.service.js';
import { GoogleIdTokenVerifier, GoogleTokenError, type GoogleIdentity } from './google-id-token.js';
import { frontendBaseUrl, frontendLocalePrefix, frontendUrl } from '../../common/utils/frontend-url.js';
import { isChildSite } from '../../common/utils/tenant.js';
import { LanguagesService } from '../languages/languages.service.js';
import type { LoginFailReason } from '@cmsnt/shared';
import type { ChangePasswordDto, RegisterDto, UpdateProfileDto } from './auth.dto.js';

/** Thông tin tối thiểu của người dùng để gửi email */
type MailUser = { id: string; email: string; name: string; locale?: string | null };
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const authLogger = new Logger('Auth');

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

/** Kết quả đăng nhập: cấp token, hoặc cần bước xác thực 2 (chưa cấp token) */
export type LoginResult = Awaited<ReturnType<AuthService['issueTokens']>> | { requires2fa: true; challenge: string };

const hasAdminAccess = (perms: string[]) => perms.includes('*') || perms.includes('admin.access');

/** Câu báo lỗi chung cho sai email / sai mật khẩu — giống nhau để không lộ email nào đã đăng ký */
const BAD_CREDENTIALS = 'Email hoặc mật khẩu không đúng';

/**
 * Hash argon2 giả để so khi email không tồn tại: thời gian phản hồi giống hệt email có thật,
 * kẻ tấn công không đo được email nào đã đăng ký. Tạo 1 lần khi khởi động.
 */
const DUMMY_HASH = argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });

type Area = 'admin' | 'site';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly mail: MailService,
    private readonly media: MediaService,
    private readonly settings: SettingsService,
    private readonly captcha: CaptchaService,
    private readonly twoFactor: TwoFactorService,
    private readonly audit: LoginAuditService,
    private readonly protection: LoginProtectionService,
    private readonly passwordPolicy: PasswordPolicyService,
    /** xoá cache trạng thái phiên sau khi thu hồi (tuỳ chọn để test dựng service dễ) */
    private readonly sessions?: SessionsService,
    /** tra ngôn ngữ mặc định để gắn tiền tố ngôn ngữ vào link email (tuỳ chọn để test dựng service dễ) */
    private readonly languages?: LanguagesService,
  ) {}

  /**
   * Địa chỉ website kèm tiền tố ngôn ngữ (vd. https://shop.vn/en) để dựng link trong email.
   * Quy ước chung: ngôn ngữ mặc định không tiền tố, ngôn ngữ khác `/{locale}`. siteUrl rỗng -> rỗng.
   */
  private async localizedSite(siteUrl: string, locale?: string | null): Promise<string> {
    const base = (siteUrl || '').replace(/\/$/, '');
    if (!base) return '';
    return `${base}${await frontendLocalePrefix({ locale, languages: this.languages })}`;
  }

  hashPassword(password: string) {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  private security() {
    return this.settings.get<SecuritySettings>('security');
  }

  /** "HH:mm" theo múi giờ website để báo thời điểm mở khoá */
  private async formatUnlockTime(d: Date) {
    const general = await this.settings.get<{ timezone?: string }>('general');
    try {
      // khoá dài (admin khoá nhiều ngày) thì hiện cả ngày, khoá ngắn chỉ cần giờ:phút
      const withDate = d.getTime() - Date.now() > 20 * 3600_000;
      return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', ...(withDate ? { day: '2-digit', month: '2-digit', year: 'numeric' } : {}), timeZone: general.timezone || 'Asia/Ho_Chi_Minh' }).format(d);
    } catch {
      return d.toISOString().slice(11, 16);
    }
  }

  /** Có `lockReason` = admin khoá tạm thời (báo kèm lý do); không có = khoá tự động do đăng nhập sai nhiều lần */
  private async assertNotLocked(user: { lockedUntil: Date | null; lockReason?: string | null }) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const until = await this.formatUnlockTime(user.lockedUntil);
      if (user.lockReason) throw new HttpException(`Tài khoản bị tạm khoá tới ${until}. Lý do: ${user.lockReason}`, HttpStatus.LOCKED);
      throw new HttpException(`Tài khoản tạm khoá tới ${until} do đăng nhập sai nhiều lần`, HttpStatus.LOCKED);
    }
  }

  /** Ghi nhật ký 1 lượt thất bại (không gắn tài khoản cụ thể / không tính vào khoá tài khoản) rồi kiểm tra chặn IP */
  private async logFailure(email: string, userId: string | null, meta: SessionMeta, area: Area, reason: LoginFailReason) {
    await this.audit.record({ email, userId, ip: meta.ip, userAgent: meta.userAgent, success: false, reason, area });
    await this.protection.afterFailure(meta.ip);
  }

  /**
   * Ghi nhận 1 lần đăng nhập sai (mật khẩu / mã 2FA). Đạt ngưỡng `security.maxFailedLogins`
   * -> khoá `security.lockoutMinutes` phút. Câu báo lỗi không cho biết còn bao nhiêu lần thử
   * (con số đó chỉ có với email tồn tại -> lộ email đã đăng ký).
   *
   * Tăng bộ đếm NGUYÊN TỬ trong DB (`failedLogins + 1 ... RETURNING`) và quyết định khoá theo giá trị trả về:
   * nhiều request sai song song không thể cùng đọc một giá trị cũ rồi ghi đè nhau để lách ngưỡng.
   */
  private async registerFailure(user: { id: string; email: string; failedLogins: number }, meta: SessionMeta, area: Area, reason: 'password' | '2fa'): Promise<never> {
    const cfg = await this.security();
    const max = Math.max(1, Number(cfg.maxFailedLogins) || 5);
    const minutes = Math.max(1, Number(cfg.lockoutMinutes) || 15);
    const rows = await this.prisma.$queryRaw<{ failedLogins: number }[]>`
      UPDATE "users" SET "failedLogins" = "failedLogins" + 1 WHERE "id" = ${user.id}::uuid RETURNING "failedLogins"`;
    const failed = Number(rows[0]?.failedLogins ?? user.failedLogins + 1);
    const lock = failed >= max;
    const lockedUntil = lock ? new Date(Date.now() + minutes * 60_000) : undefined;
    let claimedLock = false;
    if (lockedUntil) {
      // chỉ request đầu tiên chạm ngưỡng reset bộ đếm + đặt hạn khoá (điều kiện failedLogins >= max);
      // các request song song khác cũng vượt ngưỡng vẫn bị báo khoá nhưng không ghi đè / không cảnh báo lần nữa
      claimedLock = (await this.prisma.$executeRaw`
        UPDATE "users" SET "failedLogins" = 0, "lockedUntil" = ${lockedUntil}, "lockReason" = NULL
        WHERE "id" = ${user.id}::uuid AND "failedLogins" >= ${max}`) > 0;
    }
    this.events.emit('activity', { userId: user.id, action: 'auth.failed', entityType: 'user', entityId: user.id, ip: meta.ip, meta: { reason, attempt: failed } });
    await this.logFailure(user.email, user.id, meta, area, reason);
    if (lockedUntil) {
      if (claimedLock) {
        this.events.emit('activity', { userId: user.id, action: 'auth.locked', entityType: 'user', entityId: user.id, ip: meta.ip, meta: { minutes, until: lockedUntil.toISOString() } });
        await this.protection.afterLock(user, minutes, meta.ip);
      }
      throw new HttpException(`Đăng nhập sai quá nhiều lần. Tài khoản tạm khoá tới ${await this.formatUnlockTime(lockedUntil)}`, HttpStatus.LOCKED);
    }
    if (reason === '2fa') throw new UnauthorizedException('Mã xác thực không đúng');
    throw new UnauthorizedException(BAD_CREDENTIALS);
  }

  /**
   * Sau khi xác thực đúng (mật khẩu / mã 2FA): reset bộ đếm sai NGUYÊN TỬ, chỉ khi tài khoản chưa bị khoá
   * tại thời điểm ghi. Request đọc dữ liệu user trước khi một request song song khác vừa khoá tài khoản
   * (dò mật khẩu/mã 2FA hàng loạt) sẽ không lọt qua: không cập nhật được dòng nào -> đọc lại và báo khoá.
   */
  private async clearFailuresIfUnlocked(userId: string) {
    const n = await this.prisma.$executeRaw`
      UPDATE "users" SET "failedLogins" = 0, "lockedUntil" = NULL, "lockReason" = NULL
      WHERE "id" = ${userId}::uuid AND ("lockedUntil" IS NULL OR "lockedUntil" <= now())`;
    if (n > 0) return;
    const fresh = await this.prisma.user.findUnique({ where: { id: userId }, select: { lockedUntil: true, lockReason: true } });
    if (!fresh) throw new UnauthorizedException('Tài khoản không khả dụng');
    await this.assertNotLocked(fresh);
    // hạn khoá vừa hết giữa 2 truy vấn -> coi như không khoá
  }

  async validate(email: string, password: string, meta: SessionMeta, area: Area = 'site') {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findFirst({
      where: { email: normalized, deletedAt: null },
      include: { role: true },
    });
    if (!user) {
      // vẫn băm để thời gian phản hồi giống email có thật
      await argon2.verify(await DUMMY_HASH, password).catch(() => false);
      await this.logFailure(normalized, null, meta, area, 'password');
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.logFailure(normalized, user.id, meta, area, 'locked');
      await this.assertNotLocked(user);
    }
    if (!(await argon2.verify(user.passwordHash, password))) await this.registerFailure(user, meta, area, 'password');
    if (user.status === 'PENDING') {
      await this.audit.record({ email: normalized, userId: user.id, ip: meta.ip, userAgent: meta.userAgent, success: false, reason: 'pending', area });
      throw new UnauthorizedException('Tài khoản chưa được xác minh email, vui lòng kiểm tra hộp thư');
    }
    if (user.status !== 'ACTIVE') {
      await this.audit.record({ email: normalized, userId: user.id, ip: meta.ip, userAgent: meta.userAgent, success: false, reason: 'inactive', area });
      throw new UnauthorizedException('Tài khoản đã bị khoá hoặc chưa kích hoạt');
    }
    return user;
  }

  /**
   * Đăng nhập bằng mật khẩu. Tài khoản bật 2FA (và thiết bị chưa được tin cậy) -> trả `{ requires2fa, challenge }`,
   * client gọi tiếp `verify2fa`. Đúng mật khẩu thì reset bộ đếm sai.
   */
  async login(email: string, password: string, meta: SessionMeta, requireAdmin = false, trustToken?: string): Promise<LoginResult> {
    const area: Area = requireAdmin ? 'admin' : 'site';
    const user = await this.validate(email, password, meta, area);
    const perms = user.role.permissions;
    if (requireAdmin && !hasAdminAccess(perms)) {
      await this.audit.record({ email: user.email, userId: user.id, ip: meta.ip, userAgent: meta.userAgent, success: false, reason: 'not_admin', area });
      throw new UnauthorizedException('Tài khoản không có quyền truy cập trang quản trị');
    }
    await this.clearFailuresIfUnlocked(user.id);
    if (user.twoFactorEnabled && !(await this.twoFactor.isTrusted(trustToken, user.id, user.twoFactorSecret))) {
      return { requires2fa: true, challenge: await this.twoFactor.issueChallenge(user.id, area) };
    }
    return this.completeLogin(user, meta, area);
  }

  /**
   * Web con: chủ hệ thống vào admin một chạm từ novai-hub (vé đã kiểm ở controller, xem verifyHubTicket).
   * Chỉ cho tài khoản quản trị đang hoạt động; ghi nhật ký đăng nhập như đăng nhập admin thường.
   */
  async loginFromHub(email: string, meta: SessionMeta) {
    const user = await this.prisma.user.findFirst({ where: { email, deletedAt: null }, include: { role: true } });
    if (!user || user.status !== 'ACTIVE' || !hasAdminAccess(user.role.permissions)) throw new UnauthorizedException('Tài khoản Hub không hợp lệ');
    return this.completeLogin(user, meta, 'admin');
  }

  /** Bước 2 của đăng nhập: mã TOTP hoặc mã dự phòng kèm challenge */
  async verify2fa(challenge: string, input: { code?: string; recoveryCode?: string }, meta: SessionMeta, requireAdmin = false) {
    const { userId, area } = await this.twoFactor.readChallengeFull(challenge);
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null, status: 'ACTIVE' }, include: { role: true } });
    if (!user) throw new UnauthorizedException('Tài khoản không khả dụng');
    await this.assertNotLocked(user);
    // challenge cấp từ đăng nhập admin, hoặc client admin yêu cầu -> bắt buộc còn quyền admin.access
    // (chặn dùng challenge của website để lấy phiên trên trang quản trị; quyền có thể bị thu hồi giữa 2 bước)
    if ((requireAdmin || area === 'admin') && !hasAdminAccess(user.role.permissions)) {
      await this.audit.record({ email: user.email, userId: user.id, ip: meta.ip, userAgent: meta.userAgent, success: false, reason: 'not_admin', area: 'admin' });
      throw new UnauthorizedException('Tài khoản không có quyền truy cập trang quản trị');
    }
    if (!input.code && !input.recoveryCode) throw new BadRequestException('Vui lòng nhập mã xác thực');
    const result = await this.twoFactor.verifyCode(user.id, input);
    if (!result.ok) await this.registerFailure(user, meta, area, '2fa');
    await this.clearFailuresIfUnlocked(user.id);
    const tokens = await this.completeLogin(user, meta, area, result.usedRecovery ? 'recovery' : 'totp');
    return { ...tokens, usedRecovery: result.usedRecovery, recoveryLeft: result.recoveryLeft };
  }

  /** Bộ xác minh ID token Google (cache JWKS trong tiến trình) */
  private readonly google = new GoogleIdTokenVerifier();

  /**
   * Đăng nhập bằng Google cho khách (Cài đặt › Tài khoản: googleLoginEnabled + googleClientId).
   * Tìm theo googleId; chưa có thì liên kết với tài khoản cùng email (Google đã xác minh email);
   * chưa có tài khoản thì tạo khách mới nếu website cho đăng ký. Tôn trọng khoá / trạng thái / 2FA
   * như đăng nhập mật khẩu và trả cùng kiểu kết quả (`issueTokens` hoặc `{ requires2fa, challenge }`).
   * Tài khoản có quyền quản trị không được đăng nhập bằng Google (tránh bỏ qua mật khẩu của nhân sự).
   */
  async loginWithGoogle(idToken: string, meta: SessionMeta, trustToken?: string, ref?: string): Promise<LoginResult> {
    const account = await this.settings.get<{ allowRegistration?: boolean; googleLoginEnabled?: boolean; googleClientId?: string }>('account');
    const clientId = String(account.googleClientId ?? '').trim();
    if (account.googleLoginEnabled !== true || !clientId) throw new ForbiddenException('Website chưa bật đăng nhập bằng Google');
    let g: GoogleIdentity;
    try {
      g = await this.google.verify(idToken, clientId);
    } catch (err) {
      // lỗi mạng / Google trả lỗi -> ghi log để admin biết; token sai -> chỉ báo chung cho client
      if (!(err instanceof GoogleTokenError) || /tải được|JWKS/.test(err.message)) authLogger.warn(`Xác minh Google ID token thất bại: ${(err as Error).message}`);
      throw new UnauthorizedException('Không xác minh được tài khoản Google, vui lòng thử lại');
    }
    const include = { role: true } as const;
    let created = false;
    let user = await this.prisma.user.findFirst({ where: { googleId: g.sub, deletedAt: null }, include });
    if (!user) {
      const byEmail = await this.prisma.user.findFirst({ where: { email: g.email, deletedAt: null }, include });
      if (byEmail) {
        if (byEmail.googleId && byEmail.googleId !== g.sub) throw new ConflictException('Email này đã liên kết với một tài khoản Google khác');
        if (hasAdminAccess(byEmail.role.permissions)) throw new ForbiddenException('Tài khoản quản trị không hỗ trợ đăng nhập bằng Google');
        // liên kết: Google đã xác minh email = chứng minh sở hữu email -> tài khoản đang chờ xác minh được kích hoạt luôn.
        // Tài khoản CHƯA từng xác minh email có thể do kẻ gian đăng ký trước bằng email của nạn nhân (pre-account-takeover):
        // xoá mọi thông tin đăng nhập kẻ đó có thể đã cài (mật khẩu, phiên, API key, 2FA) trước khi giao cho chủ email thật.
        const resetCredentials = !byEmail.emailVerified;
        const passwordHash = resetCredentials ? await this.hashPassword(randomBytes(32).toString('hex')) : undefined;
        const count = await this.prisma.$transaction(async (tx) => {
          const now = new Date();
          const { count: linked } = await tx.user.updateMany({
            where: { id: byEmail.id, googleId: null },
            data: {
              googleId: g.sub,
              ...(byEmail.status === 'PENDING' ? { status: 'ACTIVE' as const } : {}),
              ...(resetCredentials
                ? {
                    emailVerified: now,
                    passwordHash,
                    meta: { ...((byEmail.meta ?? {}) as Record<string, unknown>), passwordSet: false } as object,
                    twoFactorEnabled: false,
                    twoFactorSecret: null,
                    recoveryCodes: [],
                    totpLastStep: null,
                  }
                : {}),
            },
          });
          if (linked && resetCredentials) {
            await tx.refreshToken.updateMany({ where: { userId: byEmail.id, revokedAt: null }, data: { revokedAt: now } });
            await tx.apiKey.updateMany({ where: { userId: byEmail.id, revokedAt: null }, data: { revokedAt: now } });
            await tx.passwordReset.updateMany({ where: { email: byEmail.email, usedAt: null }, data: { usedAt: now } });
          }
          return linked;
        });
        if (count) {
          if (resetCredentials) {
            this.sessions?.forgetAll();
            this.events.emit('user.changed', { id: byEmail.id });
          }
          this.events.emit('activity', { userId: byEmail.id, action: 'auth.google_linked', entityType: 'user', entityId: byEmail.id, ip: meta.ip, meta: { resetCredentials } });
        }
        user = await this.prisma.user.findFirst({ where: { id: byEmail.id, deletedAt: null }, include });
      } else {
        if (account.allowRegistration === false) throw new ForbiddenException('Website đang tạm ngừng đăng ký thành viên mới');
        const role = await this.prisma.role.findUnique({ where: { slug: 'customer' } });
        if (!role) throw new BadRequestException('Chưa cấu hình vai trò khách hàng');
        try {
          user = await this.prisma.user.create({
            data: {
              email: g.email,
              name: (g.name?.trim() || g.email.split('@')[0]).slice(0, 120),
              googleId: g.sub,
              // mật khẩu ngẫu nhiên không ai biết; meta.passwordSet=false đánh dấu khách chưa tự đặt mật khẩu
              passwordHash: await this.hashPassword(randomBytes(32).toString('hex')),
              roleId: role.id,
              status: 'ACTIVE',
              emailVerified: new Date(),
              meta: { passwordSet: false, signupMethod: 'google' },
            },
            include,
          });
          created = true;
        } catch (err) {
          // 2 request song song cùng tài khoản Google: request sau đọc lại bản ghi request trước vừa tạo
          if ((err as { code?: string }).code !== 'P2002') throw err;
          user = await this.prisma.user.findFirst({ where: { googleId: g.sub, deletedAt: null }, include });
          if (!user) throw new ConflictException('Email đã được sử dụng');
        }
      }
    }
    if (!user) throw new UnauthorizedException('Tài khoản không khả dụng');
    if (hasAdminAccess(user.role.permissions)) throw new ForbiddenException('Tài khoản quản trị không hỗ trợ đăng nhập bằng Google');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.logFailure(user.email, user.id, meta, 'site', 'locked');
      await this.assertNotLocked(user);
    }
    if (user.status !== 'ACTIVE') {
      await this.audit.record({ email: user.email, userId: user.id, ip: meta.ip, userAgent: meta.userAgent, success: false, reason: 'inactive', area: 'site' });
      throw new UnauthorizedException('Tài khoản đã bị khoá hoặc chưa kích hoạt');
    }
    if (created) {
      // ref = mã giới thiệu (tiếp thị liên kết) -> AffiliateService gắn người giới thiệu
      this.events.emit('user.registered', { user, ref, ip: meta.ip });
      this.events.emit('activity', { userId: user.id, action: 'auth.register', entityType: 'user', entityId: user.id, ip: meta.ip, meta: { method: 'google' } });
      this.sendWelcome(user, await frontendBaseUrl(this.config, this.settings)).catch(() => undefined);
    }
    if (user.twoFactorEnabled && !(await this.twoFactor.isTrusted(trustToken, user.id, user.twoFactorSecret))) {
      return { requires2fa: true, challenge: await this.twoFactor.issueChallenge(user.id, 'site') };
    }
    return this.completeLogin(user, meta, 'site', 'google');
  }

  private async completeLogin(
    user: { id: string; email: string; name: string; locale: string | null; role: { permissions: string[] } },
    meta: SessionMeta,
    area: Area,
    method: 'password' | 'totp' | 'recovery' | 'google' = 'password',
  ) {
    // kiểm tra thiết bị mới TRƯỚC khi ghi lượt thành công này vào nhật ký
    const newDevice = await this.audit.isNewDevice(user.id, meta.userAgent).catch(() => false);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), lastLoginIp: meta.ip } });
    await this.audit.record({ email: user.email, userId: user.id, ip: meta.ip, userAgent: meta.userAgent, success: true, area, method });
    this.events.emit('activity', { userId: user.id, action: 'auth.login', ip: meta.ip, meta: { method, area } });
    if (newDevice) this.sendNewDeviceAlert(user, meta, area).catch(() => undefined);
    await this.enforceSingleAdminSession(user);
    return this.issueTokens(user.id, meta);
  }

  /** Email cảnh báo đăng nhập từ thiết bị mới (Cài đặt › Bảo mật › Cảnh báo: off | admins | all) */
  private async sendNewDeviceAlert(user: { id: string; email: string; name: string; locale: string | null; role: { permissions: string[] } }, meta: SessionMeta, area: Area) {
    const cfg = await this.security();
    const mode = cfg.newDeviceAlert ?? 'admins';
    const isAdmin = hasAdminAccess(user.role.permissions);
    if (mode === 'off' || (mode === 'admins' && !isAdmin)) return;
    const ua = parseUserAgent(meta.userAgent);
    const general = await this.settings.get<{ timezone?: string }>('general');
    let time: string;
    try {
      time = new Intl.DateTimeFormat(user.locale === 'en' ? 'en-GB' : 'vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: general.timezone || 'Asia/Ho_Chi_Minh' }).format(new Date());
    } catch {
      time = new Date().toISOString();
    }
    // quản trị viên xem phiên ở trang Hồ sơ của admin, thành viên ở trang tài khoản website
    const adminUrl = (this.config.get<string>('adminUrl') || '').replace(/\/$/, '');
    // chưa cấu hình địa chỉ website khách -> để trống link (không gửi đường dẫn tương đối)
    const sessionsUrl = isAdmin && adminUrl ? `${adminUrl}/profile?tab=security` : ((await frontendUrl(this.config, this.settings, '/account', { locale: user.locale, languages: this.languages })) ?? '');
    await this.mail.sendTemplate({
      key: 'auth.new_login',
      locale: user.locale ?? undefined,
      to: user.email,
      vars: {
        user: { name: user.name, email: user.email },
        login: { time, ip: meta.ip ?? '', browser: ua.browser, os: ua.os, area: area === 'admin' ? (user.locale === 'en' ? 'Admin panel' : 'Trang quản trị') : 'Website' },
        sessionsUrl,
      },
      meta: { userId: user.id },
      priority: MAIL_PRIORITY.high,
    });
  }

  /** `locale` (tuỳ chọn): ngôn ngữ khách đang xem — gắn tiền tố vào link xác minh / tài khoản trong email */
  async register(dto: RegisterDto, meta: SessionMeta, siteUrl: string, locale?: string | null) {
    const account = await this.settings.get<{ allowRegistration?: boolean; requireEmailVerification?: boolean }>('account');
    if (account.allowRegistration === false) throw new ForbiddenException('Website đang tạm ngừng đăng ký thành viên mới');
    await this.captcha.assert(dto._captcha, meta.ip, 'register');
    const email = dto.email.toLowerCase().trim();
    await this.passwordPolicy.assert(dto.password, { email, name: dto.name });
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email đã được sử dụng');
    const role = await this.prisma.role.findUnique({ where: { slug: 'customer' } });
    if (!role) throw new BadRequestException('Chưa cấu hình vai trò khách hàng');
    const verify = account.requireEmailVerification === true;
    // bắt buộc xác minh email nhưng chưa cấu hình địa chỉ website -> không dựng được link xác minh, chặn trước khi tạo tài khoản
    if (verify && !siteUrl) throw new BadRequestException('Website chưa cấu hình địa chỉ (Cài đặt › Chung › Địa chỉ website) nên chưa gửi được email xác minh');
    const user = await this.prisma.user.create({
      data: { email, name: dto.name, phone: dto.phone, passwordHash: await this.hashPassword(dto.password), roleId: role.id, status: verify ? 'PENDING' : 'ACTIVE' },
    });
    // ref = mã giới thiệu (tiếp thị liên kết) -> AffiliateService gắn người giới thiệu
    this.events.emit('user.registered', { user, ref: dto.referralCode || dto.ref, ip: meta.ip });
    if (!verify) {
      this.sendWelcome(user, siteUrl, locale).catch(() => undefined);
      return this.issueTokens(user.id, meta);
    }
    await this.sendVerification(user, siteUrl, locale);
    return { requiresVerification: true, message: 'Đăng ký thành công! Vui lòng kiểm tra email để kích hoạt tài khoản.' };
  }

  /** Email chào mừng sau khi đăng ký (hoặc sau khi xác minh email) */
  private async sendWelcome(user: MailUser, siteUrl: string, requestLocale?: string | null) {
    // link theo ngôn ngữ request (nếu có) → ngôn ngữ lưu trong tài khoản → mặc định
    const site = await this.localizedSite(siteUrl, requestLocale || user.locale);
    await this.mail.sendTemplate({
      key: 'auth.welcome',
      locale: user.locale ?? undefined,
      to: user.email,
      // chưa cấu hình địa chỉ website -> để trống link (không gửi đường dẫn tương đối)
      vars: { user: { name: user.name, email: user.email }, accountUrl: site ? `${site}/account` : '' },
      meta: { userId: user.id },
    });
  }

  private async sendVerification(user: MailUser, siteUrl: string, requestLocale?: string | null) {
    // không có địa chỉ website thì link xác minh vô dụng -> không gửi
    if (!siteUrl) {
      authLogger.warn('Chưa cấu hình địa chỉ website — bỏ qua email xác minh');
      return;
    }
    const token = await this.jwt.signAsync({ sub: user.id, purpose: 'verify-email' }, { expiresIn: '24h' });
    const link = `${await this.localizedSite(siteUrl, requestLocale || user.locale)}/verify-email?token=${encodeURIComponent(token)}`;
    await this.mail.sendTemplate({
      key: 'auth.verify_email',
      locale: user.locale ?? undefined,
      to: user.email,
      vars: { user: { name: user.name, email: user.email }, link, expiresIn: user.locale === 'en' ? '24 hours' : '24 giờ' },
      meta: { userId: user.id },
      // khách đang chờ email này → ưu tiên gửi trước trong hàng chờ
      priority: MAIL_PRIORITY.high,
    });
  }

  async resendVerification(email: string, siteUrl: string, locale?: string | null) {
    const user = await this.prisma.user.findFirst({ where: { email: email.toLowerCase().trim(), status: 'PENDING', deletedAt: null } });
    if (user) await this.sendVerification(user, siteUrl, locale);
    return { success: true };
  }

  async verifyEmail(token: string, meta: SessionMeta) {
    let payload: { sub: string; purpose?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new BadRequestException('Liên kết xác minh không hợp lệ hoặc đã hết hạn');
    }
    if (payload.purpose !== 'verify-email') throw new BadRequestException('Liên kết xác minh không hợp lệ');
    const res = await this.prisma.user.updateMany({ where: { id: payload.sub, status: 'PENDING', deletedAt: null }, data: { status: 'ACTIVE', emailVerified: new Date() } });
    if (!res.count) throw new BadRequestException('Tài khoản đã được kích hoạt hoặc không tồn tại');
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, name: true, locale: true } });
    if (user) this.sendWelcome(user, await frontendBaseUrl(this.config, this.settings)).catch(() => undefined);
    return this.issueTokens(payload.sub, meta);
  }

  /**
   * Cấp access token (JWT dài hạn 30 ngày, có `sid` = id refresh token để guard kiểm tra thu hồi tức thì) + refresh token 365 ngày.
   * Phiên giữ nguyên cho tới khi người dùng bấm Đăng xuất (hoặc đổi mật khẩu / thu hồi phiên / khoá tài khoản).
   */
  async issueTokens(userId: string, meta: SessionMeta, session?: { createdAt: Date; ip?: string | null; userAgent?: string | null }) {
    const refreshToken = randomBytes(48).toString('base64url');
    const days = Math.max(365, this.config.get<number>('jwt.refreshTtlDays') ?? 365);
    const record = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        ip: meta.ip ?? session?.ip ?? undefined,
        userAgent: (meta.userAgent ?? session?.userAgent ?? undefined)?.slice(0, 500),
        expiresAt: new Date(Date.now() + days * 86400_000),
        ...(session ? { createdAt: session.createdAt, lastUsedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: record.id }, { expiresIn: '30d' });
    return { accessToken, refreshToken, refreshExpiresInDays: days, user: await this.me(userId) };
  }

  /**
   * Làm mới access token bền vững (không xoay vòng huỷ token cũ):
   * - Giữ nguyên dòng `refreshToken` hiện tại và tự động gia hạn trượt 365 ngày (`expiresAt`, `lastUsedAt`),
   *   nhờ đó mở nhiều tab / F5 liên tục / mất mạng giữa chừng / khởi động lại API KHÔNG BAO GIỜ làm lệch token hay tự đăng xuất.
   * - Chỉ khi người dùng chủ động bấm nút Đăng xuất (hoặc thu hồi thiết bị / đổi mật khẩu / tài khoản bị khoá) thì phiên mới kết thúc.
   */
  async refresh(refreshToken: string, meta: SessionMeta): Promise<Awaited<ReturnType<AuthService['issueTokens']>>> {
    if (!refreshToken) throw new UnauthorizedException('Phiên đăng nhập đã hết hạn');
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!record || record.expiresAt < new Date()) throw new UnauthorizedException('Phiên đăng nhập đã hết hạn');
    const days = Math.max(365, this.config.get<number>('jwt.refreshTtlDays') ?? 365);
    const now = new Date();
    const nextExpires = new Date(Date.now() + days * 86400_000);

    if (record.revokedAt) {
      // Thu hồi chủ động (ấn nút Đăng xuất, thu hồi thiết bị, đổi mật khẩu) -> kết thúc phiên
      if (!record.rotatedAt) throw new UnauthorizedException('Phiên đăng nhập đã kết thúc');
      // Tương thích các phiên cũ vừa xoay vòng trước bản cập nhật này: nối vào dòng đang sống cùng chuỗi nếu còn
      const activeSibling = await this.prisma.refreshToken.findFirst({
        where: { userId: record.userId, createdAt: record.createdAt, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { expiresAt: 'desc' },
      });
      if (!activeSibling) throw new UnauthorizedException('Phiên đăng nhập đã kết thúc');
      const user = await this.prisma.user.findFirst({ where: { id: record.userId, deletedAt: null, status: 'ACTIVE' } });
      if (!user) throw new UnauthorizedException('Tài khoản không khả dụng');
      await this.prisma.refreshToken.update({
        where: { id: activeSibling.id },
        data: { lastUsedAt: now, expiresAt: nextExpires, ...(meta.ip ? { ip: meta.ip } : {}) },
      });
      const accessToken = await this.jwt.signAsync({ sub: user.id, sid: activeSibling.id }, { expiresIn: '30d' });
      return { accessToken, refreshToken: '', refreshExpiresInDays: days, user: await this.me(user.id) };
    }

    const user = await this.prisma.user.findFirst({ where: { id: record.userId, deletedAt: null, status: 'ACTIVE' } });
    if (!user) throw new UnauthorizedException('Tài khoản không khả dụng');

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: {
        lastUsedAt: now,
        expiresAt: nextExpires,
        ...(meta.ip ? { ip: meta.ip } : {}),
        ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 500) } : {}),
      },
    });
    const accessToken = await this.jwt.signAsync({ sub: user.id, sid: record.id }, { expiresIn: '30d' });
    return { accessToken, refreshToken, refreshExpiresInDays: days, user: await this.me(user.id) };
  }

  /** Giữ phiên quản trị không tự thoát theo thời gian chờ hay giới hạn giờ — chỉ thoát khi ấn Đăng xuất */
  private async assertAdminSessionLimits(_perms: string[], _session: { createdAt: Date; lastUsedAt?: Date | null }) {
    return;
  }

  /** Cho phép đăng nhập song song không đá phiên đang mở trên thiết bị / tab khác */
  private async enforceSingleAdminSession(_user: { id: string; role: { permissions: string[] } }) {
    return;
  }

  /** Id phiên hiện tại từ access token (claim `sid`), không có -> null */
  async currentSessionId(authorization: string | undefined): Promise<string | null> {
    const [type, token] = authorization?.split(' ') ?? [];
    if (type !== 'Bearer' || !token) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sid?: string }>(token);
      return payload.sid ?? null;
    } catch {
      return null;
    }
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) return { success: true };
    // thu hồi cả chuỗi phiên (kể cả nhánh rẽ do refresh song song trong thời gian ân hạn)
    if (this.sessions) await this.sessions.revokeChain({ tokenHash: sha256(refreshToken) });
    else await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { role: { select: { id: true, name: true, slug: true, permissions: true } }, avatar: true },
    });
    const { passwordHash: _p, twoFactorSecret: _s, recoveryCodes, ...rest } = user;
    const security = await this.security();
    // bắt buộc 2FA với tài khoản admin: client chặn điều hướng cho tới khi bật
    const setup2faRequired = !!security.require2faForAdmins && hasAdminAccess(user.role.permissions) && !user.twoFactorEnabled;
    return { ...rest, avatar: this.media.present(user.avatar), recoveryCodesLeft: recoveryCodes.length, setup2faRequired, isChildSite: isChildSite() };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.prisma.user.update({ where: { id: userId }, data: dto });
    this.events.emit('user.changed', { id: userId });
    return this.me(userId);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, dto.currentPassword))) {
      throw new BadRequestException('Mật khẩu hiện tại không đúng');
    }
    await this.passwordPolicy.assert(dto.newPassword, { email: user.email, name: user.name });
    if (await argon2.verify(user.passwordHash, dto.newPassword)) throw new BadRequestException('Mật khẩu mới phải khác mật khẩu hiện tại');
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hashPassword(dto.newPassword) } });
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    this.sessions?.forgetAll();
    // link đặt lại mật khẩu đã gửi trước đó (có thể nằm trong hộp thư bị lộ) hết hiệu lực
    await this.prisma.passwordReset.updateMany({ where: { email: user.email, usedAt: null }, data: { usedAt: new Date() } });
    this.events.emit('activity', { userId, action: 'auth.password_changed', entityType: 'user', entityId: userId });
    return { success: true };
  }

  /**
   * `site` (tuỳ chọn, chỉ cho website khách): khi có thì link được dựng lại từ địa chỉ website + tiền tố ngôn ngữ
   * (request → tài khoản → mặc định) + `/reset-password`; trang quản trị không có tiền tố ngôn ngữ.
   */
  async forgotPassword(email: string, resetBaseUrl: string, site?: { baseUrl: string; locale?: string | null }) {
    const user = await this.prisma.user.findFirst({ where: { email: email.toLowerCase().trim(), deletedAt: null } });
    // Luôn trả về thành công để tránh dò email
    if (!user) return { success: true };
    // chưa cấu hình địa chỉ trang đặt lại mật khẩu -> không gửi link tương đối (vẫn trả thành công để không lộ email)
    if (!resetBaseUrl) {
      authLogger.warn('Chưa cấu hình địa chỉ website/trang quản trị — bỏ qua email đặt lại mật khẩu');
      return { success: true };
    }
    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordReset.create({
      data: { email: user.email, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) },
    });
    const resetPage = site?.baseUrl ? `${await this.localizedSite(site.baseUrl, site.locale || user.locale)}/reset-password` : resetBaseUrl;
    const link = `${resetPage}?token=${token}`;
    await this.mail.sendTemplate({
      key: 'auth.reset_password',
      locale: user.locale ?? undefined,
      to: user.email,
      vars: { user: { name: user.name, email: user.email }, link, expiresIn: user.locale === 'en' ? '60 minutes' : '60 phút' },
      meta: { userId: user.id },
      // khách đang chờ email này → ưu tiên gửi trước trong hàng chờ
      priority: MAIL_PRIORITY.high,
    });
    return { success: true };
  }

  async resetPassword(token: string, password: string) {
    const record = await this.prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) throw new BadRequestException('Liên kết không hợp lệ hoặc đã hết hạn');
    const user = await this.prisma.user.findFirst({ where: { email: record.email, deletedAt: null } });
    if (!user) throw new BadRequestException('Tài khoản không tồn tại');
    await this.passwordPolicy.assert(password, { email: user.email, name: user.name });
    const passwordHash = await this.hashPassword(password);
    await this.prisma.$transaction(async (tx) => {
      // "giành" token nguyên tử (điều kiện usedAt null): 2 request đồng thời chỉ 1 request đổi được mật khẩu
      const { count } = await tx.passwordReset.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (!count) throw new BadRequestException('Liên kết không hợp lệ hoặc đã hết hạn');
      // tài khoản tạo qua Google (meta.passwordSet=false) giờ đã có mật khẩu do khách tự đặt
      const userMeta = (user.meta ?? {}) as Record<string, unknown>;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, ...(userMeta.passwordSet === false ? { meta: { ...userMeta, passwordSet: true } as object } : {}) } });
      // các link đặt lại khác còn hạn của email này cũng hết hiệu lực
      await tx.passwordReset.updateMany({ where: { email: record.email, usedAt: null }, data: { usedAt: new Date() } });
      await tx.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    // guard trên instance này tra lại trạng thái phiên ngay (không chờ hết cache 20s)
    this.sessions?.forgetAll();
    return { success: true };
  }
}
