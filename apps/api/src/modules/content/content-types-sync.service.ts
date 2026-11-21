import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LanguagesService } from '../languages/languages.service.js';
import { CustomFieldsService } from '../custom-fields/custom-fields.service.js';
import { CONTENT_TYPES, type CodeContentType, type CodeTaxonomy } from '../../config/content-types.config.js';
import { ContentMetaService } from './content-meta.service.js';
import { ContentTermsService } from './content-terms.service.js';
import { ContentTypesService } from './content-types.service.js';
import { normalizeSlugs } from './content.util.js';

/** Nguồn đánh dấu loại nội dung / taxonomy khai báo trong code (admin chỉ xem, không sửa được) */
export const CODE_SOURCE = 'code';

/** JSON ổn định (sắp key) để so sánh khai báo với bản ghi hiện có, tránh ghi DB + phát sự kiện khi không đổi gì */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Đồng bộ loại nội dung + taxonomy khai báo trong apps/api/src/config/content-types.config.ts vào DB
 * mỗi lần API khởi động. Lỗi ở một loại (vd slug trùng trang) chỉ ghi log, không chặn API khởi động.
 */
@Injectable()
export class ContentTypesSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContentTypesSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly languages: LanguagesService,
    private readonly meta: ContentMetaService,
    private readonly types: ContentTypesService,
    private readonly terms: ContentTermsService,
    private readonly customFields: CustomFieldsService,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.sync(CONTENT_TYPES);
    } catch (e) {
      this.logger.error(`Đồng bộ loại nội dung từ code thất bại: ${(e as Error).message}`);
    }
  }

  async sync(list: CodeContentType[]) {
    const keys = list.map((t) => t.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) throw new Error(`content-types.config: trùng key "${dup}"`);
    this.meta.clear();
    const locales = await this.languages.codes();
    const defaultLocale = await this.languages.defaultLocale();
    // nhãn / slug khai báo có thể thiếu locale -> dùng bản của ngôn ngữ mặc định (hoặc vi, hoặc bản đầu tiên)
    const fit = <T>(map: Record<string, T>): Record<string, T> => {
      const base = map[defaultLocale] ?? map.vi ?? Object.values(map)[0];
      return Object.fromEntries(locales.map((l) => [l, map[l] ?? base]));
    };
    let changed = 0;

    // 1) loại nội dung
    for (const [i, def] of list.entries()) {
      try {
        const existing = await this.meta.type(def.key);
        const body = {
          ...def.type,
          description: def.type.description ?? '',
          icon: def.icon,
          labels: fit(def.type.labels),
          slugs: normalizeSlugs(fit(def.type.slugs), locales, defaultLocale, def.key),
          isActive: true,
          sortOrder: i,
        };
        if (existing) {
          const { id: _id, key: _key, source, ...current } = existing;
          const want = { ...body, description: body.description || null };
          const same = source === CODE_SOURCE && Object.keys(want).every((k) => stable(want[k as keyof typeof want]) === stable(current[k as keyof typeof current]));
          if (same) continue;
        }
        await this.types.saveType(existing?.id, { ...body, key: def.key }, undefined, CODE_SOURCE);
        changed++;
        this.logger.log(`${existing ? 'Cập nhật' : 'Tạo'} loại nội dung "${def.key}" từ code`);
      } catch (e) {
        this.logger.error(`Loại nội dung "${def.key}": ${(e as Error).message}`);
      }
    }

    // 2) taxonomy: gom theo key (một taxonomy có thể dùng cho nhiều loại)
    const taxDefs = new Map<string, { def: CodeTaxonomy; types: string[] }>();
    for (const t of list) for (const tx of t.taxonomies ?? []) taxDefs.set(tx.key, { def: taxDefs.get(tx.key)?.def ?? tx, types: [...(taxDefs.get(tx.key)?.types ?? []), t.key] });
    const typeKeys = new Set((await this.meta.types()).map((t) => t.key));
    for (const [key, { def, types }] of taxDefs) {
      try {
        const existing = await this.meta.taxonomy(key);
        // giữ loại nội dung khác (ngoài code) đang dùng taxonomy này; bỏ loại chưa tạo được (lỗi ở bước 1)
        const contentTypes = [...new Set([...(existing?.contentTypes ?? []), ...types])].filter((k) => typeKeys.has(k));
        const body = {
          labels: fit(def.labels),
          slugs: normalizeSlugs(fit(def.slugs), locales, defaultLocale, key),
          hierarchical: def.hierarchical,
          isPublic: def.isPublic ?? true,
          showInFilter: def.showInFilter ?? true,
          contentTypes,
        };
        if (existing) {
          const same = existing.source === CODE_SOURCE && (Object.keys(body) as (keyof typeof body)[]).every((k) => stable(body[k]) === stable(existing[k]));
          if (same) continue;
        }
        await this.types.saveTaxonomy(existing?.id, { ...body, key }, undefined, CODE_SOURCE);
        changed++;
        this.logger.log(`${existing ? 'Cập nhật' : 'Tạo'} phân loại "${key}" từ code`);
        // term mẫu chỉ tạo khi taxonomy mới tạo lần đầu
        if (!existing) {
          for (const [i, term] of (def.terms ?? []).entries()) {
            const names: Record<string, string> = { vi: term.vi, en: term.en };
            await this.terms.save(key, undefined, { sortOrder: i, translations: locales.map((l) => ({ locale: l, name: names[l] ?? names[defaultLocale] ?? term.vi })) });
          }
        }
      } catch (e) {
        this.logger.error(`Phân loại "${key}": ${(e as Error).message}`);
      }
    }

    // 3) nhóm trường tuỳ chỉnh: chỉ tạo nhóm chưa có (không ghi đè chỉnh sửa trong admin)
    const groups = list.flatMap((t) => t.fieldGroups ?? []);
    if (groups.length) {
      try {
        const r = await this.customFields.import({ groups, overwrite: false });
        if (r.created.length) this.logger.log(`Tạo nhóm trường tuỳ chỉnh từ code: ${r.created.join(', ')}`);
      } catch (e) {
        this.logger.error(`Nhóm trường tuỳ chỉnh: ${(e as Error).message}`);
      }
    }

    // 4) loại từng khai báo trong code nhưng nay đã bỏ khỏi file -> tắt (giữ nguyên bài viết)
    const removed = await this.prisma.contentType.findMany({ where: { source: CODE_SOURCE, isActive: true, key: { notIn: keys } }, select: { key: true } });
    if (removed.length) {
      await this.prisma.contentType.updateMany({ where: { source: CODE_SOURCE, key: { in: removed.map((r) => r.key) } }, data: { isActive: false } });
      changed++;
      this.logger.warn(`Đã tắt loại nội dung không còn trong code: ${removed.map((r) => r.key).join(', ')} (bài viết vẫn giữ nguyên)`);
    }

    if (changed) this.types.notifyMetaChanged();
  }
}
