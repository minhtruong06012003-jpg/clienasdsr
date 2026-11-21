import { ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hasPermission } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MediaService } from '../media/media.service.js';
import { BlockResolverService } from '../blocks/block-resolver.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { publishedCondition, resolvePublishedAt } from '../../common/utils/publish.util.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { flatten, prepareTranslations } from '../../common/utils/translation.util.js';
import { attachRevisionAuthors, countByStatus } from '../../common/utils/status-counts.util.js';
import { cleanBlocksFor } from '../../common/utils/sanitize-html.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PageQueryDto, SavePageDto } from './pages.dto.js';

const MAX_REVISIONS = 30;

@Injectable()
export class PagesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly resolver: BlockResolverService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly customFields: CustomFieldsService,
  ) {}

  onModuleInit() {
    void this.ensureDefaultPolicyPages().catch(() => undefined);
  }

  /** Tự động khởi tạo đủ 6 trang chính sách & thông tin chuẩn cho mọi site con mới tạo để không bao giờ gặp lỗi 404 (T-232) */
  private async ensureDefaultPolicyPages() {
    const general = await this.settings.get<{ siteName?: Record<string, string> | string; siteUrl?: string }>('general').catch(() => ({} as { siteName?: Record<string, string> | string; siteUrl?: string }));
    const siteName =
      typeof general.siteName === 'string'
        ? general.siteName
        : general.siteName?.vi || general.siteName?.en || 'AI Studio';
    const existing = new Set(
      (await this.prisma.pageTranslation.findMany({ select: { slug: true } })).map((r) => r.slug),
    );
    const defaults: Array<{ slug: string; titleVi: string; titleEn: string; excerptVi: string; htmlVi: string }> = [
      {
        slug: 'dieu-khoan',
        titleVi: 'Điều Khoản Dịch Vụ',
        titleEn: 'Terms of Service',
        excerptVi: 'Quy định sử dụng tài khoản, thanh toán theo lượt tạo và trách nhiệm nội dung AI.',
        htmlVi: `<div class="space-y-4 leading-relaxed"><p>Chào mừng bạn đến với <strong>${siteName}</strong>. Mọi mức phí tạo tác phẩm đều được hiển thị minh bạch bằng VNĐ trước khi thực hiện; đơn gặp lỗi kỹ thuật từ máy chủ được hoàn lại 100% vào ví tự động.</p></div>`,
      },
      {
        slug: 'chinh-sach-bao-mat',
        titleVi: 'Chính Sách Bảo Mật',
        titleEn: 'Privacy Policy',
        excerptVi: 'Cam kết bảo vệ thông tin tài khoản, tệp tải lên và quyền riêng tư của thành viên.',
        htmlVi: `<div class="space-y-4 leading-relaxed"><p><strong>${siteName}</strong> bảo mật tuyệt đối thông tin tài khoản và tệp tham chiếu người dùng tải lên; dữ liệu chỉ phục vụ xử lý tác vụ AI theo yêu cầu của bạn.</p></div>`,
      },
      {
        slug: 'chinh-sach-hoan-tien',
        titleVi: 'Chính Sách Hoàn Tiền',
        titleEn: 'Refund Policy',
        excerptVi: 'Hoàn tiền tự động 100% vào ví khi tác vụ gặp sự cố kỹ thuật hoặc quá thời gian xử lý.',
        htmlVi: `<div class="space-y-4 leading-relaxed"><p>Tất cả tác vụ AI bị lỗi xử lý hoặc quá hạn đều được hệ thống <strong>${siteName}</strong> tự động hoàn 100% số dư về ví ngay lập tức.</p></div>`,
      },
      {
        slug: 'chinh-sach-noi-dung-ai',
        titleVi: 'Chính Sách Sử Dụng & Nội Dung AI',
        titleEn: 'Acceptable Use & AI Content Policy',
        excerptVi: 'Quy định sử dụng an toàn và có trách nhiệm đối với nội dung do AI tạo ra.',
        htmlVi: `<div class="space-y-4 leading-relaxed"><p>Người dùng cam kết không tạo deepfake trái phép, nội dung nhạy cảm, vi phạm pháp luật hoặc xâm phạm quyền hợp pháp của bên thứ ba trên <strong>${siteName}</strong>.</p></div>`,
      },
      {
        slug: 'gioi-thieu',
        titleVi: `Giới Thiệu Về ${siteName}`,
        titleEn: `About ${siteName}`,
        excerptVi: 'Nền tảng AI Studio tất cả trong một: tạo video, hình ảnh, motion control và giọng nói.',
        htmlVi: `<div class="space-y-4 leading-relaxed"><p><strong>${siteName}</strong> cung cấp hệ sinh thái công cụ AI thế hệ mới tạo video, hình ảnh và âm thanh chuyên nghiệp, trả phí linh hoạt theo lượt sử dụng.</p></div>`,
      },
      {
        slug: 'lien-he',
        titleVi: 'Liên Hệ & Hỗ Trợ',
        titleEn: 'Contact & Support',
        excerptVi: 'Tiếp nhận hỗ trợ trực tuyến nhanh chóng qua hệ thống Ticket gắn liền mã đơn hàng.',
        htmlVi: `<div class="space-y-4 leading-relaxed"><p>Khi cần hỗ trợ đơn hàng hoặc nạp ví trên <strong>${siteName}</strong>, bạn vui lòng gửi yêu cầu trực tiếp tại mục <a href="/support"><strong>Ticket hỗ trợ</strong></a> để được phản hồi nhanh nhất.</p></div>`,
      },
    ];
    const pubAt = new Date(Date.now() - 60_000);
    for (const d of defaults) {
      if (existing.has(d.slug)) continue;
      await this.prisma.page
        .create({
          data: {
            status: 'PUBLISHED',
            template: 'default',
            sortOrder: 10,
            publishedAt: pubAt,
            customFields: {},
            translations: {
              create: [
                {
                  locale: 'vi',
                  slug: d.slug,
                  title: d.titleVi,
                  excerpt: d.excerptVi,
                  seoTitle: d.titleVi,
                  seoDescription: d.excerptVi,
                  blocks: [{ id: `${d.slug}-vi`, type: 'rich-text', settings: {}, data: { html: d.htmlVi } }],
                },
                {
                  locale: 'en',
                  slug: d.slug,
                  title: d.titleEn,
                  excerpt: d.titleEn,
                  seoTitle: d.titleEn,
                  blocks: [{ id: `${d.slug}-en`, type: 'rich-text', settings: {}, data: { html: d.htmlVi } }],
                },
              ],
            },
          },
        })
        .catch(() => undefined);
    }
  }

  async list(q: PageQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.PageWhereInput = { deletedAt: q.trashed === '1' ? { not: null } : null };
    if (q.status) where.status = q.status as Prisma.PageWhereInput['status'];
    if (q.search) where.translations = { some: { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { slug: { contains: q.search, mode: 'insensitive' } }] } };
    const sortable = ['createdAt', 'updatedAt', 'publishedAt', 'sortOrder'];
    const orderBy = { [sortable.includes(q.sort ?? '') ? q.sort! : 'updatedAt']: q.order ?? 'desc' };
    const [rows, total, statusCounts] = await Promise.all([
      this.prisma.page.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          translations: { select: { locale: true, title: true, slug: true, seoTitle: true, seoDescription: true, noindex: true } },
          author: { select: { id: true, name: true } },
        },
      }),
      this.prisma.page.count({ where }),
      countByStatus(this.prisma, 'page'),
    ]);
    const general = await this.settings.get<{ homepageId?: string }>('general');
    const data = rows.map((r) => ({ ...r, isHomepage: r.id === general.homepageId }));
    return { ...paginate(await this.media.attach(data, ['featuredImageId']), total, page, limit), statusCounts };
  }

  async get(id: string) {
    const page = await this.prisma.page.findUnique({
      where: { id },
      include: { translations: true, author: { select: { id: true, name: true } }, parent: { include: { translations: { select: { locale: true, title: true } } } } },
    });
    if (!page) throw new NotFoundException('Không tìm thấy trang');
    const general = await this.settings.get<{ homepageId?: string }>('general');
    return { ...(await this.media.attachOne(page, ['featuredImageId'])), isHomepage: page.id === general.homepageId };
  }

  private checkPublish(user: AuthUser, status?: string) {
    // hẹn giờ cũng là xuất bản (tự hiển thị khi tới giờ) -> cần cùng quyền
    if ((status === 'PUBLISHED' || status === 'SCHEDULED') && !hasPermission(user.permissions, 'pages.publish')) {
      throw new ForbiddenException('Bạn không có quyền xuất bản trang');
    }
  }

  async create(dto: SavePageDto, user: AuthUser) {
    this.checkPublish(user, dto.status);
    const translations = (await prepareTranslations(this.prisma, 'pageTranslation', 'pageId', undefined, dto.translations, await this.languages.codes())).map((t) => this.cleanTranslation(t, user));
    const data = await this.hooks.applyFilters('page.beforeSave', { ...dto, translations }, { user });
    // trường tuỳ chỉnh: kiểm tra theo nhóm áp dụng cho bố cục (template) này
    const customFields = await this.customFields.sanitize('page', data.customFields, { template: data.template ?? 'default' }, null, { user });
    const page = await this.prisma.page.create({
      data: {
        status: data.status ?? 'DRAFT',
        template: data.template ?? 'default',
        customFields: (customFields ?? {}) as object,
        parentId: data.parentId ?? null,
        featuredImageId: data.featuredImageId ?? null,
        sortOrder: data.sortOrder ?? 0,
        publishedAt: resolvePublishedAt(data.publishedAt, data.status, null) ?? null,
        authorId: user.id,
        translations: { create: data.translations.map((t) => ({ ...t, blocks: (t.blocks ?? []) as object, schemaJson: (t.schemaJson ?? undefined) as object | undefined })) },
      },
    });
    this.afterChange(page.id, 'page.created', user);
    if (page.status === 'PUBLISHED') await this.firePublished(page.id);
    return this.get(page.id);
  }

  /**
   * Chống XSS lưu trữ: người không có quyền "content.unfiltered_html" -> lọc HTML trong block Page Builder
   * (richtext, block HTML tuỳ chỉnh, block lạ...) trước khi lưu. Có quyền / "*" -> giữ nguyên.
   */
  private cleanTranslation<T extends { blocks?: unknown }>(t: T, user: AuthUser): T {
    return t.blocks === undefined ? t : { ...t, blocks: cleanBlocksFor(user, t.blocks) };
  }

  private async firePublished(id: string) {
    this.events.emit('page.published', { id });
    await this.hooks.doAction('page.published', { id });
  }

  async update(id: string, dto: SavePageDto, user: AuthUser) {
    this.checkPublish(user, dto.status);
    const existing = await this.prisma.page.findUniqueOrThrow({ where: { id }, include: { translations: true } });
    if (existing.status === 'PUBLISHED' && !hasPermission(user.permissions, 'pages.publish')) throw new ForbiddenException('Trang đã xuất bản — cần quyền xuất bản để chỉnh sửa');
    const translations = (await prepareTranslations(this.prisma, 'pageTranslation', 'pageId', id, dto.translations, await this.languages.codes())).map((t) => this.cleanTranslation(t, user));
    const data = await this.hooks.applyFilters('page.beforeSave', { ...dto, translations }, { user, id });
    const customFields = await this.customFields.sanitize('page', data.customFields, { template: data.template ?? existing.template }, existing.customFields, { user, id });

    await this.prisma.$transaction(async (tx) => {
      await tx.page.update({
        where: { id },
        data: {
          status: data.status,
          template: data.template,
          customFields: customFields as object | undefined,
          parentId: data.parentId === id ? null : data.parentId,
          featuredImageId: data.featuredImageId,
          sortOrder: data.sortOrder,
          publishedAt: resolvePublishedAt(data.publishedAt, data.status ?? existing.status, existing.publishedAt),
        },
      });
      for (const t of data.translations) {
        const old = existing.translations.find((x) => x.locale === t.locale);
        const payload = { ...t, blocks: (t.blocks ?? old?.blocks ?? []) as object, schemaJson: (t.schemaJson ?? undefined) as object | undefined };
        await tx.pageTranslation.upsert({
          where: { pageId_locale: { pageId: id, locale: t.locale } },
          create: { ...payload, pageId: id },
          update: payload,
        });
        // Lưu revision khi nội dung block thay đổi
        if (old && t.blocks && JSON.stringify(old.blocks) !== JSON.stringify(t.blocks)) {
          await tx.pageRevision.create({ data: { pageId: id, locale: t.locale, title: old.title, blocks: old.blocks as object, authorId: user.id } });
        }
      }
    });
    await this.pruneRevisions(id);
    this.afterChange(id, 'page.updated', user);
    if (data.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') await this.firePublished(id);
    return this.get(id);
  }

  private async pruneRevisions(pageId: string) {
    const old = await this.prisma.pageRevision.findMany({ where: { pageId }, orderBy: { createdAt: 'desc' }, skip: MAX_REVISIONS, select: { id: true } });
    if (old.length) await this.prisma.pageRevision.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  private afterChange(id: string, action: string, user?: AuthUser) {
    this.events.emit(action, { id });
    this.events.emit('content.changed', { type: 'page', id, tags: ['pages', `page:${id}`, 'menus'] });
    if (user) this.events.emit('activity', { userId: user.id, action, entityType: 'page', entityId: id });
  }

  async removeTranslation(id: string, locale: string) {
    const count = await this.prisma.pageTranslation.count({ where: { pageId: id } });
    if (count <= 1) throw new ForbiddenException('Trang phải có ít nhất một bản dịch');
    await this.prisma.pageTranslation.delete({ where: { pageId_locale: { pageId: id, locale } } });
    this.afterChange(id, 'page.updated');
    return this.get(id);
  }

  async duplicate(id: string, user: AuthUser) {
    const src = await this.prisma.page.findUniqueOrThrow({ where: { id }, include: { translations: true } });
    const translations = await prepareTranslations(
      this.prisma,
      'pageTranslation',
      'pageId',
      undefined,
      // bản sao do người đang thao tác tạo -> lọc block theo quyền của họ
      src.translations.map(({ id: _id, pageId: _p, ...t }) => ({ ...t, blocks: cleanBlocksFor(user, t.blocks), title: `${t.title} (bản sao)`, slug: `${t.slug}-copy` })),
      await this.languages.codes(),
    );
    const page = await this.prisma.page.create({
      data: {
        status: 'DRAFT',
        template: src.template,
        parentId: src.parentId,
        featuredImageId: src.featuredImageId,
        customFields: (src.customFields ?? {}) as object,
        authorId: user.id,
        translations: { create: translations.map((t) => ({ ...t, blocks: t.blocks as object, schemaJson: (t.schemaJson ?? undefined) as object | undefined })) },
      },
    });
    this.afterChange(page.id, 'page.created', user);
    return this.get(page.id);
  }

  async trash(id: string, user: AuthUser) {
    await this.prisma.page.update({ where: { id }, data: { deletedAt: new Date() } });
    this.afterChange(id, 'page.trashed', user);
    return { success: true };
  }

  async restore(id: string, user: AuthUser) {
    await this.prisma.page.update({ where: { id }, data: { deletedAt: null } });
    this.afterChange(id, 'page.restored', user);
    return { success: true };
  }

  /** Xoá vĩnh viễn - chỉ áp dụng cho trang đã ở trong thùng rác */
  async destroy(id: string, user: AuthUser) {
    const page = await this.prisma.page.findUniqueOrThrow({ where: { id } });
    if (!page.deletedAt) throw new ForbiddenException('Hãy chuyển trang vào thùng rác trước khi xoá vĩnh viễn');
    await this.prisma.page.delete({ where: { id } });
    this.afterChange(id, 'page.deleted', user);
    return { success: true };
  }

  async revisions(id: string, locale?: string) {
    const rows = await this.prisma.pageRevision.findMany({
      where: { pageId: id, ...(locale ? { locale } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, locale: true, title: true, createdAt: true, authorId: true, blocks: true },
    });
    return attachRevisionAuthors(
      this.prisma,
      rows.map(({ blocks, ...r }) => ({ ...r, blockCount: Array.isArray(blocks) ? blocks.length : 0 })),
    );
  }

  async revision(revisionId: string) {
    const rev = await this.prisma.pageRevision.findUnique({ where: { id: revisionId } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const [withAuthor] = await attachRevisionAuthors(this.prisma, [rev]);
    return withAuthor;
  }

  /** Khôi phục block của bản dịch về phiên bản cũ; bản hiện tại được lưu thành phiên bản mới trước khi ghi đè. */
  async restoreRevision(id: string, revisionId: string, user: AuthUser) {
    const rev = await this.prisma.pageRevision.findFirst({ where: { id: revisionId, pageId: id } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const page = await this.prisma.page.findUniqueOrThrow({ where: { id } });
    if (page.status === 'PUBLISHED' && !hasPermission(user.permissions, 'pages.publish')) throw new ForbiddenException('Trang đã xuất bản — cần quyền xuất bản để chỉnh sửa');
    const current = await this.prisma.pageTranslation.findUnique({ where: { pageId_locale: { pageId: id, locale: rev.locale } } });
    if (!current) throw new NotFoundException(`Bản dịch "${rev.locale}" của trang không còn tồn tại`);
    await this.prisma.$transaction(async (tx) => {
      await tx.pageRevision.create({ data: { pageId: id, locale: current.locale, title: current.title, blocks: current.blocks as object, authorId: user.id } });
      // phiên bản cũ có thể chứa HTML chưa lọc -> lọc theo quyền người khôi phục
      await tx.pageTranslation.update({ where: { id: current.id }, data: { blocks: cleanBlocksFor(user, rev.blocks) as object } });
    });
    await this.pruneRevisions(id);
    this.afterChange(id, 'page.restored_revision', user);
    return this.get(id);
  }

  /** Thao tác hàng loạt (giống bài viết) */
  async bulk(ids: string[], action: 'trash' | 'restore' | 'publish' | 'draft' | 'destroy', user: AuthUser) {
    if ((action === 'publish' || action === 'draft') && !hasPermission(user.permissions, 'pages.publish')) throw new ForbiddenException('Bạn không có quyền xuất bản / gỡ trang');
    if (['trash', 'restore', 'destroy'].includes(action) && !hasPermission(user.permissions, 'pages.delete')) throw new ForbiddenException('Bạn không có quyền xoá trang');
    const where = { id: { in: ids } };
    switch (action) {
      case 'trash': {
        // không cho đưa trang chủ vào thùng rác
        const { homepageId } = await this.settings.get<{ homepageId?: string }>('general');
        await this.prisma.page.updateMany({ where: { ...where, ...(homepageId ? { id: { in: ids, not: homepageId } } : {}) }, data: { deletedAt: new Date() } });
        break;
      }
      case 'restore':
        await this.prisma.page.updateMany({ where, data: { deletedAt: null } });
        break;
      case 'publish': {
        const newly = await this.prisma.page.findMany({ where: { ...where, status: { not: 'PUBLISHED' } }, select: { id: true } });
        await this.prisma.page.updateMany({ where: { ...where, publishedAt: null }, data: { publishedAt: new Date() } });
        await this.prisma.page.updateMany({ where, data: { status: 'PUBLISHED' } });
        for (const { id } of newly) await this.firePublished(id);
        break;
      }
      case 'draft':
        await this.prisma.page.updateMany({ where, data: { status: 'DRAFT' } });
        break;
      case 'destroy':
        // chỉ xoá vĩnh viễn trang đã nằm trong thùng rác
        await this.prisma.page.deleteMany({ where: { ...where, deletedAt: { not: null } } });
        break;
    }
    for (const id of ids) this.afterChange(id, `page.${action}`, user);
    return { success: true };
  }

  async setHomepage(id: string) {
    await this.settings.update('general', { homepageId: id });
    this.afterChange(id, 'page.updated');
    return { success: true };
  }

  // ---------------- public ----------------

  private publishedWhere(): Prisma.PageWhereInput {
    return { deletedAt: null, ...publishedCondition() };
  }

  async publicBySlug(slug: string, localeInput?: string, preview = false) {
    const locale = await this.languages.resolve(localeInput);
    let where: Prisma.PageWhereInput;
    if (slug === '__home__') {
      const { homepageId } = await this.settings.get<{ homepageId?: string }>('general');
      if (!homepageId) throw new NotFoundException('Chưa thiết lập trang chủ');
      where = { id: homepageId };
    } else {
      where = { translations: { some: { slug, locale } } };
    }
    return this.presentPublic(where, locale, preview, slug === '__home__');
  }

  /** Xem trước theo id (kể cả bản nháp / hẹn giờ): dùng cho trang xem trước của storefront */
  async publicById(id: string, localeInput?: string, preview = false) {
    const locale = await this.languages.resolve(localeInput);
    const { homepageId } = await this.settings.get<{ homepageId?: string }>('general');
    return this.presentPublic({ id }, locale, preview, id === homepageId);
  }

  private async presentPublic(where: Prisma.PageWhereInput, locale: string, preview: boolean, isHomepage: boolean) {
    const fallback = await this.languages.defaultLocale();
    const page = await this.prisma.page.findFirst({
      where: { ...where, ...(preview ? { deletedAt: null } : this.publishedWhere()) },
      include: { translations: true, author: { select: { id: true, name: true } } },
    });
    if (!page) throw new NotFoundException('Không tìm thấy trang');
    const flat = flatten(page, locale, fallback);
    // trường tuỳ chỉnh của trang: trả kèm và đưa vào ngữ cảnh để block "Trường tuỳ chỉnh" lấy được
    const cf = await this.customFields.present('page', page.customFields, locale, fallback, { template: page.template });
    const blocks = await this.resolver.resolve((flat as { blocks?: unknown }).blocks, locale, 0, 'view', { entity: 'page', customFields: cf.customFields, customFieldGroups: cf.customFieldGroups });
    const withMedia = await this.media.attachOne(flat as Record<string, unknown>, ['featuredImageId', 'ogImageId']);
    return this.hooks.applyFilters('page.public', { ...withMedia, ...cf, blocks, isHomepage }, { locale });
  }

  /** Dữ liệu cho sitemap */
  async sitemapEntries() {
    const rows = await this.prisma.page.findMany({
      where: this.publishedWhere(),
      select: { id: true, updatedAt: true, translations: { select: { locale: true, slug: true, noindex: true } } },
    });
    const { homepageId } = await this.settings.get<{ homepageId?: string }>('general');
    return rows.map((r) => ({ ...r, isHomepage: r.id === homepageId }));
  }
}
