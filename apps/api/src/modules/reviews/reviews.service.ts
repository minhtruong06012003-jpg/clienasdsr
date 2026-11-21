import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { CaptchaService } from '../security/captcha.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { publishedProductWhere } from '../products/products.presenter.js';
import type { AdminReviewQueryDto, BulkReviewDto, CreateReviewDto, PublicReviewQueryDto, UpdateReviewDto } from './reviews.dto.js';

interface ReviewSettings {
  enableReviews?: boolean;
  reviewRequireLogin?: boolean;
  reviewRequirePurchase?: boolean;
  reviewAutoApprove?: boolean;
}

/** Ẩn bớt tên khách: "Nguyễn Văn An" -> "Nguyễn V. A." (bảo vệ thông tin cá nhân) */
const maskName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name.trim();
  return [parts[0], ...parts.slice(1).map((p) => `${p[0]}.`)].join(' ');
};

const PUBLIC_SELECT = {
  id: true,
  rating: true,
  title: true,
  content: true,
  authorName: true,
  isVerified: true,
  reply: true,
  repliedAt: true,
  helpfulCount: true,
  createdAt: true,
} satisfies Prisma.ProductReviewSelect;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly captcha: CaptchaService,
  ) {}

  private config() {
    return this.settings.get<ReviewSettings>('commerce');
  }

  /** Tính lại điểm trung bình & số lượng đánh giá đã duyệt của sản phẩm */
  async recompute(productIds: string[]) {
    for (const productId of [...new Set(productIds)]) {
      const agg = await this.prisma.productReview.aggregate({ where: { productId, status: 'APPROVED' }, _avg: { rating: true }, _count: true });
      await this.prisma.product.update({
        where: { id: productId },
        data: { ratingAverage: Math.round((agg._avg.rating ?? 0) * 100) / 100, ratingCount: agg._count },
      });
      this.events.emit('content.changed', { type: 'product', id: productId, tags: ['products', `product:${productId}`, 'reviews'] });
    }
  }

  // ---------------- public ----------------

  async summary(productId: string) {
    const rows = await this.prisma.productReview.groupBy({ by: ['rating'], where: { productId, status: 'APPROVED' }, _count: true });
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let sum = 0;
    for (const r of rows) {
      distribution[r.rating] = r._count;
      count += r._count;
      sum += r.rating * r._count;
    }
    return { average: count ? Math.round((sum / count) * 10) / 10 : 0, count, distribution };
  }

  async publicList(productId: string, q: PublicReviewQueryDto) {
    const cfg = await this.config();
    const live = await this.prisma.product.findFirst({ where: { id: productId, ...publishedProductWhere() }, select: { id: true } });
    if (!live) throw new NotFoundException('Không tìm thấy sản phẩm');
    if (cfg.enableReviews === false) return { ...paginate([], 0, 1, q.limit ?? 10), summary: { average: 0, count: 0, distribution: {} }, enabled: false };
    const { skip, take, page, limit } = pageArgs({ page: q.page, limit: Math.min(q.limit ?? 10, 50) });
    const where: Prisma.ProductReviewWhereInput = { productId, status: 'APPROVED', ...(q.rating ? { rating: q.rating } : {}) };
    const orderBy: Prisma.ProductReviewOrderByWithRelationInput[] =
      q.sort === 'oldest'
        ? [{ createdAt: 'asc' }]
        : q.sort === 'highest'
          ? [{ rating: 'desc' }, { createdAt: 'desc' }]
          : q.sort === 'lowest'
            ? [{ rating: 'asc' }, { createdAt: 'desc' }]
            : q.sort === 'helpful'
              ? [{ helpfulCount: 'desc' }, { createdAt: 'desc' }]
              : [{ createdAt: 'desc' }];
    const [rows, total, summary] = await Promise.all([
      this.prisma.productReview.findMany({ where, skip, take, orderBy, select: PUBLIC_SELECT }),
      this.prisma.productReview.count({ where }),
      this.summary(productId),
    ]);
    const data = rows.map((r) => ({ ...r, authorName: maskName(r.authorName) }));
    return { ...paginate(data, total, page, limit), summary, enabled: true, requireLogin: !!cfg.reviewRequireLogin, requirePurchase: !!cfg.reviewRequirePurchase };
  }

  /**
   * Đơn đã hoàn thành của THÀNH VIÊN có sản phẩm này -> nhãn "Đã mua hàng".
   * Không xác minh theo email khách vãng lai tự nhập (có thể mạo danh email người khác).
   */
  private async findPurchase(productId: string, user?: AuthUser) {
    if (!user) return null;
    return this.prisma.order.findFirst({
      where: { status: 'COMPLETED', items: { some: { productId } }, userId: user.id },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(productId: string, dto: CreateReviewDto, user: AuthUser | undefined, ip?: string) {
    const cfg = await this.config();
    if (cfg.enableReviews === false) throw new ForbiddenException('Website đang tắt chức năng đánh giá');
    if (cfg.reviewRequireLogin && !user) throw new ForbiddenException('Vui lòng đăng nhập để đánh giá');
    await this.captcha.assert(dto._captcha, ip, 'review');
    const product = await this.prisma.product.findFirst({ where: { id: productId, ...publishedProductWhere() }, select: { id: true } });
    if (!product) throw new NotFoundException('Không tìm thấy sản phẩm');

    let authorName = dto.authorName?.trim();
    let authorEmail = dto.authorEmail?.trim().toLowerCase();
    if (user) {
      const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, email: true } });
      authorName = u.name;
      authorEmail = u.email;
    }
    if (!authorName) throw new BadRequestException('Vui lòng nhập tên của bạn');
    if (!user && !authorEmail) throw new BadRequestException('Vui lòng nhập email của bạn');
    if (cfg.reviewRequirePurchase && !user) throw new ForbiddenException('Vui lòng đăng nhập để xác minh bạn đã mua sản phẩm');

    // mỗi khách 1 đánh giá / sản phẩm. Thành viên kiểm tra theo tài khoản; khách vãng lai theo email
    // NHƯNG chỉ trong đánh giá của khách vãng lai -> người lạ không thể chặn thành viên thật bằng email của họ
    const dup = await this.prisma.productReview.findFirst({
      where: { productId, status: { not: 'SPAM' }, ...(user ? { userId: user.id } : { userId: null, authorEmail }) },
      select: { id: true },
    });
    if (dup) throw new ConflictException('Bạn đã đánh giá sản phẩm này rồi');

    const purchase = await this.findPurchase(productId, user);
    if (cfg.reviewRequirePurchase && !purchase) throw new ForbiddenException('Chỉ khách đã mua và nhận sản phẩm mới có thể đánh giá');

    const data = await this.hooks.applyFilters('review.beforeCreate', {
      productId,
      userId: user?.id ?? null,
      orderId: purchase?.id ?? null,
      authorName: authorName.slice(0, 100),
      authorEmail: authorEmail ?? null,
      rating: dto.rating,
      title: dto.title?.trim() || null,
      content: dto.content.trim(),
      isVerified: !!purchase,
      status: (cfg.reviewAutoApprove ? 'APPROVED' : 'PENDING') as 'APPROVED' | 'PENDING',
      locale: dto.locale ?? null,
      ip: ip ?? null,
    });
    const review = await this.prisma.productReview.create({ data });
    if (review.status === 'APPROVED') await this.recompute([productId]);
    this.events.emit('review.created', { review });
    await this.hooks.doAction('review.created', review);
    return {
      success: true,
      status: review.status,
      message: review.status === 'APPROVED' ? 'Cảm ơn bạn đã đánh giá!' : 'Cảm ơn bạn! Đánh giá sẽ hiển thị sau khi được duyệt.',
    };
  }

  /** Mỗi IP chỉ tính 1 lượt "hữu ích" / đánh giá trong 24h (bộ nhớ tiến trình) */
  private helpfulSeen = new Map<string, number>();

  async markHelpful(id: string, ip?: string) {
    const key = `${id}:${ip ?? ''}`;
    const now = Date.now();
    if ((this.helpfulSeen.get(key) ?? 0) > now) return { success: true, duplicate: true };
    if (this.helpfulSeen.size > 50_000) for (const [k, exp] of this.helpfulSeen) if (exp < now) this.helpfulSeen.delete(k);
    this.helpfulSeen.set(key, now + 86400_000);
    const r = await this.prisma.productReview.updateMany({ where: { id, status: 'APPROVED' }, data: { helpfulCount: { increment: 1 } } });
    if (!r.count) throw new NotFoundException('Không tìm thấy đánh giá');
    return { success: true };
  }

  /** Sản phẩm trong đơn đã hoàn thành mà khách chưa đánh giá */
  async reviewable(userId: string) {
    const items = await this.prisma.orderItem.findMany({
      where: { order: { userId, status: 'COMPLETED' }, productId: { not: null } },
      select: { productId: true, name: true, image: true, order: { select: { code: true, createdAt: true } } },
      orderBy: { order: { createdAt: 'desc' } },
    });
    const reviewed = new Set((await this.prisma.productReview.findMany({ where: { userId }, select: { productId: true } })).map((r) => r.productId));
    const seen = new Set<string>();
    const out = [];
    for (const it of items) {
      if (!it.productId || reviewed.has(it.productId) || seen.has(it.productId)) continue;
      seen.add(it.productId);
      out.push({ productId: it.productId, name: it.name, image: it.image, orderCode: it.order.code });
    }
    const slugs = await this.prisma.productTranslation.findMany({ where: { productId: { in: [...seen] } }, select: { productId: true, locale: true, slug: true } });
    return out.map((o) => ({ ...o, slugs: Object.fromEntries(slugs.filter((s) => s.productId === o.productId).map((s) => [s.locale, s.slug])) }));
  }

  // ---------------- admin ----------------

  async list(q: AdminReviewQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.ProductReviewWhereInput = {};
    if (q.status) where.status = q.status as Prisma.ProductReviewWhereInput['status'];
    if (q.rating) where.rating = q.rating;
    if (q.productId) where.productId = q.productId;
    if (q.search) {
      where.OR = [
        { content: { contains: q.search, mode: 'insensitive' } },
        { title: { contains: q.search, mode: 'insensitive' } },
        { authorName: { contains: q.search, mode: 'insensitive' } },
        { authorEmail: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [rows, total, counts] = await Promise.all([
      this.prisma.productReview.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: q.order ?? 'desc' },
        include: {
          product: { select: { id: true, featuredImageId: true, translations: { select: { locale: true, name: true, slug: true } } } },
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.productReview.count({ where }),
      this.prisma.productReview.groupBy({ by: ['status'], _count: true }),
    ]);
    const media = await this.media.findMany(rows.map((r) => r.product.featuredImageId));
    const data = rows.map((r) => ({ ...r, product: { ...r.product, featuredImage: media.get(r.product.featuredImageId ?? '') ?? null } }));
    return { ...paginate(data, total, page, limit), statusCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  async update(id: string, dto: UpdateReviewDto, actor: AuthUser) {
    const review = await this.prisma.productReview.findUniqueOrThrow({ where: { id } });
    const data: Prisma.ProductReviewUpdateInput = {};
    if (dto.status) data.status = dto.status;
    if (dto.reply !== undefined) {
      const reply = dto.reply.trim();
      data.reply = reply || null;
      data.repliedAt = reply ? new Date() : null;
      data.repliedById = reply ? actor.id : null;
    }
    const updated = await this.prisma.productReview.update({ where: { id }, data });
    if (dto.status && dto.status !== review.status) await this.recompute([review.productId]);
    else if (dto.reply !== undefined) this.events.emit('content.changed', { type: 'product', id: review.productId, tags: ['products', `product:${review.productId}`, 'reviews'] });
    this.events.emit('activity', { userId: actor.id, action: 'review.update', entityType: 'review', entityId: id, meta: { status: dto.status } });
    return updated;
  }

  async bulk(dto: BulkReviewDto, actor: AuthUser) {
    const rows = await this.prisma.productReview.findMany({ where: { id: { in: dto.ids } }, select: { productId: true } });
    if (dto.action === 'delete') await this.prisma.productReview.deleteMany({ where: { id: { in: dto.ids } } });
    else await this.prisma.productReview.updateMany({ where: { id: { in: dto.ids } }, data: { status: dto.action as 'APPROVED' } });
    await this.recompute(rows.map((r) => r.productId));
    this.events.emit('activity', { userId: actor.id, action: `review.${dto.action.toLowerCase()}`, entityType: 'review', meta: { count: rows.length } });
    return { success: true };
  }

  async remove(id: string, actor: AuthUser) {
    const r = await this.prisma.productReview.delete({ where: { id } });
    await this.recompute([r.productId]);
    this.events.emit('activity', { userId: actor.id, action: 'review.delete', entityType: 'review', entityId: id });
    return { success: true };
  }
}
