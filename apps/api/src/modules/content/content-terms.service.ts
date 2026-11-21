import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { MediaRef, PublicTerm } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { assertNoCycle } from '../../common/utils/tree.util.js';
import { uniqueSlug } from '../../common/utils/slug.util.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ContentMetaService, type TaxonomyMeta } from './content-meta.service.js';
import { publishedEntryWhere, termPath } from './content.presenter.js';
import { buildAlternates, labelFor } from './content.util.js';
import type { SaveContentTermDto } from './content.dto.js';

const pick = <T extends { locale: string }>(list: T[], locale: string, fallback: string) => list.find((t) => t.locale === locale) ?? list.find((t) => t.locale === fallback) ?? list[0];

/** Term (phân loại tuỳ biến): quản trị cây term của một taxonomy + dữ liệu công khai */
@Injectable()
export class ContentTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly media: MediaService,
    private readonly events: EventEmitter2,
    private readonly customFields: CustomFieldsService,
    private readonly meta: ContentMetaService,
  ) {}

  private async taxonomyOrThrow(key: string): Promise<TaxonomyMeta> {
    const tax = await this.meta.taxonomy(key);
    if (!tax) throw new NotFoundException(`Không tìm thấy phân loại "${key}"`);
    return tax;
  }

  /** Báo storefront làm mới: danh sách term + lưu trữ các loại dùng taxonomy này */
  private changed(tax: TaxonomyMeta, id: string | undefined, action: string, user?: AuthUser) {
    this.events.emit('content.changed', { type: 'term', id, tags: ['terms', `terms:${tax.key}`, ...tax.contentTypes.map((t) => `entries:${t}`), 'sitemap', 'menus'] });
    if (user) this.events.emit('activity', { userId: user.id, action, entityType: 'term', entityId: id, meta: { taxonomy: tax.key } });
  }

  // ======================= Admin =======================

  /** Danh sách phẳng (có parentId) kèm bản dịch, số bài; `name/slug` theo locale yêu cầu */
  async list(taxonomyKey: string, localeInput?: string) {
    const tax = await this.taxonomyOrThrow(taxonomyKey);
    const locale = await this.languages.resolve(localeInput);
    const fallback = await this.languages.defaultLocale();
    const rows = await this.prisma.term.findMany({
      where: { taxonomyId: tax.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { translations: { orderBy: { locale: 'asc' } }, _count: { select: { entries: { where: { entry: { deletedAt: null } } } } } },
    });
    const withMedia = await this.media.attach(rows as unknown as Record<string, unknown>[], ['imageId']);
    return withMedia.map((r) => {
      const row = r as unknown as (typeof rows)[number] & { image: MediaRef | null };
      const tr = pick(row.translations, locale, fallback);
      const { _count, translations, ...rest } = row;
      return {
        ...rest,
        taxonomy: tax.key,
        name: tr?.name ?? '',
        slug: tr?.slug ?? '',
        customFields: (row.customFields ?? {}) as Record<string, unknown>,
        translations: translations.map(({ locale: l, name, slug, description, seoTitle, seoDescription }) => ({ locale: l, name, slug, description, seoTitle, seoDescription })),
        entryCount: _count.entries,
      };
    });
  }

  async get(id: string) {
    const row = await this.prisma.term.findUnique({ where: { id }, include: { translations: true, taxonomy: { select: { key: true } } } });
    if (!row) throw new NotFoundException('Không tìm thấy phân loại');
    return this.media.attachOne({ ...row, taxonomy: row.taxonomy.key } as unknown as Record<string, unknown>, ['imageId']);
  }

  /** Chuẩn hoá bản dịch: locale hợp lệ, slug duy nhất trong (taxonomy, locale) */
  private async prepare(taxonomyId: string, termId: string | undefined, items: SaveContentTermDto['translations']) {
    const locales = await this.languages.codes();
    const seen = new Set<string>();
    const out: (SaveContentTermDto['translations'][number] & { slug: string })[] = [];
    for (const t of items) {
      if (!locales.includes(t.locale)) throw new BadRequestException(`Ngôn ngữ "${t.locale}" chưa được bật`);
      if (seen.has(t.locale)) throw new BadRequestException(`Trùng bản dịch ngôn ngữ "${t.locale}"`);
      seen.add(t.locale);
      // không gửi slug khi sửa -> giữ slug cũ
      const old = termId && !t.slug?.trim() ? await this.prisma.termTranslation.findUnique({ where: { termId_locale: { termId, locale: t.locale } }, select: { slug: true } }) : null;
      const slug = await uniqueSlug(t.slug?.trim() || old?.slug || t.name, async (s) => !!(await this.prisma.termTranslation.findFirst({ where: { taxonomyId, locale: t.locale, slug: s, ...(termId ? { NOT: { termId } } : {}) }, select: { id: true } })));
      out.push({ ...t, name: t.name.trim(), slug });
    }
    return out;
  }

  async save(taxonomyKey: string | undefined, id: string | undefined, dto: SaveContentTermDto, user?: AuthUser) {
    const existing = id ? await this.prisma.term.findUnique({ where: { id }, include: { taxonomy: { select: { key: true } } } }) : null;
    if (id && !existing) throw new NotFoundException('Không tìm thấy phân loại');
    const tax = await this.taxonomyOrThrow(existing?.taxonomy.key ?? taxonomyKey ?? '');
    // taxonomy phẳng (như thẻ) không có cha
    let parentId = dto.parentId;
    if (!tax.hierarchical) parentId = parentId === undefined ? undefined : null;
    if (parentId) {
      if (parentId === id) throw new BadRequestException('Mục cha không hợp lệ');
      const parent = await this.prisma.term.findUnique({ where: { id: parentId }, select: { taxonomyId: true } });
      if (!parent || parent.taxonomyId !== tax.id) throw new BadRequestException('Mục cha phải cùng phân loại');
      if (id) assertNoCycle(await this.prisma.term.findMany({ where: { taxonomyId: tax.id }, select: { id: true, parentId: true } }), [{ id, parentId }]);
    }
    const translations = await this.prepare(tax.id, id, dto.translations);
    const customFields = await this.customFields.sanitize('term', dto.customFields, { taxonomy: tax.key }, existing?.customFields, { user, id });
    const base = {
      parentId,
      imageId: dto.imageId,
      sortOrder: dto.sortOrder,
      customFields: customFields as Prisma.InputJsonValue | undefined,
    };
    const termId = await this.prisma.$transaction(async (tx) => {
      const term = id
        ? await tx.term.update({ where: { id }, data: base })
        : await tx.term.create({ data: { ...base, taxonomyId: tax.id, sortOrder: base.sortOrder ?? (await tx.term.count({ where: { taxonomyId: tax.id, parentId: parentId ?? null } })) } });
      for (const t of translations) {
        const data = { name: t.name, slug: t.slug, description: t.description ?? null, seoTitle: t.seoTitle ?? null, seoDescription: t.seoDescription ?? null };
        await tx.termTranslation.upsert({ where: { termId_locale: { termId: term.id, locale: t.locale } }, create: { ...data, termId: term.id, taxonomyId: tax.id, locale: t.locale }, update: data });
      }
      return term.id;
    });
    this.changed(tax, termId, id ? 'term.updated' : 'term.created', user);
    return this.get(termId);
  }

  async remove(id: string, user?: AuthUser) {
    const row = await this.prisma.term.findUnique({ where: { id }, include: { taxonomy: { select: { key: true } } } });
    if (!row) throw new NotFoundException('Không tìm thấy phân loại');
    const tax = await this.taxonomyOrThrow(row.taxonomy.key);
    // con của term bị xoá chuyển lên cấp của term đó (giữ cây gọn)
    await this.prisma.$transaction([this.prisma.term.updateMany({ where: { parentId: id }, data: { parentId: row.parentId } }), this.prisma.term.delete({ where: { id } })]);
    this.changed(tax, id, 'term.deleted', user);
    return { success: true };
  }

  async reorder(taxonomyKey: string, items: { id: string; parentId: string | null; sortOrder: number }[], user?: AuthUser) {
    const tax = await this.taxonomyOrThrow(taxonomyKey);
    const nodes = await this.prisma.term.findMany({ where: { taxonomyId: tax.id }, select: { id: true, parentId: true } });
    const ids = new Set(nodes.map((n) => n.id));
    for (const i of items) {
      if (!ids.has(i.id) || (i.parentId && !ids.has(i.parentId))) throw new BadRequestException('Có mục không thuộc phân loại này');
      if (!tax.hierarchical) i.parentId = null;
    }
    assertNoCycle(nodes, items.map((i) => ({ id: i.id, parentId: i.parentId ?? null })));
    await this.prisma.$transaction(items.map((i) => this.prisma.term.update({ where: { id: i.id }, data: { parentId: i.parentId ?? null, sortOrder: i.sortOrder } })));
    this.changed(tax, undefined, 'term.reordered', user);
    return { success: true };
  }

  // ======================= Public =======================

  /** Danh sách term công khai của một taxonomy (kèm số bài đã xuất bản, lọc theo loại nếu có) */
  async publicList(taxonomyKey: string, localeInput?: string, typeKey?: string): Promise<PublicTerm[]> {
    const tax = await this.meta.taxonomy(taxonomyKey);
    if (!tax) throw new NotFoundException('Không tìm thấy phân loại');
    const locale = await this.languages.resolve(localeInput);
    const defaultLocale = await this.languages.defaultLocale();
    const env = { locale, defaultLocale };
    const [rows, counts] = await Promise.all([
      this.prisma.term.findMany({ where: { taxonomyId: tax.id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { translations: true } }),
      this.prisma.entryTerm.groupBy({
        by: ['termId'],
        where: { term: { taxonomyId: tax.id }, entry: { ...publishedEntryWhere(), ...(typeKey ? { type: { key: typeKey, isActive: true } } : {}) } },
        _count: { _all: true },
      }),
    ]);
    const countMap = new Map(counts.map((c) => [c.termId, c._count._all]));
    const media = await this.media.findMany(rows.map((r) => r.imageId));
    return rows
      .map((r) => {
        const tr = pick(r.translations, locale, defaultLocale);
        if (!tr) return null;
        return {
          id: r.id,
          taxonomy: tax.key,
          parentId: r.parentId,
          name: tr.name,
          slug: tr.slug,
          description: tr.description,
          image: (media.get(r.imageId ?? '') as MediaRef | undefined) ?? null,
          path: termPath(tax, tr.slug, env),
          count: countMap.get(r.id) ?? 0,
        } satisfies PublicTerm;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }

  /** Chi tiết term công khai (trang lưu trữ term) */
  async publicBySlug(taxonomyKey: string, slug: string, localeInput?: string) {
    const tax = await this.meta.taxonomy(taxonomyKey);
    if (!tax || !tax.isPublic) throw new NotFoundException('Không tìm thấy phân loại');
    const locale = await this.languages.resolve(localeInput);
    const defaultLocale = await this.languages.defaultLocale();
    const locales = await this.languages.codes();
    const row = await this.prisma.term.findFirst({ where: { taxonomyId: tax.id, translations: { some: { locale, slug } } }, include: { translations: true } });
    if (!row) throw new NotFoundException('Không tìm thấy phân loại');
    const tr = row.translations.find((t) => t.locale === locale)!;
    const count = await this.prisma.entryTerm.count({ where: { termId: row.id, entry: publishedEntryWhere() } });
    const image = row.imageId ? (await this.media.findMany([row.imageId])).get(row.imageId) : null;
    const cf = await this.customFields.present('term', row.customFields, locale, defaultLocale, { taxonomy: tax.key });
    const types = await this.meta.types();
    return {
      id: row.id,
      taxonomy: tax.key,
      parentId: row.parentId,
      name: tr.name,
      slug: tr.slug,
      description: tr.description,
      image: (image as MediaRef | undefined) ?? null,
      path: termPath(tax, tr.slug, { locale, defaultLocale }),
      count,
      seoTitle: tr.seoTitle,
      seoDescription: tr.seoDescription,
      customFields: cf.customFields,
      customFieldGroups: cf.customFieldGroups,
      alternates: buildAlternates(row.translations, tax.slugs, locales, defaultLocale, tax.key),
      taxonomyLabel: labelFor(tax.labels, locale, defaultLocale, tax.key).plural,
      // chỉ loại đang bật + public (storefront dùng để lấy danh sách bài của term)
      contentTypes: tax.contentTypes.filter((k) => types.some((t) => t.key === k && t.isActive && t.isPublic)),
    };
  }

  /** Term public cho sitemap: taxonomy public, có ít nhất một bài đã xuất bản */
  async sitemapEntries() {
    const taxes = (await this.meta.taxonomies()).filter((t) => t.isPublic);
    if (!taxes.length) return [];
    const rows = await this.prisma.term.findMany({
      where: { taxonomyId: { in: taxes.map((t) => t.id) }, entries: { some: { entry: publishedEntryWhere() } } },
      select: { id: true, taxonomyId: true, updatedAt: true, imageId: true, translations: { select: { locale: true, slug: true, name: true } } },
    });
    return rows.map((r) => ({ ...r, taxonomy: taxes.find((t) => t.id === r.taxonomyId)! }));
  }
}
