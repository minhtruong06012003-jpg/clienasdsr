import { Body, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { buildPath, CORE_MENU_LOCATIONS, t, type ContentType, type MenuItemNode, type MenuLocationDef } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { publishedCondition } from '../../common/utils/publish.util.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { TemplateContextService } from '../theme-templates/template-context.service.js';
import { ThemeCapabilitiesService } from '../theme-templates/theme-capabilities.service.js';
import { ThemeTemplatesModule } from '../theme-templates/theme-templates.module.js';

/**
 * Mục menu: kiểu lõi (MenuItemNode) + kiểu mới cho nội dung tuỳ biến
 * - entry: refId = id bài; term: refId = id term; content_type_archive: refId = key loại nội dung
 * (khai báo cục bộ vì kiểu dùng chung trong @cmsnt/shared chưa có các type này)
 */
type MenuItemInput = Omit<MenuItemNode, 'children'> & { children: MenuItemInput[] };

const UUID_RE = /^[0-9a-f-]{36}$/i;

class SaveMenuDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() location?: string | null;
  @IsArray() items: MenuItemInput[];
}

/** Vị trí menu lõi (giữ tên cũ để tương thích); vị trí đầy đủ = lõi + theme, xem MenusService.locations() */
export const MENU_LOCATIONS: MenuLocationDef[] = CORE_MENU_LOCATIONS;

export interface ResolvedMenuItem {
  id: string;
  label: string;
  url: string;
  target: string;
  icon?: string | null;
  cssClass?: string | null;
  type: string;
  children: ResolvedMenuItem[];
}

@Injectable()
export class MenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly events: EventEmitter2,
    private readonly templateData: TemplateContextService,
    private readonly theme: ThemeCapabilitiesService,
  ) {}

  /** Vị trí menu: lõi + theme storefront khai báo (capabilities.theme.menuLocations) */
  async locations(): Promise<MenuLocationDef[]> {
    const out: MenuLocationDef[] = CORE_MENU_LOCATIONS.map((l) => ({ ...l }));
    for (const l of await this.theme.menuLocations()) if (!out.some((x) => x.key === l.key)) out.push({ key: l.key, label: l.label, source: 'theme' });
    return out;
  }

  list() {
    return this.prisma.menu.findMany({ orderBy: { createdAt: 'asc' } });
  }

  get(id: string) {
    return this.prisma.menu.findUniqueOrThrow({ where: { id } });
  }

  async save(id: string | undefined, dto: SaveMenuDto, actorId?: string | null) {
    const isNew = !id;
    const data = { name: dto.name, location: dto.location || null, items: dto.items as object };
    await this.prisma.$transaction(async (tx) => {
      // mỗi vị trí chỉ gán cho một menu
      if (data.location) await tx.menu.updateMany({ where: { location: data.location, ...(id ? { NOT: { id } } : {}) }, data: { location: null } });
      if (id) await tx.menu.update({ where: { id }, data });
      else id = (await tx.menu.create({ data })).id;
    });
    this.events.emit('content.changed', { type: 'menu', tags: ['menus'] });
    this.events.emit('activity', { userId: actorId ?? null, action: isNew ? 'menu.create' : 'menu.update', entityType: 'menu', entityId: id, meta: { name: dto.name, location: data.location } });
    return this.get(id!);
  }

  async remove(id: string, actorId?: string | null) {
    const menu = await this.prisma.menu.delete({ where: { id } });
    this.events.emit('content.changed', { type: 'menu', tags: ['menus'] });
    this.events.emit('activity', { userId: actorId ?? null, action: 'menu.delete', entityType: 'menu', entityId: id, meta: { name: menu.name, location: menu.location } });
    return { success: true };
  }

  /** Tìm slug của các nội dung được tham chiếu trong menu, theo locale */
  private async slugMap(items: MenuItemInput[], locale: string, fallback: string) {
    const ids: Record<string, Set<string>> = {};
    const walk = (list: MenuItemInput[]) =>
      list.forEach((i) => {
        if (i.refId && /^[0-9a-f-]{36}$/i.test(i.refId)) (ids[i.type] ??= new Set()).add(i.refId);
        walk(i.children ?? []);
      });
    walk(items);
    const map = new Map<string, string>();
    const pick = (trs: { locale: string; slug: string }[]) => (trs.find((x) => x.locale === locale) ?? trs.find((x) => x.locale === fallback))?.slug;
    const load = async <T extends { id: string; translations: { locale: string; slug: string }[] }>(type: string, rows: Promise<T[]>) => {
      for (const r of await rows) {
        const slug = pick(r.translations);
        if (slug) map.set(`${type}:${r.id}`, slug);
      }
    };
    const sel = { id: true, translations: { select: { locale: true, slug: true } } } as const;
    const tasks: Promise<void>[] = [];
    const live = { deletedAt: null, ...publishedCondition() };
    if (ids.page) tasks.push(load('page', this.prisma.page.findMany({ where: { id: { in: [...ids.page] }, ...live }, select: sel })));
    if (ids.post) tasks.push(load('post', this.prisma.post.findMany({ where: { id: { in: [...ids.post] }, ...live }, select: sel })));
    if (ids.product) tasks.push(load('product', this.prisma.product.findMany({ where: { id: { in: [...ids.product] }, ...live }, select: sel })));
    if (ids.post_category) tasks.push(load('post_category', this.prisma.postCategory.findMany({ where: { id: { in: [...ids.post_category] } }, select: sel })));
    if (ids.product_category) tasks.push(load('product_category', this.prisma.productCategory.findMany({ where: { id: { in: [...ids.product_category] }, isActive: true }, select: sel })));
    await Promise.all(tasks);
    return map;
  }

  /**
   * URL + nhãn cho mục menu nội dung tuỳ biến (entry / term / content_type_archive) theo locale.
   * key: "<type>:<refId>" → { url, label }
   */
  private async customRefs(items: MenuItemInput[], locale: string, fallback: string) {
    const entryIds = new Set<string>();
    const termIds = new Set<string>();
    const archives = new Set<string>();
    const walk = (list: MenuItemInput[]) =>
      list.forEach((i) => {
        if (i.refId) {
          if (i.type === 'entry' && UUID_RE.test(i.refId)) entryIds.add(i.refId);
          if (i.type === 'term' && UUID_RE.test(i.refId)) termIds.add(i.refId);
          if (i.type === 'content_type_archive') archives.add(i.refId);
        }
        walk(i.children ?? []);
      });
    walk(items);
    const out = new Map<string, { url: string; label: string }>();
    if (!entryIds.size && !termIds.size && !archives.size) return out;
    const pick = <T extends { locale: string }>(trs: T[]) => trs.find((x) => x.locale === locale) ?? trs.find((x) => x.locale === fallback);
    const [types, taxes] = await Promise.all([this.templateData.contentTypes(), this.templateData.taxonomies()]);
    if (entryIds.size) {
      const rows = await this.prisma.entry.findMany({
        where: { id: { in: [...entryIds] }, deletedAt: null, ...publishedCondition() },
        select: { id: true, typeId: true, translations: { select: { locale: true, slug: true, title: true } } },
      });
      for (const r of rows) {
        const type = types.find((x) => x.id === r.typeId);
        const tr = pick(r.translations);
        const url = type && tr ? this.templateData.entryPath(type, tr.slug, locale, fallback) : null;
        if (url && tr) out.set(`entry:${r.id}`, { url, label: tr.title });
      }
    }
    if (termIds.size) {
      const rows = await this.prisma.term.findMany({ where: { id: { in: [...termIds] } }, select: { id: true, taxonomyId: true, translations: { select: { locale: true, slug: true, name: true } } } });
      for (const r of rows) {
        const tax = taxes.find((x) => x.id === r.taxonomyId);
        const tr = pick(r.translations);
        const url = tax && tr ? this.templateData.termPath(tax, tr.slug, locale, fallback) : null;
        if (url && tr) out.set(`term:${r.id}`, { url, label: tr.name });
      }
    }
    for (const key of archives) {
      const type = types.find((x) => x.key === key);
      const url = type ? this.templateData.archivePath(type, locale, fallback) : null;
      if (type && url) out.set(`content_type_archive:${key}`, { url, label: this.templateData.label(type, locale, fallback) });
    }
    return out;
  }

  async resolveItems(items: MenuItemInput[], localeInput?: string): Promise<ResolvedMenuItem[]> {
    const locale = await this.languages.resolve(localeInput);
    const fallback = await this.languages.defaultLocale();
    const [slugs, refs] = await Promise.all([this.slugMap(items, locale, fallback), this.customRefs(items, locale, fallback)]);
    const map = (list: MenuItemInput[]): ResolvedMenuItem[] =>
      list
        .map((i): ResolvedMenuItem | null => {
          let url = i.url ?? '#';
          if (i.type === 'home') url = buildPath('home', null, locale, fallback);
          else if (i.type === 'entry' || i.type === 'term' || i.type === 'content_type_archive') {
            // nội dung tuỳ biến: không còn / chưa xuất bản / không public → ẩn mục
            const ref = i.refId ? refs.get(`${i.type}:${i.refId}`) : undefined;
            if (!ref) return null;
            const label = t(i.label, locale, fallback) || ref.label;
            return { id: i.id, label, url: ref.url, target: i.target ?? '_self', icon: i.icon, cssClass: i.cssClass, type: i.type, children: map(i.children ?? []) };
          } else if (i.type !== 'custom' && i.refId) {
            const slug = slugs.get(`${i.type}:${i.refId}`);
            if (!slug) return null; // nội dung đã bị xoá / chưa dịch
            url = buildPath(i.type as ContentType, slug, locale, fallback);
          }
          return { id: i.id, label: t(i.label, locale, fallback), url, target: i.target ?? '_self', icon: i.icon, cssClass: i.cssClass, type: i.type, children: map(i.children ?? []) };
        })
        .filter((x): x is ResolvedMenuItem => !!x);
    return map(items);
  }

  async publicMenus(locale?: string) {
    const menus = await this.prisma.menu.findMany({ where: { location: { not: null } } });
    const out: Record<string, ResolvedMenuItem[]> = {};
    for (const m of menus) out[m.location!] = await this.resolveItems(m.items as unknown as MenuItemInput[], locale);
    return out;
  }
}

@Controller('admin/menus')
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  /** Vị trí menu: lõi + theme (kèm source) */
  @RequirePermissions('admin.access')
  @Get('locations')
  locations() {
    return this.menus.locations();
  }

  @RequirePermissions('menus.manage')
  @Get()
  list() {
    return this.menus.list();
  }

  @RequirePermissions('menus.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.menus.get(id);
  }

  @RequirePermissions('menus.manage')
  @Post()
  create(@Body() dto: SaveMenuDto, @CurrentUser() user: AuthUser) {
    return this.menus.save(undefined, dto, user.id);
  }

  @RequirePermissions('menus.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveMenuDto, @CurrentUser() user: AuthUser) {
    return this.menus.save(id, dto, user.id);
  }

  @RequirePermissions('menus.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.menus.remove(id, user.id);
  }
}

@Controller('public/menus')
export class PublicMenusController {
  constructor(private readonly menus: MenusService) {}

  @Public()
  @Get()
  all(@Query('locale') locale?: string) {
    return this.menus.publicMenus(locale);
  }
}

@Module({ imports: [ThemeTemplatesModule], controllers: [MenusController, PublicMenusController], providers: [MenusService], exports: [MenusService] })
export class MenusModule {}
