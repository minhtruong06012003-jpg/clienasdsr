import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TEMPLATE_KINDS,
  type BlockNode as SharedBlockNode,
  type RenderedTemplate,
  type TemplateIndexItem,
  type TemplateKind,
  type ThemeTemplateView,
} from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { BlockResolverService } from '../blocks/block-resolver.service.js';
import { cleanBlocksFor } from '../../common/utils/sanitize-html.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { TemplateContextService } from './template-context.service.js';
import { rankTemplates, readConditions, type MatchSubject } from './template-match.js';
import type { ThemeTemplate, ThemeTemplateTranslation } from '../../generated/prisma/client.js';

/** Target hợp lệ của mẫu */
export const TEMPLATE_TARGET_RE = /^(\*|page|post|product|post_category|post_tag|product_category|entry:[a-z][a-z0-9_]{1,39}|term:[a-z][a-z0-9_]{1,39})$/;

export interface SaveTemplateInput {
  name: string;
  kind: string;
  target?: string;
  conditions?: unknown;
  priority?: number;
  isActive?: boolean;
  translations?: { locale: string; blocks: unknown[] }[];
}

export interface RenderQuery {
  kind: string;
  target?: string;
  id?: string;
  slug?: string;
  locale?: string;
  page?: string | number;
  termSlug?: string;
  q?: string;
}

export interface TargetOption {
  value: string;
  label: string;
  group: string;
}

type Row = ThemeTemplate & { translations?: ThemeTemplateTranslation[] };

/**
 * Theme Builder: mẫu giao diện (single / archive / header / footer / search / 404) dựng bằng Page Builder.
 * Storefront hỏi `render` để lấy mẫu khớp với trang đang xem, block động được gắn dữ liệu bản ghi / danh sách.
 */
@Injectable()
export class ThemeTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly hooks: HooksService,
    private readonly resolver: BlockResolverService,
    private readonly context: TemplateContextService,
    private readonly events: EventEmitter2,
  ) {}

  // ------------------------------------------------------------------ trình bày

  private view(r: Row): ThemeTemplateView {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as TemplateKind,
      target: r.target,
      conditions: readConditions(r.conditions),
      priority: r.priority,
      isActive: r.isActive,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      ...(r.translations ? { translations: r.translations.map((t) => ({ locale: t.locale, blocks: (Array.isArray(t.blocks) ? t.blocks : []) as unknown as SharedBlockNode[] })) } : {}),
    };
  }

  /** Mẫu đang bật (không kèm blocks) — gửi trong bootstrap để storefront biết khi nào gọi render */
  async index(): Promise<TemplateIndexItem[]> {
    const rows = await this.prisma.themeTemplate.findMany({ where: { isActive: true }, orderBy: [{ kind: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }] });
    return rows.map((r) => ({ id: r.id, kind: r.kind as TemplateKind, target: r.target, conditions: readConditions(r.conditions), priority: r.priority }));
  }

  // ------------------------------------------------------------------ CRUD (admin)

  async list(kind?: string): Promise<ThemeTemplateView[]> {
    const rows = await this.prisma.themeTemplate.findMany({ where: kind ? { kind } : undefined, orderBy: [{ kind: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }] });
    return rows.map((r) => this.view(r));
  }

  async get(id: string): Promise<ThemeTemplateView> {
    const row = await this.prisma.themeTemplate.findUnique({ where: { id }, include: { translations: true } });
    if (!row) throw new NotFoundException('Không tìm thấy mẫu giao diện');
    return this.view(row);
  }

  /** Kiểm tra + chuẩn hoá dữ liệu lưu */
  private normalize(dto: SaveTemplateInput) {
    if (!TEMPLATE_KINDS.includes(dto.kind as TemplateKind)) throw new BadRequestException('Loại mẫu không hợp lệ');
    const target = (dto.target ?? '*').trim() || '*';
    if (!TEMPLATE_TARGET_RE.test(target)) throw new BadRequestException(`Đối tượng áp dụng "${target}" không hợp lệ`);
    if (dto.kind === 'single' && target === 'post_category') throw new BadRequestException('Mẫu chi tiết không áp cho chuyên mục — dùng mẫu lưu trữ');
    return {
      name: dto.name.trim(),
      kind: dto.kind,
      target,
      conditions: readConditions(dto.conditions) as object,
      priority: Number.isFinite(Number(dto.priority)) ? Math.trunc(Number(dto.priority)) : 0,
      isActive: dto.isActive,
    };
  }

  /**
   * `actor`: người lưu — không có quyền "content.unfiltered_html" thì block của mẫu (richtext, HTML tuỳ chỉnh...)
   * bị lọc XSS trước khi lưu; không truyền (gọi nội bộ) -> luôn lọc.
   */
  async create(dto: SaveTemplateInput, actor?: AuthUser | null) {
    const actorId = actor?.id;
    const data = this.normalize(dto);
    const codes = await this.languages.codes();
    const row = await this.prisma.themeTemplate.create({
      data: {
        ...data,
        isActive: data.isActive ?? true,
        translations: { create: (dto.translations ?? []).filter((t) => codes.includes(t.locale)).map((t) => ({ locale: t.locale, blocks: cleanBlocksFor(actor, t.blocks ?? []) as object })) },
      },
    });
    this.changed(row.id, actorId, 'theme_template.create', row.name);
    return this.get(row.id);
  }

  async update(id: string, dto: SaveTemplateInput, actor?: AuthUser | null) {
    const actorId = actor?.id;
    await this.get(id);
    const data = this.normalize(dto);
    const codes = await this.languages.codes();
    await this.prisma.$transaction(async (tx) => {
      await tx.themeTemplate.update({ where: { id }, data });
      for (const t of (dto.translations ?? []).filter((x) => codes.includes(x.locale))) {
        const blocks = cleanBlocksFor(actor, t.blocks ?? []) as object;
        await tx.themeTemplateTranslation.upsert({
          where: { templateId_locale: { templateId: id, locale: t.locale } },
          create: { templateId: id, locale: t.locale, blocks },
          update: { blocks },
        });
      }
    });
    this.changed(id, actorId, 'theme_template.update', data.name);
    return this.get(id);
  }

  async duplicate(id: string, actor?: AuthUser | null) {
    const actorId = actor?.id;
    const src = await this.prisma.themeTemplate.findUnique({ where: { id }, include: { translations: true } });
    if (!src) throw new NotFoundException('Không tìm thấy mẫu giao diện');
    // bản sao tắt sẵn để không đè mẫu đang dùng
    const row = await this.prisma.themeTemplate.create({
      data: {
        name: `${src.name} (bản sao)`,
        kind: src.kind,
        target: src.target,
        conditions: (src.conditions ?? {}) as object,
        priority: src.priority,
        isActive: false,
        source: 'admin',
        translations: { create: src.translations.map((t) => ({ locale: t.locale, blocks: cleanBlocksFor(actor, t.blocks) as object })) },
      },
    });
    this.changed(row.id, actorId, 'theme_template.duplicate', row.name);
    return this.get(row.id);
  }

  async remove(id: string, actorId?: string | null) {
    const row = await this.prisma.themeTemplate.delete({ where: { id } }).catch(() => null);
    if (!row) throw new NotFoundException('Không tìm thấy mẫu giao diện');
    this.changed(id, actorId, 'theme_template.delete', row.name);
    return { success: true };
  }

  private changed(id: string, actorId: string | null | undefined, action: string, name: string) {
    this.events.emit('content.changed', { type: 'theme_template', id, tags: ['theme-templates', 'bootstrap'] });
    this.events.emit('activity', { userId: actorId ?? null, action, entityType: 'theme_template', entityId: id, meta: { name } });
  }

  // ------------------------------------------------------------------ đối tượng áp dụng

  /** Danh sách target cho ô chọn của builder (nhãn tiếng Việt, theo nhóm) */
  async targets(kind?: string): Promise<TargetOption[]> {
    const [types, taxes] = await Promise.all([this.context.contentTypes(), this.context.taxonomies()]);
    const vi = await this.languages.defaultLocale();
    const typeLabel = (t: { key: string; labels: unknown }) => this.context.label(t, 'vi', vi);
    const single: TargetOption[] = [
      { value: 'page', label: 'Trang', group: 'Trang & Blog' },
      { value: 'post', label: 'Bài viết', group: 'Trang & Blog' },
      { value: 'product', label: 'Sản phẩm', group: 'Bán hàng' },
      ...types.map((t) => ({ value: `entry:${t.key}`, label: typeLabel(t), group: 'Loại nội dung' })),
    ];
    const archive: TargetOption[] = [
      { value: 'post', label: 'Trang blog (tất cả bài viết)', group: 'Trang & Blog' },
      { value: 'post_category', label: 'Chuyên mục bài viết', group: 'Trang & Blog' },
      { value: 'post_tag', label: 'Thẻ bài viết', group: 'Trang & Blog' },
      { value: 'product', label: 'Cửa hàng (tất cả sản phẩm)', group: 'Bán hàng' },
      { value: 'product_category', label: 'Danh mục sản phẩm', group: 'Bán hàng' },
      ...types.filter((t) => t.hasArchive).map((t) => ({ value: `entry:${t.key}`, label: `Lưu trữ: ${typeLabel(t)}`, group: 'Loại nội dung' })),
      ...taxes.map((t) => ({ value: `term:${t.key}`, label: this.context.label(t, 'vi', vi), group: 'Phân loại' })),
    ];
    const all: TargetOption = { value: '*', label: 'Toàn website', group: 'Chung' };
    const dedupe = (list: TargetOption[]) => list.filter((x, i) => list.findIndex((y) => y.value === x.value) === i);
    switch (kind) {
      case 'single':
        return single;
      case 'archive':
        return archive;
      case 'search':
        return [
          { value: '*', label: 'Mọi loại nội dung', group: 'Chung' },
          { value: 'post', label: 'Bài viết', group: 'Trang & Blog' },
          { value: 'product', label: 'Sản phẩm', group: 'Bán hàng' },
          ...types.map((t) => ({ value: `entry:${t.key}`, label: typeLabel(t), group: 'Loại nội dung' })),
        ];
      case 'not_found':
        return [all];
      default:
        // header / footer / không lọc: mọi target (áp khi đang xem đối tượng đó)
        return dedupe([all, ...single, ...archive]);
    }
  }

  /** Dữ liệu mẫu cho builder: record / listing của target (không id → bản ghi mới nhất) */
  async previewContext(input: { target: string; id?: string; locale?: string; kind?: string; q?: string }) {
    if (!TEMPLATE_TARGET_RE.test(input.target)) throw new BadRequestException('Đối tượng áp dụng không hợp lệ');
    const c = await this.context.build({ kind: input.kind, target: input.target, id: input.id, q: input.q, locale: input.locale, admin: true });
    const strip = (r: typeof c.record) => {
      if (!r) return null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { blocks, customFieldGroups, termIds, ...rest } = r;
      return rest;
    };
    return { record: strip(c.record), listing: c.listing };
  }

  // ------------------------------------------------------------------ render (public)

  /**
   * Chọn mẫu khớp trang đang xem rồi resolve blocks với ngữ cảnh bản ghi / danh sách.
   * Trả null khi không có mẫu nào khớp (storefront dùng giao diện mặc định).
   */
  async render(q: RenderQuery): Promise<RenderedTemplate | null> {
    const kind = String(q.kind ?? '');
    if (!TEMPLATE_KINDS.includes(kind as TemplateKind)) throw new BadRequestException('kind không hợp lệ');
    const target = q.target && TEMPLATE_TARGET_RE.test(q.target) ? q.target : '*';
    const candidates = await this.prisma.themeTemplate.findMany({ where: { kind, isActive: true, target: { in: [...new Set([target, '*'])] } } });
    if (!candidates.length) return null;

    // chỉ dựng ngữ cảnh khi có mẫu ứng viên (tránh truy vấn thừa)
    const c = await this.context.build({ kind, target, id: q.id, slug: q.slug, locale: q.locale, page: Number(q.page) || 1, termSlug: q.termSlug, q: q.q });
    // single cần bản ghi tồn tại; không có → storefront tự xử lý 404
    if (kind === 'single' && !c.record) return null;
    const recordId = c.record?.id || null;
    const subject: MatchSubject = { kind, target, id: recordId, termIds: c.record?.termIds ?? [] };
    const ranked = rankTemplates(candidates, subject);
    // module khác có thể đổi mẫu được chọn qua filter (trả null = không dùng mẫu)
    const picked = await this.hooks.applyFilters('template.match', ranked[0]?.template ?? null, {
      kind,
      target,
      id: recordId,
      locale: c.locale,
      candidates: ranked.map((x) => ({ id: x.template.id, name: x.template.name, score: x.score, priority: x.template.priority })),
    });
    if (!picked) return null;
    const tpl = candidates.find((x) => x.id === picked.id) ?? picked;

    const translations = await this.prisma.themeTemplateTranslation.findMany({ where: { templateId: tpl.id } });
    const tr = translations.find((t) => t.locale === c.locale) ?? translations.find((t) => t.locale === c.fallback) ?? translations[0];
    const blocks = await this.resolver.resolve(tr?.blocks ?? [], c.locale, 0, 'view', {
      entity: c.record?.entity,
      record: c.record,
      listing: c.listing,
      page: c.page,
      customFields: c.record?.customFields,
      customFieldGroups: c.record?.customFieldGroups,
    });
    return { id: tpl.id, name: tpl.name, kind: tpl.kind as TemplateKind, blocks: blocks as unknown as SharedBlockNode[] };
  }
}
