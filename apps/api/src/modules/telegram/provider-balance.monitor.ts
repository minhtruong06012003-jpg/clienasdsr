import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AiService, RETIRED_PROVIDERS } from '../ai/ai.service.js';
import { AI_PROVIDERS } from '../ai/providers/index.js';
import { esc } from './telegram.api.js';
import { TelegramService } from './telegram.service.js';
import { isChildSite } from '../../common/utils/tenant.js';

/** Mức số dư: ok / dưới ngưỡng / hết tiền (≤ 0) / không đọc được số dư */
export type BalanceLevel = 'ok' | 'low' | 'empty' | 'error';

export interface ProviderBalanceRow {
  key: string;
  name: string;
  balance: number | null;
  unit: string | null;
  threshold: number | null;
  level: BalanceLevel;
  error?: string;
  checkedAt: string;
}

const fmt = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/** Ngưỡng admin nhập (chuỗi / số); bỏ trống, âm, lỗi -> null (chỉ báo khi hết tiền) */
const thresholdOf = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Theo dõi số dư tài khoản ở các nhà cung cấp AI (adapter có `balance()`), báo bot Telegram admin khi:
 * - số dư ≤ 0 (hết tiền) hoặc ≤ ngưỡng admin đặt cho nguồn đó;
 * - không đọc được số dư (khoá sai / nguồn lỗi);
 * - đã nạp lại (về mức bình thường) sau khi từng báo.
 * Báo khi mức thay đổi; còn ở mức xấu thì nhắc lại sau `balanceRemindHours`. Trạng thái giữ trong bộ nhớ:
 * khởi động lại API mà nguồn vẫn thấp thì báo lại một lần.
 */
@Injectable()
export class ProviderBalanceMonitor implements OnModuleInit {
  private readonly logger = new Logger('ProviderBalance');
  /** Mức + thời điểm báo gần nhất theo nhà cung cấp */
  private readonly state = new Map<string, { level: BalanceLevel; alertedAt: number }>();
  /** Kết quả lần kiểm tra gần nhất (trang admin hiển thị) */
  private last: ProviderBalanceRow[] = [];
  private lastRunAt = 0;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly ai: AiService,
    private readonly tg: TelegramService,
  ) {}

  /** Đăng ký lệnh quản trị cho bot (/sources, /stats) */
  onModuleInit() {
    this.tg.adminCommands.sources = async () => this.formatList(await this.check());
    this.tg.adminCommands.stats = () => this.todayStats();
  }

  /** Nhà cung cấp đang bật, có khoá và có hỗ trợ đọc số dư */
  private async watched() {
    const out: { key: string; name: string }[] = [];
    for (const p of AI_PROVIDERS) {
      if (RETIRED_PROVIDERS.has(p.key) || !p.balance) continue;
      const cfg = await this.settings.get<{ enabled?: boolean; apiKey?: string }>(`ai_${p.key}`);
      if (cfg.enabled === true && cfg.apiKey) out.push({ key: p.key, name: p.name });
    }
    return out;
  }

  /** Đọc số dư mọi nguồn đang theo dõi (không gửi tin) */
  async check(): Promise<ProviderBalanceRow[]> {
    const admin = await this.tg.adminSettings();
    const rows = await Promise.all(
      (await this.watched()).map(async (p): Promise<ProviderBalanceRow> => {
        const threshold = thresholdOf(admin.thresholds?.[p.key]);
        const r = (await this.ai.providerBalance(p.key)) as { ok?: boolean; balance?: number; unit?: string; error?: string };
        const checkedAt = new Date().toISOString();
        if (!r.ok || typeof r.balance !== 'number' || !Number.isFinite(r.balance)) return { ...p, balance: null, unit: null, threshold, level: 'error', error: r.error || 'Không đọc được số dư', checkedAt };
        const level: BalanceLevel = r.balance <= 0 ? 'empty' : threshold !== null && r.balance <= threshold ? 'low' : 'ok';
        return { ...p, balance: r.balance, unit: r.unit ?? null, threshold, level, checkedAt };
      }),
    );
    this.last = rows;
    return rows;
  }

  /** Kết quả lần kiểm tra gần nhất cho trang admin (`refresh` = đọc lại ngay) */
  async snapshot(refresh = false) {
    const rows = refresh || !this.last.length ? await this.check() : this.last;
    return { rows, checkedAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null };
  }

  /** Cron mỗi phút, tự giãn theo `balanceCheckMinutes` (tối thiểu 5 phút) */
  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    // web con dùng khoá nhà cung cấp của web chính: không báo số dư / model mới (web chính đã báo)
    if (this.running || isChildSite()) return;
    const admin = await this.tg.adminSettings();
    if (!admin.enabled || admin.events?.lowBalance === false) return;
    const every = Math.max(5, Number(admin.balanceCheckMinutes) || 30) * 60_000;
    if (Date.now() - this.lastRunAt < every) return;
    this.running = true;
    this.lastRunAt = Date.now();
    try {
      await this.evaluate(await this.check(), Math.max(1, Number(admin.balanceRemindHours) || 6) * 3_600_000);
    } catch (err) {
      this.logger.warn(`Kiểm tra số dư nguồn API lỗi: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** So mức mới với lần trước, gửi cảnh báo / báo đã nạp lại */
  private async evaluate(rows: ProviderBalanceRow[], remindMs: number) {
    for (const r of rows) {
      const prev = this.state.get(r.key);
      if (r.level === 'ok') {
        if (prev && prev.level !== 'ok') await this.tg.notifyAdmin('lowBalance', `✅ <b>Nguồn ${esc(r.name)}</b> đã về mức bình thường: ${fmt(r.balance!)} ${esc(r.unit ?? '')}`);
        this.state.set(r.key, { level: 'ok', alertedAt: 0 });
        continue;
      }
      if (prev?.level === r.level && Date.now() - prev.alertedAt < remindMs) continue;
      const res = await this.tg.notifyAdmin('lowBalance', this.alertText(r, prev?.level === r.level));
      // chưa gửi được (bot tắt / lỗi mạng) thì lần sau thử lại
      if (res.sent) this.state.set(r.key, { level: r.level, alertedAt: Date.now() });
    }
  }

  private alertText(r: ProviderBalanceRow, remind: boolean) {
    const head = remind ? '⏰ Nhắc lại: ' : '';
    if (r.level === 'error') return `${head}⚠️ <b>Không đọc được số dư nguồn ${esc(r.name)}</b>\n${esc(r.error)}\nKiểm tra khoá API ở AI Studio › Công cụ AI › Khoá API.`;
    const bal = `${fmt(r.balance!)} ${esc(r.unit ?? '')}`;
    if (r.level === 'empty') return `${head}🚨 <b>Nguồn ${esc(r.name)} đã HẾT TIỀN</b> (số dư ${bal})\nCông cụ của nguồn này sẽ lỗi — nạp thêm ngay ở nhà cung cấp.`;
    return `${head}🔔 <b>Nguồn ${esc(r.name)} sắp hết tiền</b>\nSố dư ${bal} ≤ ngưỡng ${fmt(r.threshold!)}. Nên nạp thêm sớm.`;
  }

  /** Nội dung lệnh /sources */
  private formatList(rows: ProviderBalanceRow[]) {
    if (!rows.length) return 'Chưa có nguồn API nào đang bật hỗ trợ đọc số dư.';
    const icon: Record<BalanceLevel, string> = { ok: '🟢', low: '🟡', empty: '🔴', error: '⚪️' };
    return [
      '<b>Số dư nguồn API</b>',
      ...rows.map((r) => `${icon[r.level]} ${esc(r.name)}: ${r.balance === null ? esc(r.error ?? 'lỗi') : `<b>${fmt(r.balance)}</b> ${esc(r.unit ?? '')}`}${r.threshold !== null ? ` (ngưỡng ${fmt(r.threshold)})` : ''}`),
    ].join('\n');
  }

  /** Nội dung lệnh /stats — số liệu từ 0h hôm nay (giờ Việt Nam) */
  private async todayStats() {
    const now = new Date();
    // 0h hôm nay theo UTC+7
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (now.getUTCHours() >= 17 ? 1 : 0), -7));
    const [users, topups, plans, tasks] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: since }, deletedAt: null } }),
      this.prisma.paymentTransaction.aggregate({ where: { purpose: 'wallet', status: 'PAID', updatedAt: { gte: since } }, _sum: { amount: true }, _count: true }),
      this.prisma.creditPurchase.aggregate({ where: { createdAt: { gte: since } }, _sum: { paid: true }, _count: true }),
      this.prisma.aiTask.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
    ]);
    const t = Object.fromEntries(tasks.map((x) => [x.status, x._count])) as Record<string, number>;
    const total = tasks.reduce((s, x) => s + x._count, 0);
    return [
      '<b>Thống kê hôm nay</b>',
      `👤 Thành viên mới: ${users}`,
      `💰 Nạp tiền: ${topups._count} giao dịch · ${fmt(Number(topups._sum.amount ?? 0))}đ`,
      `🛒 Mua gói: ${plans._count} lượt · ${fmt(Number(plans._sum.paid ?? 0))}đ`,
      `🤖 Tác vụ AI: ${total} (✅ ${t.SUCCEEDED ?? 0} · ❌ ${t.FAILED ?? 0} · ⏳ ${(t.PENDING ?? 0) + (t.PROCESSING ?? 0)})`,
    ].join('\n');
  }
}
