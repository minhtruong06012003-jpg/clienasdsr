import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { slugify } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AI_PROVIDERS } from './providers/index.js';
import type { CreateCategoryDto, UpdateCategoryDto } from './ai.dto.js';
import { isDeletedTool } from './ai.types.js';

/** Một nhóm công cụ (menu website khách, bộ lọc admin) */
export interface AiCategory {
  /** Khoá cố định, lưu vào `ai_tools.category` (vd video, image, voice) — không đổi sau khi tạo */
  key: string;
  label: string;
  /** Tên icon lucide (website khách chỉ hiện các icon có trong bảng ICONS của apps/web/src/lib/ai.ts) */
  icon: string | null;
  /** Nhóm đang bật: tắt thì website khách ẩn nhóm này cùng mọi công cụ trong nhóm (mặc định bật) */
  enabled: boolean;
  /** Thứ tự nhóm model con do admin kéo thả (T-496) */
  groupOrder?: string[];
}

/** Nhóm cài đặt lưu danh sách nhóm (thứ tự trong mảng = thứ tự hiển thị) */
export const AI_CATEGORIES_GROUP = 'ai_categories';

/**
 * Nhóm công cụ AI do admin quản lý. Danh sách lưu trong nhóm cài đặt `ai_categories` ({ items: AiCategory[] }),
 * mặc định là các nhóm adapter đang dùng (video, image, voice, audio, text, tools). Công cụ chỉ lưu khoá nhóm
 * (`ai_tools.category`): mặc định lấy theo `category` khai báo trong adapter, admin đổi được ở Sửa công cụ.
 */
@Injectable()
export class AiCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Danh sách nhóm theo thứ tự admin xếp. Nhóm mà công cụ đang dùng nhưng chưa có trong danh sách
   * (vd adapter mới khai báo nhóm lạ) được thêm vào cuối với tên = khoá, để menu khách không bị mất công cụ.
   */
  async list(): Promise<AiCategory[]> {
    const raw = (await this.settings.get<{ items?: unknown }>(AI_CATEGORIES_GROUP)).items;
    const items = (Array.isArray(raw) ? raw : [])
      .filter((c): c is AiCategory => !!c && typeof (c as AiCategory).key === 'string' && !!(c as AiCategory).key)
      .map((c) => {
        const go = Array.isArray((c as AiCategory).groupOrder)
          ? (c as AiCategory).groupOrder!.map((g) => String(g ?? '').trim()).filter(Boolean)
          : undefined;
        return {
          key: c.key,
          label: String(c.label || c.key),
          icon: c.icon ? String(c.icon) : null,
          enabled: c.enabled !== false,
          ...(go && go.length ? { groupOrder: go } : {}),
        };
      });
    const known = new Set(items.map((c) => c.key));
    const used = await this.prisma.aiTool.findMany({ distinct: ['category'], select: { category: true } });
    const declared = AI_PROVIDERS.flatMap((p) => p.tools.map((t) => t.category));
    for (const key of [...declared, ...used.map((u) => u.category)]) {
      if (known.has(key)) continue;
      known.add(key);
      items.push({ key, label: key, icon: null, enabled: true });
    }
    return items;
  }

  /** Website khách: chỉ các nhóm đang bật */
  async publicList(): Promise<AiCategory[]> {
    return (await this.list()).filter((c) => c.enabled);
  }

  /** Khoá các nhóm đang tắt (ẩn công cụ thuộc nhóm này khỏi website khách, chặn chạy) */
  async disabledKeys(): Promise<Set<string>> {
    return new Set((await this.list()).filter((c) => !c.enabled).map((c) => c.key));
  }

  /** Admin: danh sách nhóm + số công cụ trong từng nhóm */
  async adminList() {
    // đếm ở JS để bỏ công cụ đã xoá (cờ nằm trong JSON options)
    const [items, rows] = await Promise.all([this.list(), this.prisma.aiTool.findMany({ select: { category: true, options: true } })]);
    const count = new Map<string, number>();
    for (const r of rows) if (!isDeletedTool(r.options)) count.set(r.category, (count.get(r.category) ?? 0) + 1);
    return items.map((c) => ({ ...c, tools: count.get(c.key) ?? 0 }));
  }

  /** Nhóm có tồn tại không (kiểm tra khi admin đổi nhóm của công cụ) */
  async assertExists(key: string) {
    if (!(await this.list()).some((c) => c.key === key)) throw new BadRequestException(`Nhóm "${key}" không tồn tại`);
  }

  /** Ghi cả mảng (settings.update gộp nông theo khoá nên `items` được thay trọn) */
  private async save(items: AiCategory[], actorId?: string | null) {
    await this.settings.update(AI_CATEGORIES_GROUP, { items }, actorId);
  }

  async create(dto: CreateCategoryDto, actorId?: string | null) {
    const items = await this.list();
    // khoá tự sinh từ tên nếu admin bỏ trống (vd "Mạng xã hội" -> mang-xa-hoi)
    const key = (dto.key?.trim() || slugify(dto.label)).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key)) throw new BadRequestException('Khoá nhóm chỉ gồm chữ thường không dấu, số và dấu gạch ngang (tối đa 40 ký tự)');
    if (items.some((c) => c.key === key)) throw new ConflictException(`Khoá nhóm "${key}" đã tồn tại`);
    const cat: AiCategory = { key, label: dto.label.trim(), icon: dto.icon?.trim() || null, enabled: true };
    await this.save([...items, cat], actorId);
    return cat;
  }

  async update(key: string, dto: UpdateCategoryDto, actorId?: string | null) {
    const items = await this.list();
    const cat = items.find((c) => c.key === key);
    if (!cat) throw new NotFoundException('Không tìm thấy nhóm');
    if (dto.label !== undefined) cat.label = dto.label.trim() || cat.label;
    if (dto.icon !== undefined) cat.icon = dto.icon?.trim() || null;
    if (dto.enabled !== undefined) cat.enabled = dto.enabled;
    if (dto.groupOrder !== undefined) {
      const cleaned = [...new Set(dto.groupOrder.map((g) => String(g ?? '').trim()).filter(Boolean))];
      cat.groupOrder = cleaned.length ? cleaned : undefined;
    }
    await this.save(items, actorId);
    return cat;
  }

  /** Sắp xếp lại: `keys` theo thứ tự mới; khoá thiếu giữ nguyên ở cuối theo thứ tự cũ */
  async reorder(keys: string[], actorId?: string | null) {
    const items = await this.list();
    const pos = new Map(keys.map((k, i) => [k, i]));
    const sorted = [...items].sort((a, b) => (pos.get(a.key) ?? keys.length + items.indexOf(a)) - (pos.get(b.key) ?? keys.length + items.indexOf(b)));
    await this.save(sorted, actorId);
    return sorted;
  }

  /** Xoá nhóm: chỉ khi không còn công cụ nào (kể cả công cụ đang tắt) thuộc nhóm này */
  async remove(key: string, actorId?: string | null) {
    const items = await this.list();
    if (!items.some((c) => c.key === key)) throw new NotFoundException('Không tìm thấy nhóm');
    const tools = (await this.prisma.aiTool.findMany({ where: { category: key }, select: { options: true } })).filter((r) => !isDeletedTool(r.options)).length;
    if (tools) throw new BadRequestException(`Nhóm còn ${tools} công cụ, hãy chuyển công cụ sang nhóm khác trước khi xoá`);
    // nhóm adapter còn khai báo sẽ tự hiện lại ở list() -> không cho xoá
    if (AI_PROVIDERS.some((p) => p.tools.some((t) => t.category === key))) throw new BadRequestException('Nhóm đang được adapter nhà cung cấp dùng làm nhóm mặc định, không xoá được');
    await this.save(
      items.filter((c) => c.key !== key),
      actorId,
    );
    return { ok: true };
  }
}
