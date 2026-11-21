import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { normalizeUiStrings, resolveUiStrings, UI_STRING_DEFS, UI_STRING_KEY_PATTERN, type UiStringsStore } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import type { Language } from '../../generated/prisma/client.js';

/** Khoá trong bảng Setting lưu bản dịch chuỗi giao diện (không thuộc SETTING_GROUPS nên không lộ qua API cài đặt) */
const UI_STRINGS_KEY = 'uiStrings';

@Injectable()
export class LanguagesService implements OnModuleInit {
  private cache: Language[] | null = null;
  private uiCache: UiStringsStore | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly hooks: HooksService,
  ) {}

  /** Gắn bảng chuỗi giao diện đã dịch vào /public/bootstrap để frontend lấy trong một lần gọi */
  onModuleInit() {
    this.hooks.addFilter<Record<string, unknown> & { locale: string; defaultLocale: string }>(
      'public.bootstrap',
      async (data) => ({ ...data, uiStrings: await this.uiStringsFor(data.locale, data.defaultLocale) }),
      5,
      'languages',
    );
  }

  async list(onlyEnabled = false): Promise<Language[]> {
    if (!this.cache) this.cache = await this.prisma.language.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    return onlyEnabled ? this.cache.filter((l) => l.enabled) : this.cache;
  }

  async defaultLocale(): Promise<string> {
    const list = await this.list();
    return list.find((l) => l.isDefault)?.code ?? list[0]?.code ?? 'vi';
  }

  /** Trả về locale hợp lệ (đang bật), mặc định nếu không truyền / không hợp lệ */
  async resolve(locale?: string | null): Promise<string> {
    const list = await this.list(true);
    if (locale && list.some((l) => l.code === locale)) return locale;
    return this.defaultLocale();
  }

  async codes(): Promise<string[]> {
    return (await this.list(true)).map((l) => l.code);
  }

  /** Xoá cache in-memory (dùng cho công cụ Xoá cache / sau khi khôi phục DB) */
  clearCache() {
    this.cache = null;
    this.uiCache = null;
  }

  // ------------------------------------------------------------
  // Bản dịch chuỗi giao diện (nút, nhãn, thông báo cố định)
  // ------------------------------------------------------------

  /** Đọc dữ liệu bản dịch đã lưu (có cache) */
  async uiStrings(): Promise<UiStringsStore> {
    if (!this.uiCache) {
      const row = await this.prisma.setting.findUnique({ where: { key: UI_STRINGS_KEY } });
      this.uiCache = normalizeUiStrings(row?.value);
    }
    return this.uiCache;
  }

  /** Bảng chuỗi hoàn chỉnh cho một ngôn ngữ (đã fallback), dùng cho frontend */
  async uiStringsFor(localeInput?: string | null, defaultLocale?: string): Promise<Record<string, string>> {
    const locale = await this.resolve(localeInput);
    return resolveUiStrings(locale, defaultLocale ?? (await this.defaultLocale()), await this.uiStrings());
  }

  /** Ghi đè toàn bộ bản dịch của một ngôn ngữ; ô để trống = dùng bản mặc định */
  async saveUiStrings(localeInput: string, values: Record<string, unknown>, actorId?: string | null) {
    const locale = localeInput.trim().toLowerCase();
    if (!(await this.list()).some((l) => l.code === locale)) throw new BadRequestException(`Ngôn ngữ "${locale}" không tồn tại`);
    const store = await this.uiStrings();
    const known = new Set([...UI_STRING_DEFS.map((d) => d.key), ...store.custom.map((c) => c.key)]);
    // chỉ nhận khoá đã khai báo, bỏ ô rỗng, giới hạn độ dài để tránh nhồi dữ liệu
    const clean: Record<string, string> = {};
    for (const [key, v] of Object.entries(values ?? {})) {
      if (!known.has(key) || typeof v !== 'string') continue;
      const text = v.trim().slice(0, 2000);
      if (text) clean[key] = text;
    }
    await this.writeUiStrings({ ...store, values: { ...store.values, [locale]: clean } });
    this.events.emit('activity', { userId: actorId ?? null, action: 'language.ui_strings', entityType: 'language', entityId: locale, meta: { count: Object.keys(clean).length } });
    return this.uiStrings();
  }

  /** Thêm / sửa mô tả một khoá riêng (frontend của dự án dùng qua t('khoá')) */
  async upsertUiStringKey(keyInput: string, description: string | undefined, actorId?: string | null) {
    const key = keyInput.trim();
    if (!UI_STRING_KEY_PATTERN.test(key)) throw new BadRequestException('Khoá không hợp lệ: bắt đầu bằng chữ cái, chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang (tối đa 80 ký tự)');
    if (UI_STRING_DEFS.some((d) => d.key === key)) throw new BadRequestException(`Khoá "${key}" là chuỗi có sẵn của hệ thống`);
    const store = await this.uiStrings();
    const desc = description?.trim().slice(0, 200) || undefined;
    const custom = store.custom.some((c) => c.key === key) ? store.custom.map((c) => (c.key === key ? { key, description: desc } : c)) : [...store.custom, { key, description: desc }];
    await this.writeUiStrings({ ...store, custom });
    this.events.emit('activity', { userId: actorId ?? null, action: 'language.ui_string_key', entityType: 'language', entityId: key, meta: { description: desc } });
    return this.uiStrings();
  }

  /** Xoá khoá riêng kèm bản dịch của nó ở mọi ngôn ngữ */
  async removeUiStringKey(key: string, actorId?: string | null) {
    const store = await this.uiStrings();
    if (!store.custom.some((c) => c.key === key)) throw new BadRequestException(`Không tìm thấy khoá "${key}"`);
    const values = Object.fromEntries(Object.entries(store.values).map(([loc, dict]) => [loc, Object.fromEntries(Object.entries(dict).filter(([k]) => k !== key))]));
    await this.writeUiStrings({ custom: store.custom.filter((c) => c.key !== key), values });
    this.events.emit('activity', { userId: actorId ?? null, action: 'language.ui_string_key_delete', entityType: 'language', entityId: key });
    return this.uiStrings();
  }

  private async writeUiStrings(store: UiStringsStore) {
    await this.prisma.setting.upsert({
      where: { key: UI_STRINGS_KEY },
      create: { key: UI_STRINGS_KEY, value: store as object, isPublic: false },
      update: { value: store as object },
    });
    this.uiCache = null;
    // bootstrap có chứa uiStrings → xoá cache trang theo tag settings giống khi đổi ngôn ngữ
    this.events.emit('content.changed', { type: 'languages', tags: ['settings', 'languages', 'bootstrap'] });
  }

  async upsert(data: { code: string; name: string; nativeName?: string; flag?: string; enabled?: boolean; isDefault?: boolean; direction?: string; sortOrder?: number }, actorId?: string | null) {
    const code = data.code.trim().toLowerCase();
    if (!/^[a-z]{2}(-[a-z]{2})?$/.test(code)) throw new BadRequestException('Mã ngôn ngữ không hợp lệ (vd: vi, en, zh-cn)');
    await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.language.updateMany({ data: { isDefault: false } });
      await tx.language.upsert({
        where: { code },
        create: { ...data, code, enabled: data.isDefault ? true : (data.enabled ?? true) },
        update: { ...data, code, ...(data.isDefault ? { enabled: true } : {}) },
      });
    });
    this.events.emit('activity', { userId: actorId ?? null, action: 'language.upsert', entityType: 'language', entityId: code, meta: { name: data.name, enabled: data.enabled, isDefault: data.isDefault } });
    return this.changed();
  }

  async remove(code: string, actorId?: string | null) {
    const lang = await this.prisma.language.findUniqueOrThrow({ where: { code } });
    if (lang.isDefault) throw new BadRequestException('Không thể xoá ngôn ngữ mặc định');
    await this.prisma.language.delete({ where: { code } });
    this.events.emit('activity', { userId: actorId ?? null, action: 'language.delete', entityType: 'language', entityId: code, meta: { name: lang.name } });
    return this.changed();
  }

  private async changed() {
    this.cache = null;
    this.events.emit('content.changed', { type: 'languages', tags: ['settings', 'languages', 'bootstrap'] });
    return this.list();
  }
}
