import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hasPermission } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { resolvePublishedAt } from '../../common/utils/publish.util.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { uniqueSlug } from '../../common/utils/slug.util.js';
import { assertNoCycle } from '../../common/utils/tree.util.js';
import { cleanBlocksFor, cleanHtmlFor } from '../../common/utils/sanitize-html.js';
import { attachRevisionAuthors, CONTENT_STATUS_KEYS, type StatusCounts } from '../../common/utils/status-counts.util.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ContentMetaService, type TypeMeta } from './content-meta.service.js';
import type { EntryBulkAction, EntryLookupDto, EntryQueryDto, SaveEntryDto } from './content.dto.js';

/** Số phiên bản cũ giữ lại cho mỗi bài */
const MAX_REVISIONS = 30;

type TranslationInput = SaveEntryDto['translations'][number];

/** Bài của loại nội dung tuỳ biến (admin): danh sách, soạn thảo đa ngôn ngữ, phiên bản, thùng rác, thao tác hàng loạt */
@Injectable()
export class EntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
    private readonly customFields: CustomFieldsService,
    private readonly meta: ContentMetaService,
  ) {}

  private async typeOrThrow(key: string | undefined): Promise<TypeMeta> {
    if (!key) throw new BadRequestException('Thiếu loại nội dung (type)');
    const t = await this.meta.type(key);
    if (!t) throw new NotFoundException(`Không tìm thấy loại nội dung "${key}"`);
    return t;
  }

  /** Đếm theo trạng thái (tab danh sách) trong phạm vi một loại */
  private async counts(typeId?: string): Promise<StatusCounts> {
    const scope = typeId ? { typeId } : {};
    const [groups, trash] = await Promise.all([
      this.prisma.entry.groupBy({ by: ['status'], where: { ...scope, deletedAt: null }, _count: { _all: true } }),
      this.prisma.entry.count({ where: { ...scope, deletedAt: { not: null } } }),
    ]);
    const counts: StatusCounts = { ALL: 0, DRAFT: 0, PUBLISHED: 0, SCHEDULED: 0, ARCHIVED: 0, TRASH: trash };
    for (const g of groups) {
      if ((CONTENT_STATUS_KEYS as readonly string[]).includes(g.status)) counts[g.status as keyof StatusCounts] = g._count._all;
      counts.ALL += g._count._all;
    }
    return counts;
  }

  // ======================= Danh sách =======================

  async list(q: EntryQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const type = q.type ? await this.typeOrThrow(q.type) : undefined;
    const where: Prisma.EntryWhereInput = { deletedAt: q.trashed === '1' ? { not: null } : null };
    if (type) where.typeId = type.id;
    if (q.status && q.trashed !== '1') where.status = q.status as Prisma.EntryWhereInput['status'];
    if (q.termId) where.terms = { some: { termId: q.termId } };
    if (q.authorId) where.authorId = q.authorId;
    if (q.featured === '1') where.isFeatured = true;
    if (q.search) where.translations = { some: { title: { contains: q.search, mode: 'insensitive' } } };
    const sortable = ['createdAt', 'updatedAt', 'publishedAt', 'sortOrder'];
    const defaultSort = type?.orderBy === 'sortOrder_asc' ? 'sortOrder' : 'createdAt';
    const sortKey = sortable.includes(q.sort ?? '') ? q.sort! : defaultSort;
    const orderBy: Prisma.EntryOrderByWithRelationInput[] = [{ [sortKey]: q.sort ? (q.order ?? 'desc') : sortKey === 'sortOrder' ? 'asc' : 'desc' }, { createdAt: 'desc' }];
    const locale = await this.languages.resolve(q.locale);
    const fallback = await this.languages.defaultLocale();
    const [rows, total, counts] = await Promise.all([
      this.prisma.entry.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          type: { select: { key: true } },
          translations: { select: { locale: true, title: true, slug: true, seoTitle: true, seoDescription: true } },
          author: { select: { id: true, name: true } },
          terms: { include: { term: { select: { id: true, taxonomy: { select: { key: true } }, translations: { select: { locale: true, name: true } } } } } },
          _count: { select: { children: true } },
        },
      }),
      this.prisma.entry.count({ where }),
      this.counts(type?.id),
    ]);
    const pickName = (list: { locale: string; name: string }[]) => (list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0])?.name ?? '';
    const data = await this.media.attach(
      rows.map(({ type: ty, terms, translations, ...r }) => {
        const tr = translations.find((t) => t.locale === locale) ?? translations.find((t) => t.locale === fallback) ?? translations[0];
        return {
          ...r,
          type: ty.key,
          title: tr?.title ?? '',
          slug: tr?.slug ?? '',
          translations,
          terms: terms.map((x) => ({ id: x.term.id, taxonomy: x.term.taxonomy.key, name: pickName(x.term.translations) })),
        };
      }),
      ['featuredImageId'],
    );
    const res = paginate(data, total, page, limit);
    return { ...res, meta: { ...res.meta, counts }, statusCounts: counts };
  }

  /** Cho picker (trường "entries", menu, block chọn tay) */
  async lookup(q: EntryLookupDto) {
    const locale = await this.languages.resolve(q.locale);
    const fallback = await this.languages.defaultLocale();
    const ids = q.ids?.split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)) ?? [];
    const where: Prisma.EntryWhereInput = { deletedAt: null };
    if (q.type) where.type = { key: q.type };
    if (ids.length) where.id = { in: ids };
    if (q.search) where.translations = { some: { title: { contains: q.search, mode: 'insensitive' } } };
    const rows = await this.prisma.entry.findMany({
      where,
      take: ids.length ? ids.length : (q.limit ?? 20),
      orderBy: { updatedAt: 'desc' },
      select: { id: true, status: true, type: { select: { key: true } }, translations: { select: { locale: true, title: true, slug: true } } },
    });
    return rows.map((r) => {
      const tr = r.translations.find((t) => t.locale === locale) ?? r.translations.find((t) => t.locale === fallback) ?? r.translations[0];
      return { id: r.id, title: tr?.title ?? '', slug: tr?.slug ?? '', type: r.type.key, status: r.status };
    });
  }

  async get(id: string) {
    const entry = await this.prisma.entry.findUnique({
      where: { id },
      include: {
        type: { select: { key: true } },
        translations: { orderBy: { locale: 'asc' } },
        author: { select: { id: true, name: true } },
        terms: { select: { termId: true } },
      },
    });
    if (!entry) throw new NotFoundException('Không tìm thấy bài');
    const { terms, type, ...rest } = entry;
    return this.media.attachOne({ ...rest, type: type.key, termIds: terms.map((t) => t.termId) } as Record<string, unknown>, ['featuredImageId']);
  }

  // ======================= Lưu =======================

  private assertCanPublish(user: AuthUser, status?: string) {
    // hẹn giờ cũng là xuất bản (tự hiển thị khi tới giờ) -> cần cùng quyền
    if ((status === 'PUBLISHED' || status === 'SCHEDULED') && !hasPermission(user.permissions, 'entries.publish')) throw new ForbiddenException('Bạn không có quyền xuất bản nội dung');
  }

  /** Chuẩn hoá bản dịch: locale hợp lệ, không trùng, slug duy nhất trong (loại, locale) */
  private async prepareTranslations(typeId: string, entryId: string | undefined, items: TranslationInput[]) {
    const locales = await this.languages.codes();
    const seen = new Set<string>();
    const out: (TranslationInput & { slug: string })[] = [];
    for (const t of items) {
      if (!locales.includes(t.locale)) throw new BadRequestException(`Ngôn ngữ "${t.locale}" chưa được bật`);
      if (seen.has(t.locale)) throw new BadRequestException(`Trùng bản dịch ngôn ngữ "${t.locale}"`);
      seen.add(t.locale);
      // không gửi slug khi sửa -> giữ slug cũ (tránh đổi URL khi chỉ sửa tiêu đề)
      const old = entryId && !t.slug?.trim() ? await this.prisma.entryTranslation.findUnique({ where: { entryId_locale: { entryId, locale: t.locale } }, select: { slug: true } }) : null;
      const slug = await uniqueSlug(t.slug?.trim() || old?.slug || t.title, async (s) => !!(await this.prisma.entryTranslation.findFirst({ where: { typeId, locale: t.locale, slug: s, ...(entryId ? { NOT: { entryId } } : {}) }, select: { id: true } })));
      out.push({ ...t, title: t.title.trim(), slug });
    }
    return out;
  }

  /** term phải thuộc taxonomy có gắn loại nội dung này */
  private async assertTerms(type: TypeMeta, termIds: string[]) {
    if (!termIds.length) return;
    const allowed = (await this.meta.taxonomiesOf(type.key)).map((t) => t.id);
    const rows = await this.prisma.term.findMany({ where: { id: { in: termIds } }, select: { id: true, taxonomyId: true } });
    if (rows.length !== new Set(termIds).size) throw new BadRequestException('Có phân loại không tồn tại');
    if (rows.some((r) => !allowed.includes(r.taxonomyId))) throw new BadRequestException('Có phân loại không áp dụng cho loại nội dung này');
  }

  private async assertParent(type: TypeMeta, id: string | undefined, parentId: string | null | undefined) {
    if (!parentId) return;
    if (!type.supports.includes('hierarchical')) throw new BadRequestException('Loại nội dung này không hỗ trợ bài cha / con');
    if (parentId === id) throw new BadRequestException('Bài cha không hợp lệ');
    const parent = await this.prisma.entry.findUnique({ where: { id: parentId }, select: { typeId: true } });
    if (!parent || parent.typeId !== type.id) throw new BadRequestException('Bài cha phải cùng loại nội dung');
    if (id) assertNoCycle(await this.prisma.entry.findMany({ where: { typeId: type.id }, select: { id: true, parentId: true } }), [{ id, parentId }]);
  }

  async save(id: string | undefined, dto: SaveEntryDto, user: AuthUser) {
    this.assertCanPublish(user, dto.status);
    const existing = id
      ? await this.prisma.entry.findUnique({ where: { id }, include: { translations: true, type: { select: { key: true } } } })
      : null;
    if (id && !existing) throw new NotFoundException('Không tìm thấy bài');
    const type = await this.typeOrThrow(existing?.type.key ?? dto.type);
    const canPublish = hasPermission(user.permissions, 'entries.publish');
    // không có quyền xuất bản thì không được sửa bài đang hiển thị trên site
    if (existing?.status === 'PUBLISHED' && !canPublish) throw new ForbiddenException('Bài đã xuất bản — cần quyền xuất bản để chỉnh sửa');
    if (!canPublish) dto.authorId = undefined;

    // chống XSS lưu trữ: không có quyền "content.unfiltered_html" -> lọc HTML nội dung + block Page Builder trước khi lưu
    // (áp cho tạo / sửa / nhân bản vì duplicate() cũng đi qua save())
    const prepared = (await this.prepareTranslations(type.id, id, dto.translations)).map((t) => ({ ...t, content: cleanHtmlFor(user, t.content), blocks: cleanBlocksFor(user, t.blocks) }));
    const data = await this.hooks.applyFilters('entry.beforeSave', { ...dto, translations: prepared }, { user, id, type: type.key });
    await this.assertParent(type, id, data.parentId);
    if (data.termIds) await this.assertTerms(type, data.termIds);
    const publishedAt = resolvePublishedAt(data.publishedAt, data.status ?? existing?.status, existing?.publishedAt);
    const customFields = await this.customFields.sanitize('entry', data.customFields, { contentType: type.key }, existing?.customFields, { user, id });

    const base = {
      status: data.status,
      parentId: data.parentId,
      featuredImageId: data.featuredImageId,
      isFeatured: data.isFeatured,
      sortOrder: data.sortOrder,
      publishedAt,
      authorId: data.authorId,
      customFields: customFields as Prisma.InputJsonValue | undefined,
    };
    const keepRevisions = type.supports.includes('revisions');

    const entryId = await this.prisma.$transaction(async (tx) => {
      const entry = existing
        ? await tx.entry.update({ where: { id: existing.id }, data: base })
        : await tx.entry.create({ data: { ...base, typeId: type.id, status: base.status ?? 'DRAFT', authorId: base.authorId ?? user.id, sortOrder: base.sortOrder ?? 0 } });
      for (const t of data.translations) {
        const row = {
          title: t.title,
          slug: t.slug,
          excerpt: t.excerpt,
          content: t.content,
          blocks: t.blocks as Prisma.InputJsonValue | undefined,
          seoTitle: t.seoTitle,
          seoDescription: t.seoDescription,
          seoKeywords: t.seoKeywords,
          canonicalUrl: t.canonicalUrl,
          ogImageId: t.ogImageId,
          noindex: t.noindex,
          nofollow: t.nofollow,
          schemaJson: t.schemaJson === null ? undefined : (t.schemaJson as Prisma.InputJsonValue | undefined),
        };
        const old = existing?.translations.find((x) => x.locale === t.locale);
        // Lưu phiên bản cũ khi tiêu đề / tóm tắt / nội dung / blocks thay đổi
        if (old && keepRevisions && this.translationChanged(old, t)) {
          await tx.entryRevision.create({ data: { entryId: entry.id, locale: old.locale, title: old.title, excerpt: old.excerpt, content: old.content, blocks: old.blocks as Prisma.InputJsonValue, authorId: user.id } });
        }
        await tx.entryTranslation.upsert({ where: { entryId_locale: { entryId: entry.id, locale: t.locale } }, create: { ...row, entryId: entry.id, typeId: type.id, locale: t.locale }, update: row });
      }
      if (data.termIds) {
        await tx.entryTerm.deleteMany({ where: { entryId: entry.id } });
        if (data.termIds.length) await tx.entryTerm.createMany({ data: [...new Set(data.termIds)].map((termId) => ({ entryId: entry.id, termId })) });
      }
      return entry.id;
    });
    if (id) await this.pruneRevisions(id);
    this.afterChange(entryId, type.key, id ? 'entry.updated' : 'entry.created', user);
    if (data.status === 'PUBLISHED' && existing?.status !== 'PUBLISHED') await this.published(entryId, type.key);
    return this.get(entryId);
  }

  private translationChanged(old: { title: string; excerpt: string | null; content: string; blocks: unknown }, t: TranslationInput) {
    if (old.title !== t.title) return true;
    if (t.excerpt !== undefined && (t.excerpt ?? null) !== (old.excerpt ?? null)) return true;
    if (t.content !== undefined && t.content !== old.content) return true;
    if (t.blocks !== undefined && JSON.stringify(t.blocks) !== JSON.stringify(old.blocks ?? [])) return true;
    return false;
  }

  private async pruneRevisions(entryId: string) {
    const old = await this.prisma.entryRevision.findMany({ where: { entryId }, orderBy: { createdAt: 'desc' }, skip: MAX_REVISIONS, select: { id: true } });
    if (old.length) await this.prisma.entryRevision.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  /** Báo bài vừa xuất bản: event nội bộ + hook `entry.published` */
  async published(id: string, typeKey: string, scheduled = false) {
    this.events.emit('entry.published', { id, type: typeKey });
    await this.hooks.doAction('entry.published', { id, type: typeKey, ...(scheduled ? { scheduled: true } : {}) });
  }

  /** Event thay đổi: revalidate storefront + nhật ký hoạt động */
  afterChange(id: string, typeKey: string, action: string, user?: AuthUser) {
    this.events.emit(action, { id, type: typeKey });
    this.events.emit('content.changed', { type: 'entry', id, tags: ['entries', `entries:${typeKey}`, `entry:${id}`, 'sitemap'] });
    if (user) this.events.emit('activity', { userId: user.id, action, entityType: 'entry', entityId: id, meta: { type: typeKey } });
  }

  // ======================= Phiên bản =======================

  async revisions(id: string, locale?: string) {
    const rows = await this.prisma.entryRevision.findMany({
      where: { entryId: id, ...(locale ? { locale } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, locale: true, title: true, authorId: true, createdAt: true, content: true },
    });
    return attachRevisionAuthors(
      this.prisma,
      rows.map(({ content, ...r }) => ({ ...r, contentLength: content.length })),
    );
  }

  async revision(revisionId: string) {
    const rev = await this.prisma.entryRevision.findUnique({ where: { id: revisionId } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const [withAuthor] = await attachRevisionAuthors(this.prisma, [rev]);
    return withAuthor;
  }

  /** Khôi phục bản dịch về một phiên bản cũ; bản hiện tại được lưu thành phiên bản mới trước khi ghi đè */
  async restoreRevision(id: string, revisionId: string, user: AuthUser) {
    const rev = await this.prisma.entryRevision.findFirst({ where: { id: revisionId, entryId: id } });
    if (!rev) throw new NotFoundException('Không tìm thấy phiên bản');
    const entry = await this.prisma.entry.findUniqueOrThrow({ where: { id }, include: { type: { select: { key: true } } } });
    if (entry.status === 'PUBLISHED' && !hasPermission(user.permissions, 'entries.publish')) throw new ForbiddenException('Bài đã xuất bản — cần quyền xuất bản để chỉnh sửa');
    const current = await this.prisma.entryTranslation.findUnique({ where: { entryId_locale: { entryId: id, locale: rev.locale } } });
    await this.prisma.$transaction(async (tx) => {
      // phiên bản cũ có thể chứa HTML chưa lọc -> lọc theo quyền người khôi phục
      const payload = { title: rev.title, excerpt: rev.excerpt, content: cleanHtmlFor(user, rev.content), blocks: cleanBlocksFor(user, rev.blocks) as Prisma.InputJsonValue };
      if (current) {
        await tx.entryRevision.create({ data: { entryId: id, locale: current.locale, title: current.title, excerpt: current.excerpt, content: current.content, blocks: current.blocks as Prisma.InputJsonValue, authorId: user.id } });
        await tx.entryTranslation.update({ where: { id: current.id }, data: payload });
      } else {
        // bản dịch đã bị xoá sau khi tạo revision -> tạo lại với slug duy nhất
        const [t] = await this.prepareTranslations(entry.typeId, id, [{ locale: rev.locale, title: rev.title }]);
        await tx.entryTranslation.create({ data: { ...payload, entryId: id, typeId: entry.typeId, locale: rev.locale, slug: t.slug } });
      }
    });
    await this.pruneRevisions(id);
    this.afterChange(id, entry.type.key, 'entry.restored_revision', user);
    return this.get(id);
  }

  // ======================= Thùng rác / nhân bản =======================

  private async typeKeyOf(id: string) {
    const e = await this.prisma.entry.findUnique({ where: { id }, select: { deletedAt: true, type: { select: { key: true } } } });
    if (!e) throw new NotFoundException('Không tìm thấy bài');
    return e;
  }

  async trash(id: string, user: AuthUser) {
    const e = await this.typeKeyOf(id);
    await this.prisma.entry.update({ where: { id }, data: { deletedAt: new Date() } });
    this.afterChange(id, e.type.key, 'entry.trash', user);
    return { success: true };
  }

  async restore(id: string, user: AuthUser) {
    const e = await this.typeKeyOf(id);
    await this.prisma.entry.update({ where: { id }, data: { deletedAt: null } });
    this.afterChange(id, e.type.key, 'entry.restore', user);
    return { success: true };
  }

  /** Xoá vĩnh viễn — chỉ áp dụng cho bài đã ở trong thùng rác */
  async destroy(id: string, user: AuthUser) {
    const e = await this.typeKeyOf(id);
    if (!e.deletedAt) throw new ForbiddenException('Hãy chuyển bài vào thùng rác trước khi xoá vĩnh viễn');
    await this.prisma.entry.delete({ where: { id } });
    this.afterChange(id, e.type.key, 'entry.destroy', user);
    return { success: true };
  }

  async removeTranslation(id: string, locale: string, user: AuthUser) {
    const e = await this.typeKeyOf(id);
    if ((await this.prisma.entryTranslation.count({ where: { entryId: id } })) <= 1) throw new ForbiddenException('Bài phải có ít nhất một bản dịch');
    await this.prisma.entryTranslation.delete({ where: { entryId_locale: { entryId: id, locale } } });
    this.afterChange(id, e.type.key, 'entry.updated', user);
    return this.get(id);
  }

  async duplicate(id: string, user: AuthUser) {
    const src = await this.prisma.entry.findUniqueOrThrow({ where: { id }, include: { translations: true, terms: true, type: { select: { key: true } } } });
    return this.save(
      undefined,
      {
        type: src.type.key,
        status: 'DRAFT',
        parentId: src.parentId,
        featuredImageId: src.featuredImageId,
        isFeatured: src.isFeatured,
        sortOrder: src.sortOrder,
        customFields: (src.customFields ?? {}) as Record<string, unknown>,
        termIds: src.terms.map((t) => t.termId),
        translations: src.translations.map((t) => ({
          locale: t.locale,
          title: `${t.title} (bản sao)`,
          slug: `${t.slug}-copy`,
          excerpt: t.excerpt,
          content: t.content,
          blocks: (t.blocks ?? []) as unknown[],
          seoTitle: t.seoTitle,
          seoDescription: t.seoDescription,
          seoKeywords: t.seoKeywords,
          canonicalUrl: t.canonicalUrl,
          ogImageId: t.ogImageId,
          noindex: t.noindex,
          nofollow: t.nofollow,
          schemaJson: (t.schemaJson as Record<string, unknown>) ?? undefined,
        })),
      },
      user,
    );
  }

  async bulk(ids: string[], action: EntryBulkAction, user: AuthUser) {
    if ((action === 'publish' || action === 'draft') && !hasPermission(user.permissions, 'entries.publish')) throw new ForbiddenException('Bạn không có quyền xuất bản / gỡ nội dung');
    if (['trash', 'restore', 'delete'].includes(action) && !hasPermission(user.permissions, 'entries.delete')) throw new ForbiddenException('Bạn không có quyền xoá nội dung');
    const rows = await this.prisma.entry.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, deletedAt: true, type: { select: { key: true } } } });
    const found = rows.map((r) => r.id);
    let affected = rows;
    switch (action) {
      case 'trash':
        await this.prisma.entry.updateMany({ where: { id: { in: found } }, data: { deletedAt: new Date() } });
        break;
      case 'restore':
        await this.prisma.entry.updateMany({ where: { id: { in: found } }, data: { deletedAt: null } });
        break;
      case 'publish': {
        await this.prisma.entry.updateMany({ where: { id: { in: found }, publishedAt: null }, data: { publishedAt: new Date() } });
        await this.prisma.entry.updateMany({ where: { id: { in: found } }, data: { status: 'PUBLISHED' } });
        for (const r of rows.filter((x) => x.status !== 'PUBLISHED')) await this.published(r.id, r.type.key);
        break;
      }
      case 'draft':
        await this.prisma.entry.updateMany({ where: { id: { in: found } }, data: { status: 'DRAFT' } });
        break;
      case 'delete':
        // chỉ xoá vĩnh viễn bài đã nằm trong thùng rác
        affected = rows.filter((r) => r.deletedAt);
        await this.prisma.entry.deleteMany({ where: { id: { in: affected.map((r) => r.id) } } });
        break;
    }
    for (const r of affected) this.afterChange(r.id, r.type.key, `entry.${action}`, user);
    return { success: true, count: affected.length };
  }
}
