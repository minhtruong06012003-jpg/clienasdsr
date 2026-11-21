import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CONTENT_KEY_RE,
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_KEY_RE,
  CUSTOM_FIELD_TYPES,
  I18N_CAPABLE_TYPES,
  customFieldVisible,
  fieldGroupApplies,
  slugify,
  t as pickI18n,
  toCustomFieldKey,
  type CustomFieldContext,
  type CustomFieldDef,
  type CustomFieldEntity,
  type CustomFieldType,
  type FieldGroupDef,
  type FieldGroupRules,
  type PublicFieldGroup,
} from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { MediaService } from '../media/media.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { PRODUCT_CARD_INCLUDE, presentProductCard, publishedProductWhere } from '../products/products.presenter.js';
import { publishedCondition } from '../../common/utils/publish.util.js';
import { canUseUnfilteredHtml, sanitizeRichHtml } from '../../common/utils/sanitize-html.js';
import { POST_CARD_INCLUDE, presentPostCard, publishedPostWhere } from '../posts/posts.presenter.js';
import { ENTRY_CARD_INCLUDE, presentEntryCard, publishedEntryWhere, termPath } from '../content/content.presenter.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { FIELD_GROUP_PRESETS } from './custom-fields.presets.js';
import type { ImportFieldGroupsDto, SaveFieldGroupDto } from './custom-fields.dto.js';

/** Giới hạn an toàn cho dữ liệu người dùng nhập */
const MAX_TEXT = 10_000;
const MAX_RICHTEXT = 200_000;
const MAX_JSON_BYTES = 100_000;
const MAX_REPEATER_ITEMS = 200;
const MAX_FIELDS_PER_GROUP = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Values = Record<string, unknown>;

/** Bộ lọc JSON của Prisma trên cột customFields (path = [fieldKey]) */
interface CfJsonFilter {
  path: string[];
  equals?: unknown;
  array_contains?: unknown;
}

/** Tham chiếu cần nạp hàng loạt khi trình bày public (gom theo loại rồi query 1 lần) */
interface RefBag {
  media: Set<string>;
  products: Set<string>;
  posts: Set<string>;
  pages: Set<string>;
  postCategories: Set<string>;
  productCategories: Set<string>;
  /** bài của loại nội dung tuỳ biến (trường "entries") */
  entries: Set<string>;
  /** term của taxonomy tuỳ biến (trường "terms") */
  terms: Set<string>;
}

/**
 * Trường tuỳ chỉnh: quản lý nhóm trường (bảng field_groups), kiểm tra dữ liệu khi lưu
 * và trình bày giá trị cho API public (chọn ngôn ngữ, gắn object media / sản phẩm / bài viết...).
 *
 * Luồng dùng ở các module nội dung:
 *   save():   dto.customFields -> sanitize(entity, input, ctx, existing) -> ghi cột customFields
 *   public(): row.customFields -> present(entity, values, locale, fallback, ctx) -> { customFields, customFieldGroups }
 */
@Injectable()
export class CustomFieldsService {
  private readonly logger = new Logger('CustomFields');
  /** cache nhóm đang bật theo entity (xoá khi có thay đổi) */
  private cache = new Map<string, FieldGroupDef[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly languages: LanguagesService,
    private readonly hooks: HooksService,
    private readonly events: EventEmitter2,
  ) {}

  // ======================= Nhóm trường (admin) =======================

  private rowToDef(r: { id: string; key: string; name: string; description: string | null; entity: string; fields: unknown; rules: unknown; placement: string; sortOrder: number; isActive: boolean; createdAt?: Date; updatedAt?: Date }): FieldGroupDef & { createdAt?: Date; updatedAt?: Date } {
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      entity: r.entity as CustomFieldEntity,
      fields: Array.isArray(r.fields) ? (r.fields as CustomFieldDef[]) : [],
      rules: (r.rules ?? {}) as FieldGroupRules,
      placement: r.placement === 'sidebar' ? 'sidebar' : 'main',
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      source: 'db',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** Danh sách nhóm trường cho trang quản trị */
  async listAdmin(entity?: string) {
    const rows = await this.prisma.fieldGroup.findMany({ where: entity ? { entity } : undefined, orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return { data: rows.map((r) => this.rowToDef(r)), entities: CUSTOM_FIELD_ENTITIES };
  }

  async getAdmin(id: string) {
    const row = await this.prisma.fieldGroup.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Không tìm thấy nhóm trường');
    return this.rowToDef(row);
  }

  async save(id: string | undefined, dto: SaveFieldGroupDto, user?: AuthUser) {
    const fields = this.normalizeFieldDefs(dto.fields);
    const rules = this.normalizeRules(dto.rules);
    let key = dto.key?.trim() || (id ? undefined : await this.uniqueKey(toCustomFieldKey(dto.name) || slugify(dto.name).replace(/-/g, '_') || 'group'));
    if (key) {
      if (!CUSTOM_FIELD_KEY_RE.test(key)) throw new BadRequestException('Mã nhóm chỉ gồm chữ thường, số, gạch dưới và bắt đầu bằng chữ');
      const dup = await this.prisma.fieldGroup.findFirst({ where: { key, ...(id ? { NOT: { id } } : {}) }, select: { id: true } });
      if (dup) throw new BadRequestException(`Mã nhóm "${key}" đã tồn tại`);
    } else key = undefined;
    const data = {
      key,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      entity: dto.entity,
      fields: fields as unknown as Prisma.InputJsonValue,
      rules: rules as unknown as Prisma.InputJsonValue,
      placement: dto.placement ?? 'main',
      sortOrder: dto.sortOrder,
      isActive: dto.isActive,
    };
    const row = id
      ? await this.prisma.fieldGroup.update({ where: { id }, data })
      : await this.prisma.fieldGroup.create({ data: { ...data, key: key!, sortOrder: data.sortOrder ?? (await this.prisma.fieldGroup.count({ where: { entity: dto.entity } })), isActive: data.isActive ?? true } });
    this.changed(id ? 'field_group.updated' : 'field_group.created', row.id, user);
    return this.rowToDef(row);
  }

  async remove(id: string, user?: AuthUser) {
    await this.prisma.fieldGroup.delete({ where: { id } });
    this.changed('field_group.deleted', id, user);
    return { success: true };
  }

  async duplicate(id: string, user?: AuthUser) {
    const src = await this.getAdmin(id);
    return this.save(undefined, { key: await this.uniqueKey(`${src.key}_copy`), name: `${src.name} (bản sao)`, description: src.description ?? undefined, entity: src.entity, fields: src.fields, rules: src.rules as Record<string, unknown>, placement: src.placement, isActive: false }, user);
  }

  async reorder(items: { id: string; sortOrder: number }[], user?: AuthUser) {
    await this.prisma.$transaction(items.filter((i) => UUID_RE.test(i.id)).map((i) => this.prisma.fieldGroup.update({ where: { id: i.id }, data: { sortOrder: i.sortOrder } })));
    this.changed('field_group.reordered', undefined, user);
    return { success: true };
  }

  /** Mẫu có sẵn + trạng thái đã cài (theo key nhóm) */
  async presets() {
    const existing = new Set((await this.prisma.fieldGroup.findMany({ select: { key: true } })).map((r) => r.key));
    return FIELD_GROUP_PRESETS.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      icon: p.icon,
      groups: p.groups.map((g) => ({ key: g.key, name: g.name, entity: g.entity, fieldCount: g.fields.length, installed: existing.has(g.key) })),
      installed: p.groups.every((g) => existing.has(g.key)),
    }));
  }

  async applyPreset(presetKey: string, overwrite = false, user?: AuthUser) {
    const preset = FIELD_GROUP_PRESETS.find((p) => p.key === presetKey);
    if (!preset) throw new NotFoundException('Không tìm thấy mẫu');
    return this.import({ groups: preset.groups, overwrite }, user);
  }

  /** Xuất JSON để mang sang website khác (chỉ nhóm trong DB) */
  async export(ids?: string[]) {
    const rows = await this.prisma.fieldGroup.findMany({ where: ids?.length ? { id: { in: ids } } : undefined, orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }] });
    return {
      format: 'cmsnt-field-groups',
      version: 1,
      exportedAt: new Date().toISOString(),
      groups: rows.map((r) => {
        const { id: _id, createdAt: _c, updatedAt: _u, source: _s, ...g } = this.rowToDef(r);
        return g;
      }),
    };
  }

  async import(dto: ImportFieldGroupsDto, user?: AuthUser) {
    const result = { created: [] as string[], updated: [] as string[], skipped: [] as string[] };
    for (const raw of dto.groups) {
      const g = raw as Partial<FieldGroupDef>;
      if (!g || typeof g !== 'object' || !g.key || !g.name || !g.entity) throw new BadRequestException('Nhóm trường trong file không hợp lệ (thiếu key/name/entity)');
      if (!CUSTOM_FIELD_ENTITIES.includes(g.entity)) throw new BadRequestException(`Loại nội dung "${g.entity}" không hợp lệ`);
      const existing = await this.prisma.fieldGroup.findUnique({ where: { key: g.key } });
      if (existing && !dto.overwrite) {
        result.skipped.push(g.key);
        continue;
      }
      const payload: SaveFieldGroupDto = { key: g.key, name: g.name, description: g.description ?? undefined, entity: g.entity, fields: g.fields ?? [], rules: (g.rules ?? {}) as Record<string, unknown>, placement: g.placement, sortOrder: g.sortOrder, isActive: g.isActive ?? true };
      await this.save(existing?.id, payload, user);
      (existing ? result.updated : result.created).push(g.key);
    }
    return result;
  }

  private async uniqueKey(base: string) {
    let key = base;
    let i = 2;
    while ((await this.prisma.fieldGroup.findUnique({ where: { key }, select: { id: true } }))) key = `${base}_${i++}`;
    return key;
  }

  private changed(action: string, id?: string, user?: AuthUser) {
    this.cache.clear();
    if (user) this.events.emit('activity', { userId: user.id, action, entityType: 'field_group', entityId: id });
    // storefront có thể hiển thị nhãn nhóm -> làm mới mọi trang nội dung
    this.events.emit('content.changed', { type: 'field_group', id, tags: ['pages', 'posts', 'products', 'entries', 'terms', 'field-groups', 'custom-fields'] });
  }

  // ======================= Chuẩn hoá định nghĩa =======================

  /** Kiểm tra & làm sạch danh sách CustomFieldDef do admin / file import gửi lên */
  normalizeFieldDefs(input: unknown, nested = false): CustomFieldDef[] {
    if (!Array.isArray(input)) throw new BadRequestException('Danh sách trường không hợp lệ');
    if (input.length > MAX_FIELDS_PER_GROUP) throw new BadRequestException(`Tối đa ${MAX_FIELDS_PER_GROUP} trường mỗi nhóm`);
    const seen = new Set<string>();
    return input.map((raw, idx) => {
      const f = (raw ?? {}) as Record<string, unknown>;
      const label = String(f.label ?? '').trim();
      const key = String(f.key ?? '').trim() || toCustomFieldKey(label);
      if (!label) throw new BadRequestException(`Trường thứ ${idx + 1} thiếu nhãn`);
      if (!CUSTOM_FIELD_KEY_RE.test(key)) throw new BadRequestException(`Mã trường "${key}" không hợp lệ (chữ thường, số, gạch dưới; bắt đầu bằng chữ)`);
      if (seen.has(key)) throw new BadRequestException(`Trùng mã trường "${key}"`);
      seen.add(key);
      const type = String(f.type ?? 'text') as CustomFieldType;
      if (!CUSTOM_FIELD_TYPES.includes(type)) throw new BadRequestException(`Loại trường "${type}" không được hỗ trợ`);
      if (nested && type === 'repeater') throw new BadRequestException(`Trường "${label}": không lồng repeater trong repeater`);
      const def: CustomFieldDef = { key, label, type };
      if (f.help) def.help = String(f.help).slice(0, 500);
      if (f.placeholder) def.placeholder = String(f.placeholder).slice(0, 200);
      if (f.required) def.required = true;
      if (f.i18n && I18N_CAPABLE_TYPES.includes(type)) def.i18n = true;
      if (f.public === false) def.public = false;
      if (f.width === 'half') def.width = 'half';
      if (typeof f.min === 'number' && Number.isFinite(f.min)) def.min = f.min;
      if (typeof f.max === 'number' && Number.isFinite(f.max)) def.max = f.max;
      if (typeof f.step === 'number' && Number.isFinite(f.step) && f.step > 0) def.step = f.step;
      if (typeof f.rows === 'number' && f.rows > 0) def.rows = Math.min(40, Math.floor(f.rows));
      if (f.itemLabelField) def.itemLabelField = String(f.itemLabelField);
      // entries / terms: giới hạn loại nội dung / taxonomy được chọn
      if (type === 'entries' && typeof f.contentType === 'string' && CONTENT_KEY_RE.test(f.contentType)) def.contentType = f.contentType;
      if (type === 'terms' && typeof f.taxonomy === 'string' && CONTENT_KEY_RE.test(f.taxonomy)) def.taxonomy = f.taxonomy;
      if (type === 'select' || type === 'multiselect') {
        const opts = Array.isArray(f.options) ? f.options : [];
        def.options = opts
          .map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: String((o as { value?: unknown })?.value ?? ''), label: String((o as { label?: unknown })?.label ?? (o as { value?: unknown })?.value ?? '') }))
          .filter((o) => o.value !== '');
        if (!def.options.length) throw new BadRequestException(`Trường "${label}" cần ít nhất một lựa chọn`);
      }
      if (type === 'repeater') {
        def.fields = this.normalizeFieldDefs(f.fields ?? [], true);
        if (!def.fields.length) throw new BadRequestException(`Repeater "${label}" cần ít nhất một trường con`);
      }
      if (f.showIf && typeof f.showIf === 'object') {
        const s = f.showIf as { field?: unknown; equals?: unknown };
        if (s.field && String(s.field) !== key) def.showIf = { field: String(s.field), equals: s.equals };
      }
      if (f.default !== undefined && f.default !== null && f.default !== '') def.default = f.default;
      return def;
    });
  }

  private normalizeRules(input: unknown): FieldGroupRules {
    const r = (input ?? {}) as Record<string, unknown>;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
    const out: FieldGroupRules = {};
    if (arr(r.templates).length) out.templates = arr(r.templates);
    if (arr(r.categoryIds).length) out.categoryIds = arr(r.categoryIds).filter((x) => UUID_RE.test(x));
    if (arr(r.productTypes).length) out.productTypes = arr(r.productTypes);
    if (arr(r.roleSlugs).length) out.roleSlugs = arr(r.roleSlugs);
    // entry: key loại nội dung; term: key taxonomy
    if (arr(r.contentTypes).length) out.contentTypes = arr(r.contentTypes).filter((x) => CONTENT_KEY_RE.test(x));
    if (arr(r.taxonomies).length) out.taxonomies = arr(r.taxonomies).filter((x) => CONTENT_KEY_RE.test(x));
    return out;
  }

  // ======================= Dùng cho module nội dung =======================

  /** Nhóm đang bật của một loại nội dung, đã sắp xếp */
  async groups(entity: CustomFieldEntity): Promise<FieldGroupDef[]> {
    const cached = this.cache.get(entity);
    if (cached) return cached;
    const rows = await this.prisma.fieldGroup.findMany({ where: { entity, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const list = rows.map((r) => this.rowToDef(r)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    this.cache.set(entity, list);
    return list;
  }

  /** Nhóm áp dụng cho một bản ghi cụ thể (theo rules) — dùng cho admin lấy form & public */
  async groupsFor(entity: CustomFieldEntity, ctx?: CustomFieldContext | null) {
    return (await this.groups(entity)).filter((g) => fieldGroupApplies(g.rules, ctx));
  }

  /**
   * Kiểm tra & chuẩn hoá giá trị gửi lên khi lưu bản ghi.
   * - `input === undefined` -> không đụng tới (trả `undefined` để service bỏ qua cột).
   * - Chỉ nhận key thuộc nhóm của entity; key không áp dụng (rules) hoặc không còn định nghĩa vẫn giữ giá trị cũ.
   */
  async sanitize(entity: CustomFieldEntity, input: unknown, ctx: CustomFieldContext | null | undefined, existing: unknown, opts: { user?: AuthUser; id?: string } = {}): Promise<Values | undefined> {
    if (input === undefined) return undefined;
    if (input === null) input = {};
    if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('customFields phải là object { key: value }');
    const incoming = input as Values;
    const base: Values = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Values) } : {};
    const locales = await this.languages.codes();
    const defaultLocale = await this.languages.defaultLocale();
    const applicable = await this.groupsFor(entity, ctx);
    // trường richtext: người không có quyền "content.unfiltered_html" -> lọc XSS trước khi lưu
    // (không truyền user, vd gọi nội bộ / tài khoản tự sửa hồ sơ -> luôn lọc)
    const cleanHtml = canUseUnfilteredHtml(opts.user) ? (s: string) => s : sanitizeRichHtml;
    for (const group of applicable) {
      // trường ẩn theo showIf không bắt buộc, nhưng giá trị vẫn được lưu nếu gửi lên
      const groupValues: Values = {};
      for (const f of group.fields) if (f.key in incoming) groupValues[f.key] = incoming[f.key];
      const merged = { ...Object.fromEntries(group.fields.map((f) => [f.key, base[f.key]])), ...groupValues };
      for (const f of group.fields) {
        if (!(f.key in incoming)) continue;
        const value = this.coerce(f, incoming[f.key], { locales, defaultLocale, cleanHtml });
        if (f.required && customFieldVisible(f, merged) && this.isEmpty(f, value, defaultLocale)) throw new BadRequestException(`Trường "${f.label}" (${group.name}) là bắt buộc`);
        base[f.key] = value;
      }
    }
    return this.hooks.applyFilters('customFields.beforeSave', base, { entity, id: opts.id, user: opts.user, ctx });
  }

  private isEmpty(f: CustomFieldDef, v: unknown, defaultLocale: string) {
    if (v == null) return true;
    if (f.i18n && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (f.type === 'link') return !String((o as { url?: unknown }).url ?? '').trim();
      return !String(o[defaultLocale] ?? '').trim();
    }
    if (typeof v === 'string') return !v.trim();
    if (Array.isArray(v)) return v.length === 0;
    if (f.type === 'link') return !String((v as { url?: unknown }).url ?? '').trim();
    if (f.type === 'boolean') return false;
    return false;
  }

  /** Ép kiểu một giá trị theo định nghĩa trường; ném BadRequest khi sai định dạng */
  private coerce(f: CustomFieldDef, raw: unknown, env: { locales: string[]; defaultLocale: string; /** lọc HTML cho richtext (theo quyền người lưu) */ cleanHtml: (html: string) => string }): unknown {
    const bad = (msg: string) => new BadRequestException(`Trường "${f.label}": ${msg}`);
    const str = (v: unknown, max = MAX_TEXT) => {
      if (v == null) return '';
      if (typeof v === 'object') throw bad('phải là chuỗi');
      const s = String(v);
      if (s.length > max) throw bad(`tối đa ${max} ký tự`);
      return s;
    };
    const i18nStr = (v: unknown, max: number) => {
      if (v == null || v === '') return {};
      if (typeof v === 'string') return { [env.defaultLocale]: str(v, max) };
      if (typeof v !== 'object' || Array.isArray(v)) throw bad('phải là chuỗi hoặc { vi, en }');
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (env.locales.includes(k) && val != null && val !== '') out[k] = str(val, max);
      return out;
    };
    const uuid = (v: unknown) => {
      if (v == null || v === '') return null;
      const s = typeof v === 'object' ? String((v as { id?: unknown }).id ?? '') : String(v);
      if (!UUID_RE.test(s)) throw bad('tham chiếu không hợp lệ');
      return s;
    };
    const uuidList = (v: unknown) => {
      if (v == null || v === '') return [];
      if (!Array.isArray(v)) throw bad('phải là danh sách');
      return [...new Set(v.map(uuid).filter((x): x is string => !!x))].slice(0, 500);
    };
    switch (f.type) {
      case 'text':
      case 'textarea': {
        const max = f.max && f.max > 0 ? Math.min(f.max, MAX_TEXT) : MAX_TEXT;
        return f.i18n ? i18nStr(raw, max) : str(raw, max).trim();
      }
      case 'richtext': {
        // lọc sau khi kiểm độ dài; bản đa ngôn ngữ lọc từng ngôn ngữ (gồm cả richtext trong repeater vì đi qua đây)
        if (!f.i18n) return env.cleanHtml(str(raw, MAX_RICHTEXT));
        return Object.fromEntries(Object.entries(i18nStr(raw, MAX_RICHTEXT)).map(([k, v]) => [k, env.cleanHtml(v)]));
      }
      case 'url': {
        const s = str(raw, 2048).trim();
        if (s && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(s)) throw bad('URL phải bắt đầu bằng http(s):// hoặc /');
        return s;
      }
      case 'email': {
        const s = str(raw, 320).trim();
        if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('email không hợp lệ');
        return s;
      }
      case 'color': {
        const s = str(raw, 32).trim();
        if (s && !/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) && !/^(rgb|hsl)a?\(/i.test(s)) throw bad('màu không hợp lệ (vd #ff6600)');
        return s;
      }
      case 'number': {
        if (raw == null || raw === '') return null;
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
        if (!Number.isFinite(n)) throw bad('phải là số');
        if (f.min != null && n < f.min) throw bad(`không nhỏ hơn ${f.min}`);
        if (f.max != null && n > f.max) throw bad(`không lớn hơn ${f.max}`);
        return n;
      }
      case 'boolean':
        return raw === true || raw === 'true' || raw === 1 || raw === '1';
      case 'select': {
        if (raw == null || raw === '') return null;
        const s = String(raw);
        if (!f.options?.some((o) => o.value === s)) throw bad('giá trị không nằm trong danh sách');
        return s;
      }
      case 'multiselect': {
        if (raw == null || raw === '') return [];
        const list = Array.isArray(raw) ? raw : [raw];
        const out = [...new Set(list.map(String))];
        for (const s of out) if (!f.options?.some((o) => o.value === s)) throw bad(`giá trị "${s}" không nằm trong danh sách`);
        return out;
      }
      case 'date': {
        if (raw == null || raw === '') return null;
        const s = String(raw);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) throw bad('ngày không hợp lệ');
        return d.toISOString().slice(0, 10);
      }
      case 'datetime': {
        if (raw == null || raw === '') return null;
        const d = new Date(String(raw));
        if (Number.isNaN(d.getTime())) throw bad('ngày giờ không hợp lệ');
        return d.toISOString();
      }
      case 'image':
      case 'file':
      case 'post_category':
      case 'product_category':
        return uuid(raw);
      case 'gallery':
      case 'products':
      case 'posts':
      case 'pages':
      case 'entries':
      case 'terms':
        return uuidList(raw);
      case 'link': {
        if (raw == null || raw === '') return { label: f.i18n ? {} : '', url: '', target: '_self' };
        if (typeof raw !== 'object') throw bad('phải là { label, url, target }');
        const o = raw as { label?: unknown; url?: unknown; target?: unknown };
        const url = str(o.url, 2048).trim();
        if (url && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(url)) throw bad('URL phải bắt đầu bằng http(s):// hoặc /');
        return { label: f.i18n ? i18nStr(o.label, 500) : str(o.label, 500).trim(), url, target: o.target === '_blank' ? '_blank' : '_self' };
      }
      case 'repeater': {
        if (raw == null || raw === '') return [];
        if (!Array.isArray(raw)) throw bad('phải là danh sách mục');
        const max = f.max && f.max > 0 ? Math.min(f.max, MAX_REPEATER_ITEMS) : MAX_REPEATER_ITEMS;
        if (raw.length > max) throw bad(`tối đa ${max} mục`);
        return raw.map((item, i) => {
          const src = (item && typeof item === 'object' ? item : {}) as Values;
          const out: Values = {};
          for (const sf of f.fields ?? []) {
            const v = this.coerce(sf, src[sf.key], env);
            if (sf.required && customFieldVisible(sf, src) && this.isEmpty(sf, v, env.defaultLocale)) throw bad(`mục ${i + 1} thiếu "${sf.label}"`);
            out[sf.key] = v;
          }
          // giữ _key do admin sinh để React không mất focus khi sắp xếp lại
          if (typeof src._key === 'string') out._key = src._key.slice(0, 40);
          return out;
        });
      }
      case 'json': {
        if (raw == null || raw === '') return null;
        let v = raw;
        if (typeof raw === 'string') {
          try {
            v = JSON.parse(raw);
          } catch {
            throw bad('JSON không hợp lệ');
          }
        }
        if (JSON.stringify(v).length > MAX_JSON_BYTES) throw bad('JSON quá lớn');
        return v;
      }
      default:
        return raw;
    }
  }

  // ======================= Trình bày public =======================

  /**
   * Trả `{ customFields, customFieldGroups }` cho API public: chọn ngôn ngữ, bỏ trường nội bộ (public=false),
   * đổi id media / sản phẩm / bài viết / danh mục thành object. Chỉ gồm nhóm áp dụng theo ctx.
   */
  async present(entity: CustomFieldEntity, values: unknown, locale: string, fallback: string, ctx?: CustomFieldContext | null): Promise<{ customFields: Values; customFieldGroups: PublicFieldGroup[] }> {
    const raw: Values = values && typeof values === 'object' && !Array.isArray(values) ? (values as Values) : {};
    const groups = (await this.groupsFor(entity, ctx)).map((g) => ({ ...g, fields: g.fields.filter((f) => f.public !== false) })).filter((g) => g.fields.length);
    if (!groups.length) return { customFields: {}, customFieldGroups: [] };
    // Vòng 1: gom id cần nạp
    const refs: RefBag = { media: new Set(), products: new Set(), posts: new Set(), pages: new Set(), postCategories: new Set(), productCategories: new Set(), entries: new Set(), terms: new Set() };
    for (const g of groups) for (const f of g.fields) this.collectRefs(f, raw[f.key], refs);
    const loaded = await this.loadRefs(refs, locale, fallback);
    // Vòng 2: dựng giá trị
    const customFields: Values = {};
    for (const g of groups) for (const f of g.fields) customFields[f.key] = this.presentValue(f, raw[f.key], locale, fallback, loaded);
    const customFieldGroups: PublicFieldGroup[] = groups.map((g) => ({
      key: g.key,
      name: g.name,
      placement: g.placement ?? 'main',
      fields: g.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}), ...(f.fields ? { fields: f.fields.filter((s) => s.public !== false).map((s) => ({ key: s.key, label: s.label, type: s.type })) } : {}) })),
    }));
    return this.hooks.applyFilters('customFields.public', { customFields, customFieldGroups }, { entity, locale, ctx });
  }

  private collectRefs(f: CustomFieldDef, v: unknown, refs: RefBag) {
    if (v == null) return;
    const add = (set: Set<string>, x: unknown) => {
      if (typeof x === 'string' && UUID_RE.test(x)) set.add(x);
    };
    switch (f.type) {
      case 'image':
      case 'file':
        return add(refs.media, v);
      case 'gallery':
        return Array.isArray(v) && v.forEach((x) => add(refs.media, x));
      case 'products':
        return Array.isArray(v) && v.forEach((x) => add(refs.products, x));
      case 'posts':
        return Array.isArray(v) && v.forEach((x) => add(refs.posts, x));
      case 'pages':
        return Array.isArray(v) && v.forEach((x) => add(refs.pages, x));
      case 'entries':
        return Array.isArray(v) && v.forEach((x) => add(refs.entries, x));
      case 'terms':
        return Array.isArray(v) && v.forEach((x) => add(refs.terms, x));
      case 'post_category':
        return add(refs.postCategories, v);
      case 'product_category':
        return add(refs.productCategories, v);
      case 'repeater':
        if (Array.isArray(v)) for (const item of v) for (const sf of f.fields ?? []) this.collectRefs(sf, (item as Values)?.[sf.key], refs);
        return;
      default:
        return;
    }
  }

  private async loadRefs(refs: RefBag, locale: string, fallback: string) {
    const pickTr = <T extends { locale: string }>(list: T[]) => list.find((x) => x.locale === locale) ?? list.find((x) => x.locale === fallback) ?? list[0];
    const [media, products, posts, pages, postCats, productCats, entries, terms] = await Promise.all([
      refs.media.size ? this.media.findMany([...refs.media]) : new Map(),
      refs.products.size ? this.prisma.product.findMany({ where: { id: { in: [...refs.products] }, ...publishedProductWhere() }, include: PRODUCT_CARD_INCLUDE }) : [],
      refs.posts.size ? this.prisma.post.findMany({ where: { id: { in: [...refs.posts] }, ...publishedPostWhere() }, include: POST_CARD_INCLUDE }) : [],
      refs.pages.size ? this.prisma.page.findMany({ where: { id: { in: [...refs.pages] }, deletedAt: null, ...publishedCondition() }, include: { translations: { select: { locale: true, title: true, slug: true } } } }) : [],
      refs.postCategories.size ? this.prisma.postCategory.findMany({ where: { id: { in: [...refs.postCategories] } }, include: { translations: { select: { locale: true, name: true, slug: true } } } }) : [],
      refs.productCategories.size ? this.prisma.productCategory.findMany({ where: { id: { in: [...refs.productCategories] }, isActive: true }, include: { translations: { select: { locale: true, name: true, slug: true } } } }) : [],
      refs.entries.size ? this.prisma.entry.findMany({ where: { id: { in: [...refs.entries] }, ...publishedEntryWhere() }, include: ENTRY_CARD_INCLUDE }) : [],
      refs.terms.size ? this.prisma.term.findMany({ where: { id: { in: [...refs.terms] } }, include: { translations: { select: { locale: true, name: true, slug: true } }, taxonomy: { select: { key: true, slugs: true, isPublic: true } } } }) : [],
    ]);
    const cardMedia = await this.media.findMany([...products.flatMap((p) => [p.featuredImageId, p.galleryIds[0]]), ...posts.map((p) => p.featuredImageId), ...entries.map((e) => e.featuredImageId)]);
    const env = { locale, defaultLocale: fallback };
    return {
      media: media as Map<string, unknown>,
      products: new Map(products.map((p) => [p.id, presentProductCard(p, locale, fallback, cardMedia)])),
      posts: new Map(posts.map((p) => [p.id, presentPostCard(p, locale, fallback, cardMedia)])),
      pages: new Map(pages.map((p) => [p.id, { id: p.id, title: pickTr(p.translations)?.title ?? '', slug: pickTr(p.translations)?.slug ?? '' }])),
      postCategories: new Map(postCats.map((c) => [c.id, { id: c.id, name: pickTr(c.translations)?.name ?? '', slug: pickTr(c.translations)?.slug ?? '' }])),
      productCategories: new Map(productCats.map((c) => [c.id, { id: c.id, name: pickTr(c.translations)?.name ?? '', slug: pickTr(c.translations)?.slug ?? '' }])),
      // thẻ bài rút gọn (không trình bày trường tuỳ chỉnh lồng nhau để tránh đệ quy)
      entries: new Map(entries.map((e) => [e.id, presentEntryCard(e, env, cardMedia as Map<string, unknown>)])),
      terms: new Map(
        terms.map((t) => {
          const tr = pickTr(t.translations);
          return [t.id, { id: t.id, taxonomy: t.taxonomy.key, name: tr?.name ?? '', slug: tr?.slug ?? '', path: termPath(t.taxonomy, tr?.slug ?? '', env) }];
        }),
      ),
    };
  }

  private presentValue(f: CustomFieldDef, raw: unknown, locale: string, fallback: string, loaded: Awaited<ReturnType<CustomFieldsService['loadRefs']>>): unknown {
    // chưa nhập -> dùng giá trị mặc định của trường (admin cũng hiển thị mặc định khi chưa có giá trị)
    const v = raw === undefined && f.default !== undefined ? f.default : raw;
    const text = (x: unknown) => (f.i18n || (x && typeof x === 'object' && !Array.isArray(x)) ? pickI18n(x as Record<string, string>, locale, fallback) : (x ?? ''));
    const mapIds = (map: Map<string, unknown>, list: unknown) => (Array.isArray(list) ? list.map((id) => map.get(String(id))).filter(Boolean) : []);
    switch (f.type) {
      case 'text':
      case 'textarea':
      case 'richtext':
        return text(v);
      case 'image':
      case 'file':
        return v ? (loaded.media.get(String(v)) ?? null) : null;
      case 'gallery':
        return mapIds(loaded.media, v);
      case 'products':
        return mapIds(loaded.products, v);
      case 'posts':
        return mapIds(loaded.posts, v);
      case 'pages':
        return mapIds(loaded.pages, v);
      case 'entries':
        // chỉ giữ bài đúng loại nội dung đã khai báo cho trường (nếu có)
        return mapIds(loaded.entries, v).filter((e) => !f.contentType || (e as { type?: string }).type === f.contentType);
      case 'terms':
        return mapIds(loaded.terms, v)
          .filter((t) => !f.taxonomy || (t as { taxonomy?: string }).taxonomy === f.taxonomy)
          .map((t) => {
            const { taxonomy: _t, ...rest } = t as { taxonomy?: string; id: string; name: string; slug: string; path: string | null };
            return rest;
          });
      case 'post_category':
        return v ? (loaded.postCategories.get(String(v)) ?? null) : null;
      case 'product_category':
        return v ? (loaded.productCategories.get(String(v)) ?? null) : null;
      case 'link': {
        const o = (v ?? {}) as { label?: unknown; url?: string; target?: string };
        return { label: pickI18n(o.label as Record<string, string>, locale, fallback), url: o.url ?? '', target: o.target ?? '_self' };
      }
      case 'repeater':
        return Array.isArray(v)
          ? v.map((item) => {
              const out: Values = {};
              for (const sf of (f.fields ?? []).filter((s) => s.public !== false)) out[sf.key] = this.presentValue(sf, (item as Values)?.[sf.key], locale, fallback, loaded);
              return out;
            })
          : [];
      case 'number':
        return typeof v === 'number' ? v : v == null || v === '' ? null : Number(v);
      case 'boolean':
        return !!v;
      default:
        return v ?? null;
    }
  }

  /**
   * Điều kiện lọc Prisma cho API public từ query `cf[key]=value` (vd ?cf[platform]=netflix&cf[level]=beginner).
   * Chỉ chấp nhận trường public kiểu select/text/number/boolean/multiselect của entity; giá trị "a,b" = một trong.
   */
  async publicFilter(entity: CustomFieldEntity, cf: unknown): Promise<CfJsonFilter[]> {
    if (!cf || typeof cf !== 'object') return [];
    const defs = new Map<string, CustomFieldDef>();
    for (const g of await this.groups(entity)) for (const f of g.fields) if (f.public !== false && !f.i18n) defs.set(f.key, f);
    const out: CfJsonFilter[] = [];
    for (const [key, rawVal] of Object.entries(cf as Record<string, unknown>).slice(0, 10)) {
      const def = defs.get(key);
      if (!def || rawVal == null || rawVal === '') continue;
      const values = String(rawVal).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (!values.length) continue;
      const toTyped = (s: string): unknown => (def.type === 'number' ? Number(s) : def.type === 'boolean' ? s === '1' || s === 'true' : s);
      switch (def.type) {
        case 'select':
        case 'text':
        case 'number':
        case 'boolean':
          // nhiều giá trị -> OR, service gọi sẽ bọc vào where.AND/OR
          out.push(...values.map((s) => ({ path: [key], equals: toTyped(s) })));
          break;
        case 'multiselect':
          out.push(...values.map((s) => ({ path: [key], array_contains: [s] })));
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** Gom các JsonFilter của cùng một trường thành OR, các trường khác nhau thành AND (dùng với cột customFields) */
  async publicWhere<T extends { customFields?: unknown; OR?: unknown[] }>(entity: CustomFieldEntity, cf: unknown): Promise<T[]> {
    const filters = await this.publicFilter(entity, cf);
    const byKey = new Map<string, CfJsonFilter[]>();
    for (const f of filters) {
      const k = f.path[0];
      byKey.set(k, [...(byKey.get(k) ?? []), f]);
    }
    return [...byKey.values()].map((list) => (list.length === 1 ? ({ customFields: list[0] } as T) : ({ OR: list.map((f) => ({ customFields: f })) } as T)));
  }
}
