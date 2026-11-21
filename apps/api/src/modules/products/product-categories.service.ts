import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { publishedProductWhere } from './products.presenter.js';
import { prepareTranslations } from '../../common/utils/translation.util.js';
import { assertNoCycle } from '../../common/utils/tree.util.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { SaveTermDto } from '../posts/posts.dto.js';

@Injectable()
export class ProductCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly events: EventEmitter2,
    private readonly customFields: CustomFieldsService,
  ) {}

  private changed() {
    this.events.emit('content.changed', { type: 'product_category', tags: ['products', 'product-categories', 'menus', 'pages'] });
  }

  async list() {
    const rows = await this.prisma.productCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { translations: true, _count: { select: { products: true } } },
    });
    return this.media.attach(rows, ['imageId']);
  }

  async get(id: string) {
    const row = await this.prisma.productCategory.findUnique({ where: { id }, include: { translations: true } });
    if (!row) throw new NotFoundException('Không tìm thấy danh mục');
    return this.media.attachOne(row, ['imageId']);
  }

  /** `user`: người lưu — dùng để xét quyền lọc HTML trường tuỳ chỉnh richtext (không truyền -> luôn lọc) */
  async save(id: string | undefined, dto: SaveTermDto, user?: AuthUser) {
    if (id && dto.parentId === id) throw new BadRequestException('Danh mục cha không hợp lệ');
    if (id && dto.parentId !== undefined) assertNoCycle(await this.prisma.productCategory.findMany({ select: { id: true, parentId: true } }), [{ id, parentId: dto.parentId ?? null }]);
    const translations = await prepareTranslations(this.prisma, 'productCategoryTranslation', 'categoryId', id, dto.translations, await this.languages.codes());
    const existing = id ? await this.prisma.productCategory.findUnique({ where: { id }, select: { customFields: true } }) : null;
    const customFields = await this.customFields.sanitize('product_category', dto.customFields, null, existing?.customFields, { user, id });
    const base = { parentId: dto.parentId, imageId: dto.imageId, sortOrder: dto.sortOrder, isActive: dto.isActive, customFields: customFields as object | undefined };
    const catId = await this.prisma.$transaction(async (tx) => {
      const cat = id ? await tx.productCategory.update({ where: { id }, data: base }) : await tx.productCategory.create({ data: base });
      for (const t of translations) {
        await tx.productCategoryTranslation.upsert({ where: { categoryId_locale: { categoryId: cat.id, locale: t.locale } }, create: { ...t, categoryId: cat.id }, update: t });
      }
      return cat.id;
    });
    this.changed();
    return this.get(catId);
  }

  async remove(id: string) {
    await this.prisma.productCategory.delete({ where: { id } });
    this.changed();
    return { success: true };
  }

  async reorder(items: { id: string; parentId: string | null; sortOrder: number }[]) {
    assertNoCycle(await this.prisma.productCategory.findMany({ select: { id: true, parentId: true } }), items.map((i) => ({ id: i.id, parentId: i.parentId ?? null })));
    await this.prisma.$transaction(items.map((i) => this.prisma.productCategory.update({ where: { id: i.id }, data: { parentId: i.parentId, sortOrder: i.sortOrder } })));
    this.changed();
    return { success: true };
  }

  // ---- public ----
  async publicTree(localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    const fallback = await this.languages.defaultLocale();
    const rows = (await this.list()).filter((r) => r.isActive);
    const counts = await this.prisma.productCategoryOnProduct.groupBy({ by: ['categoryId'], where: { product: publishedProductWhere() }, _count: true });
    const countOf = new Map(counts.map((c) => [c.categoryId, c._count]));
    const nodes = rows.map((r) => {
      const tr = r.translations.find((t) => t.locale === locale) ?? r.translations.find((t) => t.locale === fallback);
      return {
        id: r.id,
        parentId: r.parentId,
        name: tr?.name ?? '',
        slug: tr?.slug ?? '',
        description: tr?.description ?? null,
        image: (r as Record<string, unknown>).image ?? null,
        productCount: countOf.get(r.id) ?? 0,
        children: [] as unknown[],
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const roots: typeof nodes = [];
    for (const n of nodes) {
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      if (parent) parent.children.push(n);
      else if (!n.parentId) roots.push(n); // con của danh mục đang tắt bị ẩn theo cha
    }
    return roots;
  }

  async publicBySlug(slug: string, localeInput?: string) {
    const locale = await this.languages.resolve(localeInput);
    const row = await this.prisma.productCategory.findFirst({
      where: { isActive: true, translations: { some: { slug, locale } } },
      include: { translations: true, parent: { include: { translations: true } } },
    });
    if (!row) throw new NotFoundException('Không tìm thấy danh mục');
    const tr = row.translations.find((t) => t.locale === locale)!;
    const parentTr = row.parent?.translations.find((t) => t.locale === locale);
    const withImage = await this.media.attachOne({ imageId: row.imageId }, ['imageId']);
    return {
      ...tr,
      ...(await this.customFields.present('product_category', row.customFields, locale, await this.languages.defaultLocale())),
      id: row.id,
      image: (withImage as Record<string, unknown>).image ?? null,
      parent: parentTr ? { id: row.parentId, name: parentTr.name, slug: parentTr.slug } : null,
      alternates: Object.fromEntries(row.translations.map((t) => [t.locale, t.slug])),
    };
  }

  sitemapEntries() {
    return this.prisma.productCategory.findMany({ where: { isActive: true }, select: { id: true, updatedAt: true, translations: { select: { locale: true, slug: true } } } });
  }
}
