import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CONTENT_KEY_RE, CONTENT_TYPE_SUPPORTS, hasPermission, type ContentTypeView, type TaxonomyView, type TypeLabels } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { ContentMetaService, type TaxonomyMeta, type TypeMeta } from './content-meta.service.js';
import { ContentTermsService } from './content-terms.service.js';
import { CONTENT_TYPE_PRESETS } from './content.presets.js';
import { normalizeSlugs, slugConflicts, type SlugOwner } from './content.util.js';
import type { SaveContentTypeDto, SaveTaxonomyDto } from './content.dto.js';

/** Mã không dùng cho loại nội dung (trùng thực thể lõi trong Theme Builder / query-loop) */
const RESERVED_KEYS = new Set(['post', 'page', 'product', 'entry', 'term', 'user', 'media', 'category', 'tag', 'post_category', 'post_tag', 'product_category']);

/** Nguồn "code": khai báo trong apps/api/src/config/content-types.config.ts (đồng bộ lúc khởi động) */
const CODE_SOURCE = 'code';
const CODE_LOCKED = 'được khai báo trong mã nguồn (apps/api/src/config/content-types.config.ts) — sửa ở đó rồi khởi động lại API';

/** Khai báo loại nội dung + taxonomy (quyền content_types.manage) + cài mẫu có sẵn */
@Injectable()
export class ContentTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly events: EventEmitter2,
    private readonly meta: ContentMetaService,
    private readonly terms: ContentTermsService,
    private readonly customFields: CustomFieldsService,
  ) {}

  // ======================= Chung =======================

  /** Chuẩn hoá nhãn { locale: { singular, plural } } (thiếu locale thì lấy theo ngôn ngữ mặc định) */
  private normalizeLabels(input: SaveContentTypeDto['labels'] | undefined, locales: string[], defaultLocale: string, key: string): TypeLabels {
    const raw = input && typeof input === 'object' ? input : {};
    const out: TypeLabels = {};
    for (const l of locales) {
      const v = raw[l];
      const singular = String(v?.singular ?? '').trim().slice(0, 80);
      const plural = String(v?.plural ?? '').trim().slice(0, 80);
      if (singular || plural) out[l] = { singular: singular || plural, plural: plural || singular };
    }
    const base = out[defaultLocale] ?? Object.values(out)[0];
    if (!base) throw new BadRequestException('Cần nhập tên (nhãn) cho ngôn ngữ mặc định');
    for (const l of locales) out[l] ??= base;
    void key;
    return out;
  }

  /** Mọi slug gốc đang dùng: loại nội dung, taxonomy, trang (chỉ trang có slug trùng ứng viên) */
  private async slugOwners(candidates: string[]): Promise<SlugOwner[]> {
    const [types, taxes, pages] = await Promise.all([
      this.meta.types(),
      this.meta.taxonomies(),
      candidates.length ? this.prisma.pageTranslation.findMany({ where: { slug: { in: candidates }, page: { deletedAt: null } }, select: { pageId: true, locale: true, slug: true } }) : [],
    ]);
    const pageOwners = new Map<string, Record<string, string>>();
    for (const p of pages) pageOwners.set(p.pageId, { ...(pageOwners.get(p.pageId) ?? {}), [p.locale]: p.slug });
    return [
      ...types.map((t) => ({ kind: 'content_type' as const, id: t.key, slugs: t.slugs })),
      ...taxes.map((t) => ({ kind: 'taxonomy' as const, id: t.key, slugs: t.slugs })),
      ...[...pageOwners].map(([id, slugs]) => ({ kind: 'page' as const, id, slugs })),
    ];
  }

  private async assertSlugs(slugs: Record<string, string>, self: { kind: 'content_type' | 'taxonomy'; id?: string }) {
    const locales = await this.languages.codes();
    const errors = slugConflicts(slugs, self, await this.slugOwners(Object.values(slugs)), locales);
    if (errors.length) throw new BadRequestException(errors.join('; '));
  }

  /** Tìm slug không trùng (dùng khi cài mẫu: thêm hậu tố -2, -3...) */
  private async freeSlugs(slugs: Record<string, string>, self: { kind: 'content_type' | 'taxonomy'; id: string }) {
    const locales = await this.languages.codes();
    const out = { ...slugs };
    for (const l of Object.keys(out)) {
      let i = 2;
      const base = out[l];
      while (slugConflicts({ [l]: out[l] }, self, await this.slugOwners([out[l]]), locales).length && i < 50) out[l] = `${base}-${i++}`;
    }
    return out;
  }

  /** Báo các nơi dùng cache (menu, sitemap, frontend) rằng khai báo loại nội dung đã đổi — dùng sau khi đồng bộ từ code */
  notifyMetaChanged() {
    this.metaChanged([], 'content_type.synced', 'content_type', undefined);
  }

  private metaChanged(tags: string[], action: string, entityType: string, id: string | undefined, user?: AuthUser) {
    this.meta.clear();
    this.events.emit('content.meta.changed', {});
    this.events.emit('content.changed', { type: entityType, id, tags: ['content-types', 'bootstrap', 'sitemap', 'menus', ...tags] });
    if (user) this.events.emit('activity', { userId: user.id, action, entityType, entityId: id });
  }

  // ======================= Loại nội dung =======================

  private toView(t: TypeMeta, taxes: TaxonomyMeta[], entryCount?: number): ContentTypeView {
    return { ...t, taxonomies: taxes.filter((x) => x.contentTypes.includes(t.key)).map((x) => x.key), ...(entryCount !== undefined ? { entryCount } : {}) };
  }

  /** Danh sách cho admin (content_types.manage hoặc entries.read) */
  async listTypes(user: AuthUser): Promise<ContentTypeView[]> {
    if (!hasPermission(user.permissions, 'content_types.manage') && !hasPermission(user.permissions, 'entries.read')) throw new ForbiddenException('Bạn không có quyền xem loại nội dung');
    const [types, taxes, counts] = await Promise.all([
      this.meta.types(),
      this.meta.taxonomies(),
      this.prisma.entry.groupBy({ by: ['typeId'], where: { deletedAt: null }, _count: { _all: true } }),
    ]);
    const map = new Map(counts.map((c) => [c.typeId, c._count._all]));
    return types.map((t) => this.toView(t, taxes, map.get(t.id) ?? 0));
  }

  async getType(id: string): Promise<ContentTypeView> {
    const t = await this.meta.typeById(id);
    if (!t) throw new NotFoundException('Không tìm thấy loại nội dung');
    const count = await this.prisma.entry.count({ where: { typeId: id, deletedAt: null } });
    return this.toView(t, await this.meta.taxonomies(), count);
  }

  async saveType(id: string | undefined, dto: SaveContentTypeDto, user?: AuthUser, source = 'admin'): Promise<ContentTypeView> {
    const existing = id ? await this.meta.typeById(id) : undefined;
    if (id && !existing) throw new NotFoundException('Không tìm thấy loại nội dung');
    // loại khai báo trong code chỉ được ghi bởi bộ đồng bộ (source = 'code'), admin / import không sửa được
    if (existing?.source === CODE_SOURCE && source !== CODE_SOURCE) throw new BadRequestException(`Loại nội dung "${existing.key}" ${CODE_LOCKED}`);
    const key = existing?.key ?? dto.key?.trim() ?? '';
    if (!existing) {
      if (!CONTENT_KEY_RE.test(key)) throw new BadRequestException('Mã loại nội dung: chữ thường, số, gạch dưới, bắt đầu bằng chữ (2–40 ký tự)');
      if (RESERVED_KEYS.has(key)) throw new BadRequestException(`Mã "${key}" trùng thực thể hệ thống`);
      if (await this.meta.type(key)) throw new BadRequestException(`Mã loại nội dung "${key}" đã tồn tại`);
    } else if (dto.key && dto.key !== existing.key) throw new BadRequestException('Không đổi được mã loại nội dung sau khi tạo');
    const locales = await this.languages.codes();
    const defaultLocale = await this.languages.defaultLocale();
    const labels = this.normalizeLabels(dto.labels, locales, defaultLocale, key);
    const slugs = normalizeSlugs(dto.slugs ?? existing?.slugs, locales, defaultLocale, labels[defaultLocale]?.plural || key);
    await this.assertSlugs(slugs, { kind: 'content_type', id: existing?.key });
    const supports = dto.supports ? [...new Set(dto.supports.filter((s) => (CONTENT_TYPE_SUPPORTS as readonly string[]).includes(s)))] : undefined;
    const data = {
      labels,
      slugs,
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      icon: dto.icon?.trim() || undefined,
      supports,
      isPublic: dto.isPublic,
      hasArchive: dto.hasArchive,
      searchable: dto.searchable,
      perPage: dto.perPage,
      orderBy: dto.orderBy,
      listColumns: dto.listColumns?.map((c) => c.trim()).filter(Boolean).slice(0, 8),
      isActive: dto.isActive,
      sortOrder: dto.sortOrder,
      // bản ghi cũ (tạo từ admin / mẫu) trùng key với khai báo trong code -> nhận về code
      ...(source === CODE_SOURCE ? { source } : {}),
    };
    const row = existing
      ? await this.prisma.contentType.update({ where: { id: existing.id }, data })
      : await this.prisma.contentType.create({ data: { ...data, key, source, sortOrder: data.sortOrder ?? (await this.prisma.contentType.count()) } });
    if (dto.taxonomies) await this.syncTypeTaxonomies(key, dto.taxonomies);
    this.metaChanged([`entries:${key}`, 'entries'], existing ? 'content_type.updated' : 'content_type.created', 'content_type', row.id, user);
    return this.getType(row.id);
  }

  /** Gắn / gỡ loại nội dung khỏi Taxonomy.contentTypes theo danh sách key taxonomy */
  private async syncTypeTaxonomies(typeKey: string, taxonomyKeys: string[]) {
    const want = new Set(taxonomyKeys);
    const all = await this.prisma.taxonomy.findMany({ select: { id: true, key: true, contentTypes: true } });
    for (const k of want) if (!all.some((t) => t.key === k)) throw new BadRequestException(`Không tìm thấy phân loại "${k}"`);
    for (const t of all) {
      const has = t.contentTypes.includes(typeKey);
      if (want.has(t.key) && !has) await this.prisma.taxonomy.update({ where: { id: t.id }, data: { contentTypes: [...t.contentTypes, typeKey] } });
      if (!want.has(t.key) && has) await this.prisma.taxonomy.update({ where: { id: t.id }, data: { contentTypes: t.contentTypes.filter((x) => x !== typeKey) } });
    }
  }

  async removeType(id: string, user?: AuthUser) {
    const t = await this.meta.typeById(id);
    if (!t) throw new NotFoundException('Không tìm thấy loại nội dung');
    if (t.source === CODE_SOURCE) throw new BadRequestException(`Loại nội dung "${t.key}" ${CODE_LOCKED}`);
    const count = await this.prisma.entry.count({ where: { typeId: id } });
    if (count) throw new BadRequestException(`Loại nội dung còn ${count} bài (kể cả thùng rác) — hãy xoá hết bài trước`);
    await this.prisma.contentType.delete({ where: { id } });
    await this.syncTypeTaxonomies(t.key, []);
    this.metaChanged([`entries:${t.key}`, 'entries'], 'content_type.deleted', 'content_type', id, user);
    return { success: true };
  }

  // ======================= Taxonomy =======================

  async listTaxonomies(user: AuthUser): Promise<TaxonomyView[]> {
    if (!hasPermission(user.permissions, 'content_types.manage') && !hasPermission(user.permissions, 'entries.read')) throw new ForbiddenException('Bạn không có quyền xem phân loại');
    const [taxes, counts] = await Promise.all([this.meta.taxonomies(), this.prisma.term.groupBy({ by: ['taxonomyId'], _count: { _all: true } })]);
    const map = new Map(counts.map((c) => [c.taxonomyId, c._count._all]));
    return taxes.map((t) => ({ ...t, termCount: map.get(t.id) ?? 0 }));
  }

  async saveTaxonomy(id: string | undefined, dto: SaveTaxonomyDto, user?: AuthUser, source = 'admin'): Promise<TaxonomyView> {
    const existing = id ? (await this.meta.taxonomies()).find((t) => t.id === id) : undefined;
    if (id && !existing) throw new NotFoundException('Không tìm thấy phân loại');
    if (existing?.source === CODE_SOURCE && source !== CODE_SOURCE) throw new BadRequestException(`Phân loại "${existing.key}" ${CODE_LOCKED}`);
    const key = existing?.key ?? dto.key?.trim() ?? '';
    if (!existing) {
      if (!CONTENT_KEY_RE.test(key)) throw new BadRequestException('Mã phân loại: chữ thường, số, gạch dưới, bắt đầu bằng chữ (2–40 ký tự)');
      if (RESERVED_KEYS.has(key)) throw new BadRequestException(`Mã "${key}" trùng thực thể hệ thống`);
      if (await this.meta.taxonomy(key)) throw new BadRequestException(`Mã phân loại "${key}" đã tồn tại`);
    } else if (dto.key && dto.key !== existing.key) throw new BadRequestException('Không đổi được mã phân loại sau khi tạo');
    const locales = await this.languages.codes();
    const defaultLocale = await this.languages.defaultLocale();
    const labels = this.normalizeLabels(dto.labels, locales, defaultLocale, key);
    const slugs = normalizeSlugs(dto.slugs ?? existing?.slugs, locales, defaultLocale, labels[defaultLocale]?.plural || key);
    await this.assertSlugs(slugs, { kind: 'taxonomy', id: existing?.key });
    let contentTypes = dto.contentTypes;
    if (contentTypes) {
      const types = await this.meta.types();
      contentTypes = [...new Set(contentTypes)];
      for (const k of contentTypes) if (!types.some((t) => t.key === k)) throw new BadRequestException(`Không tìm thấy loại nội dung "${k}"`);
    }
    const data = {
      labels,
      slugs,
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      hierarchical: dto.hierarchical,
      contentTypes,
      isPublic: dto.isPublic,
      showInFilter: dto.showInFilter,
      sortOrder: dto.sortOrder,
      ...(source === CODE_SOURCE ? { source } : {}),
    };
    const row = existing
      ? await this.prisma.taxonomy.update({ where: { id: existing.id }, data })
      : await this.prisma.taxonomy.create({ data: { ...data, key, source, sortOrder: data.sortOrder ?? (await this.prisma.taxonomy.count()) } });
    // đổi từ cây sang phẳng -> bỏ quan hệ cha con
    if (existing?.hierarchical && dto.hierarchical === false) await this.prisma.term.updateMany({ where: { taxonomyId: row.id }, data: { parentId: null } });
    const typeTags = [...new Set([...(existing?.contentTypes ?? []), ...row.contentTypes])].map((k) => `entries:${k}`);
    this.metaChanged(['terms', `terms:${key}`, ...typeTags], existing ? 'taxonomy.updated' : 'taxonomy.created', 'taxonomy', row.id, user);
    const view = (await this.meta.taxonomies()).find((t) => t.id === row.id)!;
    return { ...view, termCount: await this.prisma.term.count({ where: { taxonomyId: row.id } }) };
  }

  async removeTaxonomy(id: string, user?: AuthUser) {
    const tax = (await this.meta.taxonomies()).find((t) => t.id === id);
    if (!tax) throw new NotFoundException('Không tìm thấy phân loại');
    if (tax.source === CODE_SOURCE) throw new BadRequestException(`Phân loại "${tax.key}" ${CODE_LOCKED}`);
    // term + liên kết bài bị xoá theo (onDelete Cascade)
    await this.prisma.taxonomy.delete({ where: { id } });
    this.metaChanged(['terms', `terms:${tax.key}`, ...tax.contentTypes.map((k) => `entries:${k}`)], 'taxonomy.deleted', 'taxonomy', id, user);
    return { success: true };
  }

  // ======================= Mẫu có sẵn =======================

  async presets() {
    const types = await this.meta.types();
    return CONTENT_TYPE_PRESETS.map((p) => ({ key: p.key, label: p.label, description: p.description, icon: p.icon, installed: types.some((t) => t.key === p.key) }));
  }

  /**
   * Cài mẫu (idempotent): tạo loại nội dung, taxonomy (+ term mẫu khi taxonomy mới tạo) và nhóm trường
   * nếu chưa có; phần đã có (trùng key) thì bỏ qua. Slug trùng thì tự thêm hậu tố.
   */
  async installPreset(presetKey: string, user?: AuthUser) {
    const preset = CONTENT_TYPE_PRESETS.find((p) => p.key === presetKey);
    if (!preset) throw new NotFoundException('Không tìm thấy mẫu');
    const source = `preset:${preset.key}`;
    const locales = await this.languages.codes();
    const defaultLocale = await this.languages.defaultLocale();
    const result = { contentType: 'skipped' as 'created' | 'skipped', taxonomies: { created: [] as string[], skipped: [] as string[] }, terms: 0, fieldGroups: { created: [] as string[], updated: [] as string[], skipped: [] as string[] } };

    // nhãn / slug của mẫu chỉ có vi + en -> locale khác dùng ngôn ngữ mặc định
    const fit = <T>(map: Record<string, T>): Record<string, T> => {
      const base = map[defaultLocale] ?? map.vi ?? Object.values(map)[0];
      return Object.fromEntries(locales.map((l) => [l, map[l] ?? base]));
    };

    // 1) loại nội dung
    let type = await this.meta.type(preset.key);
    if (!type) {
      const slugs = await this.freeSlugs(normalizeSlugs(fit(preset.type.slugs), locales, defaultLocale, preset.key), { kind: 'content_type', id: preset.key });
      await this.saveType(undefined, { ...preset.type, key: preset.key, icon: preset.icon, labels: fit(preset.type.labels), slugs }, user, source);
      type = await this.meta.type(preset.key);
      result.contentType = 'created';
    }

    // 2) taxonomy (+ gắn vào loại nội dung)
    for (const tx of preset.taxonomies) {
      const existing = await this.meta.taxonomy(tx.key);
      if (existing) {
        result.taxonomies.skipped.push(tx.key);
        if (!existing.contentTypes.includes(preset.key) && existing.source !== CODE_SOURCE) await this.saveTaxonomy(existing.id, { labels: existing.labels, contentTypes: [...existing.contentTypes, preset.key] }, user);
        continue;
      }
      const slugs = await this.freeSlugs(normalizeSlugs(fit(tx.slugs), locales, defaultLocale, tx.key), { kind: 'taxonomy', id: tx.key });
      await this.saveTaxonomy(undefined, { key: tx.key, labels: fit(tx.labels), slugs, hierarchical: tx.hierarchical, isPublic: tx.isPublic ?? true, showInFilter: tx.showInFilter ?? true, contentTypes: [preset.key] }, user, source);
      result.taxonomies.created.push(tx.key);
      for (const [i, term] of (tx.terms ?? []).entries()) {
        const names: Record<string, string> = { vi: term.vi, en: term.en };
        const translations = locales.map((l) => ({ locale: l, name: names[l] ?? names[defaultLocale] ?? term.vi }));
        await this.terms.save(tx.key, undefined, { sortOrder: i, translations }, user);
        result.terms++;
      }
    }

    // 3) nhóm trường tuỳ chỉnh
    if (preset.fieldGroups.length) {
      const r = await this.customFields.import({ groups: preset.fieldGroups, overwrite: false }, user);
      result.fieldGroups = r;
    }
    void type;
    if (user) this.events.emit('activity', { userId: user.id, action: 'content_type.preset_installed', entityType: 'content_type', entityId: preset.key });
    return result;
  }
}
