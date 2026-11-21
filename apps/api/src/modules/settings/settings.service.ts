import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AI_TASK_RETENTION_MIN_DAYS, SETTING_GROUPS } from './settings.defaults.js';

type Dict = Record<string, unknown>;

/**
 * Thời gian giữ cache cài đặt (giây), env SETTINGS_CACHE_TTL, mặc định 30. 0 = luôn đọc DB.
 * Cần TTL vì chạy nhiều instance API: admin lưu cài đặt ở instance A thì instance B chỉ thấy sau tối đa TTL giây
 * (trong cùng tiến trình vẫn xoá cache ngay khi cập nhật).
 */
export function settingsCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.SETTINGS_CACHE_TTL ?? '', 10);
  return (Number.isFinite(n) && n >= 0 ? n : 30) * 1000;
}

@Injectable()
export class SettingsService {
  private cache: Map<string, Dict> | null = null;
  /** thời điểm nạp cache (ms) */
  private cachedAt = 0;
  /** lượt nạp đang chạy — nhiều request cùng lúc dùng chung một truy vấn */
  private loading: Promise<Map<string, Dict>> | null = null;
  private readonly ttlMs = settingsCacheTtlMs();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  private async load(): Promise<Map<string, Dict>> {
    if (this.cache && Date.now() - this.cachedAt < this.ttlMs) return this.cache;
    if (this.loading) return this.loading;
    const loading = this.fetch();
    this.loading = loading;
    try {
      const map = await loading;
      // clearCache()/update() chạy trong lúc đang nạp thì kết quả cũ không được ghi vào cache
      if (this.loading === loading) {
        this.cache = map;
        this.cachedAt = Date.now();
      }
      return map;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }

  /** Đọc toàn bộ cài đặt từ DB, trộn với giá trị mặc định của từng nhóm */
  private async fetch(): Promise<Map<string, Dict>> {
    const rows = await this.prisma.setting.findMany();
    const map = new Map<string, Dict>();
    for (const [key, group] of Object.entries(SETTING_GROUPS)) {
      const row = rows.find((r) => r.key === key);
      const merged: Dict = { ...group.defaults, ...((row?.value as Dict) ?? {}) };
      // bảng giá vốn AHiep: model mới thêm vào adapter phải hiện ô giá ở admin dù admin đã lưu bảng giá cũ -> trộn sâu 1 cấp
      if (key === 'ai_ahiep') for (const k of ['tokenCosts', 'imageCosts']) merged[k] = { ...((group.defaults as Dict)[k] as Dict), ...((merged[k] as Dict) ?? {}) };
      map.set(key, merged);
    }
    // Nhóm có trong DB nhưng không khai báo trong defaults (dữ liệu cũ) vẫn đọc được
    for (const row of rows) if (!map.has(row.key)) map.set(row.key, row.value as Dict);
    return map;
  }

  /** Trả về bản sao để nơi gọi có sửa object cũng không làm hỏng cache */
  async get<T = Dict>(group: string): Promise<T> {
    return { ...((await this.load()).get(group) ?? {}) } as T;
  }

  async all(): Promise<Record<string, Dict>> {
    return Object.fromEntries([...(await this.load())].map(([k, v]) => [k, { ...v }]));
  }

  async publicSettings(): Promise<Record<string, Dict>> {
    const all = await this.load();
    const out: Record<string, Dict> = {};
    for (const [key, group] of Object.entries(SETTING_GROUPS)) if (group.public) out[key] = { ...(all.get(key) ?? {}) };
    // khoá nội bộ trong nhóm public không gửi ra frontend
    delete out.commerce?.orderNotifyEmails;
    delete out.comments?.notifyEmail;
    delete out.general?.homepageId;
    // frontend chỉ cần enabled / excludeAdmins / respectDnt; đường dẫn loại trừ và thời hạn lưu là cấu hình nội bộ
    delete out.analytics?.excludePaths;
    delete out.analytics?.retentionDays;
    // nhóm `ai` là nội bộ; chỉ gửi số ngày tự xoá tác vụ thực tế (0 = giữ vĩnh viễn, đặt 1–6 thì cron vẫn giữ 7 ngày)
    // để trang Lịch sử tạo của website hiện đúng thời hạn lưu trữ
    const days = Math.max(0, Math.floor(Number(all.get('ai')?.taskRetentionDays) || 0));
    out.ai = { taskRetentionDays: days > 0 ? Math.max(AI_TASK_RETENTION_MIN_DAYS, days) : 0 };
    return out;
  }

  /** Xoá cache in-memory (dùng cho công cụ Xoá cache / sau khi khôi phục DB) */
  clearCache() {
    this.cache = null;
    this.loading = null;
  }

  async update(group: string, value: Dict, actorId?: string | null) {
    if (!SETTING_GROUPS[group]) throw new BadRequestException(`Nhóm cài đặt "${group}" không tồn tại`);
    // đọc thẳng DB (không qua cache có TTL): instance khác vừa sửa khoá khác của cùng nhóm thì không bị ghi đè bằng giá trị cũ
    const row = await this.prisma.setting.findUnique({ where: { key: group } });
    const current = { ...SETTING_GROUPS[group].defaults, ...((row?.value as Dict) ?? {}) };
    const next = { ...current, ...value };
    const changedKeys = Object.keys(value).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
    await this.prisma.setting.upsert({
      where: { key: group },
      create: { key: group, value: next as object, isPublic: SETTING_GROUPS[group]?.public ?? false },
      update: { value: next as object },
    });
    this.clearCache();
    this.events.emit('content.changed', { type: 'settings', tags: group === 'commerce' ? ['settings', 'bootstrap', 'reviews', 'products'] : ['settings', 'bootstrap'] });
    // chỉ ghi tên khoá đã đổi, không ghi giá trị (nhóm mail có mật khẩu)
    this.events.emit('activity', { userId: actorId ?? null, action: 'settings.update', entityType: 'settings', entityId: group, meta: { group, keys: Object.keys(value), changedKeys } });
    return this.get(group);
  }
}
