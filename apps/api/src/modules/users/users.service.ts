import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuthService } from '../auth/auth.service.js';
import { MediaService } from '../media/media.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { SessionsService } from '../security/sessions.service.js';
import { TwoFactorService } from '../security/two-factor.service.js';
import { PasswordPolicyService } from '../security/password-policy.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { CommentsService } from '../comments/comments.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import type { BulkUserDto, CreateUserDto, DeleteUserDto, LockUserDto, UpdateUserDto, UserPurgeOption, UserQueryDto } from './users.dto.js';

/** Nhóm dữ liệu tuỳ chọn được tích sẵn khi xoá (dữ liệu cá nhân); đơn hàng / nội dung / media mặc định giữ lại */
export const DEFAULT_PURGE: UserPurgeOption[] = ['reviews', 'comments', 'activity', 'loginHistory'];

const userSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  bio: true,
  status: true,
  locale: true,
  avatar: true,
  avatarId: true,
  roleId: true,
  role: { select: { id: true, name: true, slug: true } },
  lastLoginAt: true,
  lastLoginIp: true,
  twoFactorEnabled: true,
  failedLogins: true,
  lockedUntil: true,
  lockReason: true,
  walletBalance: true,
  customDiscount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly events: EventEmitter2,
    private readonly media: MediaService,
    private readonly sessions: SessionsService,
    private readonly twoFactor: TwoFactorService,
    private readonly customFields: CustomFieldsService,
    private readonly passwordPolicy: PasswordPolicyService,
    private readonly comments: CommentsService,
    private readonly reviews: ReviewsService,
  ) {}

  /** Gắn url cho avatar và chuẩn hoá customDiscount về number */
  private withAvatar<T extends { avatar: Parameters<MediaService['present']>[0]; customDiscount?: unknown }>(u: T) {
    return { ...u, avatar: this.media.present(u.avatar), customDiscount: Number(u.customDiscount ?? 0) };
  }

  async list(q: UserQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.UserWhereInput = { deletedAt: null };
    if (q.search) {
      where.OR = [
        { email: { contains: q.search, mode: 'insensitive' } },
        { name: { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
      ];
    }
    if (q.status) where.status = q.status as Prisma.EnumUserStatusFilter['equals'];
    if (q.roleId) where.roleId = q.roleId;
    if (q.type === 'customer') where.role = { slug: 'customer' };
    if (q.type === 'staff') where.role = { slug: { not: 'customer' } };
    // walletBalance là cột của bảng users nên sắp xếp thẳng bằng Prisma; totalDeposit là tổng cộng dồn nên xử lý riêng bên dưới
    const sortable = ['createdAt', 'name', 'email', 'lastLoginAt', 'walletBalance'];
    const order = q.order === 'asc' ? 'asc' : 'desc';
    const select = { ...userSelect, _count: { select: { orders: true } } } satisfies Prisma.UserSelect;
    let data: Prisma.UserGetPayload<{ select: typeof select }>[];
    let total: number;
    if (q.sort === 'totalDeposit') {
      // Sắp xếp theo tổng nạp: lấy id mọi thành viên khớp bộ lọc, để SQL cộng tiền nạp và cắt trang, rồi nạp đủ dữ liệu theo đúng thứ tự
      const ids = (await this.prisma.user.findMany({ where, select: { id: true } })).map((u) => u.id);
      total = ids.length;
      const pageIds = ids.length
        ? (
            await this.prisma.$queryRawUnsafe<{ id: string }[]>(
              `SELECT u.id FROM users u
               LEFT JOIN (SELECT "userId", SUM(amount) AS s FROM wallet_transactions
                          WHERE type = 'DEPOSIT' AND meta->>'source' IN ('gateway', 'card_topup') AND "userId" = ANY($1::uuid[])
                          GROUP BY "userId") d ON d."userId" = u.id
               WHERE u.id = ANY($1::uuid[])
               ORDER BY COALESCE(d.s, 0) ${order === 'asc' ? 'ASC' : 'DESC'}, u."createdAt" DESC
               OFFSET $2 LIMIT $3`,
              ids,
              skip,
              take,
            )
          ).map((r) => r.id)
        : [];
      const rows = await this.prisma.user.findMany({ where: { id: { in: pageIds } }, select });
      data = pageIds.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
    } else if (q.sort === 'aiTasksCount') {
      // Sắp xếp theo tổng số đơn chạy AI (T-448)
      const ids = (await this.prisma.user.findMany({ where, select: { id: true } })).map((u) => u.id);
      total = ids.length;
      const pageIds = ids.length
        ? (
            await this.prisma.$queryRawUnsafe<{ id: string }[]>(
              `SELECT u.id FROM users u
               LEFT JOIN (SELECT "userId", COUNT(*)::int AS c FROM ai_tasks WHERE "userId" = ANY($1::uuid[]) GROUP BY "userId") t ON t."userId" = u.id
               WHERE u.id = ANY($1::uuid[])
               ORDER BY COALESCE(t.c, 0) ${order === 'asc' ? 'ASC' : 'DESC'}, u."createdAt" DESC
               OFFSET $2 LIMIT $3`,
              ids,
              skip,
              take,
            )
          ).map((r) => r.id)
        : [];
      const rows = await this.prisma.user.findMany({ where: { id: { in: pageIds } }, select });
      data = pageIds.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
    } else {
      const orderBy = { [sortable.includes(q.sort ?? '') ? q.sort! : 'createdAt']: order };
      [data, total] = await Promise.all([this.prisma.user.findMany({ where, skip, take, orderBy, select }), this.prisma.user.count({ where })]);
    }
    const userIds = data.map((u) => u.id);
    // Thống kê credits & tổng đơn chạy AI của các user trong trang
    const [stats, aiTaskGroups, deposits] = data.length
      ? await Promise.all([
          this.prisma.creditTransaction.groupBy({
            by: ['userId', 'type'],
            where: { userId: { in: userIds }, type: { in: ['USAGE', 'REFUND', 'PURCHASE'] } },
            _sum: { amount: true },
            _count: { _all: true },
          }),
          this.prisma.aiTask.groupBy({
            by: ['userId'],
            where: { userId: { in: userIds } },
            _count: { _all: true },
          }),
          // Tổng tiền thật đã nạp vào ví qua cổng thanh toán / thẻ cào (giống cách tính "tiền nạp" ở Tổng quan, không tính admin cộng tay)
          this.prisma.$queryRawUnsafe<{ userId: string; s: number }[]>(
            `SELECT "userId", SUM(amount)::float AS s FROM wallet_transactions
             WHERE type = 'DEPOSIT' AND meta->>'source' IN ('gateway', 'card_topup') AND "userId" = ANY($1::uuid[])
             GROUP BY "userId"`,
            userIds,
          ),
        ])
      : [[], [], []];
    const sumOf = (userId: string, type: string) => stats.find((x) => x.userId === userId && x.type === type)?._sum.amount ?? 0;
    const countOf = (userId: string, type: string) => stats.find((x) => x.userId === userId && x.type === type)?._count._all ?? 0;
    const taskCountMap = new Map(aiTaskGroups.map((g) => [g.userId, g._count._all]));
    return paginate(
      data.map((u) => ({
        ...this.withAvatar(u),
        // USAGE ghi số âm, REFUND số dương → đã dùng thực = -(USAGE + REFUND)
        creditsUsed: Math.max(0, -(sumOf(u.id, 'USAGE') + sumOf(u.id, 'REFUND'))),
        creditsPurchased: sumOf(u.id, 'PURCHASE'),
        totalDeposit: deposits.find((d) => d.userId === u.id)?.s ?? 0,
        aiTasksCount: Math.max(taskCountMap.get(u.id) ?? 0, countOf(u.id, 'USAGE')),
      })),
      total,
      page,
      limit,
    );
  }

  async get(id: string) {
    const user = await this.prisma.user.findFirstOrThrow({
      where: { id, deletedAt: null },
      select: { ...userSelect, meta: true, customFields: true, addresses: { orderBy: { createdAt: 'asc' } }, _count: { select: { orders: true, posts: true } } },
    });
    return this.withAvatar(user);
  }

  /** Không cho thao tác lên tài khoản / gán vai trò có quyền vượt quá quyền của người thực hiện */
  private async assertCanManage(actor: AuthUser, targetId: string | null, newRoleId?: string) {
    const isSuper = actor.permissions.includes('*');
    const exceeds = (perms: string[]) => !isSuper && perms.some((p) => p === '*' || !actor.permissions.includes(p));
    if (targetId && targetId !== actor.id) {
      const target = await this.prisma.user.findUniqueOrThrow({ where: { id: targetId }, include: { role: true } });
      if (exceeds(target.role.permissions)) throw new ForbiddenException('Không thể chỉnh sửa tài khoản có quyền cao hơn bạn');
    }
    if (newRoleId) {
      if (targetId === actor.id && newRoleId !== actor.roleId) throw new BadRequestException('Không thể tự đổi vai trò của chính mình');
      const role = await this.prisma.role.findUniqueOrThrow({ where: { id: newRoleId } });
      if (exceeds(role.permissions)) throw new ForbiddenException('Không thể gán vai trò có quyền cao hơn bạn');
    }
  }

  /** Luôn phải còn ít nhất 1 quản trị viên đang hoạt động */
  private async assertKeepsAdmin(targetId: string, dto: { roleId?: string; status?: string }) {
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id: targetId }, include: { role: true } });
    if (target.role.slug !== 'administrator') return;
    const losesAdmin = (dto.roleId && dto.roleId !== target.roleId) || (dto.status && dto.status !== 'ACTIVE');
    if (!losesAdmin) return;
    const others = await this.prisma.user.count({ where: { id: { not: targetId }, role: { slug: 'administrator' }, status: 'ACTIVE', deletedAt: null } });
    if (!others) throw new BadRequestException('Phải còn ít nhất một Quản trị viên đang hoạt động');
  }

  async create(dto: CreateUserDto, actor: AuthUser) {
    const actorId = actor.id;
    await this.assertCanManage(actor, null, dto.roleId);
    const email = dto.email.toLowerCase().trim();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Email đã được sử dụng');
    const { password, customFields: cfInput, ...rest } = dto;
    await this.passwordPolicy.assert(password, { email, name: dto.name });
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: dto.roleId }, select: { slug: true } });
    const customFields = await this.customFields.sanitize('user', cfInput, { roleSlug: role.slug }, null, { user: actor });
    const user = await this.prisma.user.create({
      data: { ...rest, email, passwordHash: await this.auth.hashPassword(password), customFields: (customFields ?? {}) as object },
      select: userSelect,
    });
    this.events.emit('activity', { userId: actorId, action: 'user.create', entityType: 'user', entityId: user.id });
    return this.withAvatar(user);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser) {
    const actorId = actor.id;
    await this.assertCanManage(actor, id, dto.roleId);
    await this.assertKeepsAdmin(id, dto);
    const { password, customFields: cfInput, ...rest } = dto;
    if (id === actorId && (dto.status && dto.status !== 'ACTIVE')) throw new BadRequestException('Không thể tự khoá tài khoản của chính mình');
    // Tự đổi mật khẩu/email của chính mình phải qua Hồ sơ (yêu cầu mật khẩu hiện tại). Nếu không, ai cầm phiên bị lộ
    // hoặc API key có users.write sẽ đổi mật khẩu + email (rồi reset 2FA) để chiếm hẳn tài khoản.
    if (id === actorId && (password || (rest.email && rest.email.toLowerCase().trim() !== actor.email.toLowerCase()))) {
      throw new BadRequestException('Hãy đổi mật khẩu/email của chính bạn tại trang Hồ sơ (cần mật khẩu hiện tại)');
    }
    const data: Prisma.UserUncheckedUpdateInput = { ...rest };
    if (cfInput !== undefined) {
      const current = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { customFields: true, role: { select: { slug: true } } } });
      const roleSlug = dto.roleId ? (await this.prisma.role.findUniqueOrThrow({ where: { id: dto.roleId }, select: { slug: true } })).slug : current.role.slug;
      data.customFields = (await this.customFields.sanitize('user', cfInput, { roleSlug }, current.customFields, { user: actor, id })) as object;
    }
    if (rest.email) data.email = rest.email.toLowerCase().trim();
    if (password) {
      const target = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { email: true, name: true } });
      await this.passwordPolicy.assert(password, { email: rest.email ?? target.email, name: rest.name ?? target.name });
      data.passwordHash = await this.auth.hashPassword(password);
    }
    const user = await this.prisma.user.update({ where: { id }, data, select: userSelect });
    if (password || (dto.status && dto.status !== 'ACTIVE')) {
      await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    this.events.emit('user.changed', { id });
    this.events.emit('activity', { userId: actorId, action: 'user.update', entityType: 'user', entityId: id });
    return this.withAvatar(user);
  }

  /** Không cho xoá / khoá chính mình và quản trị viên cuối cùng (`requireActive`: chỉ tính quản trị viên còn đăng nhập được) */
  private async assertRemovable(id: string, actor: AuthUser, verb: string, requireActive = false) {
    await this.assertCanManage(actor, id);
    if (id === actor.id) throw new BadRequestException(`Không thể ${verb} tài khoản của chính mình`);
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, include: { role: true } });
    if (!user) throw new NotFoundException('Không tìm thấy thành viên');
    if (user.role.slug === 'administrator') {
      const now = new Date();
      const others = await this.prisma.user.count({
        where: {
          id: { not: id },
          role: { slug: 'administrator' },
          deletedAt: null,
          ...(requireActive ? { status: 'ACTIVE', OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] } : {}),
        },
      });
      if (!others) throw new BadRequestException(requireActive ? 'Phải còn ít nhất một Quản trị viên đang hoạt động' : 'Phải còn ít nhất một Quản trị viên');
    }
    return user;
  }

  /**
   * Thống kê dữ liệu liên quan tới thành viên để hiện trong hộp thoại xoá.
   * `required` = luôn bị xoá theo tài khoản (ràng buộc khoá ngoại cascade); còn lại admin tự chọn.
   */
  async deletePreview(id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true, email: true, walletBalance: true } });
    if (!user) throw new NotFoundException('Không tìm thấy thành viên');
    const w = { userId: id };
    const author = { authorId: id, deletedAt: null };
    const [sessions, apiKeys, addresses, wishlist, carts, walletTx, cardTopups, orders, posts, pages, entries, media, reviews, comments, activity, loginHistory] = await Promise.all([
      this.prisma.refreshToken.count({ where: w }),
      this.prisma.apiKey.count({ where: w }),
      this.prisma.address.count({ where: w }),
      this.prisma.wishlistItem.count({ where: w }),
      this.prisma.cart.count({ where: w }),
      this.prisma.walletTransaction.count({ where: w }),
      this.prisma.cardTopup.count({ where: w }),
      this.prisma.order.count({ where: w }),
      this.prisma.post.count({ where: author }),
      this.prisma.page.count({ where: author }),
      this.prisma.entry.count({ where: author }),
      this.prisma.media.count({ where: { uploaderId: id, deletedAt: null } }),
      this.prisma.productReview.count({ where: w }),
      this.prisma.comment.count({ where: w }),
      this.prisma.activityLog.count({ where: w }),
      this.prisma.loginAttempt.count({ where: w }),
    ]);
    const orderTotal = orders
      ? await this.prisma.order.aggregate({ where: w, _sum: { total: true } }).then((r) => Number(r._sum.total ?? 0))
      : 0;
    return {
      user: { ...user, walletBalance: Number(user.walletBalance) },
      required: [
        { key: 'sessions', label: 'Phiên đăng nhập', count: sessions },
        { key: 'apiKeys', label: 'API key', count: apiKeys },
        { key: 'addresses', label: 'Sổ địa chỉ', count: addresses },
        { key: 'wishlist', label: 'Sản phẩm yêu thích', count: wishlist },
        { key: 'carts', label: 'Giỏ hàng', count: carts },
        { key: 'walletTransactions', label: 'Lịch sử giao dịch ví', count: walletTx },
        { key: 'cardTopups', label: 'Lịch sử nạp thẻ cào', count: cardTopups },
      ],
      optional: [
        { key: 'orders', label: 'Đơn hàng', count: orders, total: orderTotal, keepNote: 'Giữ lại dưới dạng đơn của khách vãng lai (vẫn còn trong báo cáo doanh thu)', deleteNote: 'Xoá hẳn đơn kèm thanh toán, vận đơn, hoàn tiền — doanh thu báo cáo sẽ giảm' },
        { key: 'content', label: 'Bài viết, trang & nội dung', count: posts + pages + entries, detail: { posts, pages, entries }, keepNote: 'Giữ lại, bỏ trống tác giả', deleteNote: 'Chuyển vào thùng rác (khôi phục được)' },
        { key: 'media', label: 'File đã tải lên', count: media, keepNote: 'Giữ lại trong thư viện media', deleteNote: 'Chuyển vào thùng rác (tự xoá vĩnh viễn sau 30 ngày), kể cả file đang được dùng' },
        { key: 'reviews', label: 'Đánh giá sản phẩm', count: reviews, keepNote: 'Giữ lại, ẩn danh người viết', deleteNote: 'Xoá và tính lại điểm đánh giá sản phẩm' },
        { key: 'comments', label: 'Bình luận', count: comments, keepNote: 'Giữ lại, ẩn danh người viết', deleteNote: 'Xoá kèm các trả lời' },
        { key: 'activity', label: 'Nhật ký hoạt động', count: activity, keepNote: 'Giữ lại, không còn gắn tài khoản', deleteNote: 'Xoá khỏi nhật ký hệ thống' },
        { key: 'loginHistory', label: 'Lịch sử đăng nhập', count: loginHistory, keepNote: 'Giữ lại trong Trung tâm bảo mật', deleteNote: 'Xoá khỏi nhật ký đăng nhập' },
      ],
      defaults: DEFAULT_PURGE,
    };
  }

  /**
   * Xoá VĨNH VIỄN thành viên. Dữ liệu ràng buộc cascade (phiên, địa chỉ, ví, giỏ hàng...) luôn bị xoá;
   * các nhóm tuỳ chọn chỉ bị xoá khi có trong `include`, nếu không thì giữ lại và bỏ liên kết.
   * `confirmEmail` bắt buộc khi xoá từng người (chống bấm nhầm); thao tác hàng loạt bỏ qua bước này.
   */
  async remove(id: string, actor: AuthUser, dto?: DeleteUserDto) {
    const user = await this.assertRemovable(id, actor, 'xoá');
    if (dto && dto.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) throw new BadRequestException('Email xác nhận không khớp');
    const inc = new Set<UserPurgeOption>(dto ? (dto.include ?? []) : DEFAULT_PURGE);

    // thu thập trước những gì cần xử lý sau khi xoá (media, tính lại điểm đánh giá / số bình luận)
    const mediaIds = inc.has('media') ? (await this.prisma.media.findMany({ where: { uploaderId: id, deletedAt: null }, select: { id: true } })).map((m) => m.id) : [];
    const productIds = inc.has('reviews') ? [...new Set((await this.prisma.productReview.findMany({ where: { userId: id }, select: { productId: true } })).map((r) => r.productId))] : [];
    const postIds = inc.has('comments') ? [...new Set((await this.prisma.comment.findMany({ where: { userId: id }, select: { postId: true } })).map((c) => c.postId))] : [];
    const contentIds = inc.has('content')
      ? await Promise.all([
          this.prisma.post.findMany({ where: { authorId: id, deletedAt: null }, select: { id: true } }),
          this.prisma.page.findMany({ where: { authorId: id, deletedAt: null }, select: { id: true } }),
          this.prisma.entry.findMany({ where: { authorId: id, deletedAt: null }, select: { id: true } }),
        ])
      : null;

    // thu hồi phiên trước (xoá cache trạng thái phiên để access token cũ bị từ chối ngay)
    await this.sessions.revokeOthers(id, null);
    const now = new Date();
    const removed: Record<string, number> = {};
    await this.prisma.$transaction(async (tx) => {
      if (inc.has('orders')) removed.orders = (await tx.order.deleteMany({ where: { userId: id } })).count;
      if (inc.has('reviews')) removed.reviews = (await tx.productReview.deleteMany({ where: { userId: id } })).count;
      if (inc.has('comments')) removed.comments = (await tx.comment.deleteMany({ where: { userId: id } })).count;
      if (inc.has('activity')) removed.activity = (await tx.activityLog.deleteMany({ where: { userId: id } })).count;
      if (inc.has('loginHistory')) removed.loginHistory = (await tx.loginAttempt.deleteMany({ where: { userId: id } })).count;
      if (contentIds) {
        const [posts, pages, entries] = contentIds;
        await tx.post.updateMany({ where: { id: { in: posts.map((p) => p.id) } }, data: { deletedAt: now } });
        await tx.page.updateMany({ where: { id: { in: pages.map((p) => p.id) } }, data: { deletedAt: now } });
        await tx.entry.updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { deletedAt: now } });
        removed.content = posts.length + pages.length + entries.length;
      }
      // cột userId không có khoá ngoại: bỏ liên kết / dọn để không trỏ tới tài khoản đã xoá
      await tx.couponUsage.updateMany({ where: { userId: id }, data: { userId: null } });
      if (!inc.has('loginHistory')) await tx.loginAttempt.updateMany({ where: { userId: id }, data: { userId: null } });
      await tx.editLock.deleteMany({ where: { userId: id } });
      // phần còn lại do khoá ngoại xử lý: cascade (phiên, địa chỉ, ví, giỏ, thẻ cào...) hoặc SetNull (đơn, bài viết, media...)
      await tx.user.delete({ where: { id } });
    });

    // việc phụ sau khi xoá — lỗi ở đây không làm hỏng thao tác xoá
    if (mediaIds.length) await this.media.remove(mediaIds, { force: true, userId: actor.id }).catch(() => undefined);
    if (mediaIds.length) removed.media = mediaIds.length;
    if (productIds.length) await this.reviews.recompute(productIds).catch(() => undefined);
    if (postIds.length) await this.comments.recompute(postIds).catch(() => undefined);
    if (contentIds) {
      const [posts, pages, entries] = contentIds;
      for (const p of posts) this.events.emit('content.changed', { type: 'post', id: p.id, tags: ['posts', `post:${p.id}`] });
      for (const p of pages) this.events.emit('content.changed', { type: 'page', id: p.id, tags: ['pages', `page:${p.id}`, 'menus'] });
      if (entries.length) this.events.emit('content.changed', { type: 'entry', tags: ['entries'] });
    }
    if (removed.orders) this.events.emit('content.changed', { type: 'product', tags: ['products'] });
    this.events.emit('user.changed', { id });
    this.events.emit('activity', { userId: actor.id, action: 'user.delete', entityType: 'user', entityId: id, meta: { email: user.email, name: user.name, include: [...inc], removed } });
    return { success: true, removed };
  }

  /** Khoá tạm thời tới `until` kèm lý do; đăng xuất mọi thiết bị ngay. Hết hạn tự mở khoá. */
  async lock(id: string, dto: LockUserDto, actor: AuthUser) {
    const until = new Date(dto.until);
    if (!(until.getTime() > Date.now() + 30_000)) throw new BadRequestException('Thời điểm mở khoá phải ở tương lai');
    if (until.getTime() > Date.now() + 10 * 365 * 86_400_000) throw new BadRequestException('Thời gian khoá tối đa 10 năm — muốn cấm hẳn hãy đổi trạng thái sang "Bị khoá"');
    await this.assertRemovable(id, actor, 'khoá', true);
    const reason = dto.reason?.trim() || null;
    await this.prisma.user.update({ where: { id }, data: { lockedUntil: until, lockReason: reason, failedLogins: 0 } });
    await this.sessions.revokeOthers(id, null);
    this.events.emit('user.changed', { id });
    this.events.emit('activity', { userId: actor.id, action: 'user.lock', entityType: 'user', entityId: id, meta: { until: until.toISOString(), reason } });
    return { success: true, lockedUntil: until };
  }

  async revokeSessions(id: string, actor: AuthUser) {
    const actorId = actor.id;
    // không cho đăng xuất liên tục tài khoản có quyền cao hơn (vd. siêu quản trị)
    await this.assertCanManage(actor, id);
    await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    this.events.emit('activity', { userId: actorId ?? null, action: 'user.revokeSessions', entityType: 'user', entityId: id });
    return { success: true };
  }

  /** Danh sách phiên đang hoạt động của một thành viên (admin xem) */
  listSessions(id: string) {
    return this.sessions.list(id);
  }

  async revokeSession(id: string, sessionId: string, actor: AuthUser) {
    await this.assertCanManage(actor, id);
    const res = await this.sessions.revoke(id, sessionId);
    this.events.emit('activity', { userId: actor.id, action: 'user.session_revoked', entityType: 'user', entityId: id, meta: { sessionId } });
    return res;
  }

  /** Mở khoá tài khoản (khoá do đăng nhập sai nhiều lần hoặc do admin khoá tạm thời) */
  async unlock(id: string, actor: AuthUser) {
    await this.assertCanManage(actor, id);
    await this.prisma.user.update({ where: { id }, data: { failedLogins: 0, lockedUntil: null, lockReason: null } });
    this.events.emit('user.changed', { id });
    this.events.emit('activity', { userId: actor.id, action: 'user.unlock', entityType: 'user', entityId: id });
    return { success: true };
  }

  /** Đặt lại 2FA (thành viên mất điện thoại / mã dự phòng) — họ đăng nhập lại chỉ bằng mật khẩu */
  async reset2fa(id: string, actor: AuthUser) {
    await this.assertCanManage(actor, id);
    // tự tắt 2FA của chính mình phải qua Hồ sơ (cần mã/mật khẩu), không qua quyền quản lý thành viên
    if (id === actor.id) throw new BadRequestException('Hãy tắt 2FA của chính bạn tại trang Hồ sơ');
    await this.twoFactor.reset(id, actor.id);
    // cookie "tin cậy thiết bị" cũ không còn ý nghĩa; đăng xuất mọi nơi để buộc đăng nhập lại
    await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { success: true };
  }

  /**
   * Thao tác hàng loạt: chạy lần lượt từng thành viên qua đúng các hàm đơn lẻ ở trên để giữ nguyên mọi
   * ràng buộc (không vượt quyền, không tự khoá/xoá mình, luôn còn quản trị viên...). Mục lỗi không chặn mục khác.
   */
  async bulk(dto: BulkUserDto, actor: AuthUser) {
    if (dto.action === 'status' && !dto.status) throw new BadRequestException('Thiếu trạng thái cần đổi');
    if (dto.action === 'role' && !dto.roleId) throw new BadRequestException('Thiếu vai trò cần gán');
    const can = (p: string) => actor.permissions.includes('*') || actor.permissions.includes(p);
    if (dto.action === 'delete' && !can('users.delete')) throw new ForbiddenException('Bạn không có quyền xoá thành viên');
    const ids = [...new Set(dto.ids)];
    const ok: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const id of ids) {
      try {
        if (dto.action === 'status') await this.update(id, { status: dto.status }, actor);
        else if (dto.action === 'role') await this.update(id, { roleId: dto.roleId }, actor);
        else if (dto.action === 'revoke-sessions') {
          if (id === actor.id) throw new BadRequestException('Không thể tự đăng xuất chính mình tại đây');
          await this.revokeSessions(id, actor);
        } else if (dto.action === 'unlock') await this.unlock(id, actor);
        else await this.remove(id, actor);
        ok.push(id);
      } catch (e) {
        // id không tồn tại (Prisma P2025) hoặc lỗi nghiệp vụ → ghi lại thông điệp, tiếp tục mục sau
        const message = e instanceof HttpException ? e.message : (e as { code?: string })?.code === 'P2025' ? 'Không tìm thấy thành viên' : 'Lỗi không xác định';
        failed.push({ id, message });
      }
    }
    return { ok: ok.length, failed };
  }
}
