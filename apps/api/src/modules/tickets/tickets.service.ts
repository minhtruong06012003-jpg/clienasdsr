import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AiService } from '../ai/ai.service.js';
import { AuthService } from '../auth/auth.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { esc, sendMessage } from '../telegram/telegram.api.js';
import { parseChatIds, type TelegramAdminSettings, type TelegramUserSettings } from '../telegram/telegram.service.js';
import { isChildSite, shouldHideAiProviders } from '../../common/utils/tenant.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type {
  AdminSiteUserUpdateDto,
  AdminSiteUserWalletDto,
  CascadeRefundDto,
  CreateTicketDto,
  ReplyTicketDto,
  TicketAttachmentDto,
  TicketQueryDto,
  TicketStatusType,
} from './tickets.dto.js';

export interface NormalizedTicketAttachment {
  url: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video';
}

export interface TicketRow {
  id: string;
  code: number;
  user_id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  order_codes: string | null;
  customer_unread: boolean;
  staff_unread: boolean;
  last_reply_at: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  user_name?: string | null;
  user_email?: string | null;
  user_balance?: string | number | null;
  last_body?: string | null;
  last_is_staff?: boolean | null;
  last_attachments?: unknown;
}

interface MessageRow {
  id: string;
  ticket_id: string;
  author_id: string | null;
  author_name: string | null;
  is_staff: boolean;
  body: string;
  attachments?: unknown;
  created_at: Date;
}

interface ChildSiteMeta {
  code: string;
  port: number;
  apiBase: string;
  publicOrigin: string;
  domain: string;
  siteName: string;
  serverSecret: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TicketsService implements OnModuleInit {
  private readonly logger = new Logger('Tickets');
  private childSitesCache: { at: number; items: ChildSiteMeta[] } | null = null;
  private readonly mainOrigin = (process.env.API_PUBLIC_URL || process.env.WEB_URL || 'https://nov.ai.vn').replace(/\/$/, '');
  private readonly mainDomain = this.mainOrigin.replace(/^https?:\/\//, '');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly wallet: WalletService,
    private readonly auth: AuthService,
  ) {}

  /** Tự động khởi tạo bảng support_tickets & support_ticket_messages trên cả site chính và mọi site con */
  async onModuleInit() {
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS support_tickets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code SERIAL UNIQUE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subject VARCHAR(200) NOT NULL,
          category VARCHAR(32) NOT NULL DEFAULT 'ORDER',
          priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
          status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
          order_codes VARCHAR(200),
          customer_unread BOOLEAN NOT NULL DEFAULT FALSE,
          staff_unread BOOLEAN NOT NULL DEFAULT TRUE,
          last_reply_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, last_reply_at DESC);
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, last_reply_at DESC);
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS support_ticket_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
          author_id UUID REFERENCES users(id) ON DELETE SET NULL,
          author_name VARCHAR(120),
          is_staff BOOLEAN NOT NULL DEFAULT FALSE,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE support_ticket_messages
        ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_support_ticket_msgs_ticket ON support_ticket_messages(ticket_id, created_at ASC);
      `);
    } catch (err) {
      this.logger.error(`Khởi tạo bảng support_tickets lỗi: ${(err as Error).message}`);
    }
  }

  /** Đọc danh sách cấu hình các Website con trên máy chủ (`/var/www/novai-sites/<code>/env.json`, cache 30s) */
  private async discoverChildSites(): Promise<ChildSiteMeta[]> {
    if (isChildSite()) return [];
    if (this.childSitesCache && Date.now() - this.childSitesCache.at < 30_000) {
      return this.childSitesCache.items;
    }
    const sitesDir = process.env.NOVAI_SITES_DIR || '/var/www/novai-sites';
    const items: ChildSiteMeta[] = [];
    try {
      const entries = await readdir(sitesDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const code = ent.name.trim();
        if (!/^[a-z0-9_-]{1,40}$/i.test(code)) continue;
        try {
          const raw = await readFile(join(sitesDir, code, 'env.json'), 'utf8');
          const parsed = JSON.parse(raw) as {
            api?: { PORT?: string | number; API_PUBLIC_URL?: string; WEB_URL?: string; SERVER_API_SECRET?: string };
            web?: { NEXT_PUBLIC_SITE_NAME?: string };
          };
          const port = Number(parsed.api?.PORT);
          const serverSecret = String(parsed.api?.SERVER_API_SECRET ?? '').trim();
          const publicOrigin = String(parsed.api?.API_PUBLIC_URL || parsed.api?.WEB_URL || '').replace(/\/$/, '');
          if (!port || !serverSecret || !publicOrigin) continue;
          const domain = publicOrigin.replace(/^https?:\/\//, '');
          items.push({
            code,
            port,
            apiBase: `http://127.0.0.1:${port}`,
            publicOrigin,
            domain,
            siteName: String(parsed.web?.NEXT_PUBLIC_SITE_NAME || domain),
            serverSecret,
          });
        } catch {
          /* bỏ qua thư mục không có env.json hợp lệ */
        }
      }
      items.sort((a, b) => a.domain.localeCompare(b.domain));
    } catch {
      /* môi trường dev local không có /var/www/novai-sites */
    }
    this.childSitesCache = { at: Date.now(), items };
    return items;
  }

  private parseCompositeId(rawId: string): { siteCode: string; ticketId: string } {
    const clean = (rawId ?? '').trim();
    const sepIdx = clean.indexOf('__');
    if (sepIdx > 0) {
      const siteCode = clean.slice(0, sepIdx);
      const ticketId = clean.slice(sepIdx + 2);
      if (/^[a-z0-9_-]{1,40}$/i.test(siteCode) && UUID_RE.test(ticketId)) {
        return { siteCode, ticketId };
      }
    }
    if (!UUID_RE.test(clean)) {
      throw new BadRequestException('Mã định danh Ticket không hợp lệ');
    }
    return { siteCode: 'main', ticketId: clean };
  }

  private normalizeAttachments(raw: unknown, originPrefix = ''): NormalizedTicketAttachment[] {
    let arr: unknown[] = [];
    if (Array.isArray(raw)) {
      arr = raw;
    } else if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        arr = [];
      }
    }
    const out: NormalizedTicketAttachment[] = [];
    for (const item of arr.slice(0, 6)) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Partial<TicketAttachmentDto>;
      let url = typeof it.url === 'string' ? it.url.trim() : '';
      if (!url || !/^(\/uploads\/|https?:\/\/)/i.test(url)) continue;
      if (originPrefix && url.startsWith('/uploads/')) {
        url = `${originPrefix}${url}`;
      }
      const mimeType = typeof it.mimeType === 'string' ? it.mimeType.trim().slice(0, 80) : '';
      const isVideo =
        it.kind === 'video' ||
        mimeType.startsWith('video/') ||
        /\.(mp4|webm|mov)(\?|$)/i.test(url);
      out.push({
        url,
        name: (typeof it.name === 'string' ? it.name.trim() : '').slice(0, 200) || (isVideo ? 'video.mp4' : 'image.jpg'),
        mimeType: mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
        size: Math.max(0, Math.round(Number(it.size) || 0)),
        kind: isVideo ? 'video' : 'image',
      });
    }
    return out;
  }

  private mapTicket(r: TicketRow, messages?: MessageRow[], siteInfo?: { siteCode: string; siteDomain: string; isChild: boolean }) {
    const lastAtts = this.normalizeAttachments(r.last_attachments);
    const lastPreviewBody =
      r.last_body != null
        ? r.last_body.trim() ||
          (lastAtts.length > 0
            ? lastAtts.some((a) => a.kind === 'video')
              ? '[Đính kèm video]'
              : '[Đính kèm hình ảnh]'
            : '')
        : null;
    const compositeId = siteInfo && siteInfo.siteCode !== 'main' ? `${siteInfo.siteCode}__${r.id}` : r.id;
    return {
      id: compositeId,
      rawId: r.id,
      code: Number(r.code),
      ...(siteInfo
        ? {
            siteCode: siteInfo.siteCode,
            siteDomain: siteInfo.siteDomain,
            isFromChildSite: siteInfo.isChild,
          }
        : {}),
      subject: r.subject,
      category: r.category,
      priority: r.priority,
      status: r.status,
      orderCodes: r.order_codes,
      customerUnread: !!r.customer_unread,
      staffUnread: !!r.staff_unread,
      lastReplyAt: r.last_reply_at,
      closedAt: r.closed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      canReopen: true,
      user:
        r.user_email !== undefined
          ? {
              id: r.user_id,
              name: r.user_name ?? '',
              email: r.user_email ?? '',
              walletBalance: Number(r.user_balance ?? 0),
            }
          : undefined,
      lastMessage:
        lastPreviewBody != null
          ? {
              body: lastPreviewBody,
              isStaff: !!r.last_is_staff,
              hasImage: lastAtts.length > 0,
            }
          : null,
      ...(messages
        ? {
            messages: messages.map((m) => ({
              id: m.id,
              body: m.body,
              isStaff: !!m.is_staff,
              authorName: m.author_name,
              attachments: this.normalizeAttachments(m.attachments),
              createdAt: m.created_at,
            })),
          }
        : {}),
    };
  }

  // ---------------- GỬI THÔNG BÁO TELEGRAM ----------------

  private async notifyAdminTelegram(html: string) {
    try {
      const s = await this.settings.get<TelegramAdminSettings>('telegram_admin');
      if (s?.enabled && s.botToken) {
        const chats = parseChatIds(s.chatIds);
        for (const chatId of chats) {
          await sendMessage(s.botToken.trim(), chatId, html).catch(() => undefined);
        }
      }
    } catch {
      /* bỏ qua nếu chưa cấu hình Telegram */
    }

    // Nếu đang chạy trên Website con -> đẩy thêm thông báo về máy chủ chính nov.ai.vn để Admin tổng nhận ngay (T-430)
    if (isChildSite()) {
      const childSecret = (process.env.SERVER_API_SECRET ?? '').trim();
      const domain = (process.env.API_PUBLIC_URL || process.env.WEB_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      const parentApi = (process.env.PARENT_API_INTERNAL_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
      if (childSecret && domain) {
        await fetch(`${parentApi}/api/internal/hub-tickets/notify-parent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ childSecret, domain, html }),
          signal: AbortSignal.timeout(4_000),
        }).catch(() => undefined);
      }
    }
  }

  async receiveChildTelegramAlert(childSecret: string, domain: string, html: string) {
    if (isChildSite() || !childSecret || !html) return { ok: false };
    const children = await this.discoverChildSites();
    const matched = children.find((c) => {
      if (c.serverSecret.length !== childSecret.length) return false;
      return timingSafeEqual(Buffer.from(c.serverSecret), Buffer.from(childSecret));
    });
    if (!matched) throw new ForbiddenException('Không khớp khoá nội bộ web con');
    const prefixed = `🌐 <b>[Web con: ${esc(matched.domain || domain)}]</b>\n${html}`;
    try {
      const s = await this.settings.get<TelegramAdminSettings>('telegram_admin');
      if (s?.enabled && s.botToken) {
        for (const chatId of parseChatIds(s.chatIds)) {
          await sendMessage(s.botToken.trim(), chatId, prefixed).catch(() => undefined);
        }
      }
    } catch {
      /* bỏ qua */
    }
    return { ok: true };
  }

  private async notifyCustomerTelegram(userId: string, html: string) {
    try {
      const [s, u] = await Promise.all([
        this.settings.get<TelegramUserSettings>('telegram_user'),
        this.prisma.user.findUnique({ where: { id: userId }, select: { telegramChatId: true } }),
      ]);
      if (!s?.enabled || !s.botToken || !u?.telegramChatId) return;
      await sendMessage(s.botToken.trim(), u.telegramChatId, html).catch(() => undefined);
    } catch {
      /* bỏ qua */
    }
  }

  // ---------------- KHÁCH HÀNG (/account/tickets) ----------------

  async myList(userId: string, q: TicketQueryDto) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const offset = (page - 1) * limit;
    const status = (q.status ?? '').trim().toUpperCase();
    const search = (q.search ?? '').trim();

    const params: unknown[] = [userId];
    const conds = ['t.user_id = $1::uuid'];

    if (status === 'OPEN') {
      conds.push(`t.status IN ('OPEN', 'CUSTOMER_REPLY')`);
    } else if (status === 'ANSWERED' || status === 'CLOSED') {
      params.push(status);
      conds.push(`t.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      const pIdx = params.length;
      conds.push(`(t.subject ILIKE $${pIdx} OR COALESCE(t.order_codes, '') ILIKE $${pIdx} OR CAST(t.code AS TEXT) = $${params.length + 1})`);
      params.push(search.replace(/^#?(TK-?)?/i, ''));
    }

    const whereSql = conds.join(' AND ');

    const [rows, totalRows, countRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<TicketRow[]>(
        `SELECT t.*,
           lm.body AS last_body,
           lm.is_staff AS last_is_staff,
           lm.attachments AS last_attachments
         FROM support_tickets t
         LEFT JOIN LATERAL (
           SELECT body, is_staff, attachments FROM support_ticket_messages m
           WHERE m.ticket_id = t.id
           ORDER BY m.created_at DESC LIMIT 1
         ) lm ON TRUE
         WHERE ${whereSql}
         ORDER BY t.customer_unread DESC, t.last_reply_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<{ total: bigint }[]>(
        `SELECT COUNT(*)::bigint AS total FROM support_tickets t WHERE ${whereSql}`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<{ status: string; cnt: bigint; unread: bigint }[]>(
        `SELECT status,
           COUNT(*)::bigint AS cnt,
           SUM(CASE WHEN customer_unread THEN 1 ELSE 0 END)::bigint AS unread
         FROM support_tickets
         WHERE user_id = $1::uuid
         GROUP BY status`,
        userId,
      ),
    ]);

    let openCnt = 0;
    let answeredCnt = 0;
    let closedCnt = 0;
    let unread = 0;
    for (const c of countRows) {
      const n = Number(c.cnt || 0);
      unread += Number(c.unread || 0);
      if (c.status === 'OPEN' || c.status === 'CUSTOMER_REPLY') openCnt += n;
      else if (c.status === 'ANSWERED') answeredCnt += n;
      else if (c.status === 'CLOSED') closedCnt += n;
    }
    const total = Number(totalRows[0]?.total ?? 0);

    return {
      data: rows.map((r) => this.mapTicket(r)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      counts: {
        ALL: openCnt + answeredCnt + closedCnt,
        OPEN: openCnt,
        ANSWERED: answeredCnt,
        CLOSED: closedCnt,
      },
      unread,
    };
  }

  /** Đếm số lượng tin nhắn phản hồi mới từ Admin mà khách chưa đọc (hiện badge đỏ trên sidebar — T-216) */
  async myUnreadCount(userId: string) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ unread_msgs: number; unread_tickets: number }[]>(
        `SELECT
           (SELECT COUNT(*)::int
            FROM support_ticket_messages m
            JOIN support_tickets t ON t.id = m.ticket_id
            WHERE t.user_id = $1::uuid
              AND t.customer_unread = TRUE
              AND m.is_staff = TRUE
              AND m.created_at >= COALESCE(
                (SELECT MAX(c.created_at) FROM support_ticket_messages c WHERE c.ticket_id = t.id AND c.is_staff = FALSE),
                t.created_at
              )) AS unread_msgs,
           (SELECT COUNT(*)::int FROM support_tickets WHERE user_id = $1::uuid AND customer_unread = TRUE) AS unread_tickets`,
        userId,
      );
      const msgs = Number(rows[0]?.unread_msgs ?? 0);
      const tks = Number(rows[0]?.unread_tickets ?? 0);
      return { unread: Math.max(msgs, tks) };
    } catch {
      return { unread: 0 };
    }
  }

  async myDetail(userId: string, id: string) {
    const rows = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT * FROM support_tickets WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
      id,
      userId,
    );
    const ticket = rows[0];
    if (!ticket) throw new NotFoundException('Không tìm thấy yêu cầu hỗ trợ');

    if (ticket.customer_unread) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE support_tickets SET customer_unread = FALSE WHERE id = $1::uuid`,
        id,
      );
      ticket.customer_unread = false;
    }

    const messages = await this.prisma.$queryRawUnsafe<MessageRow[]>(
      `SELECT * FROM support_ticket_messages WHERE ticket_id = $1::uuid ORDER BY created_at ASC`,
      id,
    );
    return this.mapTicket(ticket, messages);
  }

  async create(user: AuthUser, dto: CreateTicketDto) {
    const owner = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, name: true, email: true },
    });
    if (!owner) throw new NotFoundException('Không tìm thấy tài khoản');

    const subject = dto.subject.trim();
    const body = (dto.message ?? '').trim();
    const attachments = this.normalizeAttachments(dto.attachments);
    const category = dto.category ?? 'ORDER';
    const priority = dto.priority ?? 'NORMAL';
    const orderCodes = dto.orderCodes?.trim() || null;

    if (!subject || (!body && attachments.length === 0)) {
      throw new BadRequestException('Vui lòng nhập tiêu đề và nội dung hoặc đính kèm ảnh/video cần hỗ trợ');
    }

    const created = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `INSERT INTO support_tickets (user_id, subject, category, priority, status, order_codes, customer_unread, staff_unread)
       VALUES ($1::uuid, $2, $3, $4, 'OPEN', $5, FALSE, TRUE)
       RETURNING *`,
      owner.id,
      subject,
      category,
      priority,
      orderCodes,
    );
    const ticket = created[0];
    const msgs = await this.prisma.$queryRawUnsafe<MessageRow[]>(
      `INSERT INTO support_ticket_messages (ticket_id, author_id, author_name, is_staff, body, attachments)
       VALUES ($1::uuid, $2::uuid, $3, FALSE, $4, $5::jsonb)
       RETURNING *`,
      ticket.id,
      owner.id,
      owner.name || owner.email,
      body,
      JSON.stringify(attachments),
    );

    const mediaHint = attachments.length > 0 ? `\n📎 <i>Đính kèm ${attachments.length} tệp ảnh/video</i>` : '';

    void this.notifyAdminTelegram(
      `🎫 <b>Ticket mới #${ticket.code}</b>\n` +
        `👤 Khách: <b>${esc(owner.name || '')}</b> (${esc(owner.email)})\n` +
        `📌 Tiêu đề: <b>${esc(subject)}</b>\n` +
        (orderCodes ? `🧾 Mã đơn: <code>${esc(orderCodes)}</code>\n` : '') +
        (body ? `💬 ${esc(body.slice(0, 400))}` : '') +
        mediaHint,
    );

    return this.mapTicket(ticket, msgs);
  }

  async customerReply(user: AuthUser, id: string, dto: ReplyTicketDto) {
    const rows = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT * FROM support_tickets WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
      id,
      user.id,
    );
    const ticket = rows[0];
    if (!ticket) throw new NotFoundException('Không tìm thấy yêu cầu hỗ trợ');

    const owner = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true, email: true },
    });
    const body = (dto.message ?? '').trim();
    const attachments = this.normalizeAttachments(dto.attachments);
    if (!body && attachments.length === 0) throw new BadRequestException('Vui lòng nhập nội dung phản hồi');

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO support_ticket_messages (ticket_id, author_id, author_name, is_staff, body, attachments)
       VALUES ($1::uuid, $2::uuid, $3, FALSE, $4, $5::jsonb)`,
      id,
      user.id,
      owner?.name || owner?.email || 'Khách hàng',
      body,
      JSON.stringify(attachments),
    );

    await this.prisma.$executeRawUnsafe(
      `UPDATE support_tickets
       SET status = 'CUSTOMER_REPLY',
           staff_unread = TRUE,
           customer_unread = FALSE,
           closed_at = NULL,
           last_reply_at = NOW(),
           updated_at = NOW()
       WHERE id = $1::uuid`,
      id,
    );

    const mediaHint = attachments.length > 0 ? `\n📎 <i>Đính kèm ${attachments.length} tệp ảnh/video</i>` : '';

    void this.notifyAdminTelegram(
      `💬 <b>Khách phản hồi Ticket #${ticket.code}</b>\n` +
        `👤 ${esc(owner?.email ?? '')}\n` +
        `📌 ${esc(ticket.subject)}\n` +
        (body ? `👉 ${esc(body.slice(0, 400))}` : '') +
        mediaHint,
    );

    return this.myDetail(user.id, id);
  }

  async customerClose(userId: string, id: string) {
    const rows = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `UPDATE support_tickets
       SET status = 'CLOSED', closed_at = NOW(), customer_unread = FALSE, updated_at = NOW()
       WHERE id = $1::uuid AND user_id = $2::uuid
       RETURNING *`,
      id,
      userId,
    );
    if (!rows[0]) throw new NotFoundException('Không tìm thấy yêu cầu hỗ trợ');
    return this.myDetail(userId, id);
  }

  // ---------------- CỔNG NỘI BỘ GOM TICKET TỪ WEB CON (T-430) ----------------

  async internalExportTickets() {
    const rows = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT t.*,
         u.name AS user_name,
         u.email AS user_email,
         u."walletBalance" AS user_balance,
         lm.body AS last_body,
         lm.is_staff AS last_is_staff,
         lm.attachments AS last_attachments
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT body, is_staff, attachments FROM support_ticket_messages m
         WHERE m.ticket_id = t.id
         ORDER BY m.created_at DESC LIMIT 1
       ) lm ON TRUE
       ORDER BY t.last_reply_at DESC
       LIMIT 500`,
    );
    return { rows };
  }

  async internalOpenCount() {
    const rows = await this.prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*)::int AS c FROM support_tickets WHERE status IN ('OPEN', 'CUSTOMER_REPLY')`,
    );
    return { openCount: Number(rows[0]?.c ?? 0) };
  }

  async internalCancelTask(taskId: string) {
    const systemActor: AuthUser = { id: 'system', name: 'Đội ngũ Hỗ trợ', email: 'hub@nov.ai.vn', roleId: 'system', roleSlug: 'admin', permissions: ['*'] };
    return this.ai.adminCancel(taskId, systemActor);
  }

  private async callChildHub<T = any>(child: ChildSiteMeta, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${child.apiBase}/api/internal/hub-tickets${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Server-Secret': child.serverSecret,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let msg = `Web con ${child.domain} trả lỗi HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(txt);
        if (parsed?.message) msg = Array.isArray(parsed.message) ? parsed.message.join(', ') : String(parsed.message);
      } catch {
        /* giữ msg mặc định */
      }
      throw new BadRequestException(msg);
    }
    return (await res.json()) as T;
  }

  /** Đếm tổng số Ticket đang chờ xử lý trên Web chính + toàn bộ Web con (hiện badge đỏ trên menu Admin — T-430) */
  async adminOpenTicketsCount(user?: AuthUser): Promise<number> {
    const localCnt = await this.prisma
      .$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*)::int AS c FROM support_tickets WHERE status IN ('OPEN', 'CUSTOMER_REPLY')`)
      .then((r) => Number(r[0]?.c ?? 0))
      .catch(() => 0);

    if (isChildSite() || shouldHideAiProviders(user)) return localCnt;

    const children = await this.discoverChildSites();
    if (!children.length) return localCnt;
    const childCounts = await Promise.all(
      children.map((c) =>
        this.callChildHub<{ openCount: number }>(c, '/open-count')
          .then((r) => Number(r?.openCount ?? 0))
          .catch(() => 0),
      ),
    );
    return localCnt + childCounts.reduce((a, b) => a + b, 0);
  }

  // ---------------- QUẢN TRỊ VIÊN (/admin/tickets) ----------------

  private async localAdminList(q: TicketQueryDto) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const offset = (page - 1) * limit;
    const status = (q.status ?? '').trim().toUpperCase();
    const search = (q.search ?? '').trim();

    const params: unknown[] = [];
    const conds: string[] = ['1=1'];

    if (status === 'OPEN') {
      conds.push(`t.status IN ('OPEN', 'CUSTOMER_REPLY')`);
    } else if (status === 'ANSWERED' || status === 'CLOSED') {
      params.push(status);
      conds.push(`t.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      const pIdx = params.length;
      params.push(search.replace(/^#?(TK-?)?/i, ''));
      const exactIdx = params.length;
      conds.push(
        `(t.subject ILIKE $${pIdx} OR COALESCE(t.order_codes, '') ILIKE $${pIdx} OR u.email ILIKE $${pIdx} OR u.name ILIKE $${pIdx} OR CAST(t.code AS TEXT) = $${exactIdx})`,
      );
    }

    const whereSql = conds.join(' AND ');

    const [rows, totalRows, countRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<TicketRow[]>(
        `SELECT t.*,
           u.name AS user_name,
           u.email AS user_email,
           u."walletBalance" AS user_balance,
           lm.body AS last_body,
           lm.is_staff AS last_is_staff,
           lm.attachments AS last_attachments
         FROM support_tickets t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN LATERAL (
           SELECT body, is_staff, attachments FROM support_ticket_messages m
           WHERE m.ticket_id = t.id
           ORDER BY m.created_at DESC LIMIT 1
         ) lm ON TRUE
         WHERE ${whereSql}
         ORDER BY
           CASE WHEN t.status IN ('OPEN', 'CUSTOMER_REPLY') THEN 0 ELSE 1 END,
           t.staff_unread DESC,
           t.last_reply_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<{ total: bigint }[]>(
        `SELECT COUNT(*)::bigint AS total
         FROM support_tickets t
         JOIN users u ON u.id = t.user_id
         WHERE ${whereSql}`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<{ status: string; cnt: bigint; unread: bigint }[]>(
        `SELECT status,
           COUNT(*)::bigint AS cnt,
           SUM(CASE WHEN staff_unread THEN 1 ELSE 0 END)::bigint AS unread
         FROM support_tickets
         GROUP BY status`,
      ),
    ]);

    let openCnt = 0;
    let answeredCnt = 0;
    let closedCnt = 0;
    let unread = 0;
    for (const c of countRows) {
      const n = Number(c.cnt || 0);
      unread += Number(c.unread || 0);
      if (c.status === 'OPEN' || c.status === 'CUSTOMER_REPLY') openCnt += n;
      else if (c.status === 'ANSWERED') answeredCnt += n;
      else if (c.status === 'CLOSED') closedCnt += n;
    }
    const total = Number(totalRows[0]?.total ?? 0);

    return {
      data: rows.map((r) => this.mapTicket(r)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      counts: {
        ALL: openCnt + answeredCnt + closedCnt,
        OPEN: openCnt,
        ANSWERED: answeredCnt,
        CLOSED: closedCnt,
      },
      unread,
    };
  }

  async adminList(q: TicketQueryDto, user?: AuthUser) {
    if (isChildSite() || shouldHideAiProviders(user)) {
      return this.localAdminList(q);
    }

    const children = await this.discoverChildSites();
    if (!children.length) {
      const localOnly = await this.localAdminList(q);
      return {
        ...localOnly,
        data: localOnly.data.map((d) => ({ ...d, siteCode: 'main', siteDomain: this.mainDomain, isFromChildSite: false })),
        sites: [{ code: 'main', domain: this.mainDomain, count: localOnly.counts.ALL, openCount: localOnly.counts.OPEN }],
      };
    }

    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const statusFilter = (q.status ?? '').trim().toUpperCase();
    const siteFilter = (q.site ?? '').trim().toLowerCase();
    const search = (q.search ?? '').trim().toLowerCase();
    const cleanCodeSearch = search.replace(/^#?(tk-?)?/i, '');

    const [localExport, ...childExports] = await Promise.all([
      this.internalExportTickets().catch(() => ({ rows: [] as TicketRow[] })),
      ...children.map((c) =>
        this.callChildHub<{ rows: TicketRow[] }>(c, '/all').catch(() => ({ rows: [] as TicketRow[] })),
      ),
    ]);

    type MergedEntry = ReturnType<TicketsService['mapTicket']> & { siteCode: string; siteDomain: string; isFromChildSite: boolean };
    const allItems: MergedEntry[] = [];
    const siteSummaries: { code: string; domain: string; count: number; openCount: number }[] = [];

    const pushSiteRows = (siteCode: string, siteDomain: string, isChild: boolean, rows: TicketRow[]) => {
      let sCount = 0;
      let sOpen = 0;
      for (const r of rows) {
        sCount += 1;
        if (r.status === 'OPEN' || r.status === 'CUSTOMER_REPLY') sOpen += 1;
        const mapped = this.mapTicket(r, undefined, { siteCode, siteDomain, isChild });
        allItems.push({ ...mapped, siteCode, siteDomain, isFromChildSite: isChild });
      }
      siteSummaries.push({ code: siteCode, domain: siteDomain, count: sCount, openCount: sOpen });
    };

    pushSiteRows('main', this.mainDomain, false, localExport.rows ?? []);
    children.forEach((c, idx) => {
      pushSiteRows(c.code, c.domain, true, childExports[idx]?.rows ?? []);
    });

    const bySite = siteFilter && siteFilter !== 'all' ? allItems.filter((it) => it.siteCode.toLowerCase() === siteFilter) : allItems;

    let openCnt = 0;
    let answeredCnt = 0;
    let closedCnt = 0;
    let unread = 0;
    for (const it of bySite) {
      if (it.staffUnread) unread += 1;
      if (it.status === 'OPEN' || it.status === 'CUSTOMER_REPLY') openCnt += 1;
      else if (it.status === 'ANSWERED') answeredCnt += 1;
      else if (it.status === 'CLOSED') closedCnt += 1;
    }

    const filtered = bySite.filter((it) => {
      if (statusFilter === 'OPEN' && it.status !== 'OPEN' && it.status !== 'CUSTOMER_REPLY') return false;
      if ((statusFilter === 'ANSWERED' || statusFilter === 'CLOSED') && it.status !== statusFilter) return false;
      if (search) {
        const hay = `${it.subject} ${it.orderCodes ?? ''} ${it.user?.email ?? ''} ${it.user?.name ?? ''} ${it.siteDomain}`.toLowerCase();
        if (!hay.includes(search) && String(it.code) !== cleanCodeSearch) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const aOpen = a.status === 'OPEN' || a.status === 'CUSTOMER_REPLY' ? 0 : 1;
      const bOpen = b.status === 'OPEN' || b.status === 'CUSTOMER_REPLY' ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      if (a.staffUnread !== b.staffUnread) return a.staffUnread ? -1 : 1;
      return new Date(b.lastReplyAt).getTime() - new Date(a.lastReplyAt).getTime();
    });

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const pageRows = filtered.slice(offset, offset + limit);

    return {
      data: pageRows,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      counts: {
        ALL: openCnt + answeredCnt + closedCnt,
        OPEN: openCnt,
        ANSWERED: answeredCnt,
        CLOSED: closedCnt,
      },
      unread,
      sites: siteSummaries,
    };
  }

  async localAdminDetail(id: string) {
    const rows = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT t.*, u.name AS user_name, u.email AS user_email, u."walletBalance" AS user_balance
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1::uuid
       LIMIT 1`,
      id,
    );
    const ticket = rows[0];
    if (!ticket) throw new NotFoundException('Không tìm thấy ticket');

    if (ticket.staff_unread) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE support_tickets SET staff_unread = FALSE WHERE id = $1::uuid`,
        id,
      );
      ticket.staff_unread = false;
    }

    const messages = await this.prisma.$queryRawUnsafe<MessageRow[]>(
      `SELECT * FROM support_ticket_messages WHERE ticket_id = $1::uuid ORDER BY created_at ASC`,
      id,
    );

    let linkedTasks: unknown[] = [];
    if (ticket.order_codes) {
      const codes = ticket.order_codes
        .split(/[\s,;]+/)
        .map((s) => s.replace(/^#/, '').trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 5);
      if (codes.length) {
        linkedTasks = await this.prisma.aiTask.findMany({
          where: { code: { in: codes } },
          select: {
            id: true,
            code: true,
            status: true,
            credits: true,
            refunded: true,
            error: true,
            createdAt: true,
            tool: { select: { name: true } },
          },
        });
      }
    }

    return { ...this.mapTicket(ticket, messages), linkedTasks };
  }

  private rewriteChildDetail(detail: any, child: ChildSiteMeta) {
    const messages = Array.isArray(detail?.messages)
      ? detail.messages.map((m: any) => ({
          ...m,
          attachments: this.normalizeAttachments(m.attachments, child.publicOrigin),
        }))
      : [];
    return {
      ...detail,
      id: `${child.code}__${detail.rawId || detail.id}`,
      rawId: detail.rawId || detail.id,
      siteCode: child.code,
      siteDomain: child.domain,
      isFromChildSite: true,
      messages,
    };
  }

  async adminDetail(compositeId: string, user?: AuthUser) {
    const { siteCode, ticketId } = this.parseCompositeId(compositeId);
    if (siteCode === 'main' || isChildSite() || shouldHideAiProviders(user)) {
      const d = await this.localAdminDetail(ticketId);
      return isChildSite() ? d : { ...d, siteCode: 'main', siteDomain: this.mainDomain, isFromChildSite: false };
    }
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === siteCode);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${siteCode}"`);
    const detail = await this.callChildHub<any>(child, `/${encodeURIComponent(ticketId)}`);
    return this.rewriteChildDetail(detail, child);
  }

  async localAdminReplyByName(authorName: string, id: string, dto: ReplyTicketDto, authorId: string | null = null) {
    const rows = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `SELECT * FROM support_tickets WHERE id = $1::uuid LIMIT 1`,
      id,
    );
    const ticket = rows[0];
    if (!ticket) throw new NotFoundException('Không tìm thấy ticket');

    const body = (dto.message ?? '').trim();
    const attachments = this.normalizeAttachments(dto.attachments);
    if (!body && attachments.length === 0) {
      throw new BadRequestException('Vui lòng nhập nội dung trả lời hoặc đính kèm ảnh/video');
    }

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO support_ticket_messages (ticket_id, author_id, author_name, is_staff, body, attachments)
       VALUES ($1::uuid, $2::uuid, $3, TRUE, $4, $5::jsonb)`,
      id,
      authorId,
      authorName || 'Đội ngũ Hỗ trợ',
      body,
      JSON.stringify(attachments),
    );

    await this.prisma.$executeRawUnsafe(
      `UPDATE support_tickets
       SET status = 'ANSWERED',
           customer_unread = TRUE,
           staff_unread = FALSE,
           closed_at = NULL,
           last_reply_at = NOW(),
           updated_at = NOW()
       WHERE id = $1::uuid`,
      id,
    );

    const mediaHint =
      attachments.length > 0
        ? `\n📎 <i>Đính kèm ${attachments.length} tệp ảnh/video — vui lòng mở Ticket trên website để xem</i>`
        : '';

    void this.notifyCustomerTelegram(
      ticket.user_id,
      `💬 <b>Ticket hỗ trợ #${ticket.code} đã có phản hồi mới!</b>\n` +
        `📌 ${esc(ticket.subject)}\n` +
        (body ? `👉 ${esc(body.slice(0, 400))}` : '') +
        mediaHint,
    );

    return this.localAdminDetail(id);
  }

  async adminReply(actor: AuthUser, compositeId: string, dto: ReplyTicketDto) {
    const staffUser =
      actor.id && actor.id !== 'system'
        ? await this.prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } })
        : null;
    const authorName = staffUser?.name || 'Đội ngũ Hỗ trợ';
    const { siteCode, ticketId } = this.parseCompositeId(compositeId);

    if (siteCode === 'main' || isChildSite() || shouldHideAiProviders(actor)) {
      const updated = await this.localAdminReplyByName(authorName, ticketId, dto, actor.id === 'system' ? null : actor.id);
      return isChildSite() ? updated : { ...updated, siteCode: 'main', siteDomain: this.mainDomain, isFromChildSite: false };
    }

    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === siteCode);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${siteCode}"`);

    // Chuyển đường dẫn tương đối /uploads/... sang URL tuyệt đối của web chính để khách trên web con xem trực tiếp được ảnh/video đính kèm
    const rewrittenAttachments = (dto.attachments ?? []).map((a) => ({
      ...a,
      url: a.url?.startsWith('/uploads/') ? `${this.mainOrigin}${a.url}` : a.url,
    }));

    const detail = await this.callChildHub<any>(child, `/${encodeURIComponent(ticketId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message: dto.message, attachments: rewrittenAttachments, authorName: 'Đội ngũ Hỗ trợ' }),
    });
    return this.rewriteChildDetail(detail, child);
  }

  async localAdminSetStatus(id: string, status: TicketStatusType) {
    const closedAtSql = status === 'CLOSED' ? 'NOW()' : 'NULL';
    const rows = await this.prisma.$queryRawUnsafe<TicketRow[]>(
      `UPDATE support_tickets
       SET status = $2, closed_at = ${closedAtSql}, staff_unread = FALSE, updated_at = NOW()
       WHERE id = $1::uuid
       RETURNING *`,
      id,
      status,
    );
    if (!rows[0]) throw new NotFoundException('Không tìm thấy ticket');
    return this.localAdminDetail(id);
  }

  async adminSetStatus(compositeId: string, status: TicketStatusType, actor?: AuthUser) {
    const { siteCode, ticketId } = this.parseCompositeId(compositeId);
    if (siteCode === 'main' || isChildSite() || shouldHideAiProviders(actor)) {
      const updated = await this.localAdminSetStatus(ticketId, status);
      return isChildSite() ? updated : { ...updated, siteCode: 'main', siteDomain: this.mainDomain, isFromChildSite: false };
    }
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === siteCode);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${siteCode}"`);
    const detail = await this.callChildHub<any>(child, `/${encodeURIComponent(ticketId)}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    return this.rewriteChildDetail(detail, child);
  }

  /** Bấm nút Hoàn tiền trên đơn AI đính kèm trong Ticket (hỗ trợ cả Ticket Web chính lẫn Ticket từ Web con — T-409 & T-430) */
  async adminRefundLinkedTask(compositeId: string, taskId: string, actor: AuthUser) {
    const { siteCode, ticketId } = this.parseCompositeId(compositeId);
    if (siteCode === 'main' || isChildSite() || shouldHideAiProviders(actor)) {
      await this.ai.adminCancel(taskId, actor);
      return this.adminDetail(compositeId, actor);
    }
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === siteCode);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${siteCode}"`);
    await this.callChildHub(child, `/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
    const detail = await this.callChildHub<any>(child, `/${encodeURIComponent(ticketId)}`);
    return this.rewriteChildDetail(detail, child);
  }

  // ---------------------------------------------------------------------------
  // T-430 + T-435 + T-436: Kiểm tra / Sửa thành viên & Cộng trừ tiền độc lập từng Site ngay trong Ticket
  // ---------------------------------------------------------------------------

  /** Đọc chi tiết thành viên ĐỘC LẬP theo đúng `userId` trên DB hiện tại (tuyệt đối không nối/gộp theo email giữa các site — T-435) */
  async localInspectUser(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        status: true,
        walletBalance: true,
        customDiscount: true,
        lastLoginAt: true,
        lastLoginIp: true,
        lockReason: true,
        createdAt: true,
        role: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!user) throw new NotFoundException('Không tìm thấy thành viên trên hệ thống này');

    const [walletSummary, recentTransactions, recentTasks, activeSessions] = await Promise.all([
      this.wallet.summary(userId),
      this.prisma.walletTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: {
          id: true,
          type: true,
          amount: true,
          balanceAfter: true,
          note: true,
          createdAt: true,
        },
      }),
      this.prisma.aiTask.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: {
          id: true,
          code: true,
          status: true,
          credits: true,
          refunded: true,
          error: true,
          createdAt: true,
          tool: { select: { name: true } },
        },
      }),
      this.prisma.refreshToken.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);

    return {
      user: {
        ...user,
        walletBalance: Number(user.walletBalance ?? 0),
        customDiscount: Number(user.customDiscount ?? 0),
        activeSessions,
      },
      stats: walletSummary,
      recentTransactions: recentTransactions.map((tx) => ({
        ...tx,
        amount: Number(tx.amount),
        balanceAfter: Number(tx.balanceAfter),
      })),
      recentTasks,
    };
  }

  /** Cập nhật thành viên ĐỘC LẬP theo `userId` trên DB hiện tại */
  async localUpdateUser(userId: string, dto: AdminSiteUserUpdateDto, actor?: AuthUser) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { role: true },
    });
    if (!target) throw new NotFoundException('Không tìm thấy thành viên');
    if (actor && actor.id === userId && dto.status && dto.status !== 'ACTIVE') {
      throw new BadRequestException('Không thể tự khoá tài khoản của chính mình');
    }
    // Không cho khoá nhầm tài khoản siêu quản trị cuối cùng trên site
    if (target.role.slug === 'admin' && dto.status && dto.status !== 'ACTIVE') {
      const otherAdmins = await this.prisma.user.count({
        where: { id: { not: userId }, deletedAt: null, status: 'ACTIVE', role: { slug: 'admin' } },
      });
      if (otherAdmins === 0) {
        throw new BadRequestException('Không thể khoá quản trị viên đang hoạt động duy nhất của site');
      }
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.customDiscount !== undefined) data.customDiscount = Math.max(0, Math.min(100, Number(dto.customDiscount) || 0));
    if (dto.password) {
      data.passwordHash = await this.auth.hashPassword(dto.password);
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.user.update({ where: { id: userId }, data });
    }

    let revokedSessions = 0;
    if (dto.forceLogout || dto.password || (dto.status && dto.status !== 'ACTIVE')) {
      const res = await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      revokedSessions = res.count;
    }

    const detail = await this.localInspectUser(userId);
    return { ...detail, revokedSessions };
  }

  /** Cộng / Trừ tiền ví thành viên ĐỘC LẬP trên DB hiện tại (bắt buộc khoá `idempotencyKey` chống bấm đúp / lặp trừ tiền — T-436) */
  async localAdjustUserWallet(userId: string, dto: AdminSiteUserWalletDto, actor?: AuthUser) {
    const key = dto.idempotencyKey?.trim();
    if (!key) throw new BadRequestException('Thiếu khoá chống lặp giao dịch (idempotencyKey)');
    const effectiveActor: AuthUser = actor ?? {
      id: 'system',
      name: 'Quản trị tổng',
      email: 'hub@nov.ai.vn',
      roleId: 'system',
      roleSlug: 'admin',
      permissions: ['*'],
    };
    const res = await this.wallet.adjust(
      userId,
      {
        type: dto.type,
        amount: Math.round(Math.abs(dto.amount)),
        note: dto.note?.trim() || (dto.type === 'deposit' ? 'Admin cộng tiền qua Ticket hỗ trợ' : 'Admin trừ tiền qua Ticket hỗ trợ'),
        idempotencyKey: key,
      },
      effectiveActor,
    );
    const detail = await this.localInspectUser(userId);
    return {
      ...detail,
      balance: res.balance,
      duplicate: Boolean((res as { duplicate?: boolean }).duplicate),
    };
  }

  private resolveChildOrMain(siteCode: string, actor?: AuthUser) {
    const clean = (siteCode || 'main').trim().toLowerCase();
    if (clean === 'main' || isChildSite()) {
      return { isMain: true as const, code: 'main' };
    }
    if (shouldHideAiProviders(actor)) {
      throw new ForbiddenException('Chỉ quản trị tổng trên Web mẹ mới truy cập thành viên Web con');
    }
    return { isMain: false as const, code: clean };
  }

  async adminInspectSiteUser(siteCode: string, userId: string, actor: AuthUser) {
    const target = this.resolveChildOrMain(siteCode, actor);
    if (target.isMain) {
      const d = await this.localInspectUser(userId);
      return { ...d, siteCode: 'main', siteDomain: this.mainDomain, siteName: 'Web mẹ', isFromChildSite: false };
    }
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === target.code);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${target.code}"`);
    const d = await this.callChildHub<any>(child, `/users/${encodeURIComponent(userId)}`);
    return { ...d, siteCode: child.code, siteDomain: child.domain, siteName: child.siteName, isFromChildSite: true };
  }

  async adminUpdateSiteUser(siteCode: string, userId: string, dto: AdminSiteUserUpdateDto, actor: AuthUser) {
    const target = this.resolveChildOrMain(siteCode, actor);
    if (target.isMain) {
      const d = await this.localUpdateUser(userId, dto, actor);
      return { ...d, siteCode: 'main', siteDomain: this.mainDomain, siteName: 'Web mẹ', isFromChildSite: false };
    }
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === target.code);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${target.code}"`);
    const d = await this.callChildHub<any>(child, `/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify(dto),
    });
    return { ...d, siteCode: child.code, siteDomain: child.domain, siteName: child.siteName, isFromChildSite: true };
  }

  async adminAdjustSiteUserWallet(siteCode: string, userId: string, dto: AdminSiteUserWalletDto, actor: AuthUser) {
    const target = this.resolveChildOrMain(siteCode, actor);
    if (target.isMain) {
      const d = await this.localAdjustUserWallet(userId, dto, actor);
      return { ...d, siteCode: 'main', siteDomain: this.mainDomain, siteName: 'Web mẹ', isFromChildSite: false };
    }
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === target.code);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${target.code}"`);
    const scopedDto: AdminSiteUserWalletDto = {
      ...dto,
      // Khoá chống trùng gắn chặt với siteCode + userId để không bao giờ trộn lẫn
      idempotencyKey: `${child.code}:${userId}:${dto.idempotencyKey}`,
    };
    const d = await this.callChildHub<any>(child, `/users/${encodeURIComponent(userId)}/wallet`, {
      method: 'POST',
      body: JSON.stringify(scopedDto),
    });
    return { ...d, siteCode: child.code, siteDomain: child.domain, siteName: child.siteName, isFromChildSite: true };
  }

  async adminCancelSiteTask(siteCode: string, taskId: string, actor: AuthUser) {
    const target = this.resolveChildOrMain(siteCode, actor);
    if (target.isMain) {
      return this.ai.adminCancel(taskId, actor);
    }
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === target.code);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${target.code}"`);
    return this.callChildHub<any>(child, `/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }

  // ---------------------------------------------------------------------------
  // T-434 + T-436: Tìm kiếm / Xem / Tự động hoàn đơn liên hoàn giữa Web mẹ & Web con
  // ---------------------------------------------------------------------------

  async internalSearchTasks(q?: string, status?: string) {
    const kw = (q ?? '').trim();
    if (!kw) return { items: [] };
    const systemActor: AuthUser = { id: 'system', name: 'Hub', email: 'hub@nov.ai.vn', roleId: 'system', roleSlug: 'admin', permissions: ['*'] };
    const res = await this.ai.adminTasks({ page: 1, limit: 15, search: kw, status: status || undefined } as any, systemActor);
    return { items: res.data ?? [] };
  }

  async internalGetTask(taskId: string) {
    const systemActor: AuthUser = { id: 'system', name: 'Hub', email: 'hub@nov.ai.vn', roleId: 'system', roleSlug: 'admin', permissions: ['*'] };
    return this.ai.adminTask(taskId, systemActor);
  }

  /**
   * Khi Web mẹ hoàn tiền một đơn hàng, Web con kiểm tra xem có đơn nào tương ứng theo đúng mã định danh kỹ thuật
   * (`providerTaskId = parentCode | parentId | parent.providerTaskId` — TUYỆT ĐỐI không khớp theo email khách để giữ độc lập T-435)
   * và chưa hoàn (`refunded = false`) thì tự động hoàn tiền ngay lập tức + khoá chống lặp `refund:<id>` (T-436).
   */
  async internalCascadeRefund(dto: CascadeRefundDto) {
    const matchValues: string[] = [];
    if (dto.parentCode && dto.parentCode.trim().length >= 4) matchValues.push(dto.parentCode.trim());
    if (dto.parentId && UUID_RE.test(dto.parentId.trim())) matchValues.push(dto.parentId.trim());
    if (dto.providerTaskId && dto.providerTaskId.trim().length >= 8) matchValues.push(dto.providerTaskId.trim());
    if (!matchValues.length) return { refundedTasks: [] };

    const candidates = await this.prisma.aiTask.findMany({
      where: {
        refunded: false,
        status: { in: ['PENDING', 'PROCESSING', 'SUCCEEDED'] },
        providerTaskId: { in: matchValues },
      },
      select: { id: true, code: true, credits: true },
      take: 10,
    });
    if (!candidates.length) return { refundedTasks: [] };

    const systemActor: AuthUser = {
      id: 'system',
      name: 'Hệ thống Hoàn tự động',
      email: 'hub@nov.ai.vn',
      roleId: 'system',
      roleSlug: 'admin',
      permissions: ['*'],
    };
    const refundedTasks: { id: string; code: string; credits: number }[] = [];
    for (const c of candidates) {
      try {
        await this.ai.adminCancel(
          c.id,
          systemActor,
          dto.reason?.trim() || 'Đơn hàng đã được hoàn tiền đồng bộ tự động từ hệ thống tổng',
        );
        refundedTasks.push(c);
      } catch {
        /* nếu đơn vừa được hoàn trước đó thì bỏ qua, không hoàn lặp */
      }
    }
    return { refundedTasks };
  }
}
