import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { buildPath, type ContentType, type MenuItemNode } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { SETTING_GROUPS } from '../settings/settings.defaults.js';

export const SECTIONS = ['languages', 'settings', 'blocks', 'pages', 'menus'] as const;
export type Section = (typeof SECTIONS)[number];
/** Không xuất các nhóm/khoá nhạy cảm */
const SECRET_GROUPS = ['mail'];

export interface ExportBundle {
  format: 'cmsnt-export';
  version: 1;
  exportedAt: string;
  defaultLocale: string;
  data: Partial<Record<Section, unknown[] | Record<string, unknown>>>;
}

/**
 * Xuất / nhập cấu hình website (trang, block dùng chung, menu, cài đặt, ngôn ngữ)
 * để tái sử dụng bộ giao diện mẫu cho dự án khách hàng khác. Nhập là thao tác cộng thêm:
 * mặc định bỏ qua mục đã tồn tại (mode=skip), không bao giờ xoá dữ liệu.
 */
@Injectable()
export class ToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly settings: SettingsService,
    private readonly events: EventEmitter2,
  ) {}

  async export(sections: Section[]): Promise<ExportBundle> {
    const defaultLocale = await this.languages.defaultLocale();
    const data: ExportBundle['data'] = {};

    if (sections.includes('languages')) {
      data.languages = (await this.languages.list()).map(({ createdAt: _c, updatedAt: _u, ...l }) => l);
    }
    if (sections.includes('settings')) {
      const all = await this.settings.all();
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(all)) if (!SECRET_GROUPS.includes(k) && SETTING_GROUPS[k]) out[k] = v;
      data.settings = out;
    }
    if (sections.includes('blocks')) {
      const rows = await this.prisma.globalBlock.findMany({ include: { translations: true } });
      data.blocks = rows.map((b) => ({ name: b.name, key: b.key, type: b.type, isActive: b.isActive, translations: b.translations.map((t) => ({ locale: t.locale, blocks: t.blocks })) }));
    }
    let pageSlugById = new Map<string, string>();
    if (sections.includes('pages') || sections.includes('menus')) {
      const pages = await this.prisma.page.findMany({ where: { deletedAt: null }, include: { translations: true } });
      pageSlugById = new Map(pages.map((p) => [p.id, (p.translations.find((t) => t.locale === defaultLocale) ?? p.translations[0])?.slug ?? '']));
      if (sections.includes('pages')) {
        const { homepageId } = await this.settings.get<{ homepageId?: string }>('general');
        data.pages = pages.map((p) => ({
          status: p.status,
          template: p.template,
          isHomepage: p.id === homepageId,
          translations: p.translations.map(({ id: _i, pageId: _p, ogImageId: _o, ...t }) => t),
        }));
      }
    }
    if (sections.includes('menus')) {
      const menus = await this.prisma.menu.findMany();
      const convert = async (items: MenuItemNode[]): Promise<unknown[]> => {
        const out: unknown[] = [];
        for (const it of items) {
          const base = { ...it, children: await convert(it.children ?? []) };
          if (it.type === 'page' && it.refId) out.push({ ...base, refId: null, refSlug: pageSlugById.get(it.refId) });
          else if (['post', 'product', 'post_category', 'product_category'].includes(it.type) && it.refId) {
            // nội dung này không đi kèm bản xuất -> chuyển thành link tuỳ chỉnh
            out.push({ ...base, type: 'custom', refId: null, url: await this.pathOf(it.type as ContentType, it.refId, defaultLocale) });
          } else out.push(base);
        }
        return out;
      };
      data.menus = await Promise.all(menus.map(async (m) => ({ name: m.name, location: m.location, items: await convert(m.items as unknown as MenuItemNode[]) })));
    }
    return { format: 'cmsnt-export', version: 1, exportedAt: new Date().toISOString(), defaultLocale, data };
  }

  private async pathOf(type: ContentType, id: string, locale: string) {
    const sel = { translations: { select: { locale: true, slug: true } } } as const;
    const row =
      type === 'post'
        ? await this.prisma.post.findUnique({ where: { id }, select: sel })
        : type === 'product'
          ? await this.prisma.product.findUnique({ where: { id }, select: sel })
          : type === 'post_category'
            ? await this.prisma.postCategory.findUnique({ where: { id }, select: sel })
            : await this.prisma.productCategory.findUnique({ where: { id }, select: sel });
    const slug = (row?.translations.find((t) => t.locale === locale) ?? row?.translations[0])?.slug;
    return slug ? buildPath(type, slug, locale, locale) : '#';
  }

  async import(bundle: ExportBundle, mode: 'skip' | 'overwrite', user: AuthUser) {
    if (bundle?.format !== 'cmsnt-export' || bundle.version !== 1) throw new BadRequestException('File không đúng định dạng xuất của CMSNT Panel');
    const d = bundle.data ?? {};
    const report: Record<string, { created: number; updated: number; skipped: number }> = {};
    const count = (k: string) => (report[k] ??= { created: 0, updated: 0, skipped: 0 });

    if (Array.isArray(d.languages)) {
      for (const l of d.languages as { code: string; name: string; isDefault?: boolean }[]) {
        const exists = await this.prisma.language.findUnique({ where: { code: l.code } });
        if (exists && mode === 'skip') count('languages').skipped++;
        else {
          // không đổi ngôn ngữ mặc định của site đích
          await this.languages.upsert({ ...l, isDefault: exists?.isDefault ?? false });
          count('languages')[exists ? 'updated' : 'created']++;
        }
      }
    }
    const locales = await this.languages.codes();

    if (d.settings && !Array.isArray(d.settings)) {
      for (const [group, value] of Object.entries(d.settings)) {
        if (!SETTING_GROUPS[group] || SECRET_GROUPS.includes(group)) continue;
        const exists = await this.prisma.setting.findUnique({ where: { key: group } });
        if (exists && mode === 'skip') {
          count('settings').skipped++;
          continue;
        }
        const { homepageId: _h, logo: _l, logoDark: _ld, favicon: _f, defaultOgImage: _o, organizationLogo: _ol, ...rest } = value as Record<string, unknown>;
        // không nhập công tắc danh sách IP quản trị: IP máy nguồn khác máy này -> có thể khoá mọi người ngoài trang quản trị
        if (group === 'security') delete rest.adminIpAllowlist;
        await this.settings.update(group, rest);
        count('settings')[exists ? 'updated' : 'created']++;
      }
    }

    if (Array.isArray(d.blocks)) {
      for (const b of d.blocks as { name: string; key: string; type: string; isActive: boolean; translations: { locale: string; blocks: object }[] }[]) {
        const trs = b.translations.filter((t) => locales.includes(t.locale));
        const exists = await this.prisma.globalBlock.findUnique({ where: { key: b.key } });
        if (exists && mode === 'skip') {
          count('blocks').skipped++;
          continue;
        }
        if (exists) {
          await this.prisma.globalBlock.update({ where: { id: exists.id }, data: { name: b.name, type: b.type, isActive: b.isActive } });
          for (const t of trs) {
            await this.prisma.globalBlockTranslation.upsert({ where: { blockId_locale: { blockId: exists.id, locale: t.locale } }, create: { blockId: exists.id, locale: t.locale, blocks: t.blocks }, update: { blocks: t.blocks } });
          }
          count('blocks').updated++;
        } else {
          await this.prisma.globalBlock.create({ data: { name: b.name, key: b.key, type: b.type, isActive: b.isActive, translations: { create: trs } } });
          count('blocks').created++;
        }
      }
    }

    const pageIdBySlug = new Map<string, string>();
    if (Array.isArray(d.pages)) {
      for (const p of d.pages as { status: 'DRAFT'; template: string; isHomepage?: boolean; translations: Record<string, unknown>[] }[]) {
        const trs = p.translations.filter((t) => locales.includes(t.locale as string));
        if (!trs.length) continue;
        const main = trs.find((t) => t.locale === bundle.defaultLocale) ?? trs[0];
        const existing = await this.prisma.pageTranslation.findFirst({ where: { locale: main.locale as string, slug: main.slug as string }, select: { pageId: true } });
        let pageId = existing?.pageId;
        if (existing && mode === 'skip') {
          count('pages').skipped++;
        } else if (existing) {
          for (const t of trs) {
            const payload = { ...t, blocks: t.blocks as object, schemaJson: (t.schemaJson ?? undefined) as object | undefined } as never;
            await this.prisma.pageTranslation.upsert({ where: { pageId_locale: { pageId: existing.pageId, locale: t.locale as string } }, create: { ...(payload as object), pageId: existing.pageId } as never, update: payload });
          }
          count('pages').updated++;
        } else {
          // tránh trùng slug ở ngôn ngữ khác
          const safe = [];
          for (const t of trs) {
            const clash = await this.prisma.pageTranslation.findFirst({ where: { locale: t.locale as string, slug: t.slug as string } });
            safe.push({ ...t, slug: clash ? `${t.slug}-${Date.now().toString(36)}` : t.slug, blocks: t.blocks as object, schemaJson: (t.schemaJson ?? undefined) as object | undefined });
          }
          const page = await this.prisma.page.create({ data: { status: 'DRAFT', template: p.template, authorId: user.id, translations: { create: safe as never } } });
          pageId = page.id;
          count('pages').created++;
        }
        if (pageId) pageIdBySlug.set(main.slug as string, pageId);
        if (pageId && p.isHomepage) {
          const { homepageId } = await this.settings.get<{ homepageId?: string }>('general');
          if (!homepageId) await this.settings.update('general', { homepageId: pageId });
        }
      }
    }

    if (Array.isArray(d.menus)) {
      const resolveItems = async (items: (MenuItemNode & { refSlug?: string })[]): Promise<MenuItemNode[]> => {
        const out: MenuItemNode[] = [];
        for (const it of items) {
          const children = await resolveItems((it.children ?? []) as (MenuItemNode & { refSlug?: string })[]);
          if (it.type === 'page' && it.refSlug) {
            const id =
              pageIdBySlug.get(it.refSlug) ??
              (await this.prisma.pageTranslation.findFirst({ where: { slug: it.refSlug }, select: { pageId: true } }))?.pageId;
            const { refSlug: _s, ...rest } = it;
            out.push(id ? { ...rest, refId: id, children } : { ...rest, type: 'custom', url: `/${it.refSlug}`, children });
          } else out.push({ ...it, children });
        }
        return out;
      };
      for (const m of d.menus as { name: string; location: string | null; items: (MenuItemNode & { refSlug?: string })[] }[]) {
        const exists = await this.prisma.menu.findFirst({ where: m.location ? { location: m.location } : { name: m.name } });
        if (exists && mode === 'skip') {
          count('menus').skipped++;
          continue;
        }
        const items = (await resolveItems(m.items)) as object;
        if (exists) await this.prisma.menu.update({ where: { id: exists.id }, data: { name: m.name, items } });
        else await this.prisma.menu.create({ data: { name: m.name, location: m.location, items } });
        count('menus')[exists ? 'updated' : 'created']++;
      }
    }

    this.events.emit('content.changed', { type: 'import', tags: ['settings', 'pages', 'menus', 'blocks'] });
    this.events.emit('activity', { userId: user.id, action: 'tools.import', meta: report });
    return { success: true, report };
  }
}
