import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { frontendBaseUrl } from '../../common/utils/frontend-url.js';
import { esc, getMe, sendMessage, tgCall, TelegramError, type TgUpdate } from './telegram.api.js';

/** Loại thông báo gửi khách (khoá trong `telegram_user.events` và `users.telegramPrefs`) */
export const USER_EVENTS = ['taskSucceeded', 'taskFailed', 'topup', 'plan', 'affiliate'] as const;
export type UserEvent = (typeof USER_EVENTS)[number];

/** Loại thông báo gửi quản trị (khoá trong `telegram_admin.events`) */
export const ADMIN_EVENTS = ['newUser', 'topup', 'plan', 'payout', 'needsRefund', 'taskFailed', 'providerError', 'security', 'lowBalance', 'newModel'] as const;
export type AdminEvent = (typeof ADMIN_EVENTS)[number];

export interface TelegramUserSettings {
  enabled?: boolean;
  botToken?: string;
  events?: Partial<Record<UserEvent, boolean>>;
}

export interface TelegramAdminSettings {
  enabled?: boolean;
  botToken?: string;
  chatIds?: string;
  events?: Partial<Record<AdminEvent, boolean>>;
  /** Ngưỡng cảnh báo số dư theo nguồn API { tmc: 500 } — bỏ trống thì chỉ báo khi hết (≤ 0) */
  thresholds?: Record<string, number | string | null>;
  balanceCheckMinutes?: number;
  balanceRemindHours?: number;
  /** Chu kỳ kiểm tra danh mục model của nguồn API (phút, tối thiểu 15) — báo khi nguồn thêm / gỡ model */
  catalogCheckMinutes?: number;
}

type BotKind = 'user' | 'admin';

/** Hạn của link liên kết (giây) */
const LINK_TTL_SEC = 30 * 60;
/** Thời gian long-poll getUpdates (giây) */
const POLL_TIMEOUT_SEC = 25;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Tách danh sách chat ID admin nhập (phẩy, khoảng trắng, xuống dòng) */
export const parseChatIds = (s?: string) => [...new Set(String(s ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^-?\d+$/.test(x) || /^@\w{4,}$/.test(x)))];

const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

/**
 * Bot Telegram: gửi tin cho khách / quản trị và nhận lệnh.
 *
 * Nhận lệnh bằng long-polling `getUpdates` (không cần webhook / HTTPS công khai, chạy được cả ở máy dev). Mỗi bot một vòng lặp;
 * hai bot dùng chung token thì vòng của bot khách xử lý luôn lệnh admin. Telegram chỉ cho MỘT nơi gọi getUpdates mỗi token —
 * máy dev dùng chung bot với production thì đặt `TELEGRAM_POLLING=false` ở máy dev (vẫn gửi tin được).
 *
 * Liên kết tài khoản: trang Tài khoản xin link `t.me/<bot>?start=<mã>`; mã ký HMAC gồm id khách + hạn + mốc liên kết gần nhất
 * nên không cần lưu DB, hết hạn sau 30 phút và mất hiệu lực ngay khi đã dùng để liên kết.
 */
@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Telegram');
  private readonly abort = new AbortController();
  /** username bot theo token (getMe), tránh gọi lại mỗi lần dựng link */
  private readonly usernames = new Map<string, string>();
  /** Lỗi gần nhất của vòng nhận lệnh từng bot (trang admin hiển thị) */
  readonly pollErrors: Record<BotKind, string | null> = { user: null, admin: null };

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  /** Có chạy vòng nhận lệnh không (tắt bằng TELEGRAM_POLLING=false, không chạy khi test) */
  get pollingEnabled() {
    return process.env.TELEGRAM_POLLING !== 'false' && process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap() {
    if (!this.pollingEnabled) return;
    void this.pollLoop('user');
    void this.pollLoop('admin');
  }

  onApplicationShutdown() {
    this.abort.abort();
  }

  // ---------------- cấu hình ----------------

  userSettings() {
    return this.settings.get<TelegramUserSettings>('telegram_user');
  }

  adminSettings() {
    return this.settings.get<TelegramAdminSettings>('telegram_admin');
  }

  /** Bot khách đang bật và có token */
  async userBot() {
    const s = await this.userSettings();
    return s.enabled && s.botToken ? { ...s, token: s.botToken.trim() } : null;
  }

  /** Bot admin đang bật, có token và ít nhất một chat nhận */
  async adminBot() {
    const s = await this.adminSettings();
    const chats = parseChatIds(s.chatIds);
    return s.enabled && s.botToken && chats.length ? { ...s, token: s.botToken.trim(), chats } : null;
  }

  /** username của bot (có cache theo token) */
  async botUsername(token: string) {
    const hit = this.usernames.get(token);
    if (hit) return hit;
    const me = await getMe(token);
    this.usernames.set(token, me.username);
    return me.username;
  }

  // ---------------- gửi tin ----------------

  /**
   * Gửi tin cho một khách đã liên kết, nếu admin cho phép loại thông báo này và khách không tắt.
   * Khách chặn bot / xoá chat (403) thì tự huỷ liên kết để không gửi lại mãi.
   */
  async notifyUser(userId: string, event: UserEvent, html: string) {
    const bot = await this.userBot();
    if (!bot || bot.events?.[event] === false) return false;
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { telegramChatId: true, telegramPrefs: true } });
    if (!user?.telegramChatId) return false;
    if ((user.telegramPrefs as Record<string, boolean> | null)?.[event] === false) return false;
    try {
      await sendMessage(bot.token, user.telegramChatId, html);
      return true;
    } catch (err) {
      const e = err as TelegramError;
      if (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message))) {
        await this.prisma.user.updateMany({ where: { id: userId, telegramChatId: user.telegramChatId }, data: { telegramChatId: null, telegramUsername: null } });
        this.logger.log(`Khách ${userId} đã chặn bot — huỷ liên kết Telegram`);
      } else this.logger.warn(`Gửi Telegram cho khách ${userId} lỗi: ${e.message}`);
      return false;
    }
  }

  /** Gửi tin vào mọi chat quản trị nếu loại thông báo đang bật (`event` null = luôn gửi, vd tin thử) */
  async notifyAdmin(event: AdminEvent | null, html: string) {
    const bot = await this.adminBot();
    if (!bot || (event && bot.events?.[event] === false)) return { sent: 0, errors: [] as string[] };
    const errors: string[] = [];
    let sent = 0;
    for (const chat of bot.chats) {
      try {
        await sendMessage(bot.token, chat, html);
        sent++;
      } catch (err) {
        errors.push(`${chat}: ${(err as Error).message}`);
      }
    }
    if (errors.length) this.logger.warn(`Gửi Telegram admin lỗi: ${errors.join('; ')}`);
    return { sent, errors };
  }

  /** Địa chỉ website khách (dựng link trong tin nhắn); chưa cấu hình thì chuỗi rỗng */
  siteUrl() {
    return frontendBaseUrl(this.config, this.settings);
  }

  /** Số khách đã liên kết Telegram (trang admin) */
  linkedCount() {
    return this.prisma.user.count({ where: { telegramChatId: { not: null }, deletedAt: null } });
  }

  /** Tin thử từ trang admin */
  async sendTest(kind: BotKind, actorId: string) {
    const time = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    if (kind === 'admin') {
      const s = await this.adminSettings();
      if (!s.enabled || !s.botToken) throw new BadRequestException('Bot admin chưa bật hoặc chưa có token — lưu cài đặt trước khi gửi thử');
      if (!parseChatIds(s.chatIds).length) throw new BadRequestException('Chưa nhập Chat ID nhận thông báo');
      const r = await this.notifyAdmin(null, `🔔 Tin thử từ bot quản trị — ${esc(time)}
Bot đã gửi được vào chat này.`);
      if (!r.sent) throw new BadRequestException(`Không gửi được: ${r.errors.join('; ')}`);
      return { sent: r.sent, errors: r.errors };
    }
    const bot = await this.userBot();
    if (!bot) throw new BadRequestException('Bot khách chưa bật hoặc chưa có token — lưu cài đặt trước khi gửi thử');
    const me = await this.prisma.user.findUnique({ where: { id: actorId }, select: { telegramChatId: true } });
    if (!me?.telegramChatId) throw new BadRequestException('Tài khoản admin của bạn chưa liên kết Telegram — liên kết ở trang Tài khoản trên website khách rồi thử lại');
    await sendMessage(bot.token, me.telegramChatId, `🔔 Tin thử từ bot thông báo khách — ${esc(time)}`).catch((err) => {
      throw new BadRequestException(`Không gửi được: ${(err as Error).message}`);
    });
    return { sent: 1, errors: [] };
  }

  // ---------------- liên kết tài khoản khách ----------------

  private sign(payload: string) {
    const secret = this.config.get<string>('jwt.accessSecret') ?? 'dev-secret';
    return createHmac('sha256', `telegram-link:${secret}`).update(payload).digest('base64url').slice(0, 16);
  }

  /** Mã start: <uuid bỏ gạch 32 ký tự><hạn base36 7 ký tự><chữ ký 16 ký tự> — vừa giới hạn 64 ký tự của Telegram */
  private linkCode(userId: string, linkedAt: Date | null) {
    const exp = (Math.floor(Date.now() / 1000) + LINK_TTL_SEC).toString(36).padStart(7, '0');
    const id = userId.replace(/-/g, '');
    return `${id}${exp}${this.sign(`${id}.${exp}.${linkedAt?.getTime() ?? 0}`)}`;
  }

  /** Giải mã + kiểm tra mã start; trả id khách hoặc null */
  private async verifyLinkCode(code: string) {
    const m = /^([0-9a-f]{32})([0-9a-z]{7})([\w-]{16})$/.exec(code);
    if (!m) return null;
    const [, id, exp, sig] = m;
    if (parseInt(exp, 36) < Date.now() / 1000) return null;
    const userId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null, status: 'ACTIVE' }, select: { id: true, name: true, email: true, telegramLinkedAt: true } });
    if (!user) return null;
    const expect = Buffer.from(this.sign(`${id}.${exp}.${user.telegramLinkedAt?.getTime() ?? 0}`));
    return expect.length === sig.length && timingSafeEqual(expect, Buffer.from(sig)) ? user : null;
  }

  /** Trạng thái liên kết + loại thông báo cho trang Tài khoản */
  async myStatus(userId: string) {
    const [bot, user] = await Promise.all([this.userBot(), this.prisma.user.findUnique({ where: { id: userId }, select: { telegramChatId: true, telegramUsername: true, telegramLinkedAt: true, telegramPrefs: true } })]);
    let botUsername: string | null = null;
    if (bot) botUsername = await this.botUsername(bot.token).catch(() => null);
    const prefs = (user?.telegramPrefs ?? {}) as Record<string, boolean>;
    return {
      available: !!bot && !!botUsername,
      botUsername,
      linked: !!user?.telegramChatId,
      username: user?.telegramChatId ? user.telegramUsername : null,
      linkedAt: user?.telegramChatId ? user.telegramLinkedAt : null,
      // chỉ hiện loại thông báo admin đang cho phép; giá trị = khách có bật không
      events: USER_EVENTS.filter((e) => bot?.events?.[e] !== false).map((key) => ({ key, enabled: prefs[key] !== false })),
    };
  }

  /** Tạo link mở bot để liên kết (hết hạn sau 30 phút) */
  async createLink(userId: string) {
    const bot = await this.userBot();
    if (!bot) throw new BadRequestException('Thông báo Telegram đang tắt');
    const username = await this.botUsername(bot.token).catch(() => {
      throw new BadRequestException('Bot Telegram chưa cấu hình đúng, vui lòng báo quản trị viên');
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { telegramLinkedAt: true } });
    const code = this.linkCode(userId, user?.telegramLinkedAt ?? null);
    return { url: `https://t.me/${username}?start=${code}`, expiresIn: LINK_TTL_SEC };
  }

  /** Khách bật / tắt từng loại thông báo */
  async updatePrefs(userId: string, events: Record<string, boolean>) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { telegramPrefs: true } });
    const next = { ...((user?.telegramPrefs ?? {}) as Record<string, boolean>) };
    for (const k of USER_EVENTS) if (typeof events[k] === 'boolean') next[k] = events[k];
    await this.prisma.user.update({ where: { id: userId }, data: { telegramPrefs: next } });
    return this.myStatus(userId);
  }

  /** Khách huỷ liên kết ở trang Tài khoản (báo luôn vào chat cũ) */
  async unlink(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { telegramChatId: true } });
    await this.prisma.user.update({ where: { id: userId }, data: { telegramChatId: null, telegramUsername: null } });
    const bot = await this.userBot();
    if (bot && user?.telegramChatId) await sendMessage(bot.token, user.telegramChatId, 'Đã huỷ liên kết tài khoản. Bạn sẽ không nhận thông báo nữa.').catch(() => undefined);
    return this.myStatus(userId);
  }

  // ---------------- nhận lệnh (long-polling) ----------------

  /** Token vòng nhận lệnh của từng bot; bot admin trùng token bot khách thì vòng khách xử lý chung */
  private async loopToken(kind: BotKind) {
    const [u, a] = await Promise.all([this.userSettings(), this.adminSettings()]);
    const ut = u.enabled ? (u.botToken ?? '').trim() : '';
    const at = a.enabled ? (a.botToken ?? '').trim() : '';
    if (kind === 'user') return ut || null;
    return at && at !== ut ? at : null;
  }

  private async pollLoop(kind: BotKind) {
    const signal = this.abort.signal;
    let token: string | null = null;
    let offset = 0;
    while (!signal.aborted) {
      let next: string | null = null;
      try {
        next = await this.loopToken(kind);
      } catch {
        // DB chưa sẵn sàng -> thử lại sau
      }
      if (!next) {
        token = null;
        this.pollErrors[kind] = null;
        await sleep(15_000, signal);
        continue;
      }
      if (next !== token) {
        // đổi token: bỏ webhook cũ (getUpdates không chạy khi bot đang đặt webhook), đọc lại từ đầu hàng đợi
        token = next;
        offset = 0;
        await tgCall(token, 'deleteWebhook', {}).catch(() => undefined);
      }
      try {
        const updates = await tgCall<TgUpdate[]>(token, 'getUpdates', { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message'] }, { timeoutMs: (POLL_TIMEOUT_SEC + 10) * 1000, signal });
        this.pollErrors[kind] = null;
        for (const u of updates) {
          offset = u.update_id + 1;
          await this.handleUpdate(kind, token, u).catch((err) => this.logger.warn(`Xử lý lệnh Telegram lỗi: ${(err as Error).message}`));
        }
      } catch (err) {
        if (signal.aborted) break;
        const e = err as TelegramError;
        this.pollErrors[kind] = e.code === 409 ? 'Token này đang được nơi khác nhận lệnh (máy chủ khác hoặc webhook) — đặt TELEGRAM_POLLING=false ở máy không cần nhận lệnh' : e.message;
        // token sai (401/404) thì chờ lâu hơn cho đỡ gọi vô ích
        await sleep(e.code === 401 || e.code === 404 ? 60_000 : e.retryAfter ? e.retryAfter * 1000 : 10_000, signal);
      }
    }
  }

  /** Xử lý một tin nhắn gửi tới bot */
  private async handleUpdate(kind: BotKind, token: string, u: TgUpdate) {
    const msg = u.message;
    const text = msg?.text?.trim();
    if (!msg || !text?.startsWith('/')) return;
    // "/start@TenBot abc" -> lệnh "start", tham số "abc"
    const [head, ...rest] = text.split(/\s+/);
    const cmd = head.slice(1).split('@')[0].toLowerCase();
    const arg = rest.join(' ');
    const chatId = String(msg.chat.id);
    const reply = (html: string) => sendMessage(token, chatId, html);
    const admin = await this.adminSettings();
    // vòng nhận lệnh của bot khách xử lý luôn lệnh quản trị khi hai bot dùng chung token
    const handlesUser = kind === 'user';
    const handlesAdmin = kind === 'admin' || (!!admin.enabled && (admin.botToken ?? '').trim() === token);

    if (cmd === 'id' || cmd === 'chatid') return reply(`Chat ID: <code>${esc(chatId)}</code>`);

    if (handlesUser && cmd === 'start' && arg) {
      if (msg.chat.type !== 'private') return reply('Vui lòng mở chat riêng với bot để liên kết tài khoản.');
      const user = await this.verifyLinkCode(arg);
      if (!user) return reply('Link liên kết không hợp lệ hoặc đã hết hạn. Vào trang Tài khoản trên website để lấy link mới.');
      const username = msg.from?.username ?? ([msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || null);
      await this.prisma.$transaction([
        // một chat Telegram chỉ gắn một tài khoản: gỡ khỏi tài khoản cũ (nếu có)
        this.prisma.user.updateMany({ where: { telegramChatId: chatId, id: { not: user.id } }, data: { telegramChatId: null, telegramUsername: null } }),
        this.prisma.user.update({ where: { id: user.id }, data: { telegramChatId: chatId, telegramUsername: username, telegramLinkedAt: new Date() } }),
      ]);
      return reply(`✅ Đã liên kết với tài khoản <b>${esc(user.name)}</b> (${esc(user.email)}).\nBạn sẽ nhận thông báo tác vụ AI, nạp tiền, gói cước tại đây.\n\nGõ /me để xem số dư, /stop để huỷ liên kết.`);
    }

    if (cmd === 'start' || cmd === 'help') {
      const lines: string[] = [];
      if (handlesUser) {
        const site = await this.siteUrl();
        lines.push(`Xin chào! Đây là bot thông báo của website.`, `Để liên kết, vào <b>Tài khoản › Thông báo Telegram</b>${site ? ` tại ${esc(site)}/account` : ''} và bấm "Liên kết Telegram".`, '', '/me — số dư, gói cước', '/stop — huỷ liên kết');
      }
      if (handlesAdmin) lines.push('', '<b>Lệnh quản trị</b> (chỉ chat đã khai báo):', '/sources — số dư các nguồn API AI', '/stats — thống kê hôm nay', '/models — kiểm tra ngay nguồn API có thêm / gỡ model không');
      lines.push('/id — xem Chat ID');
      return reply(lines.join('\n'));
    }

    if (handlesUser && (cmd === 'me' || cmd === 'stop' || cmd === 'unlink')) {
      const user = await this.prisma.user.findFirst({ where: { telegramChatId: chatId, deletedAt: null }, select: { id: true, name: true, walletBalance: true, planExpiresAt: true, plan: { select: { name: true } } } });
      if (!user) return reply('Chat này chưa liên kết tài khoản nào. Vào trang Tài khoản trên website để liên kết.');
      if (cmd !== 'me') {
        await this.prisma.user.update({ where: { id: user.id }, data: { telegramChatId: null, telegramUsername: null } });
        return reply('Đã huỷ liên kết. Bạn sẽ không nhận thông báo nữa.');
      }
      const planOn = user.plan && user.planExpiresAt && user.planExpiresAt > new Date();
      return reply(
        [
          `👤 <b>${esc(user.name)}</b>`,
          `💰 Số dư: <b>${vnd(Number(user.walletBalance))}</b>`,
          `📦 Gói: ${planOn ? `${esc(user.plan!.name)} (hết hạn ${user.planExpiresAt!.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })})` : 'chưa có gói'}`,
        ].join('\n'),
      );
    }

    if (handlesAdmin && (cmd === 'sources' || cmd === 'stats')) {
      // chỉ trả dữ liệu quản trị cho chat đã khai báo ở Cài đặt
      if (!parseChatIds(admin.chatIds).includes(chatId)) return reply(`Chat này chưa được cấp quyền. Thêm Chat ID <code>${esc(chatId)}</code> vào Admin › Cài đặt › Bot Telegram admin.`);
      const handler = this.adminCommands[cmd];
      return reply(handler ? await handler() : 'Chức năng chưa sẵn sàng');
    }
  }

  /** Lệnh quản trị do các service khác đăng ký (tránh vòng phụ thuộc với AiService) */
  readonly adminCommands: Record<string, () => Promise<string>> = {};
}
