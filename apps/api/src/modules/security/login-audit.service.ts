import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isLoopbackIp, normalizeIp, type LoginAttemptView, type LoginFailReason, type SecurityCheck, type SecurityOverview } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { SettingsService } from '../settings/settings.service.js';
import { paginate } from '../../common/dto/pagination.dto.js';
import { parseUserAgent } from './sessions.service.js';

export interface RecordAttemptInput {
  email: string;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  success: boolean;
  reason?: LoginFailReason | null;
  area: 'admin' | 'site';
  /** google = đăng nhập bằng tài khoản Google (không qua 2FA) */
  method?: 'password' | 'totp' | 'recovery' | 'google' | null;
}

export interface LoginAttemptQuery {
  page?: number;
  limit?: number;
  /** success | failed */
  result?: string;
  /** admin | site */
  area?: string;
  /** tìm theo email hoặc IP */
  search?: string;
  userId?: string;
}

/** Thiết bị = trình duyệt (bỏ số phiên bản) + hệ điều hành — để cập nhật trình duyệt không bị coi là thiết bị mới */
function deviceKey(ua: string | null | undefined) {
  const p = parseUserAgent(ua);
  return `${p.browser.replace(/\s+\d+$/, '')}|${p.os}`;
}

const hasAdminAccess = (perms: string[]) => perms.includes('*') || perms.includes('admin.access');

/**
 * Nhật ký đăng nhập (bảng login_attempts): ghi mỗi lượt thành công / thất bại, đếm lượt sai theo IP
 * để tự chặn, nhận diện thiết bị mới, và tổng hợp "điểm bảo mật" cho Trung tâm bảo mật.
 */
@Injectable()
export class LoginAuditService {
  private readonly logger = new Logger('LoginAudit');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Ghi 1 lượt đăng nhập. Không bao giờ ném lỗi (nhật ký hỏng không được chặn đăng nhập). */
  async record(input: RecordAttemptInput) {
    try {
      await this.prisma.loginAttempt.create({
        data: {
          email: input.email.toLowerCase().trim().slice(0, 200),
          userId: input.userId ?? null,
          ip: input.ip ? normalizeIp(input.ip).slice(0, 64) : null,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          success: input.success,
          reason: input.success ? null : (input.reason ?? null),
          area: input.area,
          method: input.success ? (input.method ?? 'password') : null,
        },
      });
    } catch (err) {
      this.logger.warn(`Không ghi được nhật ký đăng nhập: ${(err as Error).message}`);
    }
  }

  /** Số lượt sai từ 1 IP trong `minutes` phút gần nhất (loopback không tính) */
  async failuresFromIp(ipRaw: string | null | undefined, minutes: number): Promise<number> {
    const ip = normalizeIp(ipRaw);
    if (!ip || isLoopbackIp(ip)) return 0;
    return this.prisma.loginAttempt.count({ where: { ip, success: false, createdAt: { gte: new Date(Date.now() - minutes * 60_000) } } });
  }

  /**
   * Lượt đăng nhập thành công này có từ thiết bị mới không. Chỉ coi là "mới" khi tài khoản đã có lịch sử
   * đăng nhập (tránh gửi cảnh báo hàng loạt cho mọi người ngay sau khi nâng cấp / lần đăng nhập đầu tiên).
   * Gọi TRƯỚC khi ghi lượt thành công hiện tại.
   */
  async isNewDevice(userId: string, userAgent: string | null | undefined): Promise<boolean> {
    const recent = await this.prisma.loginAttempt.findMany({
      where: { userId, success: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { userAgent: true },
    });
    if (!recent.length) return false;
    const key = deviceKey(userAgent);
    return !recent.some((r) => deviceKey(r.userAgent) === key);
  }

  async list(q: LoginAttemptQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const where: Prisma.LoginAttemptWhereInput = {};
    if (q.result === 'success') where.success = true;
    if (q.result === 'failed') where.success = false;
    if (q.area === 'admin' || q.area === 'site') where.area = q.area;
    if (q.userId) where.userId = q.userId;
    const s = q.search?.trim();
    if (s) where.OR = [{ email: { contains: s.toLowerCase() } }, { ip: { startsWith: s } }];
    const [rows, total] = await Promise.all([
      this.prisma.loginAttempt.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.loginAttempt.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const data: LoginAttemptView[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      user: r.userId ? (byId.get(r.userId) ?? null) : null,
      ip: r.ip,
      ...parseUserAgent(r.userAgent),
      success: r.success,
      reason: (r.reason as LoginFailReason | null) ?? null,
      area: r.area === 'admin' ? 'admin' : 'site',
      method: (r.method as LoginAttemptView['method']) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return paginate(data, total, page, limit);
  }

  /** Tổng quan cho Trung tâm bảo mật: điểm, các mục kiểm tra, thống kê 24h và 14 ngày */
  async overview(yourIp: string | null): Promise<SecurityOverview> {
    const since24h = new Date(Date.now() - 86_400_000);
    const since14d = new Date(Date.now() - 14 * 86_400_000);
    const now = new Date();
    const [cfg, mail, failed24h, success24h, lockedUsers, blockedIps, adminRoles, topIps, daily, blockRules] = await Promise.all([
      this.settings.get<Record<string, unknown>>('security'),
      this.settings.get<{ host?: string }>('mail'),
      this.prisma.loginAttempt.count({ where: { success: false, createdAt: { gte: since24h } } }),
      this.prisma.loginAttempt.count({ where: { success: true, createdAt: { gte: since24h } } }),
      this.prisma.user.count({ where: { lockedUntil: { gt: now }, deletedAt: null } }),
      this.prisma.ipRule.count({ where: { type: 'block', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
      this.prisma.role.findMany({ select: { id: true, permissions: true } }),
      this.prisma.loginAttempt.groupBy({ by: ['ip'], where: { success: false, createdAt: { gte: since24h }, ip: { not: null } }, _count: { _all: true }, orderBy: { _count: { ip: 'desc' } }, take: 8 }),
      this.prisma.$queryRaw<{ date: string; success: bigint; failed: bigint }[]>`
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "date",
          COUNT(*) FILTER (WHERE "success") AS "success", COUNT(*) FILTER (WHERE NOT "success") AS "failed"
        FROM "login_attempts" WHERE "createdAt" >= ${since14d} GROUP BY 1 ORDER BY 1`,
      this.prisma.ipRule.findMany({ where: { type: 'block', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { value: true } }),
    ]);
    const adminRoleIds = adminRoles.filter((r) => hasAdminAccess(r.permissions)).map((r) => r.id);
    const adminWhere: Prisma.UserWhereInput = { roleId: { in: adminRoleIds }, deletedAt: null, status: 'ACTIVE' };
    const [admins, adminsWithout2fa] = await Promise.all([this.prisma.user.count({ where: adminWhere }), this.prisma.user.count({ where: { ...adminWhere, twoFactorEnabled: false } })]);

    const num = (k: string, d: number) => (Number.isFinite(Number(cfg[k])) ? Number(cfg[k]) : d);
    const checks: SecurityCheck[] = [];
    const add = (c: SecurityCheck) => checks.push(c);
    const prod = process.env.NODE_ENV === 'production';

    add({
      key: '2fa',
      label: 'Xác thực 2 bước cho quản trị viên',
      weight: 25,
      status: cfg.require2faForAdmins ? 'ok' : adminsWithout2fa === 0 && admins > 0 ? 'ok' : adminsWithout2fa < admins ? 'warn' : 'error',
      detail: cfg.require2faForAdmins
        ? `Đang bắt buộc · ${admins - adminsWithout2fa}/${admins} tài khoản đã bật`
        : `${admins - adminsWithout2fa}/${admins} tài khoản quản trị đã bật 2FA`,
      hint: cfg.require2faForAdmins ? undefined : 'Bật "Bắt buộc 2FA với tài khoản quản trị"',
      href: '/settings?tab=security',
    });
    const policyStrong = num('passwordMinLength', 8) >= 10 || (num('passwordMinLength', 8) >= 8 && [cfg.passwordRequireUppercase, cfg.passwordRequireNumber, cfg.passwordRequireSymbol].filter(Boolean).length >= 2);
    add({
      key: 'password',
      label: 'Chính sách mật khẩu',
      weight: 15,
      status: policyStrong && cfg.passwordBlockCommon !== false ? 'ok' : cfg.passwordBlockCommon !== false ? 'warn' : 'error',
      detail: `Tối thiểu ${num('passwordMinLength', 8)} ký tự${cfg.passwordBlockCommon !== false ? ', chặn mật khẩu phổ biến' : ''}`,
      hint: policyStrong ? undefined : 'Tăng độ dài tối thiểu lên 10 hoặc yêu cầu chữ hoa + chữ số + ký tự đặc biệt',
      href: '/settings?tab=security',
    });
    add({
      key: 'brute-force',
      label: 'Chống dò mật khẩu',
      weight: 15,
      status: cfg.ipProtection !== false && num('maxFailedLogins', 5) <= 10 ? 'ok' : 'warn',
      detail: `Khoá tài khoản sau ${num('maxFailedLogins', 5)} lần sai · ${cfg.ipProtection !== false ? `chặn IP sau ${num('ipMaxFailures', 20)} lần sai / ${num('ipWindowMinutes', 15)} phút` : 'chưa bật chặn IP'}`,
      hint: cfg.ipProtection !== false ? undefined : 'Bật "Tự chặn IP đăng nhập sai nhiều lần"',
      href: '/settings?tab=security',
    });
    add({
      key: 'captcha',
      label: 'Captcha cho form công khai',
      weight: 10,
      status: cfg.captchaProvider && cfg.captchaProvider !== 'none' && cfg.captchaSiteKey ? 'ok' : 'warn',
      detail: cfg.captchaProvider && cfg.captchaProvider !== 'none' ? `Đang dùng ${String(cfg.captchaProvider)}` : 'Chưa bật — form liên hệ / đăng ký dễ bị spam',
      hint: cfg.captchaProvider && cfg.captchaProvider !== 'none' ? undefined : 'Cloudflare Turnstile miễn phí, không làm phiền người dùng',
      href: '/settings?tab=security',
    });
    add({
      key: 'session',
      label: 'Giới hạn phiên quản trị',
      weight: 10,
      status: num('adminIdleTimeoutMinutes', 0) > 0 || num('adminSessionMaxHours', 0) > 0 ? 'ok' : 'warn',
      detail:
        num('adminIdleTimeoutMinutes', 0) > 0 || num('adminSessionMaxHours', 0) > 0
          ? [num('adminIdleTimeoutMinutes', 0) > 0 && `tự đăng xuất sau ${num('adminIdleTimeoutMinutes', 0)} phút không hoạt động`, num('adminSessionMaxHours', 0) > 0 && `phiên tối đa ${num('adminSessionMaxHours', 0)} giờ`].filter(Boolean).join(', ')
          : 'Phiên quản trị sống tới khi hết hạn refresh token',
      hint: 'Đặt thời gian tự đăng xuất khi không hoạt động (vd. 60 phút)',
      href: '/settings?tab=security',
    });
    add({
      key: 'alerts',
      label: 'Cảnh báo đăng nhập',
      weight: 10,
      status: cfg.newDeviceAlert && cfg.newDeviceAlert !== 'off' && mail.host ? 'ok' : 'warn',
      detail: !mail.host ? 'Chưa cấu hình email — không gửi được cảnh báo' : cfg.newDeviceAlert === 'off' ? 'Tắt email cảnh báo thiết bị mới' : 'Email khi đăng nhập từ thiết bị mới',
      hint: !mail.host ? 'Cấu hình SMTP trong Cài đặt › Email' : undefined,
      href: !mail.host ? '/settings/emails' : '/settings?tab=security',
    });
    const jwt = process.env.JWT_ACCESS_SECRET ?? '';
    add({
      key: 'secrets',
      label: 'Khoá bí mật máy chủ',
      weight: 10,
      status: jwt.length >= 32 && !/change-me|dev-secret|chuoi-ngau-nhien/.test(jwt) ? 'ok' : prod ? 'error' : 'warn',
      detail: jwt.length >= 32 ? 'JWT_ACCESS_SECRET đủ mạnh' : 'JWT_ACCESS_SECRET quá ngắn hoặc là giá trị mẫu',
      hint: jwt.length >= 32 ? undefined : 'Đặt chuỗi ngẫu nhiên ≥ 32 ký tự trong apps/api/.env',
      href: '/tools?tab=health',
    });
    const apiUrl = process.env.API_PUBLIC_URL ?? '';
    add({
      key: 'https',
      label: 'HTTPS',
      weight: 5,
      status: apiUrl.startsWith('https://') ? 'ok' : prod ? 'error' : 'warn',
      detail: apiUrl.startsWith('https://') ? 'API chạy qua HTTPS' : 'API_PUBLIC_URL chưa dùng HTTPS',
      hint: apiUrl.startsWith('https://') ? undefined : 'Production bắt buộc HTTPS để cookie phiên không bị đánh cắp',
      href: '/tools?tab=health',
    });

    const total = checks.reduce((n, c) => n + c.weight, 0);
    const got = checks.reduce((n, c) => n + (c.status === 'ok' ? c.weight : c.status === 'warn' ? c.weight * 0.4 : 0), 0);
    const blocked = new Set(blockRules.map((r) => r.value));

    // điền đủ 14 ngày (ngày không có lượt nào = 0)
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const days: SecurityOverview['daily'] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const row = byDate.get(d);
      days.push({ date: d, success: Number(row?.success ?? 0), failed: Number(row?.failed ?? 0) });
    }

    return {
      score: Math.round((got / total) * 100),
      checks,
      stats: { failed24h, success24h, lockedUsers, blockedIps, adminsWithout2fa, admins },
      topFailedIps: topIps.filter((r) => r.ip).map((r) => ({ ip: r.ip!, count: r._count._all, blocked: blocked.has(r.ip!) })),
      daily: days,
      yourIp: yourIp ? normalizeIp(yourIp) : null,
    };
  }

  /** Dọn nhật ký cũ hơn `security.loginLogRetentionDays` (mặc định 90 ngày) */
  @Cron('45 4 * * *')
  async prune() {
    if (process.env.NODE_ENV === 'test') return;
    const cfg = await this.settings.get<{ loginLogRetentionDays?: number }>('security');
    const days = Math.min(3650, Math.max(7, Number(cfg.loginLogRetentionDays) || 90));
    const r = await this.prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - days * 86_400_000) } } });
    if (r.count) this.logger.log(`Đã dọn ${r.count} dòng nhật ký đăng nhập cũ hơn ${days} ngày`);
  }
}
