import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hasPermission } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { resolvePublishedAt } from '../../common/utils/publish.util.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { flatten, prepareTranslations } from '../../common/utils/translation.util.js';
import { readingTime } from '../../common/utils/html.util.js';
import { cleanHtmlFor } from '../../common/utils/sanitize-html.js';
import { attachRevisionAuthors, countByStatus } from '../../common/utils/status-counts.util.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { POST_CARD_INCLUDE, presentPostCard, publishedPostWhere } from './posts.presenter.js';
import { ViewDeduper } from './view-dedupe.js';
import type { PostQueryDto, PublicPostQueryDto, SavePostDto } from './posts.dto.js';

/** Số phiên bản cũ giữ lại cho mỗi bài viết */
const MAX_REVISIONS = 30;

const PUBLIC_POST_INCLUDE = {
  translations: true,
  author: { select: { id: true, name: true, bio: true, avatar: true } },
  categories: { include: { category: { include: { translations: { select: { locale: true, name: true, slug: true } } } } } },
  tags: { include: { tag: { include: { translations: { select: { locale: true, name: true, slug: true } } } } } },
} satisfies Prisma.PostInclude;

@Injectable()
export class PostsService {
  /** Chống đếm trùng lượt xem: cùng IP + bài trong 30 phút chỉ tính 1 lần (bộ nhớ tiến trình, tối đa 50k khoá) */
  private readonly viewDedupe = new ViewDeduper(30 * 60_000, 50_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly customFields: CustomFieldsService,
  ) {}

  async list(q: PostQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.PostWhereInput = { deletedAt: q.trashed === '1' ? { not: null } : null };
    if (q.status) where.status = q.status as Prisma.PostWhereInput['status'];
    if (q.categoryId) where.categories = { some: { categoryId: q.categoryId } };
    if (q.tagId) where.tags = { some: { tagId: q.tagId } };
    if (q.authorId) where.authorId = q.authorId;
    if (q.search) where.translations = { some: { title: { contains: q.search, mode: 'insensitive' } } };
    const sortable = ['createdAt', 'updatedAt', 'publishedAt', 'viewCount'];
    const orderBy = { [sortable.includes(q.sort ?? '') ? q.sort! : 'createdAt']: q.order ?? 'desc' };
    const [rows, total, statusCounts] = await Promise.all([
      this.prisma.post.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          translations: { select: { locale: true, title: true, slug: true, seoTitle: true, seoDescription: true } },
          author: { select: { id: true, name: true } },
          categories: { include: { category: { include: { translations: { select: { locale: true, name: true } } } } } },
          _count: { select: { tags: true } },
        },
      }),
      this.prisma.post.count({ where }),
      countByStatus(this.prisma, 'post'),
    ]);
    return { ...paginate(await this.media.attach(rows, ['featuredImageId']), total, page, limit), statusCounts };
  }

  async get(id: string) {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        translations: true,
        author: { select: { id: true, name: true } },
        categories: { select: { categoryId: true } },
        tags: { include: { tag: { include: { translations: true } } } },
      },
    });
    if (!post) throw new NotFoundException('Không tìm thấy bài viết');
    const { categories, tags, ...rest } = post;
    return this.media.attachOne(
      { ...rest, categoryIds: categories.map((c) => c.categoryId), tagIds: tags.map((t) => t.tagId), tags: tags.map((t) => t.tag) },
      ['featuredImageId'],
    );
  }

  private checkPublish(user: AuthUser, status?: string) {
    // hẹn giờ cũng là xuất bản (tự hiển thị khi tới giờ) -> cần cùng quyền
    if ((status === 'PUBLISHED' || status === 'SCHEDULED') && !hasPermission(user.permissions, 'posts.publish')) throw new ForbiddenException('Bạn không có quyền xuất bản bài viết');
  }

  private async resolveTags(dto: { tagIds?: string[]; newTags?: string[] }): Promise<string[]> {
    const ids = [...(dto.tagIds ?? [])];
    const locale = await this.languages.defaultLocale();
    for (const name of dto.newTags ?? []) {
      const clean = name.trim();
      if (!clean) continue;
      const existing = await this.prisma.postTagTranslation.findFirst({ where: { locale, name: { equals: clean, mode: 'insensitive' } } });
      if (existing) {
        ids.push(existing.tagId);
        continue;
      }
      const [tr] = await prepareTranslations(this.prisma, 'postTagTranslation', 'tagId', undefined, [{ locale, name: clean }], [locale]);
      const tag = await this.prisma.postTag.create({ data: { translations: { create: { locale, name: clean, slug: tr.slug } } } });
      ids.push(tag.id);
    }
    return [...new Set(ids)];
  }

  async save(id: string | undefined, dto: SavePostDto, user: AuthUser) {
    this.checkPublish(user, dto.status);
    const existing = id ? await this.prisma.post.findUniqueOrThrow({ where: { id }, include: { translations: true, categories: { select: { categoryId: true } } } }) : null;
    const canPublish = hasPermission(user.permissions, 'posts.publish');
    // không có quyền xuất bản thì không được sửa bài đang hiển thị trên site (tránh lọt nội dung chưa duyệt)
    if (existing?.status === 'PUBLISHED' && !canPublish) throw new ForbiddenException('Bài đã xuất bản — cần quyền xuất bản để chỉnh sửa');
    // chỉ người có quyền xuất bản mới được đổi tác giả
    if (!canPublish) dto.authorId = undefined;
    const translations = (await prepareTranslations(this.prisma, 'postTranslation', 'postId', id, dto.translations, await this.languages.codes())).map((t) => {
      // chống XSS lưu trữ: không có quyền "content.unfiltered_html" -> lọc HTML nội dung trước khi lưu
      // (áp cho tạo / sửa / nhân bản vì duplicate() cũng đi qua save())
      const content = cleanHtmlFor(user, t.content);
      return {
        ...t,
        content,
        // sửa nhanh (chỉ gửi tiêu đề/slug) không làm mất thời gian đọc đã tính
        readingTime: content === undefined ? undefined : readingTime(content),
        schemaJson: (t.schemaJson ?? undefined) as object | undefined,
      };
    });
    const data = await this.hooks.applyFilters('post.beforeSave', { ...dto, translations }, { user, id });
    const tagIds = await this.resolveTags(data);
    const publishedAt = resolvePublishedAt(data.publishedAt, data.status ?? existing?.status, existing?.publishedAt);
    // trường tuỳ chỉnh: nhóm áp dụng theo chuyên mục của bài
    const customFields = await this.customFields.sanitize('post', data.customFields, { categoryIds: data.categoryIds ?? existing?.categories.map((c) => c.categoryId) ?? [] }, existing?.customFields, { user, id });

    const base = {
      status: data.status,
      featuredImageId: data.featuredImageId,
      isFeatured: data.isFeatured,
      allowComments: data.allowComments,
      publishedAt,
      authorId: data.authorId,
      customFields: customFields as object | undefined,
    };

    const postId = await this.prisma.$transaction(async (tx) => {
      const post = id
        ? await tx.post.update({ where: { id }, data: base })
        : await tx.post.create({ data: { ...base, status: base.status ?? 'DRAFT', authorId: base.authorId ?? user.id } });
      for (const t of data.translations) {
        const old = existing?.translations.find((x) => x.locale === t.locale);
        // Lưu phiên bản cũ khi tiêu đề / tóm tắt / nội dung thay đổi (giống WordPress revisions)
        if (old && this.translationChanged(old, t)) {
          await tx.postRevision.create({ data: { postId: post.id, locale: old.locale, title: old.title, excerpt: old.excerpt, content: old.content, authorId: user.id } });
        }
        await tx.postTranslation.upsert({ where: { postId_locale: { postId: post.id, locale: t.locale } }, create: { ...t, postId: post.id }, update: t });
      }
      if (data.categoryIds) {
        await tx.postCategoryOnPost.deleteMany({ where: { postId: post.id } });
        await tx.postCategoryOnPost.createMany({ data: data.categoryIds.map((categoryId) => ({ postId: post.id, categoryId })) });
      }
      if (data.tagIds || data.newTags) {
        await tx.postTagOnPost.deleteMany({ where: { postId: post.id } });
        await tx.postTagOnPost.createMany({ data: tagIds.map((tagId) => ({ postId: post.id, tagId })) });
      }
      return post.id;
    });
    if (id) await this.pruneRevisions(id);
    this.afterChange(postId, id ? 'post.updated' : 'post.created', user);
    if (data.status === 'PUBLISHED' && existing?.status !== 'PUBLISHED') {
      this.events.emit('post.published', { id: postId });
      await this.hooks.doAction('post.published', { id: postId });
    }
    return this.get(postId);
  }

  private translationChanged(old: { title: string; excerpt: string | null; content: string }, t: { title: string; excerpt?: string | null; content?: string }) {
    if (old.title !== t.title) return true;
    if (t.excerpt !== undefined && (t.excerpt ?? null) !== (old.excerpt ?? null)) return true;
    if (t.content !== undefined && t.content !== old.content) return true;
    return false;
  }

  private async pruneRevisions(postId: string) {
    const old = await this.prisma.postRevision.findMany({ where: { postId }, orderBy: { createdAt: 'desc' }, skip: MAX_REVISIONS, select: { id: true } });
    if (old.length) await this.prisma.postRevision.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  // ---------------- revisions ----------------

  async revisions(id: string, locale?: string) {
    const rows = await this.prisma.postRevision.findMany({
      where: { postId: id, ...(locale ? { locale } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, locale: true, title: true, authorId: true, createdAt: true, content: true },
    });
    return attachRevisionAuthors(
      this.prisma,
      rows.map(({ content, ...r }) => ({ ...r, contentLength: content.length })),
    );
  }

  async revision(revisionId: string) {
    const rev = await this.prisma.postRevision.findUnique({ where: { id: revisionId } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const [withAuthor] = await attachRevisionAuthors(this.prisma, [rev]);
    return withAuthor;
  }

  /** Khôi phục bản dịch về một phiên bản cũ; bản hiện tại được lưu thành phiên bản mới trước khi ghi đè. */
  async restoreRevision(id: string, revisionId: string, user: AuthUser) {
    const rev = await this.prisma.postRevision.findFirst({ where: { id: revisionId, postId: id } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id } });
    if (post.status === 'PUBLISHED' && !hasPermission(user.permissions, 'posts.publish')) throw new ForbiddenException('Bài đã xuất bản — cần quyền xuất bản để chỉnh sửa');
    const current = await this.prisma.postTranslation.findUnique({ where: { postId_locale: { postId: id, locale: rev.locale } } });
    // phiên bản cũ có thể chứa HTML chưa lọc (lưu trước khi có bộ lọc) -> lọc theo quyền người khôi phục
    const content = cleanHtmlFor(user, rev.content);
    await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.postRevision.create({ data: { postId: id, locale: current.locale, title: current.title, excerpt: current.excerpt, content: current.content, authorId: user.id } });
        await tx.postTranslation.update({ where: { id: current.id }, data: { title: rev.title, excerpt: rev.excerpt, content, readingTime: readingTime(content) } });
      } else {
        // bản dịch đã bị xoá sau khi tạo revision -> tạo lại với slug duy nhất
        const [t] = await prepareTranslations(this.prisma, 'postTranslation', 'postId', id, [{ locale: rev.locale, title: rev.title }], await this.languages.codes());
        await tx.postTranslation.create({ data: { postId: id, locale: rev.locale, title: rev.title, slug: t.slug, excerpt: rev.excerpt, content, readingTime: readingTime(content) } });
      }
    });
    await this.pruneRevisions(id);
    this.afterChange(id, 'post.restored_revision', user);
    return this.get(id);
  }

  // ---------------- thùng rác ----------------

  async trash(id: string, user: AuthUser) {
    await this.prisma.post.update({ where: { id }, data: { deletedAt: new Date() } });
    this.afterChange(id, 'post.trash', user);
    return { success: true };
  }

  async restore(id: string, user: AuthUser) {
    await this.prisma.post.update({ where: { id }, data: { deletedAt: null } });
    this.afterChange(id, 'post.restore', user);
    return { success: true };
  }

  /** Xoá vĩnh viễn - chỉ áp dụng cho bài đã ở trong thùng rác */
  async destroy(id: string, user: AuthUser) {
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id } });
    if (!post.deletedAt) throw new ForbiddenException('Hãy chuyển bài viết vào thùng rác trước khi xoá vĩnh viễn');
    await this.prisma.post.delete({ where: { id } });
    this.afterChange(id, 'post.destroy', user);
    return { success: true };
  }

  private afterChange(id: string, action: string, user?: AuthUser) {
    this.events.emit(action, { id });
    this.events.emit('content.changed', { type: 'post', id, tags: ['posts', `post:${id}`] });
    if (user) this.events.emit('activity', { userId: user.id, action, entityType: 'post', entityId: id });
  }

  async removeTranslation(id: string, locale: string) {
    if ((await this.prisma.postTranslation.count({ where: { postId: id } })) <= 1) throw new ForbiddenException('Bài viết phải có ít nhất một bản dịch');
    await this.prisma.postTranslation.delete({ where: { postId_locale: { postId: id, locale } } });
    this.afterChange(id, 'post.updated');
    return this.get(id);
  }

  async duplicate(id: string, user: AuthUser) {
    const src = await this.prisma.post.findUniqueOrThrow({ where: { id }, include: { translations: true, categories: true, tags: true } });
    return this.save(
      undefined,
      {
        status: 'DRAFT',
        featuredImageId: src.featuredImageId,
        customFields: (src.customFields ?? {}) as Record<string, unknown>,
        categoryIds: src.categories.map((c) => c.categoryId),
        tagIds: src.tags.map((t) => t.tagId),
        translations: src.translations.map(({ id: _i, postId: _p, readingTime: _r, ...t }) => ({
          ...t,
          title: `${t.title} (bản sao)`,
          slug: `${t.slug}-copy`,
          schemaJson: (t.schemaJson as Record<string, unknown>) ?? undefined,
        })),
      },
      user,
    );
  }

  async bulk(ids: string[], action: 'trash' | 'restore' | 'publish' | 'draft' | 'destroy', user: AuthUser) {
    if ((action === 'publish' || action === 'draft') && !hasPermission(user.permissions, 'posts.publish')) throw new ForbiddenException('Bạn không có quyền xuất bản / gỡ bài viết');
    if (['trash', 'restore', 'destroy'].includes(action) && !hasPermission(user.permissions, 'posts.delete')) throw new ForbiddenException('Bạn không có quyền xoá bài viết');
    switch (action) {
      case 'trash':
        await this.prisma.post.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
        break;
      case 'restore':
        await this.prisma.post.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
        break;
      case 'publish': {
        const newly = await this.prisma.post.findMany({ where: { id: { in: ids }, status: { not: 'PUBLISHED' } }, select: { id: true } });
        await this.prisma.post.updateMany({ where: { id: { in: ids }, publishedAt: null }, data: { publishedAt: new Date() } });
        await this.prisma.post.updateMany({ where: { id: { in: ids } }, data: { status: 'PUBLISHED' } });
        for (const { id } of newly) {
          this.events.emit('post.published', { id });
          await this.hooks.doAction('post.published', { id });
        }
        break;
      }
      case 'draft':
        await this.prisma.post.updateMany({ where: { id: { in: ids } }, data: { status: 'DRAFT' } });
        break;
      case 'destroy':
        // chỉ xoá vĩnh viễn bài đã nằm trong thùng rác
        await this.prisma.post.deleteMany({ where: { id: { in: ids }, deletedAt: { not: null } } });
        break;
    }
    for (const id of ids) this.afterChange(id, `post.${action}`, user);
    return { success: true };
  }

  // ---------------- public ----------------

  async publicList(q: PublicPostQueryDto) {
    const locale = await this.languages.resolve(q.locale);
    const fallback = await this.languages.defaultLocale();
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.PostWhereInput = { ...publishedPostWhere(), translations: { some: { locale } } };
    if (q.category) where.categories = { some: { category: { translations: { some: { slug: q.category } } } } };
    if (q.tag) where.tags = { some: { tag: { translations: { some: { slug: q.tag } } } } };
    if (q.featured === '1') where.isFeatured = true;
    if (q.search) where.translations = { some: { locale, OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { content: { contains: q.search, mode: 'insensitive' } }] } };
    // lọc theo trường tuỳ chỉnh ?cf[key]=value
    const cfWhere = await this.customFields.publicWhere<Prisma.PostWhereInput>('post', q.cf);
    if (cfWhere.length) where.AND = cfWhere;
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({ where, skip, take, orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], include: POST_CARD_INCLUDE }),
      this.prisma.post.count({ where }),
    ]);
    const media = await this.media.findMany(rows.map((r) => r.featuredImageId));
    return paginate(rows.map((r) => presentPostCard(r, locale, fallback, media)), total, page, limit);
  }

  async publicBySlug(slug: string, localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    const post = await this.prisma.post.findFirst({ where: { ...publishedPostWhere(), translations: { some: { slug, locale } } }, include: PUBLIC_POST_INCLUDE });
    if (!post) throw new NotFoundException('Không tìm thấy bài viết');
    // KHÔNG tăng viewCount ở đây: response GET được CDN/proxy cache (s-maxage) nên request trúng cache không tới API
    // -> đếm thiếu. Frontend gọi POST /api/public/posts/:id/view từ trình duyệt sau khi trang hiển thị (xem registerView).
    return this.presentPublic(post, locale);
  }

  /**
   * Ghi nhận 1 lượt xem bài (POST /api/public/posts/:id/view, gọi từ trình duyệt).
   * - Chỉ tính bài đang hiển thị công khai (PUBLISHED / hẹn giờ đã tới giờ, chưa xoá); không có -> 404.
   * - Cùng IP + bài trong 30 phút chỉ tính 1 lần -> trả `{ counted: false }`, không chạm DB.
   */
  async registerView(id: string, ip: string): Promise<{ counted: boolean }> {
    const key = `${ip || '-'}|${id}`;
    if (this.viewDedupe.isDuplicate(key)) return { counted: false };
    // updateMany để gộp điều kiện "đã xuất bản" vào cùng câu lệnh tăng (không cần đọc trước)
    const r = await this.prisma.post.updateMany({ where: { id, ...publishedPostWhere() }, data: { viewCount: { increment: 1 } } });
    if (!r.count) throw new NotFoundException('Không tìm thấy bài viết');
    this.viewDedupe.mark(key);
    return { counted: true };
  }

  /** Xem trước theo id (kể cả bản nháp / hẹn giờ). Không tăng lượt xem. */
  async publicById(id: string, localeInput?: string, preview = false) {
    const locale = await this.languages.resolve(localeInput);
    const post = await this.prisma.post.findFirst({ where: { id, ...(preview ? { deletedAt: null } : publishedPostWhere()) }, include: PUBLIC_POST_INCLUDE });
    if (!post) throw new NotFoundException('Không tìm thấy bài viết');
    return this.presentPublic(post, locale);
  }

  private async presentPublic(post: Prisma.PostGetPayload<{ include: typeof PUBLIC_POST_INCLUDE }>, locale: string) {
    const fallback = await this.languages.defaultLocale();
    const pickName = (list: { locale: string; name: string; slug: string }[]) => list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0];
    const flat = flatten({ ...post, categories: undefined, tags: undefined }, locale, fallback);
    const withMedia = await this.media.attachOne(flat as Record<string, unknown>, ['featuredImageId', 'ogImageId']);
    const categoryIds = post.categories.map((c) => c.categoryId);
    const related = await this.prisma.post.findMany({
      where: { ...publishedPostWhere(), id: { not: post.id }, translations: { some: { locale } }, ...(categoryIds.length ? { categories: { some: { categoryId: { in: categoryIds } } } } : {}) },
      orderBy: { publishedAt: 'desc' },
      take: 4,
      include: POST_CARD_INCLUDE,
    });
    const relMedia = await this.media.findMany(related.map((r) => r.featuredImageId));
    const result = {
      ...withMedia,
      ...(await this.customFields.present('post', post.customFields, locale, fallback, { categoryIds })),
      author: post.author ? { ...post.author, avatar: this.media.present(post.author.avatar) } : null,
      categories: post.categories.map((c) => ({ id: c.categoryId, ...pickName(c.category.translations) })),
      tags: post.tags.map((t) => ({ id: t.tagId, ...pickName(t.tag.translations) })),
      related: related.map((r) => presentPostCard(r, locale, fallback, relMedia)),
    };
    return this.hooks.applyFilters('post.public', result, { locale });
  }

  sitemapEntries() {
    return this.prisma.post.findMany({
      where: publishedPostWhere(),
      select: { id: true, updatedAt: true, featuredImageId: true, translations: { select: { locale: true, slug: true, noindex: true, title: true } } },
      orderBy: { publishedAt: 'desc' },
    });
  }
}
