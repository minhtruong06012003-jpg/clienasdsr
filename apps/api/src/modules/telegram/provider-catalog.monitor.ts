import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AiService, RETIRED_PROVIDERS } from '../ai/ai.service.js';
import type { AiCatalogItem } from '../ai/ai.types.js';
import { AI_PROVIDERS } from '../ai/providers/index.js';
import { esc } from './telegram.api.js';
import { TelegramService } from './telegram.service.js';
import { isChildSite } from '../../common/utils/tenant.js';

/** Khoá dòng trong bảng settings lưu danh mục đã thấy lần trước (không khai báo trong SETTING_GROUPS, admin không sửa) */
const STATE_KEY = 'ai_catalog_state';
/** Số model tối đa liệt kê trong một tin (Telegram giới hạn 4096 ký tự) */
const MAX_LIST = 30;

/** Danh mục đã thấy của một nguồn: mã -> tên */
interface ProviderState {
  items: Record<string, string>;
  checkedAt: string;
}
type CatalogState = Record<string, ProviderState>;

/** Kết quả so sánh một nguồn */
interface CatalogDiff {
  key: string;
  name: string;
  total: number;
  added: AiCatalogItem[];
  removed: AiCatalogItem[];
  /** true = lần đầu đọc nguồn này -> chỉ ghi nhớ làm mốc, không báo */
  baseline: boolean;
  /** Đã gửi được tin báo chênh lệch chưa */
  notified?: boolean;
  error?: string;
}

/**
 * Theo dõi danh mục model / workflow của các nhà cung cấp AI (adapter có `catalog()`), báo bot Telegram admin khi
 * nguồn thêm model mới (để thêm vào adapter và bật trên web) hoặc gỡ / tắt model.
 *
 * Không đối chiếu với model khai báo trong code (mã model mỗi nguồn đặt mỗi kiểu) mà so với lần đọc trước:
 * lần đầu đọc một nguồn thì ghi nhớ làm mốc, các lần sau báo phần chênh lệch. Danh mục đã thấy lưu ở bảng settings
 * (khoá `ai_catalog_state`) nên khởi động lại / deploy không báo lại. Chưa gửi được tin (bot tắt / lỗi mạng) thì
 * không cập nhật mốc, lần sau báo lại.
 */
@Injectable()
export class ProviderCatalogMonitor implements OnModuleInit {
  private readonly logger = new Logger('ProviderCatalog');
  private lastRunAt = 0;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly tg: TelegramService,
  ) {}

  /** Đăng ký lệnh quản trị /models — kiểm tra ngay */
  onModuleInit() {
    this.tg.adminCommands.models = async () => this.formatSummary(await this.run());
  }

  /** Cron mỗi phút, tự giãn theo `catalogCheckMinutes` (tối thiểu 15 phút) */
  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    // web con dùng khoá nhà cung cấp của web chính: không báo số dư / model mới (web chính đã báo)
    if (this.running || isChildSite()) return;
    const admin = await this.tg.adminSettings();
    if (!admin.enabled || admin.events?.newModel === false) return;
    const every = Math.max(15, Number(admin.catalogCheckMinutes) || 60) * 60_000;
    if (Date.now() - this.lastRunAt < every) return;
    this.lastRunAt = Date.now();
    await this.run();
  }

  /** Đọc danh mục mọi nguồn đang bật, gửi tin báo chênh lệch và lưu mốc mới */
  async run(): Promise<CatalogDiff[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const state = await this.loadState();
      const diffs: CatalogDiff[] = [];
      for (const p of AI_PROVIDERS) {
        if (RETIRED_PROVIDERS.has(p.key) || !p.catalog) continue;
        const cfg = await this.settings.get<{ enabled?: boolean }>(`ai_${p.key}`);
        if (cfg.enabled !== true) continue;
        let items: AiCatalogItem[];
        try {
          items = (await this.ai.providerCatalog(p.key)) ?? [];
        } catch (err) {
          // nguồn lỗi tạm thời -> giữ mốc cũ, lần sau đọc lại (không báo để tránh tin rác)
          const error = (err as Error).message;
          this.logger.warn(`Đọc danh mục model ${p.name} lỗi: ${error}`);
          diffs.push({ key: p.key, name: p.name, total: 0, added: [], removed: [], baseline: false, error });
          continue;
        }
        // danh sách rỗng thường là nguồn trục trặc -> không coi là gỡ hết model
        if (!items.length) continue;
        const prev = state[p.key];
        const now = Object.fromEntries(items.map((i) => [i.id, i.label]));
        const diff: CatalogDiff = {
          key: p.key,
          name: p.name,
          total: items.length,
          added: prev ? items.filter((i) => !(i.id in prev.items)) : [],
          removed: prev ? Object.entries(prev.items).filter(([id]) => !(id in now)).map(([id, label]) => ({ id, label })) : [],
          baseline: !prev,
        };
        diffs.push(diff);
        if (diff.added.length || diff.removed.length) {
          const res = await this.tg.notifyAdmin('newModel', this.alertText(diff));
          // chưa gửi được -> giữ mốc cũ để lần sau báo lại
          if (!res.sent) continue;
          diff.notified = true;
          this.logger.log(`${p.name}: +${diff.added.length} / -${diff.removed.length} model`);
        }
        state[p.key] = { items: now, checkedAt: new Date().toISOString() };
      }
      await this.saveState(state);
      return diffs;
    } catch (err) {
      this.logger.warn(`Kiểm tra danh mục model lỗi: ${(err as Error).message}`);
      return [];
    } finally {
      this.running = false;
    }
  }

  private async loadState(): Promise<CatalogState> {
    const row = await this.prisma.setting.findUnique({ where: { key: STATE_KEY } });
    return (row?.value as unknown as CatalogState | undefined) ?? {};
  }

  private async saveState(state: CatalogState) {
    const value = state as unknown as object;
    await this.prisma.setting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, isPublic: false }, update: { value } });
  }

  /** Liệt kê tối đa MAX_LIST dòng, còn lại ghi "và N model khác" */
  private list(items: AiCatalogItem[], icon: string) {
    const lines = items.slice(0, MAX_LIST).map((i) => `${icon} ${esc(i.label)}${i.label.includes(i.id) ? '' : ` — <code>${esc(i.id)}</code>`}`);
    if (items.length > MAX_LIST) lines.push(`… và ${items.length - MAX_LIST} model khác`);
    return lines;
  }

  private alertText(d: CatalogDiff) {
    const out = [`🆕 <b>Nguồn ${esc(d.name)} thay đổi danh mục model</b>`];
    if (d.added.length) out.push('', `<b>Thêm mới (${d.added.length}):</b>`, ...this.list(d.added, '➕'));
    if (d.removed.length) out.push('', `<b>Đã gỡ / tắt (${d.removed.length}):</b>`, ...this.list(d.removed, '➖'));
    if (d.added.length) out.push('', 'Model mới cần thêm vào adapter rồi deploy; sau đó bật ở AI Studio › Công cụ AI.');
    if (d.removed.length) out.push('Kiểm tra công cụ đang dùng model đã gỡ để tắt trên web, tránh khách chạy bị lỗi.');
    return out.join('\n');
  }

  /** Nội dung lệnh /models */
  private formatSummary(diffs: CatalogDiff[]) {
    if (!diffs.length) return 'Chưa có nguồn API nào đang bật hỗ trợ đọc danh mục model (hoặc đang kiểm tra dở, thử lại sau).';
    return [
      '<b>Danh mục model các nguồn API</b>',
      ...diffs.map((d) => {
        if (d.error) return `⚪️ ${esc(d.name)}: lỗi — ${esc(d.error)}`;
        if (d.baseline) return `🟢 ${esc(d.name)}: ${d.total} model (lần đầu, đã ghi nhớ làm mốc)`;
        const changed = d.added.length || d.removed.length;
        return `${changed ? '🆕' : '🟢'} ${esc(d.name)}: ${d.total} model${changed ? ` (+${d.added.length} / -${d.removed.length}, ${d.notified ? 'đã gửi chi tiết' : 'chưa gửi được tin — kiểm tra sự kiện "Nguồn API thêm / gỡ model"'})` : ', không đổi'}`;
      }),
    ].join('\n');
  }
}
