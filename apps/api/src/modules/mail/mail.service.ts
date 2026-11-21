import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import nodemailer, { type Transporter } from 'nodemailer';
import { Prisma, type EmailLog, type EmailStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SETTING_GROUPS } from '../settings/settings.defaults.js';
import { MediaService } from '../media/media.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { formatDate, formatMoney, render, type TemplateHelper } from './template-engine.js';
import { LAYOUT_KEY, defaultTemplate } from './email-templates.defaults.js';
import { buildOrderVars, type OrderVars, type OrderVarsOptions } from './order-vars.js';
import { isPermanentMailError, retryDelayMs } from './mail-retry.js';
import { frontendBaseUrl, frontendLocalePrefix, frontendUrl } from '../../common/utils/frontend-url.js';

interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  /** Hàng chờ: tối đa số email gửi mỗi phút (0 = không giới hạn) */
  rateLimitPerMinute: number;
  /** Hàng chờ: số lần thử tối đa cho mỗi email trước khi đánh dấu thất bại */
  maxAttempts: number;
  /** Hàng chờ: tạm dừng gửi (email mới vẫn được xếp hàng, gửi tiếp khi bật lại) */
  queuePaused: boolean;
}

/** Cấu hình hàng chờ đã chuẩn hoá (dùng bởi MailQueueService và trang quản trị) */
export interface MailQueueConfig {
  hostConfigured: boolean;
  paused: boolean;
  rateLimitPerMinute: number;
  maxAttempts: number;
}

/** Ưu tiên trong hàng chờ: số lớn gửi trước */
export const MAIL_PRIORITY = { low: -10, normal: 0, high: 10 } as const;

/** Đính kèm lưu trong DB khi xếp hàng (Buffer → base64) */
interface StoredAttachment {
  filename: string;
  contentType?: string;
  base64: string;
}

export interface SendMailInput {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
  /** key mẫu (để ghi log) */
  templateKey?: string | null;
  /** dữ liệu thêm ghi vào log (orderId, userId...) */
  meta?: Record<string, unknown>;
  /** File đính kèm (vd PDF hoá đơn điện tử) */
  attachments?: MailAttachment[];
  /** Gửi ngay, không qua hàng chờ (gửi thử, việc đã chạy trong job nền có thử lại riêng) */
  immediate?: boolean;
  /** Ưu tiên trong hàng chờ (MAIL_PRIORITY), mặc định 0 */
  priority?: number;
}

/** Kết quả send(): đã xếp hàng / đã gửi ngay / bỏ qua vì chưa cấu hình SMTP */
export type SendMailResult = { queued: true; logId: string } | { skipped: true; logId: string } | { messageId: string; logId: string };

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendTemplateInput {
  key: string;
  locale?: string;
  to: string | string[];
  vars: Record<string, unknown>;
  replyTo?: string;
  meta?: Record<string, unknown>;
  /** File đính kèm (vd PDF hoá đơn điện tử) */
  attachments?: MailAttachment[];
  /** ghi đè subject/html chưa lưu (dùng khi gửi thử từ trình soạn) */
  template?: { subject?: string; html?: string };
  /** Gửi ngay, không qua hàng chờ */
  immediate?: boolean;
  /** Ưu tiên trong hàng chờ (MAIL_PRIORITY), mặc định 0 */
  priority?: number;
}

export type SendTemplateResult = { status: 'QUEUED'; logId: string } | { status: 'SENT'; logId: string; messageId?: string } | { status: 'SKIPPED'; logId: string | null; reason: string } | { status: 'FAILED'; logId: string | null; error: string };

export interface ResolvedTemplate {
  key: string;
  locale: string;
  subject: string;
  html: string;
  enabled: boolean;
  source: 'db' | 'default';
}

export interface SiteVars {
  site: { name: string; url: string; logoUrl: string; primaryColor: string; email: string; phone: string; address: string; companyName: string };
  adminUrl: string;
  webUrl: string;
  year: number;
}

const i18n = (v: unknown, locale: string): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  const o = v as Record<string, string>;
  return o[locale] ?? o.vi ?? Object.values(o).find(Boolean) ?? '';
};

const LOG_RETENTION_DAYS = 90;

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  /** transporter dùng lại giữa các lần gửi; tạo lại khi cấu hình SMTP đổi */
  private transporter: { signature: string; instance: Transporter } | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly languages: LanguagesService,
    private readonly hooks: HooksService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // Gửi thô
  // ---------------------------------------------------------------------------

  private async getTransport(): Promise<{ transporter: Transporter; from: string } | null> {
    const [cfg, general] = await Promise.all([
      this.settings.get<MailSettings>('mail'),
      this.settings.get<Record<string, unknown>>('general'),
    ]);
    if (!cfg.host) return null;
    const signature = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass]);
    if (!this.transporter || this.transporter.signature !== signature) {
      this.transporter?.instance.close?.();
      this.transporter = {
        signature,
        instance: nodemailer.createTransport({
          host: cfg.host,
          port: Number(cfg.port),
          secure: Boolean(cfg.secure),
          auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
          pool: true,
          maxConnections: 3,
        }),
      };
    }
    const ownSiteName = i18n(general?.siteName, 'vi') || (this.config.get<string>('web.url') || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || 'AI Studio';
    return { transporter: this.transporter.instance, from: `"${cfg.fromName || ownSiteName}" <${cfg.fromEmail || cfg.user}>` };
  }

  /**
   * Cấu hình hàng chờ đã chuẩn hoá (giới hạn hợp lệ).
   * `fresh`: đọc thẳng DB, bỏ qua cache in-memory của SettingsService — worker dùng mỗi lượt để
   * "tạm dừng" / "giới hạn tốc độ" có hiệu lực ngay trên mọi instance API (cache chỉ xoá ở instance nhận lệnh lưu).
   */
  async queueConfig(fresh = false): Promise<MailQueueConfig> {
    const cfg = fresh
      ? ({ ...SETTING_GROUPS.mail.defaults, ...(((await this.prisma.setting.findUnique({ where: { key: 'mail' } }))?.value as object) ?? {}) } as unknown as MailSettings)
      : await this.settings.get<MailSettings>('mail');
    return {
      hostConfigured: !!cfg.host,
      paused: !!cfg.queuePaused,
      rateLimitPerMinute: Math.max(0, Math.floor(Number(cfg.rateLimitPerMinute ?? 60)) || 0),
      maxAttempts: Math.min(10, Math.max(1, Math.floor(Number(cfg.maxAttempts ?? 5)) || 5)),
    };
  }

  /**
   * Gửi email với HTML có sẵn. Mặc định xếp vào hàng chờ (bảng email_logs, trạng thái QUEUED) để
   * MailQueueService gửi nền: không làm chậm request, tự thử lại khi lỗi, tôn trọng giới hạn tốc độ.
   * - `immediate: true`: gửi ngay như trước — ném lỗi khi thất bại (đã ghi log FAILED).
   * - SMTP chưa cấu hình: ghi SKIPPED, trả `{ skipped: true }`.
   */
  async send(opts: SendMailInput): Promise<SendMailResult> {
    const cfg = await this.queueConfig();
    const base = { to: opts.to, subject: opts.subject, html: opts.html, replyTo: opts.replyTo, templateKey: opts.templateKey ?? null, meta: opts.meta };
    if (!cfg.hostConfigured) {
      const log = await this.writeLog({ ...base, status: 'SKIPPED', error: 'SMTP chưa cấu hình' });
      return { skipped: true, logId: log.id };
    }

    if (!opts.immediate) {
      const log = await this.prisma.emailLog.create({
        data: {
          to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
          subject: opts.subject,
          templateKey: opts.templateKey ?? null,
          status: 'QUEUED',
          meta: this.logMeta(base) as object,
          attachments: opts.attachments?.length ? (opts.attachments.map((f) => ({ filename: f.filename, contentType: f.contentType, base64: f.content.toString('base64') })) as object) : undefined,
          priority: opts.priority ?? MAIL_PRIORITY.normal,
          maxAttempts: cfg.maxAttempts,
          nextAttemptAt: new Date(),
        },
        select: { id: true },
      });
      return { queued: true, logId: log.id };
    }

    const transport = await this.getTransport();
    if (!transport) {
      const log = await this.writeLog({ ...base, status: 'SKIPPED', error: 'SMTP chưa cấu hình' });
      return { skipped: true, logId: log.id };
    }
    try {
      const info = await transport.transporter.sendMail({ from: transport.from, to: opts.to, subject: opts.subject, html: opts.html, replyTo: opts.replyTo, attachments: opts.attachments });
      const log = await this.writeLog({ ...base, status: 'SENT', meta: { ...(opts.meta ?? {}), messageId: info.messageId } });
      return { messageId: info.messageId, logId: log.id };
    } catch (err) {
      const log = await this.writeLog({ ...base, status: 'FAILED', error: (err as Error).message });
      throw Object.assign(err as Error, { logId: log.id });
    }
  }

  /**
   * meta lưu cùng nhật ký: kèm subject/html/replyTo để worker gửi và để gửi lại sau này.
   * Email nhạy cảm (`meta.sensitive = true`, vd email giao mã / tài khoản): `keepHtml=false` -> không lưu html
   * (chỉ giữ khi còn cần gửi: đang chờ trong hàng / chờ thử lại), tránh lộ dữ liệu trong nhật ký email.
   * Gửi lại email nhạy cảm dùng route riêng của module (vd admin/digital-codes/by-order/:id/resend), không từ nhật ký.
   */
  private logMeta(input: { subject: string; html: string; replyTo?: string; meta?: Record<string, unknown> }, keepHtml = true) {
    const redact = !keepHtml && input.meta?.sensitive === true;
    return { ...(input.meta ?? {}), subject: input.subject, html: redact ? '' : input.html, ...(redact ? { redacted: true } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}) };
  }

  /** meta đã xoá html nếu là email nhạy cảm (khi email kết thúc: gửi xong / thất bại hẳn / huỷ); null = không cần đổi */
  private redactedMeta(meta: unknown): Record<string, unknown> | null {
    const m = (meta ?? {}) as Record<string, unknown>;
    if (m.sensitive !== true || (m.redacted === true && !m.html)) return null;
    return { ...m, html: '', redacted: true };
  }

  /**
   * Gửi một email đã được worker nhận (status SENDING, attempts đã +1) rồi cập nhật kết quả:
   * thành công → SENT; lỗi tạm thời còn lượt → QUEUED với lịch thử lại; hết lượt / lỗi vĩnh viễn → FAILED.
   */
  async deliverQueued(log: EmailLog): Promise<EmailStatus> {
    const meta = (log.meta ?? {}) as Record<string, unknown>;
    const html = typeof meta.html === 'string' ? meta.html : '';
    if (!html) return this.finishFailed(log, 'Không có nội dung email để gửi');
    const transport = await this.getTransport();
    if (!transport) {
      // SMTP bị gỡ sau khi xếp hàng → trả lại hàng chờ, không tính lượt thử
      await this.prisma.emailLog.update({ where: { id: log.id }, data: { status: 'QUEUED', attempts: { decrement: 1 }, lockedAt: null, nextAttemptAt: new Date(Date.now() + 5 * 60_000), error: 'SMTP chưa cấu hình' } });
      return 'QUEUED';
    }
    const stored = Array.isArray(log.attachments) ? (log.attachments as unknown as StoredAttachment[]) : [];
    try {
      const info = await transport.transporter.sendMail({
        from: transport.from,
        to: log.to,
        subject: (meta.subject as string) || log.subject,
        html,
        replyTo: (meta.replyTo as string | undefined) || undefined,
        attachments: stored.map((f) => ({ filename: f.filename, contentType: f.contentType, content: Buffer.from(f.base64, 'base64') })),
      });
      const row = await this.prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'SENT', sentAt: new Date(), lockedAt: null, nextAttemptAt: null, error: null, attachments: Prisma.DbNull, meta: (meta.sensitive === true ? { ...meta, html: '', redacted: true, messageId: info.messageId } : { ...meta, messageId: info.messageId }) as object },
      });
      this.hooks.doAction('mail.sent', row).catch(() => undefined);
      return 'SENT';
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const permanent = isPermanentMailError(err);
      if (!permanent && log.attempts < log.maxAttempts) {
        const delay = retryDelayMs(log.attempts);
        this.logger.warn(`Email #${log.id.slice(0, 8)} tới ${log.to} lỗi (lần ${log.attempts}/${log.maxAttempts}), thử lại sau ${Math.round(delay / 60_000)} phút: ${message}`);
        await this.prisma.emailLog.update({ where: { id: log.id }, data: { status: 'QUEUED', lockedAt: null, nextAttemptAt: new Date(Date.now() + delay), error: message } });
        return 'QUEUED';
      }
      return this.finishFailed(log, permanent ? `${message} (lỗi vĩnh viễn — không thử lại)` : message);
    }
  }

  /** Đánh dấu thất bại hẳn: báo hook `mail.sent` + sự kiện `mail.failed` (thông báo cho admin). Email nhạy cảm: xoá html */
  private async finishFailed(log: EmailLog, error: string): Promise<EmailStatus> {
    const redacted = this.redactedMeta(log.meta);
    const row = await this.prisma.emailLog.update({ where: { id: log.id }, data: { status: 'FAILED', lockedAt: null, nextAttemptAt: null, error, ...(redacted ? { meta: redacted as object } : {}) } });
    this.logger.warn(`Email #${log.id.slice(0, 8)} tới ${log.to} thất bại: ${error}`);
    this.hooks.doAction('mail.sent', row).catch(() => undefined);
    this.events.emit('mail.failed', row);
    return 'FAILED';
  }

  private async writeLog(input: { to: string | string[]; subject: string; html: string; replyTo?: string; templateKey: string | null; status: EmailStatus; error?: string; meta?: Record<string, unknown> }): Promise<EmailLog> {
    const to = Array.isArray(input.to) ? input.to.join(', ') : input.to;
    let log: EmailLog;
    try {
      log = await this.prisma.emailLog.create({
        data: {
          to,
          subject: input.subject,
          templateKey: input.templateKey,
          status: input.status,
          error: input.error ?? null,
          // lưu html/subject để có thể gửi lại từ nhật ký; email nhạy cảm không bao giờ giữ html (kể cả khi lỗi)
          meta: this.logMeta(input, false) as object,
          attempts: input.status === 'SENT' || input.status === 'FAILED' ? 1 : 0,
          sentAt: input.status === 'SENT' ? new Date() : null,
        },
      });
    } catch (err) {
      this.logger.error(`Không ghi được nhật ký email: ${(err as Error).message}`);
      const now = new Date();
      log = { id: '', to, subject: input.subject, templateKey: input.templateKey, status: input.status, error: input.error ?? null, meta: {}, attempts: 0, maxAttempts: 0, nextAttemptAt: null, priority: 0, lockedAt: null, sentAt: null, attachments: null, createdAt: now, updatedAt: now };
    }
    if (log.id) this.hooks.doAction('mail.sent', log).catch(() => undefined);
    return log;
  }

  // ---------------------------------------------------------------------------
  // Mẫu email
  // ---------------------------------------------------------------------------

  /** Mẫu đang có hiệu lực: DB (key, locale) → DB (key, locale mặc định) → mặc định trong code */
  async resolveTemplate(key: string, locale?: string): Promise<ResolvedTemplate | null> {
    const def = await this.languages.defaultLocale();
    const loc = locale || def;
    const rows = await this.prisma.emailTemplate.findMany({ where: { key, locale: { in: [...new Set([loc, def])] } } });
    const row = rows.find((r) => r.locale === loc) ?? rows.find((r) => r.locale === def);
    if (row) return { key, locale: row.locale, subject: row.subject, html: row.html, enabled: row.enabled, source: 'db' };
    const d = defaultTemplate(key, loc) ?? defaultTemplate(key, def);
    if (!d) return null;
    return { key, locale: loc, subject: d.subject, html: d.html, enabled: true, source: 'default' };
  }

  /** Biến `site`, `adminUrl`, `webUrl`, `year` tự gắn vào mọi mẫu */
  async siteVars(locale: string): Promise<SiteVars> {
    const [general, contact, appearance] = await Promise.all([this.settings.get('general'), this.settings.get('contact'), this.settings.get('appearance')]);
    const logoId = (general.logo as string | null) ?? null;
    const logo = logoId ? (await this.media.findMany([logoId])).get(logoId) : null;
    const webUrl = (this.config.get<string>('web.url') || (general.siteUrl as string) || '').replace(/\/$/, '');
    const adminUrl = (this.config.get<string>('adminUrl') || '').replace(/\/$/, '');
    // site.url = trang chủ đúng ngôn ngữ của email (mặc định không tiền tố, ngôn ngữ khác /{locale});
    // webUrl giữ địa chỉ gốc không tiền tố (mẫu tự ghép đường dẫn thì tự thêm tiền tố nếu cần)
    const siteHome = webUrl ? `${webUrl}${await frontendLocalePrefix({ locale, languages: this.languages })}` : '';
    const fallbackName = webUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || 'AI Studio';
    return {
      site: {
        name: i18n(general.siteName, locale) || fallbackName,
        url: siteHome,
        logoUrl: logo?.url ?? '',
        primaryColor: (appearance.primaryColor as string) || '#2563eb',
        email: (contact.email as string) || '',
        phone: (contact.hotline as string) || (contact.phone as string) || '',
        address: i18n(contact.address, locale),
        companyName: (contact.companyName as string) || '',
      },
      adminUrl,
      webUrl,
      year: new Date().getFullYear(),
    };
  }

  /** Helper money/date theo Cài đặt › Bán hàng / Chung */
  private async helpers(): Promise<Record<string, TemplateHelper>> {
    const [commerce, general] = await Promise.all([this.settings.get('commerce'), this.settings.get('general')]);
    const tz = (general.timezone as string) || 'Asia/Ho_Chi_Minh';
    return {
      money: (v) => formatMoney(v, commerce as never),
      date: (v, withTime) => formatDate(v, tz, withTime !== false && withTime !== 'short'),
    };
  }

  /**
   * Render mẫu (subject + html đã bọc layout) với biến. Dùng cho xem trước và gửi.
   * `override` cho phép render nội dung chưa lưu.
   */
  async renderTemplate(key: string, locale: string | undefined, vars: Record<string, unknown>, override?: { subject?: string; html?: string }): Promise<{ subject: string; html: string; template: ResolvedTemplate } | null> {
    const tpl = await this.resolveTemplate(key, locale);
    if (!tpl) return null;
    const loc = tpl.locale;
    const [site, helpers] = await Promise.all([this.siteVars(loc), this.helpers()]);
    const full: Record<string, unknown> = { ...site, ...vars, locale: loc };
    const subjectSrc = override?.subject ?? tpl.subject;
    const htmlSrc = override?.html ?? tpl.html;
    const subject = render(subjectSrc, full, { helpers }).replace(/\s+/g, ' ').trim();
    let html = render(htmlSrc, { ...full, subject }, { helpers });
    if (key !== LAYOUT_KEY && !/<body[\s>]/i.test(html)) {
      const layout = await this.resolveTemplate(LAYOUT_KEY, loc);
      if (layout) html = render(layout.html, { ...full, subject, body: html }, { helpers });
    }
    return { subject, html, template: tpl };
  }

  /**
   * Gửi email theo mẫu. Không ném lỗi — trả về trạng thái và ghi EmailLog (SENT/FAILED/SKIPPED).
   * Module khác có thể sửa/huỷ qua filter `mail.beforeSend` (trả null để huỷ).
   */
  async sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
    const recipients = (Array.isArray(input.to) ? input.to : [input.to]).map((e) => String(e ?? '').trim()).filter(Boolean);
    const meta = { ...(input.meta ?? {}), locale: input.locale };
    if (!recipients.length) return { status: 'SKIPPED', logId: null, reason: 'Không có người nhận' };
    let rendered: Awaited<ReturnType<MailService['renderTemplate']>>;
    try {
      rendered = await this.renderTemplate(input.key, input.locale, input.vars, input.template);
    } catch (err) {
      const msg = `Render mẫu lỗi: ${(err as Error).message}`;
      const log = await this.writeLog({ to: recipients, subject: input.key, html: '', templateKey: input.key, status: 'FAILED', error: msg, meta });
      return { status: 'FAILED', logId: log.id || null, error: msg };
    }
    if (!rendered) {
      const log = await this.writeLog({ to: recipients, subject: input.key, html: '', templateKey: input.key, status: 'FAILED', error: `Không có mẫu "${input.key}"`, meta });
      return { status: 'FAILED', logId: log.id || null, error: `Không có mẫu "${input.key}"` };
    }
    if (!rendered.template.enabled && !input.template) {
      const log = await this.writeLog({ to: recipients, subject: rendered.subject, html: rendered.html, templateKey: input.key, status: 'SKIPPED', error: 'Mẫu đang tắt', meta });
      return { status: 'SKIPPED', logId: log.id || null, reason: 'Mẫu đang tắt' };
    }

    const payload = await this.hooks.applyFilters<{ to: string[]; subject: string; html: string; key: string; vars: Record<string, unknown>; replyTo?: string } | null>('mail.beforeSend', {
      to: recipients,
      subject: rendered.subject,
      html: rendered.html,
      key: input.key,
      vars: input.vars,
      replyTo: input.replyTo,
    });
    if (!payload) {
      const log = await this.writeLog({ to: recipients, subject: rendered.subject, html: rendered.html, templateKey: input.key, status: 'SKIPPED', error: 'Bị huỷ bởi filter (mail.beforeSend)', meta });
      return { status: 'SKIPPED', logId: log.id || null, reason: 'Bị huỷ bởi filter mail.beforeSend' };
    }

    try {
      const res = await this.send({ to: payload.to, subject: payload.subject, html: payload.html, replyTo: payload.replyTo, templateKey: input.key, meta, attachments: input.attachments, immediate: input.immediate, priority: input.priority });
      if ('queued' in res) return { status: 'QUEUED', logId: res.logId };
      if ('skipped' in res) return { status: 'SKIPPED', logId: res.logId || null, reason: 'SMTP chưa cấu hình' };
      return { status: 'SENT', logId: res.logId, messageId: res.messageId };
    } catch (err) {
      this.logger.warn(`Gửi email "${input.key}" tới ${payload.to.join(', ')} thất bại: ${(err as Error).message}`);
      return { status: 'FAILED', logId: (err as { logId?: string }).logId ?? null, error: (err as Error).message };
    }
  }

  /**
   * Gửi lại email từ nhật ký (dùng html/subject đã lưu trong meta), ưu tiên cao:
   * - Thất bại / bỏ qua / đã huỷ: đưa chính bản ghi đó trở lại hàng chờ (đếm lại số lần thử).
   * - Đang chờ thử lại: gửi ngay ở lượt kế tiếp của worker.
   * - Đã gửi: tạo bản ghi mới (resendOf) trong hàng chờ.
   */
  async resend(logId: string): Promise<EmailLog> {
    const log = await this.prisma.emailLog.findUniqueOrThrow({ where: { id: logId } });
    const meta = (log.meta ?? {}) as Record<string, unknown>;
    // email nhạy cảm (giao mã / tài khoản) không gửi lại từ nhật ký — dùng "Gửi lại email" trong chi tiết đơn hàng
    if (meta.sensitive === true) throw new Error('Email này chứa mã / tài khoản nên không gửi lại từ nhật ký. Hãy dùng "Gửi lại email" trong chi tiết đơn hàng.');
    const html = typeof meta.html === 'string' ? meta.html : '';
    if (!html) throw new Error('Nhật ký này không lưu nội dung email, không thể gửi lại');
    const cfg = await this.queueConfig();
    if (!cfg.hostConfigured) throw new Error('Chưa cấu hình máy chủ SMTP (Cài đặt › Email SMTP)');
    if (log.status === 'SENDING') throw new Error('Email đang được gửi, hãy đợi vài giây');
    if (log.status !== 'SENT') {
      return this.prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'QUEUED', attempts: log.status === 'QUEUED' ? log.attempts : 0, maxAttempts: log.status === 'QUEUED' ? log.maxAttempts : cfg.maxAttempts, nextAttemptAt: new Date(), priority: Math.max(log.priority, MAIL_PRIORITY.high), lockedAt: null, ...(log.status === 'QUEUED' ? {} : { error: null }) },
      });
    }
    const to = log.to.split(',').map((s) => s.trim()).filter(Boolean);
    const { html: _h, subject: _s, messageId: _m, resendOf: _r, ...rest } = meta;
    const res = await this.send({ to, subject: (meta.subject as string) || log.subject, html, replyTo: meta.replyTo as string | undefined, templateKey: log.templateKey, meta: { ...rest, resendOf: log.id }, priority: MAIL_PRIORITY.high });
    return this.prisma.emailLog.findUniqueOrThrow({ where: { id: res.logId } });
  }

  /** Huỷ email còn trong hàng chờ (chưa gửi). Email nhạy cảm: xoá luôn html khỏi nhật ký */
  async cancel(logId: string): Promise<EmailLog> {
    const r = await this.prisma.emailLog.updateMany({ where: { id: logId, status: 'QUEUED' }, data: { status: 'CANCELLED', nextAttemptAt: null, lockedAt: null, attachments: Prisma.DbNull } });
    if (!r.count) throw new Error('Chỉ huỷ được email đang chờ gửi');
    const row = await this.prisma.emailLog.findUniqueOrThrow({ where: { id: logId } });
    const redacted = this.redactedMeta(row.meta);
    return redacted ? this.prisma.emailLog.update({ where: { id: logId }, data: { meta: redacted as object } }) : row;
  }

  /** Đưa mọi email thất bại trong N ngày gần đây (còn lưu nội dung) trở lại hàng chờ */
  async retryFailed(days = 7): Promise<number> {
    const cfg = await this.queueConfig();
    if (!cfg.hostConfigured) throw new Error('Chưa cấu hình máy chủ SMTP (Cài đặt › Email SMTP)');
    return this.prisma.$executeRaw`
      UPDATE "email_logs" SET "status" = 'QUEUED', "attempts" = 0, "maxAttempts" = ${cfg.maxAttempts}, "nextAttemptAt" = now(), "error" = NULL, "lockedAt" = NULL, "updatedAt" = now()
      WHERE "status" = 'FAILED' AND "createdAt" > now() - make_interval(days => ${days}) AND coalesce("meta"->>'html', '') <> ''`;
  }

  /** Huỷ toàn bộ email đang chờ (vd cấu hình sai, gửi nhầm hàng loạt) */
  async cancelAllQueued(): Promise<number> {
    const r = await this.prisma.emailLog.updateMany({ where: { status: 'QUEUED' }, data: { status: 'CANCELLED', nextAttemptAt: null, attachments: Prisma.DbNull } });
    // email nhạy cảm vừa huỷ: xoá html khỏi nhật ký (không gửi lại từ nhật ký được)
    if (r.count) {
      await this.prisma.$executeRaw`
        UPDATE "email_logs" SET "meta" = "meta" || '{"html":"","redacted":true}'::jsonb, "updatedAt" = now()
        WHERE "status" = 'CANCELLED' AND "meta"->>'sensitive' = 'true' AND coalesce("meta"->>'html', '') <> ''`;
    }
    return r.count;
  }

  /** Số liệu hàng chờ cho trang quản trị */
  async queueStats() {
    const now = Date.now();
    const day = new Date(now - 86_400_000);
    const [cfg, queued, retrying, sending, sent24h, failed24h, sentLastMinute, oldest, next] = await Promise.all([
      this.queueConfig(),
      this.prisma.emailLog.count({ where: { status: 'QUEUED' } }),
      this.prisma.emailLog.count({ where: { status: 'QUEUED', attempts: { gt: 0 } } }),
      this.prisma.emailLog.count({ where: { status: 'SENDING' } }),
      this.prisma.emailLog.count({ where: { status: 'SENT', sentAt: { gte: day } } }),
      this.prisma.emailLog.count({ where: { status: 'FAILED', updatedAt: { gte: day } } }),
      this.prisma.emailLog.count({ where: { sentAt: { gte: new Date(now - 60_000) } } }),
      this.prisma.emailLog.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.emailLog.findFirst({ where: { status: 'QUEUED' }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } }),
    ]);
    return { ...cfg, queued, retrying, sending, sent24h, failed24h, sentLastMinute, oldestQueuedAt: oldest?.createdAt ?? null, nextAttemptAt: next?.nextAttemptAt ?? null };
  }

  // ---------------------------------------------------------------------------
  // Tiện ích biến
  // ---------------------------------------------------------------------------

  /**
   * Biến `order` cho mẫu email từ bản ghi Order (include items), tự điền webUrl/adminUrl
   * và nhãn phương thức thanh toán. Nơi khác gọi: `vars: { order: await mail.orderVars(order) }`.
   */
  async orderVars(order: Record<string, any>, locale?: string, extra: Partial<OrderVarsOptions> = {}): Promise<OrderVars> {
    const loc = locale || (order.locale as string) || (await this.languages.defaultLocale());
    const commerce = await this.settings.get<{ paymentMethods?: { key: string; label: Record<string, string> }[] }>('commerce');
    const labels: Record<string, string> = {};
    for (const m of commerce.paymentMethods ?? []) labels[m.key] = i18n(m.label, loc);
    try {
      for (const m of await this.payments.methods(loc)) labels[m.key] = m.label;
    } catch {
      // không có cổng online -> giữ nhãn offline
    }
    // địa chỉ website giống mọi chỗ khác (WEB_URL → Cài đặt › Chung › Địa chỉ website);
    // trackingUrl/payUrl được gắn tiền tố ngôn ngữ theo order.locale bên trong buildOrderVars
    const [webUrl, defaultLocale] = await Promise.all([frontendBaseUrl(this.config, this.settings), this.languages.defaultLocale()]);
    const adminUrl = (this.config.get<string>('adminUrl') || '').replace(/\/$/, '');
    // ngôn ngữ link: ngôn ngữ đặt đơn (đã chuẩn hoá — ngôn ngữ đã tắt quay về mặc định), không có thì theo ngôn ngữ email
    const linkLocale = await this.languages.resolve((order.locale as string) || loc);
    return buildOrderVars(order, { locale: loc, linkLocale, defaultLocale, webUrl, adminUrl, paymentMethodLabels: labels, isOnlinePayment: this.payments.isOnline(String(order.paymentMethod ?? '')), ...extra });
  }

  /**
   * Link tuyệt đối tới website khách kèm tiền tố ngôn ngữ (mặc định không tiền tố, ngôn ngữ khác /{locale}).
   * Trả "" khi chưa cấu hình địa chỉ website — dùng cho biến link trong email (`{{#if accountUrl}}`).
   */
  async frontendLink(path: string, locale?: string | null): Promise<string> {
    return (await frontendUrl(this.config, this.settings, path, { locale, languages: this.languages })) ?? '';
  }

  /** Lấy bản ghi đơn (kèm items) rồi dựng biến — dùng khi chỉ có id */
  async orderVarsById(orderId: string, locale?: string): Promise<OrderVars | null> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    return order ? this.orderVars(order, locale) : null;
  }

  // ---------------------------------------------------------------------------
  // Dọn nhật ký
  // ---------------------------------------------------------------------------

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanupLogs() {
    // chỉ dọn bản ghi đã kết thúc — email còn chờ/đang gửi giữ lại cho worker
    const r = await this.prisma.emailLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000) }, status: { in: ['SENT', 'FAILED', 'SKIPPED', 'CANCELLED'] } } });
    if (r.count) this.logger.log(`Đã dọn ${r.count} nhật ký email cũ hơn ${LOG_RETENTION_DAYS} ngày`);
  }
}
