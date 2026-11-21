import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { prepareTranslations } from '../../common/utils/translation.util.js';
import { assertNoCycle } from '../../common/utils/tree.util.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { SaveTermDto } from './posts.dto.js';

/** Chuyên mục & thẻ bài viết */
@Injectable()
export class PostTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly events: EventEmitter2,
    private readonly customFields: CustomFieldsService,
  ) {}

  private changed() {
    this.events.emit('content.changed', { type: 'post_category', tags: ['posts', 'post-categories', 'menus'] });
  }

  // ---- categories ----
  async categories() {
    const rows = await this.prisma.postCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { translations: true, _count: { select: { posts: true } } },
    });
    return this.media.attach(rows, ['imageId']);
  }

  async category(id: string) {
    const row = await this.prisma.postCategory.findUnique({ where: { id }, include: { translations: true } });
    if (!row) throw new NotFoundException('Không tìm thấy chuyên mục');
    return this.media.attachOne(row, ['imageId']);
  }

  /** `user`: người lưu — dùng để xét quyền lọc HTML trường tuỳ chỉnh richtext (không truyền -> luôn lọc) */
  async saveCategory(id: string | undefined, dto: SaveTermDto, user?: AuthUser) {
    if (id && dto.parentId === id) throw new BadRequestException('Chuyên mục cha không hợp lệ');
    if (id && dto.parentId !== undefined) assertNoCycle(await this.prisma.postCategory.findMany({ select: { id: true, parentId: true } }), [{ id, parentId: dto.parentId ?? null }]);
    const translations = await prepareTranslations(this.prisma, 'postCategoryTranslation', 'categoryId', id, dto.translations, await this.languages.codes());
    const existing = id ? await this.prisma.postCategory.findUnique({ where: { id }, select: { customFields: true } }) : null;
    const customFields = await this.customFields.sanitize('post_category', dto.customFields, null, existing?.customFields, { user, id });
    const base = { parentId: dto.parentId, imageId: dto.imageId, sortOrder: dto.sortOrder, customFields: customFields as object | undefined };
    const catId = await this.prisma.$transaction(async (tx) => {
      const cat = id ? await tx.postCategory.update({ where: { id }, data: base }) : await tx.postCategory.create({ data: base });
      for (const t of translations) {
        await tx.postCategoryTranslation.upsert({ where: { categoryId_locale: { categoryId: cat.id, locale: t.locale } }, create: { ...t, categoryId: cat.id }, update: t });
      }
      return cat.id;
    });
    this.changed();
    return this.category(catId);
  }

  async removeCategory(id: string) {
    await this.prisma.postCategory.delete({ where: { id } });
    this.changed();
    return { success: true };
  }

  async reorderCategories(items: { id: string; parentId: string | null; sortOrder: number }[]) {
    assertNoCycle(await this.prisma.postCategory.findMany({ select: { id: true, parentId: true } }), items.map((i) => ({ id: i.id, parentId: i.parentId ?? null })));
    await this.prisma.$transaction(items.map((i) => this.prisma.postCategory.update({ where: { id: i.id }, data: { parentId: i.parentId, sortOrder: i.sortOrder } })));
    this.changed();
    return { success: true };
  }

  // ---- tags ----
  async tags(q: { page?: number; limit?: number; search?: string }) {
    const { skip, take, page, limit } = pageArgs({ ...q, limit: q.limit ?? 50 });
    const where = q.search ? { translations: { some: { name: { contains: q.search, mode: 'insensitive' as const } } } } : {};
    const [data, total] = await Promise.all([
      this.prisma.postTag.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: { translations: true, _count: { select: { posts: true } } } }),
      this.prisma.postTag.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  async saveTag(id: string | undefined, dto: SaveTermDto) {
    const translations = await prepareTranslations(this.prisma, 'postTagTranslation', 'tagId', id, dto.translations, await this.languages.codes());
    const tagId = await this.prisma.$transaction(async (tx) => {
      const tag = id ? await tx.postTag.findUniqueOrThrow({ where: { id } }) : await tx.postTag.create({ data: {} });
      for (const t of translations) {
        const row = { locale: t.locale, name: t.name, slug: t.slug };
        await tx.postTagTranslation.upsert({ where: { tagId_locale: { tagId: tag.id, locale: t.locale } }, create: { ...row, tagId: tag.id }, update: row });
      }
      return tag.id;
    });
    this.changed();
    return this.prisma.postTag.findUniqueOrThrow({ where: { id: tagId }, include: { translations: true } });
  }

  async removeTag(id: string) {
    await this.prisma.postTag.delete({ where: { id } });
    this.changed();
    return { success: true };
  }

  // ---- public ----
  async publicCategories(localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    const fallback = await this.languages.defaultLocale();
    const rows = await this.categories();
    return rows.map((r) => {
      const tr = r.translations.find((t) => t.locale === locale) ?? r.translations.find((t) => t.locale === fallback);
      return { id: r.id, parentId: r.parentId, name: tr?.name ?? '', slug: tr?.slug ?? '', description: tr?.description, image: (r as Record<string, unknown>).image ?? null, postCount: r._count.posts };
    });
  }

  async publicCategory(slug: string, localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    const row = await this.prisma.postCategory.findFirst({ where: { translations: { some: { slug, locale } } }, include: { translations: true } });
    if (!row) throw new NotFoundException('Không tìm thấy chuyên mục');
    const tr = row.translations.find((t) => t.locale === locale)!;
    return {
      ...(await this.media.attachOne({ id: row.id, parentId: row.parentId, imageId: row.imageId }, ['imageId'])),
      ...tr,
      ...(await this.customFields.present('post_category', row.customFields, locale, await this.languages.defaultLocale())),
      id: row.id,
      alternates: Object.fromEntries(row.translations.map((t) => [t.locale, t.slug])),
    };
  }

  async publicTag(slug: string, localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    const row = await this.prisma.postTag.findFirst({ where: { translations: { some: { slug, locale } } }, include: { translations: true } });
    if (!row) throw new NotFoundException('Không tìm thấy thẻ');
    const tr = row.translations.find((t) => t.locale === locale)!;
    return { ...tr, id: row.id, alternates: Object.fromEntries(row.translations.map((t) => [t.locale, t.slug])) };
  }

  sitemapCategories() {
    return this.prisma.postCategory.findMany({ select: { id: true, updatedAt: true, translations: { select: { locale: true, slug: true } } } });
  }
}
