import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ALL_SETTINGS_ACCESS_PERMISSIONS, findContactChannel, hasAnyPermission, hasPermission, normalizeContactButtons } from '@cmsnt/shared';
import { IsEmail } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { SettingsService } from './settings.service.js';
import { SETTING_GROUPS } from './settings.defaults.js';
import { mergeRestrictedWebMenu, normalizeWebMenu } from './web-menu.js';
import { MailService } from '../mail/mail.service.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { isChildSite } from '../../common/utils/tenant.js';

const MASK = '••••••••';
/** Trường bí mật theo nhóm — không trả về admin, chỉ trả chuỗi mask */
const SECRET_FIELDS: Record<string, string[]> = {
  mail: ['pass'],
  security: ['captchaSecretKey'],
  // khoá API / chữ ký của cổng thanh toán
  payos: ['apiKey', 'checksumKey'],
  sepay: ['apiKey', 'hmacSecret'],
  pay2s: ['accessKey', 'secretKey', 'webhookToken'],
  web2m: ['token'],
  usdt: ['apiKey'],
  // khoá đối tác nhà cung cấp đổi thẻ cào
  card_topup: ['partnerKey'],
  // khoá API nhà cung cấp AI (modules/ai)
  ai_tmc: ['apiKey'],
  ai_aideepcut: ['apiKey', 'sessionCookie'],
  ai_kapend: ['apiKey'],
  ai_imgstudio: ['apiKey'],
  ai_vidgrab: ['apiKey'],
  ai_yupvox: ['apiKey'],
  ai_ahiep: ['apiKey'],
  ai_vimo: ['apiKey'],
  ai_tavtavvideo: ['apiKey'],
  ai_runup: ['apiKey'],
  ai_fable: ['apiKey'],
  ai_prismforge: ['apiKey'],
  ai_up4k: ['apiKey'],
  ai_ivoi: ['apiKey'],
  ai_tramsangtao: ['apiKey'],
  ai_gommo: ['apiKey'],
  ai_botsd: ['apiKey'],
  ai_maivideo: ['apiKey', 'sessionCookie'],
  ai_aishop24: ['apiKey'],
  ai_plenxai: ['apiKey', 'sessionCookie'],
  ai_seedancebot: ['apiKey'],
  // token bot Telegram (modules/telegram)
  telegram_user: ['botToken'],
  telegram_admin: ['botToken'],
};
/**
 * Quyền cần có theo từng nhóm cài đặt (mảng = chỉ cần một trong các quyền; '*' = chỉ siêu quản trị).
 * Lưu ý: `hasPermission` đã tự cho phép `settings.manage` (vai trò cũ / toàn bộ cài đặt) thỏa mãn mọi `settings.<mục>`.
 * Riêng `mail` trên site chính: chỉ cho phép khi có '*' hoặc được siêu quản trị cấp đích danh `settings.mail`
 * (vai trò chỉ có `settings.manage` chung không tự sửa được SMTP trên site chính để tránh leo thang đặc quyền).
 */
const GROUP_WRITE_PERMS: Record<string, string | string[]> = {
  general: 'settings.general',
  features: 'settings.features',
  contact: 'settings.contact',
  social: 'settings.contact',
  appearance: 'settings.appearance',
  contactButtons: 'settings.contactButtons',
  popup: 'settings.popup',
  seo: 'settings.seo',
  credits: 'settings.credits',
  ai: 'settings.ai_general',
  currency: 'settings.currency',
  commerce: ['settings.commerce', 'settings.tax'],
  web2m: 'settings.payments',
  usdt: 'settings.payments',
  payos: 'settings.payments',
  sepay: 'settings.payments',
  pay2s: 'settings.payments',
  card_topup: 'settings.payments',
  wallet: 'settings.payments',
  shipping: 'settings.shipping',
  digital: 'settings.digital',
  einvoice: ['settings.einvoice', 'einvoice.settings'],
  mail: 'settings.mail',
  orderNotification: 'settings.notifications',
  telegram_user: 'settings.telegram_user',
  telegram_admin: 'settings.telegram_admin',
  account: 'settings.account',
  comments: 'settings.comments',
  security: 'settings.security',
  scripts: 'settings.scripts',
  tracking: 'settings.tracking',
  analytics: 'settings.analytics',
  demo: 'settings.demo',
  logging: 'settings.logging',
  web_menu: ['web_menu.manage', 'settings.general', 'settings.appearance'],
  affiliate: ['affiliate.manage', 'settings.manage'],
  backup: 'settings.manage',
  // khoá API nhà cung cấp AI: đổi baseUrl sang máy chủ lạ là lấy được khoá thật -> chỉ siêu quản trị
  ai_tmc: '*',
  ai_kapend: '*',
  ai_aideepcut: '*',
  ai_imgstudio: '*',
  ai_vidgrab: '*',
  ai_yupvox: '*',
  ai_ahiep: '*',
  ai_vimo: '*',
  ai_tavtavvideo: '*',
  ai_runup: '*',
  ai_fable: '*',
  ai_prismforge: '*',
  ai_up4k: '*',
  ai_ivoi: '*',
  ai_tramsangtao: '*',
  ai_gommo: '*',
  ai_botsd: '*',
  ai_maivideo: '*',
  ai_aishop24: '*',
  ai_plenxai: '*',
  ai_seedancebot: '*',
  // danh sách nhóm công cụ AI: cùng quyền với trang Công cụ AI
  ai_categories: 'ai.tools',
};

/** Một số trang khác chỉ đọc nhóm cài đặt (vd trang SEO đọc `seo`, trang lập HĐĐT đọc `einvoice`) */
const GROUP_EXTRA_READ_PERMS: Record<string, string[]> = {
  seo: ['seo.manage'],
  einvoice: ['einvoice.read', 'einvoice.write'],
};

/**
 * Web con: admin web con không có '*' (chỉ novai-hub ghi thẳng DB), nên nhóm nào cần '*' là bị khoá hẳn.
 * - Khoá thêm cổng thanh toán, thẻ cào, sao lưu: đang dùng khoá / tài khoản của web chính.
 * - Mở mail cho settings.mail (hoặc settings.manage): web con không có siêu quản trị và phải tự dùng SMTP riêng.
 */
const CHILD_LOCKED_GROUPS = new Set(['payos', 'sepay', 'pay2s', 'web2m', 'usdt', 'card_topup', 'backup']);

const canAccessGroup = (group: string, user: AuthUser, mode: 'read' | 'write'): { ok: boolean; superOnly?: boolean } => {
  const isAiProviderGroup = group.startsWith('ai_') && group !== 'ai_categories';
  if (isAiProviderGroup) {
    if (isChildSite()) return { ok: false, superOnly: true };
    return { ok: user.permissions.includes('*'), superOnly: !user.permissions.includes('*') };
  }
  if (user.permissions.includes('*')) return { ok: true };
  if (mode === 'write' && isChildSite() && CHILD_LOCKED_GROUPS.has(group)) {
    return { ok: false, superOnly: true };
  }
  // Trên site chính, sửa / gửi thử SMTP đòi hỏi '*' hoặc quyền đích danh `settings.mail`
  if (group === 'mail' && !isChildSite() && mode === 'write') {
    return { ok: user.permissions.includes('settings.mail'), superOnly: !user.permissions.includes('settings.mail') };
  }
  const need = GROUP_WRITE_PERMS[group] ?? 'settings.manage';
  if (need === '*') {
    // Cho phép đọc trạng thái đã che (mask) nếu có quyền liên quan trên web con, còn ghi thì chặn hoàn toàn
    if (mode === 'read' && group === 'backup') return { ok: hasPermission(user.permissions, 'settings.manage') };
    return { ok: false, superOnly: true };
  }
  const candidates = [...(Array.isArray(need) ? need : [need]), ...(mode === 'read' ? (GROUP_EXTRA_READ_PERMS[group] ?? []) : [])];
  return { ok: hasAnyPermission(user.permissions, candidates) };
};

const assertGroupAccess = (group: string, user: AuthUser, mode: 'read' | 'write') => {
  const res = canAccessGroup(group, user, mode);
  if (!res.ok) {
    throw new ForbiddenException(res.superOnly ? 'Chỉ siêu quản trị mới được đổi cấu hình này' : 'Bạn không có quyền truy cập mục cài đặt này');
  }
};
const mask = (group: string, v: Record<string, unknown>) => {
  const fields = SECRET_FIELDS[group];
  if (!fields) return v;
  const out = { ...v };
  for (const f of fields) if (out[f]) out[f] = MASK;
  return out;
};

class TestMailDto {
  @IsEmail({}, { message: 'Email nhận không hợp lệ' }) to: string;
}

@Controller('admin/settings')
@RequirePermissions('admin.access')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly mail: MailService,
  ) {}

  @Get()
  async all(@CurrentUser() user: AuthUser) {
    const all = await this.settings.all();
    const allowed = Object.entries(all).filter(([k]) => canAccessGroup(k, user, 'read').ok);
    if (!allowed.length && !hasAnyPermission(user.permissions, ALL_SETTINGS_ACCESS_PERMISSIONS)) {
      throw new ForbiddenException('Bạn không có quyền truy cập cài đặt');
    }
    const canManageWebMenu = hasPermission(user.permissions, 'web_menu.manage');
    return Object.fromEntries(
      allowed.map(([k, v]) => [k, k === 'web_menu' && !canManageWebMenu ? mergeRestrictedWebMenu(v, {}) : mask(k, v)]),
    );
  }

  @Get('groups')
  groups(@CurrentUser() user: AuthUser) {
    return Object.keys(SETTING_GROUPS).filter((k) => canAccessGroup(k, user, 'read').ok);
  }

  /** Gửi email thử với cấu hình SMTP đã lưu */
  @Post('mail/test')
  @HttpCode(200)
  async testMail(@Body() dto: TestMailDto, @CurrentUser() user: AuthUser) {
    assertGroupAccess('mail', user, 'write');
    try {
      const res = await this.mail.send({
        to: dto.to,
        subject: 'Email thử từ CMSNT Panel',
        html: '<p>Xin chào! Nếu bạn nhận được email này, cấu hình SMTP đã hoạt động.</p>',
        // gửi ngay để báo lỗi kết nối SMTP tức thì
        immediate: true,
      });
      if ('skipped' in res) throw new BadRequestException('Chưa cấu hình máy chủ SMTP (host)');
      return { success: true, messageId: 'messageId' in res ? res.messageId : undefined };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Gửi thất bại: ${(err as Error).message}`);
    }
  }

  @Get(':group')
  async get(@Param('group') group: string, @CurrentUser() user: AuthUser) {
    assertGroupAccess(group, user, 'read');
    const val = await this.settings.get(group);
    if (group === 'web_menu' && !hasPermission(user.permissions, 'web_menu.manage')) {
      return mergeRestrictedWebMenu(val, {});
    }
    return mask(group, val);
  }

  @Put(':group')
  async update(@Param('group') group: string, @Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    assertGroupAccess(group, user, 'write');
    const value = { ...body };
    // giữ nguyên secret cũ khi client gửi lại chuỗi mask
    for (const f of SECRET_FIELDS[group] ?? []) if (value[f] === MASK) delete value[f];
    // danh sách IP quản trị chỉ bật/tắt qua Trung tâm bảo mật (kiểm tra IP hiện tại để không tự khoá mình ngoài)
    if (group === 'security') delete value.adminIpAllowlist;
    // nút liên hệ nổi: giữ đúng cấu trúc danh sách kênh, cắt giá trị quá dài; bỏ khoá kiểu cũ (phone/zalo/messenger) đã chuyển vào items
    if (group === 'contactButtons') {
      const cb = normalizeContactButtons(value);
      cb.items = cb.items.slice(0, 30).map((it) => ({ ...it, label: (it.label.trim() || findContactChannel(it.key)?.label || 'Liên hệ').slice(0, 60), url: it.url.trim().slice(0, 500), icon: it.icon.slice(0, 500) }));
      return this.settings.update(group, { ...cb, phone: '', zalo: '', messenger: '' } as unknown as Record<string, unknown>, user.id);
    }
    // thông báo nổi: chỉ nhận đúng các trường, cắt độ dài, giá trị lựa chọn sai thì về mặc định
    if (group === 'popup') return this.settings.update(group, normalizePopup(value), user.id);
    // nạp tiền & khuyến mãi: CTV / web con (không có '*') chỉ được sửa đúng mục "Khuyến mãi theo mốc nạp" (`topup.tiers`), giữ nguyên 100% tỉ lệ quy đổi, thưởng đăng ký, số luồng & khuyến mãi hệ thống
    if (group === 'credits' && (isChildSite() || !user.permissions.includes('*'))) {
      const current = ((await this.settings.get('credits')) ?? {}) as Record<string, unknown>;
      const curTopup = (current.topup && typeof current.topup === 'object' ? current.topup : {}) as Record<string, unknown>;
      const nextTopup = (value.topup && typeof value.topup === 'object' ? value.topup : {}) as Record<string, unknown>;
      const rawTiers = Array.isArray(nextTopup.tiers) ? nextTopup.tiers : Array.isArray(curTopup.tiers) ? curTopup.tiers : [];
      const tiers = rawTiers
        .slice(0, 20)
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((t) => ({
          min: Math.max(1000, Math.round(Number(t.min) || 0)),
          bonus: Math.min(100, Math.max(0, Math.round((Number(t.bonus) || 0) * 100) / 100)),
        }));
      return mask(
        group,
        await this.settings.update(
          group,
          {
            ...current,
            topup: {
              ...curTopup,
              tiers,
            },
          },
          user.id,
        ),
      );
    }
    // menu website khách: CTV (không có `web_menu.manage`) chỉ được sửa đúng 2 mục liên kết cộng đồng (Telegram & FB); các mục hệ thống giữ nguyên
    if (group === 'web_menu') {
      if (!hasPermission(user.permissions, 'web_menu.manage')) {
        const current = await this.settings.get('web_menu');
        return this.settings.update(group, mergeRestrictedWebMenu(current, value) as unknown as Record<string, unknown>, user.id);
      }
      return this.settings.update(group, normalizeWebMenu(value) as unknown as Record<string, unknown>, user.id);
    }
    return mask(group, await this.settings.update(group, value, user.id));
  }
}

/** Chuẩn hoá cài đặt thông báo nổi (nhóm `popup`) trước khi lưu */
function normalizePopup(v: Record<string, unknown>): Record<string, unknown> {
  const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const pick = (x: unknown, list: string[], def: string) => (typeof x === 'string' && list.includes(x) ? x : def);
  const delay = Math.round(Number(v.delay));
  return {
    enabled: v.enabled === true,
    title: str(v.title, 150),
    content: str(v.content, 5000),
    image: str(v.image, 500),
    buttonLabel: str(v.buttonLabel, 60),
    buttonUrl: str(v.buttonUrl, 500),
    audience: pick(v.audience, ['all', 'member', 'guest'], 'all'),
    frequency: pick(v.frequency, ['once', 'daily', 'session', 'always'], 'once'),
    // số giây chờ trước khi hiện (0–60)
    delay: Number.isFinite(delay) ? Math.min(60, Math.max(0, delay)) : 1,
  };
}
