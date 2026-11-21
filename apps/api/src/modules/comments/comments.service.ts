import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MailService } from '../mail/mail.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { CaptchaService } from '../security/captcha.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { publishedPostWhere } from '../posts/posts.presenter.js';
import type { AdminCommentQueryDto, BulkCommentDto, CommentStatusValue, CreateCommentDto, PublicCommentQueryDto, ReplyCommentDto, UpdateCommentDto } from './comments.dto.js';

interface CommentSettings {
  enabled?: boolean;
  requireLogin?: boolean;
  autoApprove?: boolean;
  allowReplies?: boolean;
  maxDepth?: number;
  notifyEmail?: string;
  closeAfterDays?: number;
}

/** Trường trả về cho storefront (không lộ email/IP) */
const PUBLIC_SELECT = {
  id: true,
  parentId: true,
  authorName: true,
  authorUrl: true,
  content: true,
  isAdminReply: true,
  createdAt: true,
} satisfies Prisma.CommentSelect;

const ADMIN_INCLUDE = {
  post: { select: { id: true, allowComments: true, translations: { select: { locale: true, title: true, slug: true } } } },
  user: { select: { id: true, name: true, email: true } },
  parent: { select: { id: true, authorName: true, content: true, status: true } },
  _count: { select: { replies: true } },
} satisfies Prisma.CommentInclude;

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly captcha: CaptchaService,
  ) {}

  private async config(): Promise<Required<CommentSettings>> {
    const c = await this.settings.get<CommentSettings>('comments');
    return {
      enabled: c.enabled !== false,
      requireLogin: !!c.requireLogin,
      autoApprove: !!c.autoApprove,
      allowReplies: c.allowReplies !== false,
      maxDepth: Math.min(Math.max(Number(c.maxDepth) || 1, 1), 10),
      notifyEmail: String(c.notifyEmail ?? '').trim(),
      closeAfterDays: Math.max(Number(c.closeAfterDays) || 0, 0),
    };
  }

  /** Bài viết đã hết hạn nhận bình luận theo cài đặt "đóng sau N ngày"? */
  private isExpired(cfg: Required<CommentSettings>, publishedAt: Date | null) {
    if (!cfg.closeAfterDays || !publishedAt) return false;
    return publishedAt.getTime() + cfg.closeAfterDays * 86400_000 < Date.now();
  }

  /** Đếm lại số bình luận đã duyệt của các bài viết và báo storefront làm mới cache */
  async recompute(postIds: string[]) {
    for (const postId of [...new Set(postIds)]) {
      const count = await this.prisma.comment.count({ where: { postId, status: 'APPROVED' } });
      await this.prisma.post.updateMany({ where: { id: postId }, data: { commentCount: count } });
      this.events.emit('content.changed', { type: 'post', id: postId, tags: ['posts', `post:${postId}`, 'comments'] });
    }
  }

  // ---------------- public ----------------

  /**
   * Danh sách bình luận đã duyệt: phân trang theo bình luận GỐC (createdAt asc), kèm toàn bộ trả lời
   * của các gốc đó. Trả phẳng + parentId, client tự dựng cây.
   */
  async publicList(postId: string, q: PublicCommentQueryDto) {
    const cfg = await this.config();
    const post = await this.prisma.post.findFirst({ where: { id: postId, ...publishedPostWhere() }, select: { id: true, allowComments: true, publishedAt: true, commentCount: true } });
    if (!post) throw new NotFoundException('Không tìm thấy bài viết');
    const closed = !post.allowComments || this.isExpired(cfg, post.publishedAt);
    const settings = { enabled: cfg.enabled, requireLogin: cfg.requireLogin, allowReplies: cfg.allowReplies, maxDepth: cfg.maxDepth, closed };
    const { skip, take, page, limit } = pageArgs({ page: q.page, limit: Math.min(q.limit ?? 20, 100) });
    if (!cfg.enabled) return { ...paginate([], 0, page, limit), count: 0, settings };

    const rootWhere: Prisma.CommentWhereInput = { postId, status: 'APPROVED', parentId: null };
    const [roots, total, count] = await Promise.all([
      this.prisma.comment.findMany({ where: rootWhere, skip, take, orderBy: { createdAt: 'asc' }, select: PUBLIC_SELECT }),
      this.prisma.comment.count({ where: rootWhere }),
      this.prisma.comment.count({ where: { postId, status: 'APPROVED' } }),
    ]);
    // tải lần lượt từng cấp trả lời của các gốc trong trang này (độ sâu bị chặn nên vài truy vấn nhỏ)
    const data = [...roots];
    let parentIds = roots.map((r) => r.id);
    for (let depth = 0; parentIds.length && depth < 10; depth++) {
      const replies = await this.prisma.comment.findMany({ where: { postId, status: 'APPROVED', parentId: { in: parentIds } }, orderBy: { createdAt: 'asc' }, select: PUBLIC_SELECT });
      data.push(...replies);
      parentIds = replies.map((r) => r.id);
    }
    return { ...paginate(data, total, page, limit), count, settings };
  }

  /** Độ sâu của bình luận (gốc = 1) bằng cách lần ngược chuỗi cha */
  private async depthOf(commentId: string) {
    let depth = 1;
    let cur: string | null = commentId;
    while (cur && depth < 50) {
      const row: { parentId: string | null } | null = await this.prisma.comment.findUnique({ where: { id: cur }, select: { parentId: true } });
      if (!row?.parentId) break;
      depth++;
      cur = row.parentId;
    }
    return depth;
  }

  async create(postId: string, dto: CreateCommentDto, user: AuthUser | undefined, meta: { ip?: string; userAgent?: string }) {
    const cfg = await this.config();
    if (!cfg.enabled) throw new ForbiddenException('Website đang tắt chức năng bình luận');
    if (cfg.requireLogin && !user) throw new ForbiddenException('Vui lòng đăng nhập để bình luận');
    await this.captcha.assert(dto._captcha, meta.ip, 'comment');
    const post = await this.prisma.post.findFirst({ where: { id: postId, ...publishedPostWhere() }, select: { id: true, allowComments: true, publishedAt: true, translations: { select: { locale: true, title: true, slug: true } } } });
    if (!post) throw new NotFoundException('Không tìm thấy bài viết');
    if (!post.allowComments) throw new ForbiddenException('Bài viết này đã đóng bình luận');
    if (this.isExpired(cfg, post.publishedAt)) throw new ForbiddenException('Bài viết này đã hết thời gian nhận bình luận');

    // honeypot: bot điền vào ô ẩn -> giả vờ thành công, không lưu
    if (dto._hp?.trim()) return { success: true, status: 'PENDING' as const, message: 'Cảm ơn bạn! Bình luận sẽ hiển thị sau khi được duyệt.', comment: null };

    let authorName = dto.authorName?.trim();
    let authorEmail = dto.authorEmail?.trim().toLowerCase();
    if (user) {
      const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, email: true } });
      authorName = u.name;
      authorEmail = u.email;
    }
    if (!authorName) throw new BadRequestException('Vui lòng nhập tên của bạn');
    if (!authorEmail) throw new BadRequestException('Vui lòng nhập email của bạn');

    const content = dto.content.trim();
    if (content.length < 2) throw new BadRequestException('Nội dung bình luận tối thiểu 2 ký tự');

    if (dto.parentId) {
      if (!cfg.allowReplies) throw new ForbiddenException('Website không cho phép trả lời bình luận');
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId }, select: { id: true, postId: true, status: true } });
      if (!parent || parent.postId !== postId || parent.status !== 'APPROVED') throw new BadRequestException('Bình luận cần trả lời không tồn tại hoặc chưa được duyệt');
      if ((await this.depthOf(parent.id)) + 1 > cfg.maxDepth) throw new BadRequestException('Đã đạt độ sâu trả lời tối đa');
    }

    // chống gửi trùng: cùng email, cùng nội dung trong 1 phút
    const dup = await this.prisma.comment.findFirst({ where: { postId, authorEmail, content, createdAt: { gte: new Date(Date.now() - 60_000) } }, select: { id: true } });
    if (dup) throw new BadRequestException('Bạn vừa gửi bình luận này rồi');

    let authorUrl = dto.authorUrl?.trim() || null;
    if (authorUrl && !/^https?:\/\//i.test(authorUrl)) authorUrl = `https://${authorUrl}`;

    const data = await this.hooks.applyFilters<Prisma.CommentUncheckedCreateInput>('comment.beforeCreate', {
      postId,
      parentId: dto.parentId ?? null,
      userId: user?.id ?? null,
      authorName: authorName.slice(0, 100),
      authorEmail,
      authorUrl,
      content,
      status: cfg.autoApprove ? 'APPROVED' : 'PENDING',
      isAdminReply: false,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      locale: dto.locale ?? null,
    });
    const comment = await this.prisma.comment.create({ data });
    if (comment.status === 'APPROVED') await this.recompute([postId]);
    this.events.emit('activity', { userId: user?.id ?? null, action: 'comment.create', entityType: 'comment', entityId: comment.id, meta: { postId, status: comment.status }, ip: meta.ip });
    this.events.emit('comment.created', { comment });
    await this.hooks.doAction('comment.created', comment);
    this.notify(cfg.notifyEmail, comment, post.translations).catch((e) => this.logger.warn(`Không gửi được email thông báo bình luận: ${(e as Error).message}`));

    return {
      success: true,
      status: comment.status,
      message: comment.status === 'APPROVED' ? 'Cảm ơn bạn đã bình luận!' : 'Cảm ơn bạn! Bình luận sẽ hiển thị sau khi được duyệt.',
      // bình luận vừa tạo (để client hiện ngay nếu đã duyệt)
      comment: comment.status === 'APPROVED' ? { id: comment.id, parentId: comment.parentId, authorName: comment.authorName, authorUrl: comment.authorUrl, content: comment.content, isAdminReply: false, createdAt: comment.createdAt } : null,
    };
  }

  /** Email báo có bình luận mới cho quản trị viên (nếu cấu hình) — mẫu `comment.admin_notify` */
  private async notify(to: string, comment: { id: string; postId: string; authorName: string; authorEmail: string | null; content: string; status: string }, translations: { locale: string; title: string }[]) {
    if (!to) return;
    const title = translations[0]?.title ?? '(không tiêu đề)';
    const adminUrl = (process.env.ADMIN_URL ?? '').replace(/\/$/, '');
    await this.mail.sendTemplate({
      key: 'comment.admin_notify',
      to: to.split(',').map((e) => e.trim()).filter(Boolean),
      replyTo: comment.authorEmail ?? undefined,
      vars: { comment: { id: comment.id, authorName: comment.authorName, authorEmail: comment.authorEmail ?? '', content: comment.content, postTitle: title, status: comment.status, pending: comment.status === 'PENDING', adminUrl: adminUrl ? `${adminUrl}/posts/comments?status=${comment.status}` : '' } },
      meta: { commentId: comment.id, postId: comment.postId },
    });
  }

  // ---------------- admin ----------------

  async counts() {
    const rows = await this.prisma.comment.groupBy({ by: ['status'], _count: true });
    const counts: Record<CommentStatusValue, number> = { PENDING: 0, APPROVED: 0, SPAM: 0, TRASH: 0 };
    for (const r of rows) counts[r.status] = r._count;
    return counts;
  }

  async list(q: AdminCommentQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.CommentWhereInput = {};
    if (q.status) where.status = q.status as CommentStatusValue;
    if (q.postId) where.postId = q.postId;
    if (q.search) {
      where.OR = [
        { content: { contains: q.search, mode: 'insensitive' } },
        { authorName: { contains: q.search, mode: 'insensitive' } },
        { authorEmail: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [rows, total, statusCounts] = await Promise.all([
      this.prisma.comment.findMany({ where, skip, take, orderBy: { createdAt: q.order ?? 'desc' }, include: ADMIN_INCLUDE }),
      this.prisma.comment.count({ where }),
      this.counts(),
    ]);
    return { ...paginate(rows, total, page, limit), statusCounts };
  }

  async update(id: string, dto: UpdateCommentDto, actor: AuthUser) {
    const comment = await this.prisma.comment.findUnique({ where: { id } });
    if (!comment) throw new NotFoundException('Không tìm thấy bình luận');
    const data: Prisma.CommentUpdateInput = {};
    if (dto.status) data.status = dto.status;
    if (dto.content !== undefined) {
      const content = dto.content.trim();
      if (!content) throw new BadRequestException('Nội dung bình luận không được để trống');
      data.content = content;
    }
    const updated = await this.prisma.comment.update({ where: { id }, data, include: ADMIN_INCLUDE });
    if (dto.status && dto.status !== comment.status) await this.recompute([comment.postId]);
    else if (dto.content !== undefined && comment.status === 'APPROVED') this.events.emit('content.changed', { type: 'post', id: comment.postId, tags: ['posts', `post:${comment.postId}`, 'comments'] });
    this.events.emit('activity', { userId: actor.id, action: 'comment.update', entityType: 'comment', entityId: id, meta: { status: dto.status, edited: dto.content !== undefined } });
    return updated;
  }

  /** Quản trị viên trả lời: tạo bình luận đã duyệt gắn nhãn "Quản trị viên"; bình luận gốc đang chờ sẽ được duyệt luôn */
  async reply(id: string, dto: ReplyCommentDto, actor: AuthUser) {
    const parent = await this.prisma.comment.findUnique({ where: { id }, select: { id: true, postId: true, status: true } });
    if (!parent) throw new NotFoundException('Không tìm thấy bình luận');
    if (parent.status === 'SPAM' || parent.status === 'TRASH') throw new BadRequestException('Không thể trả lời bình luận trong spam / thùng rác');
    const created = await this.prisma.$transaction(async (tx) => {
      if (parent.status === 'PENDING') await tx.comment.update({ where: { id: parent.id }, data: { status: 'APPROVED' } });
      return tx.comment.create({
        data: { postId: parent.postId, parentId: parent.id, userId: actor.id, authorName: actor.name, authorEmail: actor.email, content: dto.content.trim(), status: 'APPROVED', isAdminReply: true },
        include: ADMIN_INCLUDE,
      });
    });
    await this.recompute([parent.postId]);
    this.events.emit('activity', { userId: actor.id, action: 'comment.reply', entityType: 'comment', entityId: created.id, meta: { parentId: parent.id } });
    await this.hooks.doAction('comment.created', created);
    return created;
  }

  async bulk(dto: BulkCommentDto, actor: AuthUser) {
    const rows = await this.prisma.comment.findMany({ where: { id: { in: dto.ids } }, select: { id: true, postId: true, status: true } });
    if (dto.action === 'delete') {
      const blocked = rows.find((r) => r.status !== 'SPAM' && r.status !== 'TRASH');
      if (blocked) throw new BadRequestException('Chỉ xoá vĩnh viễn được bình luận trong spam hoặc thùng rác');
      await this.prisma.comment.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    } else {
      await this.prisma.comment.updateMany({ where: { id: { in: dto.ids } }, data: { status: dto.action } });
    }
    await this.recompute(rows.map((r) => r.postId));
    this.events.emit('activity', { userId: actor.id, action: `comment.${dto.action.toLowerCase()}`, entityType: 'comment', meta: { count: rows.length } });
    return { success: true, count: rows.length };
  }

  /** Xoá vĩnh viễn (kéo theo các trả lời) — chỉ với bình luận đã vào spam / thùng rác */
  async remove(id: string, actor: AuthUser) {
    const c = await this.prisma.comment.findUnique({ where: { id }, select: { id: true, postId: true, status: true } });
    if (!c) throw new NotFoundException('Không tìm thấy bình luận');
    if (c.status !== 'SPAM' && c.status !== 'TRASH') throw new BadRequestException('Hãy chuyển bình luận vào thùng rác hoặc spam trước khi xoá vĩnh viễn');
    await this.prisma.comment.delete({ where: { id } });
    await this.recompute([c.postId]);
    this.events.emit('activity', { userId: actor.id, action: 'comment.delete', entityType: 'comment', entityId: id });
    return { success: true };
  }
}
