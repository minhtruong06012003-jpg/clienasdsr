import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { paginate, pageArgs } from '../../common/dto/pagination.dto.js';
import { MailService } from './mail.service.js';
import { EMAIL_TEMPLATES, EMAIL_TEMPLATE_GROUPS, EMAIL_TEMPLATE_MAP, defaultTemplate } from './email-templates.defaults.js';
import { sampleVars } from './email-samples.js';
import { SettingsService } from '../settings/settings.service.js';
import { frontendLocaleBaseUrl } from '../../common/utils/frontend-url.js';
import type { EmailLogQueryDto, PreviewEmailTemplateDto, TestEmailTemplateDto, UpsertEmailTemplateDto } from './mail.dto.js';

/** Thay cho nội dung email nhạy cảm trong nhật ký */
const SENSITIVE_LOG_NOTE = 'Nội dung chứa mã / tài khoản nên không lưu lại. Muốn gửi lại, mở đơn hàng và bấm "Gửi lại email" ở thẻ Mã đã giao.';

/** Quản trị mẫu email + nhật ký email (admin) */
@Injectable()
export class EmailTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    /** đọc địa chỉ website (Cài đặt › Chung) khi chưa đặt WEB_URL (tuỳ chọn để test dựng service dễ) */
    private readonly settings?: SettingsService,
  ) {}

  private def(key: string) {
    const d = EMAIL_TEMPLATE_MAP[key];
    if (!d) throw new NotFoundException(`Không có mẫu email "${key}"`);
    return d;
  }

  private async locales() {
    const langs = await this.languages.list(true);
    const defaultLocale = await this.languages.defaultLocale();
    const codes = langs.map((l) => l.code);
    if (!codes.includes(defaultLocale)) codes.unshift(defaultLocale);
    return { codes, defaultLocale };
  }

  private isCustomized(row: { key: string; locale: string; subject: string; html: string }) {
    const d = defaultTemplate(row.key, row.locale);
    return !d || d.subject !== row.subject || d.html !== row.html;
  }

  /** Danh sách mẫu + trạng thái tuỳ chỉnh / bật tắt theo locale */
  async list() {
    const { codes, defaultLocale } = await this.locales();
    const rows = await this.prisma.emailTemplate.findMany();
    const data = EMAIL_TEMPLATES.map((t) => {
      const perLocale: Record<string, { exists: boolean; customized: boolean; enabled: boolean }> = {};
      for (const code of codes) {
        const row = rows.find((r) => r.key === t.key && r.locale === code);
        perLocale[code] = { exists: !!row, customized: row ? this.isCustomized(row) : false, enabled: row ? row.enabled : true };
      }
      return {
        key: t.key,
        name: t.name,
        description: t.description,
        group: t.group,
        audience: t.audience,
        customized: Object.values(perLocale).some((l) => l.customized),
        enabled: Object.values(perLocale).every((l) => l.enabled),
        locales: perLocale,
        updatedAt: rows.filter((r) => r.key === t.key).reduce<Date | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), null),
      };
    });
    return { data, groups: EMAIL_TEMPLATE_GROUPS, locales: codes, defaultLocale };
  }

  /** Chi tiết mẫu theo locale: nội dung hiện tại + mặc định + biến */
  async get(key: string, locale?: string) {
    const d = this.def(key);
    const { defaultLocale } = await this.locales();
    const loc = locale || defaultLocale;
    const row = await this.prisma.emailTemplate.findUnique({ where: { key_locale: { key, locale: loc } } });
    const def = defaultTemplate(key, loc) ?? { subject: '', html: '' };
    return {
      key,
      name: d.name,
      description: d.description,
      group: d.group,
      audience: d.audience,
      vars: d.vars,
      locale: loc,
      subject: row?.subject ?? def.subject,
      html: row?.html ?? def.html,
      enabled: row?.enabled ?? true,
      customized: row ? this.isCustomized(row) : false,
      default: def,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async upsert(key: string, dto: UpsertEmailTemplateDto) {
    this.def(key);
    if (!dto.subject.trim()) throw new BadRequestException('Tiêu đề email không được để trống');
    if (!dto.html.trim()) throw new BadRequestException('Nội dung email không được để trống');
    if (key === 'layout' && !dto.html.includes('{{{body}}}')) throw new BadRequestException('Bố cục chung phải chứa {{{body}}} để chèn nội dung email');
    const data = { subject: dto.subject, html: dto.html, ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }) };
    await this.prisma.emailTemplate.upsert({
      where: { key_locale: { key, locale: dto.locale } },
      create: { key, locale: dto.locale, ...data, enabled: dto.enabled ?? true },
      update: data,
    });
    return this.get(key, dto.locale);
  }

  /**
   * Bật/tắt nhanh cho mọi ngôn ngữ. Tắt: tạo bản ghi (nội dung mặc định) nếu chưa có.
   * Bật: cập nhật cờ; bản ghi chưa tuỳ chỉnh thì xoá luôn cho gọn (về mặc định).
   */
  async toggle(key: string, enabled: boolean) {
    this.def(key);
    const { codes } = await this.locales();
    const rows = await this.prisma.emailTemplate.findMany({ where: { key } });
    await this.prisma.$transaction(
      codes.map((locale) => {
        const row = rows.find((r) => r.locale === locale);
        const def = defaultTemplate(key, locale) ?? { subject: '', html: '' };
        if (enabled && row && !this.isCustomized(row)) return this.prisma.emailTemplate.delete({ where: { id: row.id } });
        return this.prisma.emailTemplate.upsert({ where: { key_locale: { key, locale } }, create: { key, locale, subject: def.subject, html: def.html, enabled }, update: { enabled } });
      }),
    );
    return { key, enabled };
  }

  /** Khôi phục mặc định (giữ trạng thái tắt nếu đang tắt) */
  async reset(key: string, locale?: string) {
    this.def(key);
    const { defaultLocale } = await this.locales();
    const loc = locale || defaultLocale;
    const row = await this.prisma.emailTemplate.findUnique({ where: { key_locale: { key, locale: loc } } });
    if (row) {
      if (row.enabled) await this.prisma.emailTemplate.delete({ where: { id: row.id } });
      else {
        const def = defaultTemplate(key, loc) ?? { subject: '', html: '' };
        await this.prisma.emailTemplate.update({ where: { id: row.id }, data: { subject: def.subject, html: def.html } });
      }
    }
    return this.get(key, loc);
  }

  /**
   * Địa chỉ cho dữ liệu mẫu: webUrl = địa chỉ website + tiền tố ngôn ngữ của mẫu đang xem
   * (mặc định không tiền tố, ngôn ngữ khác /{locale}) để link mẫu giống email thật.
   */
  private async urls(locale: string) {
    const fallback = (this.config.get<string>('web.url') || '').replace(/\/$/, '');
    const webUrl = this.settings ? await frontendLocaleBaseUrl(this.config, this.settings, { locale, languages: this.languages }) : fallback;
    return {
      webUrl,
      adminUrl: (this.config.get<string>('adminUrl') || '').replace(/\/$/, ''),
    };
  }

  /** Render với dữ liệu mẫu (nội dung chưa lưu nếu truyền subject/html) */
  async preview(key: string, dto: PreviewEmailTemplateDto) {
    this.def(key);
    const { defaultLocale } = await this.locales();
    const loc = dto.locale || defaultLocale;
    const vars = sampleVars(key, loc, await this.urls(loc));
    try {
      const out = await this.mail.renderTemplate(key, loc, vars, { subject: dto.subject, html: dto.html });
      if (!out) throw new NotFoundException(`Không có mẫu email "${key}"`);
      return { subject: out.subject, html: out.html, locale: loc, vars };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new BadRequestException(`Không render được mẫu: ${(err as Error).message}`);
    }
  }

  /** Gửi thử tới 1 email với dữ liệu mẫu */
  async sendTest(key: string, dto: TestEmailTemplateDto) {
    this.def(key);
    const { defaultLocale } = await this.locales();
    const loc = dto.locale || defaultLocale;
    const res = await this.mail.sendTemplate({
      key,
      locale: loc,
      to: dto.to,
      vars: sampleVars(key, loc, await this.urls(loc)),
      meta: { test: true },
      // gửi thử luôn dùng nội dung đang mở trong trình soạn (kể cả khi mẫu đang tắt)
      template: { subject: dto.subject, html: dto.html },
      // gửi ngay (không qua hàng chờ) để báo kết quả tức thì
      immediate: true,
    });
    if (res.status === 'FAILED') throw new BadRequestException(`Gửi thất bại: ${res.error}`);
    if (res.status === 'SKIPPED') throw new BadRequestException(res.reason === 'SMTP chưa cấu hình' ? 'Chưa cấu hình máy chủ SMTP (Cài đặt › Email)' : `Không gửi: ${res.reason}`);
    return { success: true, logId: res.logId, messageId: res.status === 'SENT' ? res.messageId : undefined };
  }

  // ---------------- Nhật ký ----------------

  async logs(q: EmailLogQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.EmailLogWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.templateKey ? { templateKey: q.templateKey === 'none' ? null : q.templateKey } : {}),
      ...(q.search ? { OR: [{ to: { contains: q.search, mode: 'insensitive' } }, { subject: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total, counts] = await Promise.all([
      this.prisma.emailLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.emailLog.count({ where }),
      this.prisma.emailLog.groupBy({ by: ['status'], _count: true }),
    ]);
    const data = rows.map((r) => this.presentLog(r, false));
    const statusCounts = Object.fromEntries(counts.map((c) => [c.status, c._count]));
    return { ...paginate(data, total, page, limit), statusCounts, templates: EMAIL_TEMPLATES.map((t) => ({ key: t.key, name: t.name })) };
  }

  async log(id: string) {
    const row = await this.prisma.emailLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy nhật ký email');
    return this.presentLog(row, true);
  }

  private presentLog(
    r: { id: string; to: string; subject: string; templateKey: string | null; status: string; error: string | null; meta: unknown; createdAt: Date; attempts: number; maxAttempts: number; nextAttemptAt: Date | null; sentAt: Date | null; priority: number },
    withHtml: boolean,
  ) {
    const { html, ...meta } = ((r.meta ?? {}) as Record<string, unknown>) as { html?: string } & Record<string, unknown>;
    // email nhạy cảm (giao mã / tài khoản): không trả nội dung, không gửi lại từ nhật ký (dùng "Gửi lại email" trong đơn hàng)
    const sensitive = meta.sensitive === true;
    return {
      id: r.id,
      to: r.to,
      subject: r.subject,
      templateKey: r.templateKey,
      templateName: r.templateKey ? (EMAIL_TEMPLATE_MAP[r.templateKey]?.name ?? r.templateKey) : null,
      status: r.status,
      error: r.error,
      meta,
      canResend: !sensitive && typeof html === 'string' && html.length > 0,
      sensitive,
      // thông tin hàng chờ
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      nextAttemptAt: r.nextAttemptAt,
      sentAt: r.sentAt,
      priority: r.priority,
      ...(withHtml ? { html: sensitive ? `<p style="font-family:sans-serif;color:#666">${SENSITIVE_LOG_NOTE}</p>` : (html ?? ''), htmlRedacted: sensitive } : {}),
      createdAt: r.createdAt,
    };
  }

  async resend(id: string) {
    // chặn sớm email nhạy cảm với thông báo hướng dẫn (MailService.resend cũng chặn)
    const row = await this.prisma.emailLog.findUnique({ where: { id }, select: { meta: true } });
    if ((row?.meta as Record<string, unknown> | null)?.sensitive === true) throw new BadRequestException('Email này chứa mã / tài khoản nên không gửi lại từ nhật ký. Hãy mở đơn hàng và bấm "Gửi lại email" ở thẻ Mã đã giao.');
    try {
      const log = await this.mail.resend(id);
      if (log.status === 'SKIPPED') throw new BadRequestException('Chưa cấu hình máy chủ SMTP (Cài đặt › Email)');
      return this.presentLog(log, false);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Gửi lại thất bại: ${(err as Error).message}`);
    }
  }

  // ---------------- Hàng chờ ----------------

  queueStats() {
    return this.mail.queueStats();
  }

  async cancel(id: string) {
    try {
      return this.presentLog(await this.mail.cancel(id), false);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  async retryFailed() {
    try {
      return { count: await this.mail.retryFailed() };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  async cancelAllQueued() {
    return { count: await this.mail.cancelAllQueued() };
  }
}
