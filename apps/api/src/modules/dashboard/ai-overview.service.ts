import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { hasPermission } from '@cmsnt/shared';
import pg from 'pg';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AI_PROVIDERS as ADAPTER_PROVIDERS } from '../ai/providers/index.js';
import { hideProviderText, publicToolKey } from '../ai/ai-public-key.js';
import type { AiPricing } from '../ai/ai.types.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { isChildSite, shouldHideAiProviders } from '../../common/utils/tenant.js';

/** Nhà cung cấp AI (khớp nhóm cài đặt `ai_<key>` và PROVIDERS ở admin ai-tabs.tsx) */
const AI_PROVIDERS = [
  { key: 'tmc', name: 'TMC Video AI' },
  { key: 'kapend', name: 'Kapend' },
  { key: 'aideepcut', name: 'AI DeepCut' },
  { key: 'imgstudio', name: 'IMG Studio' },
  { key: 'ahiep', name: 'AHiep API' },
  { key: 'tavtavvideo', name: 'tavtavvideo' },
  { key: 'runup', name: 'Runup Studio' },
  { key: 'fable', name: 'Fable Studio' },
  { key: 'up4k', name: 'Up4K' },
  { key: 'ivoi', name: 'iVoi TTS' },
  { key: 'tramsangtao', name: 'Trạm Sáng Tạo' },
  { key: 'gommo', name: '79AI (GoMMO)' },
  { key: 'botsd', name: 'BotSD (botsd.pro)' },
  { key: 'maivideo', name: 'MaiVideo (maivideo.top)' },
  { key: 'aishop24', name: 'AIShop24 (aishop24.io.vn)' },
  { key: 'plenxai', name: 'PlenxAI (plenxai.com)' },
  { key: 'seedancebot', name: 'Seedance Studio (seedancecreationbot.online)' },
  { key: 'novaihub', name: 'NovAI Hub' },
];

/** Múi giờ Việt Nam (+7) — ngày trên biểu đồ / "hôm nay" tính theo giờ VN, không theo UTC */
const VN_OFFSET = 7 * 3600_000;
/** Tác vụ chạy quá lâu coi như bị treo, cần admin xem */
const STUCK_MINUTES = 30;

/** Ngày VN (YYYY-MM-DD) của một thời điểm */
const vnDay = (d: Date) => new Date(d.getTime() + VN_OFFSET).toISOString().slice(0, 10);
/** 0 giờ ngày VN chứa thời điểm `d` (trả về Date UTC) */
const vnMidnight = (d: Date) => new Date(Date.parse(`${vnDay(d)}T00:00:00Z`) - VN_OFFSET);
/** % thay đổi so với kỳ trước (kỳ trước = 0 mà kỳ này có -> 100%) */
const pct = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100));
const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * Tổng quan kinh doanh AI Studio cho trang /admin/dashboard: tiền nạp ví, bán gói cước, tác vụ AI, credits,
 * khách hàng, tiếp thị liên kết. Phần nào người xem không có quyền thì trả `null` (giao diện tự ẩn).
 */
@Injectable()
export class AiOverviewService implements OnModuleDestroy {
  private readonly childPools = new Map<string, { url: string; pool: pg.Pool }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleDestroy() {
    const pools = [...this.childPools.values()].map((x) => x.pool.end().catch(() => undefined));
    this.childPools.clear();
    await Promise.all(pools);
  }

  /** Danh sách kết nối PostgreSQL của các Web con đang hoạt động (đọc động từ NovAI Hub để gộp doanh thu & chi phí real-time — T-375) */
  private getActiveChildPools(): { code: string; domain: string; pool: pg.Pool }[] {
    if (isChildSite()) return [];
    const sitesFile = '/var/www/novai-hub/data/sites.json';
    if (!existsSync(sitesFile)) return [];
    try {
      const raw = JSON.parse(readFileSync(sitesFile, 'utf8'));
      const sites = Array.isArray(raw) ? raw : raw?.sites ?? [];
      const out: { code: string; domain: string; pool: pg.Pool }[] = [];
      for (const s of sites) {
        const code = String(s?.code ?? '').trim().toLowerCase();
        if (!/^[a-z][a-z0-9]{1,19}$/.test(code) || s?.status !== 'active') continue;
        const envFile = join('/var/www/novai-sites', code, 'env.json');
        if (!existsSync(envFile)) continue;
        const envData = JSON.parse(readFileSync(envFile, 'utf8'));
        const rawUrl = String(envData?.api?.DATABASE_URL ?? '').trim();
        if (!rawUrl) continue;
        const cleanUrl = rawUrl.replace(/([?&])schema=[^&]+(&|$)/, (_m, p1, p2) => (p2 === '&' ? p1 : '')).replace(/[?&]$/, '');
        let entry = this.childPools.get(code);
        if (!entry || entry.url !== cleanUrl) {
          if (entry) void entry.pool.end().catch(() => undefined);
          entry = {
            url: cleanUrl,
            pool: new pg.Pool({
              connectionString: cleanUrl,
              max: 2,
              idleTimeoutMillis: 20_000,
              connectionTimeoutMillis: 5_000,
            }),
          };
          this.childPools.set(code, entry);
        }
        out.push({ code, domain: String(s?.domain ?? code), pool: entry.pool });
      }
      return out;
    } catch {
      return [];
    }
  }

  async overview(days: number, user: AuthUser) {
    const can = (p: string) => hasPermission(user.permissions, p);
    const canMoney = can('payments.read') || can('users.wallet');
    const canCredits = can('credits.read') || can('credits.plans');
    const canTasks = can('ai.tasks');
    const canUsers = can('users.read');
    const canAff = can('affiliate.manage');

    const hideProviders = shouldHideAiProviders(user);
    const now = new Date();
    const today = vnMidnight(now);
    // kỳ hiện tại = `days` ngày gần nhất tính cả hôm nay (theo ngày VN), kỳ trước = `days` ngày liền trước
    const since = new Date(today.getTime() - (days - 1) * 86400_000);
    const prevSince = new Date(since.getTime() - days * 86400_000);

    const [money, credits, tasks, users, affiliate, providers] = await Promise.all([
      canMoney ? this.money(since, prevSince, today) : null,
      canCredits ? this.credits(since, prevSince, today) : null,
      canTasks ? this.tasks(since, prevSince, today, now, hideProviders) : null,
      canUsers ? this.users(since, prevSince, today, now) : null,
      canAff ? this.affiliate(since) : null,
      !hideProviders && can('ai.tools') ? this.providers() : null,
    ]);

    // biểu đồ theo ngày: gộp các chuỗi được phép xem, ngày trống = 0
    const series = await this.series(since, { money: canMoney, credits: canCredits, tasks: canTasks, users: canUsers });
    const chart: { date: string; deposits: number; sales: number; tasks: number; credits: number; users: number }[] = [];
    for (let i = 0; i < days; i++) {
      const key = vnDay(new Date(since.getTime() + i * 86400_000));
      const s = series.get(key);
      chart.push({ date: key, deposits: s?.deposits ?? 0, sales: s?.sales ?? 0, tasks: s?.tasks ?? 0, credits: s?.credits ?? 0, users: s?.users ?? 0 });
    }

    return { days, hideProviders, money, credits, tasks, users, affiliate, providers, chart };
  }

  /** Tiền nạp vào ví: tách theo nguồn (cổng thanh toán, thẻ cào, admin cộng tay, rút hoa hồng về ví) */
  private async money(since: Date, prevSince: Date, today: Date) {
    // nguồn nạp lấy từ meta.source của giao dịch ví DEPOSIT; không có source = admin cộng tay
    const bySource = (from: Date, to?: Date) => this.prisma.$queryRaw<{ source: string; provider: string | null; total: number; count: bigint }[]>`
      SELECT COALESCE(meta->>'source', 'admin') AS source, meta->>'provider' AS provider,
        COALESCE(SUM(amount), 0)::float AS total, COUNT(*) AS count
      FROM wallet_transactions
      WHERE type = 'DEPOSIT' AND "createdAt" >= ${from} AND "createdAt" < ${to ?? new Date('9999-01-01')}
      GROUP BY 1, 2`;
    const [cur, prev, todayRows, allTime, balance, pendingCards, needsRefund, recent, topDepositors] = await Promise.all([
      bySource(since),
      bySource(prevSince, since),
      bySource(today),
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT COALESCE(SUM(amount), 0)::float AS total FROM wallet_transactions
        WHERE type = 'DEPOSIT' AND meta->>'source' IN ('gateway', 'card_topup')`,
      this.prisma.user.aggregate({ where: { deletedAt: null }, _sum: { walletBalance: true } }),
      this.prisma.cardTopup.count({ where: { status: 'PENDING' } }),
      // nhận tiền nhưng không cộng được (đơn huỷ / trùng) -> cần hoàn tay cho khách
      this.prisma.paymentTransaction.count({ where: { needsRefund: true } }),
      this.prisma.walletTransaction.findMany({
        where: { type: 'DEPOSIT' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, amount: true, note: true, meta: true, createdAt: true, user: { select: { id: true, name: true, email: true } } },
      }),
      // khách nạp nhiều nhất trong kỳ (chỉ tính tiền thật: cổng + thẻ cào)
      this.prisma.$queryRaw<{ id: string; name: string; email: string; total: number; count: bigint }[]>`
        SELECT u.id, u.name, u.email, SUM(w.amount)::float AS total, COUNT(*) AS count
        FROM wallet_transactions w JOIN users u ON u.id = w."userId"
        WHERE w.type = 'DEPOSIT' AND w.meta->>'source' IN ('gateway', 'card_topup') AND w."createdAt" >= ${since}
        GROUP BY u.id ORDER BY total DESC LIMIT 5`,
    ]);
    // tiền thật khách trả = cổng thanh toán + thẻ cào (không tính admin cộng tay / hoa hồng rút về ví)
    const real = (rows: { source: string; total: number }[]) => rows.filter((r) => r.source === 'gateway' || r.source === 'card_topup').reduce((s, r) => s + num(r.total), 0);
    const count = (rows: { source: string; count: bigint }[]) => rows.filter((r) => r.source === 'gateway' || r.source === 'card_topup').reduce((s, r) => s + num(r.count), 0);
    const SOURCE_LABEL: Record<string, string> = { card_topup: 'Thẻ cào', admin: 'Admin cộng tay', affiliate_payout: 'Rút hoa hồng về ví' };
    const deposits = real(cur);
    const prevDeposits = real(prev);
    return {
      deposits,
      depositsCount: count(cur),
      depositsChange: pct(deposits, prevDeposits),
      depositsToday: real(todayRows),
      depositsAllTime: num(allTime[0]?.total),
      walletBalance: num(balance._sum.walletBalance),
      pendingCards,
      needsRefund,
      // cơ cấu nguồn nạp trong kỳ (cổng tách theo nhà cung cấp: PAY2S, SEPAY, PAYOS...)
      bySource: cur
        .map((r) => ({ name: r.source === 'gateway' ? (r.provider ?? 'cổng').toUpperCase() : (SOURCE_LABEL[r.source] ?? r.source), value: num(r.total), count: num(r.count), real: r.source === 'gateway' || r.source === 'card_topup' }))
        .sort((a, b) => b.value - a.value),
      recent: recent.map((r) => ({ ...r, amount: num(r.amount), source: ((r.meta ?? {}) as { source?: string }).source ?? 'admin' })),
      topDepositors: topDepositors.map((r) => ({ ...r, total: num(r.total), count: num(r.count) })),
    };
  }

  /** Bán gói cước (trừ ví) + credits đã cấp / đã dùng */
  private async credits(since: Date, prevSince: Date, today: Date) {
    const sales = (from: Date, to?: Date) => this.prisma.creditPurchase.aggregate({ where: { createdAt: { gte: from, ...(to ? { lt: to } : {}) } }, _sum: { paid: true, credits: true }, _count: true });
    // credits dùng thực = USAGE (âm) trừ phần đã hoàn (REFUND, dương)
    const used = (from: Date, to?: Date) =>
      this.prisma.creditTransaction.groupBy({ by: ['type'], where: { type: { in: ['USAGE', 'REFUND'] }, createdAt: { gte: from, ...(to ? { lt: to } : {}) } }, _sum: { amount: true } });
    const netUsed = (rows: { type: string; _sum: { amount: number | null } }[]) => -rows.reduce((s, r) => s + num(r._sum.amount), 0);
    const [cur, prev, todaySales, allTime, usedCur, usedPrev, issued, balance, activePlans, byPlan, recent] = await Promise.all([
      sales(since),
      sales(prevSince, since),
      sales(today),
      this.prisma.creditPurchase.aggregate({ _sum: { paid: true } }),
      used(since),
      used(prevSince, since),
      // tiền cộng vào số dư trong kỳ do AI Studio: mua gói, tặng, điều chỉnh
      this.prisma.creditTransaction.groupBy({ by: ['type'], where: { type: { in: ['PURCHASE', 'BONUS', 'ADJUST'] }, createdAt: { gte: since } }, _sum: { amount: true } }),
      // tổng số dư khách đang giữ (số dư ví = số dư chạy AI, VND)
      this.prisma.user.aggregate({ where: { deletedAt: null }, _sum: { walletBalance: true } }),
      // khách đang có gói còn hạn, theo từng gói
      this.prisma.user.groupBy({ by: ['planId'], where: { deletedAt: null, planId: { not: null }, planExpiresAt: { gt: new Date() } }, _count: true }),
      this.prisma.creditPurchase.groupBy({ by: ['planName'], where: { createdAt: { gte: since } }, _sum: { paid: true }, _count: true, orderBy: { _sum: { paid: 'desc' } } }),
      this.prisma.creditPurchase.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, code: true, planName: true, paid: true, credits: true, cycle: true, createdAt: true, user: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    const plans = activePlans.length ? await this.prisma.creditPlan.findMany({ where: { id: { in: activePlans.map((p) => p.planId!) } }, select: { id: true, name: true } }) : [];
    const revenue = num(cur._sum.paid);
    const prevRevenue = num(prev._sum.paid);
    const usedNow = netUsed(usedCur);
    return {
      sales: revenue,
      salesCount: cur._count,
      salesChange: pct(revenue, prevRevenue),
      salesToday: num(todaySales._sum.paid),
      salesAllTime: num(allTime._sum.paid),
      creditsUsed: usedNow,
      creditsUsedChange: pct(usedNow, netUsed(usedPrev)),
      creditsIssued: issued.reduce((s, r) => s + num(r._sum.amount), 0),
      creditBalance: num(balance._sum.walletBalance),
      activePlanUsers: activePlans.reduce((s, p) => s + p._count, 0),
      activePlans: activePlans.map((p) => ({ name: plans.find((x) => x.id === p.planId)?.name ?? 'Gói đã xoá', value: p._count })).sort((a, b) => b.value - a.value),
      byPlan: byPlan.map((p) => ({ name: p.planName, value: num(p._sum.paid), count: p._count })),
      recent: recent.map((r) => ({ ...r, paid: num(r.paid) })),
    };
  }

  /** Tác vụ AI: số lượng, tỉ lệ thành công, theo nhà cung cấp / công cụ, công cụ tạo >30 phút nhiều nhất, tác vụ treo */
  private async tasks(since: Date, prevSince: Date, today: Date, now: Date, hideProviders = false) {
    const stuckBefore = new Date(now.getTime() - STUCK_MINUTES * 60_000);
    const [byStatus, prevCount, todayCount, running, stuck, failed24h, byProvider, topTools, slowCountRows, slowTools, recent, topUsers] = await Promise.all([
      this.prisma.aiTask.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
      this.prisma.aiTask.count({ where: { createdAt: { gte: prevSince, lt: since } } }),
      this.prisma.aiTask.count({ where: { createdAt: { gte: today } } }),
      this.prisma.aiTask.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      this.prisma.aiTask.count({ where: { status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: stuckBefore } } }),
      this.prisma.aiTask.count({ where: { status: 'FAILED', createdAt: { gte: new Date(now.getTime() - 86400_000) } } }),
      hideProviders
        ? Promise.resolve([] as { provider: string; total: bigint; ok: bigint; failed: bigint; credits: number }[])
        : this.prisma.$queryRaw<{ provider: string; total: bigint; ok: bigint; failed: bigint; credits: number }[]>`
            SELECT provider, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'SUCCEEDED') AS ok,
              COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
              COALESCE(SUM(credits) FILTER (WHERE NOT refunded), 0)::float AS credits
            FROM ai_tasks WHERE "createdAt" >= ${since}
            GROUP BY provider ORDER BY total DESC`,
      this.prisma.$queryRaw<{ key: string; name: string; category: string; provider: string; total: bigint; ok: bigint; failed: bigint; credits: number }[]>`
        SELECT t."toolKey" AS key, tl.name, tl.category, tl.provider, COUNT(*) AS total,
          COUNT(*) FILTER (WHERE t.status = 'SUCCEEDED') AS ok,
          COUNT(*) FILTER (WHERE t.status = 'FAILED') AS failed,
          COALESCE(SUM(t.credits) FILTER (WHERE NOT t.refunded), 0)::float AS credits
        FROM ai_tasks t JOIN ai_tools tl ON tl.key = t."toolKey"
        WHERE t."createdAt" >= ${since}
        GROUP BY t."toolKey", tl.name, tl.category, tl.provider ORDER BY total DESC LIMIT 8`,
      this.prisma.$queryRaw<{ cnt: bigint }[]>`
        SELECT COUNT(*) AS cnt
        FROM ai_tasks t
        WHERE t."createdAt" >= ${since}
          AND EXTRACT(EPOCH FROM (
            COALESCE(
              t."completedAt",
              CASE WHEN t.status IN ('PENDING', 'PROCESSING') THEN ${now} ELSE t."updatedAt" END
            ) - t."createdAt"
          )) >= 1800`,
      this.prisma.$queryRaw<{
        key: string;
        name: string;
        category: string;
        provider: string;
        total: bigint;
        slow: bigint;
        slow_ok: bigint;
        slow_failed: bigint;
        slow_running: bigint;
        avg_minutes: number;
        max_minutes: number;
      }[]>`
        WITH task_durs AS (
          SELECT
            t."toolKey" AS key,
            tl.name,
            tl.category,
            tl.provider,
            t.status,
            EXTRACT(EPOCH FROM (
              COALESCE(
                t."completedAt",
                CASE WHEN t.status IN ('PENDING', 'PROCESSING') THEN ${now} ELSE t."updatedAt" END
              ) - t."createdAt"
            )) AS dur_sec
          FROM ai_tasks t
          JOIN ai_tools tl ON tl.key = t."toolKey"
          WHERE t."createdAt" >= ${since}
        )
        SELECT
          key,
          name,
          category,
          provider,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE dur_sec >= 1800) AS slow,
          COUNT(*) FILTER (WHERE dur_sec >= 1800 AND status = 'SUCCEEDED') AS slow_ok,
          COUNT(*) FILTER (WHERE dur_sec >= 1800 AND status IN ('FAILED', 'CANCELLED')) AS slow_failed,
          COUNT(*) FILTER (WHERE dur_sec >= 1800 AND status IN ('PENDING', 'PROCESSING')) AS slow_running,
          COALESCE(ROUND((AVG(dur_sec) FILTER (WHERE dur_sec >= 1800) / 60.0)::numeric, 1), 0)::float AS avg_minutes,
          COALESCE(ROUND((MAX(dur_sec) FILTER (WHERE dur_sec >= 1800) / 60.0)::numeric, 1), 0)::float AS max_minutes
        FROM task_durs
        GROUP BY key, name, category, provider
        HAVING COUNT(*) FILTER (WHERE dur_sec >= 1800) > 0
        ORDER BY slow DESC, avg_minutes DESC, total DESC
        LIMIT 8`,
      this.prisma.aiTask.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, code: true, status: true, credits: true, refunded: true, provider: true, error: true, createdAt: true, tool: { select: { name: true } }, user: { select: { id: true, name: true, email: true } } },
      }),
      // khách dùng AI nhiều nhất trong kỳ (theo credits thực tiêu)
      this.prisma.$queryRaw<{ id: string; name: string; email: string; tasks: bigint; credits: number }[]>`
        SELECT u.id, u.name, u.email, COUNT(*) AS tasks, COALESCE(SUM(t.credits) FILTER (WHERE NOT t.refunded), 0)::float AS credits
        FROM ai_tasks t JOIN users u ON u.id = t."userId"
        WHERE t."createdAt" >= ${since}
        GROUP BY u.id ORDER BY credits DESC, tasks DESC LIMIT 5`,
    ]);
    const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count])) as Record<string, number>;
    const total = byStatus.reduce((s, r) => s + r._count, 0);
    const done = (counts.SUCCEEDED ?? 0) + (counts.FAILED ?? 0);
    const providerName = (k: string) =>
      AI_PROVIDERS.find((p) => p.key === k)?.name ??
      ADAPTER_PROVIDERS.find((p) => p.key === k)?.name ??
      k;
    return {
      total,
      change: pct(total, prevCount),
      today: todayCount,
      counts,
      // tỉ lệ thành công trên các tác vụ đã có kết quả (bỏ qua đang chạy / khách huỷ)
      successRate: done ? Math.round(((counts.SUCCEEDED ?? 0) / done) * 1000) / 10 : null,
      running,
      stuck,
      failed24h,
      slow30m: num(slowCountRows[0]?.cnt),
      byProvider: hideProviders
        ? []
        : byProvider.map((r) => ({ key: r.provider, name: providerName(r.provider), total: num(r.total), ok: num(r.ok), failed: num(r.failed), credits: num(r.credits) })),
      topTools: topTools.map((r) => ({
        ...r,
        key: hideProviders ? publicToolKey(r.key) : r.key,
        name: hideProviders ? hideProviderText(r.name) : r.name,
        provider: hideProviders ? '' : r.provider,
        providerName: hideProviders ? '' : providerName(r.provider),
        total: num(r.total),
        ok: num(r.ok),
        failed: num(r.failed),
        credits: num(r.credits),
      })),
      slowTools: slowTools.map((r) => ({
        key: hideProviders ? publicToolKey(r.key) : r.key,
        name: hideProviders ? hideProviderText(r.name) : r.name,
        category: r.category,
        provider: hideProviders ? '' : r.provider,
        providerName: hideProviders ? '' : providerName(r.provider),
        total: num(r.total),
        slow: num(r.slow),
        slowOk: num(r.slow_ok),
        slowFailed: num(r.slow_failed),
        slowRunning: num(r.slow_running),
        avgMinutes: num(r.avg_minutes),
        maxMinutes: num(r.max_minutes),
      })),
      recent: hideProviders
        ? recent.map((t) => ({ ...t, provider: '', error: hideProviderText(t.error), tool: { name: hideProviderText(t.tool.name) } }))
        : recent,
      topUsers: topUsers.map((r) => ({ ...r, tasks: num(r.tasks), credits: num(r.credits) })),
    };
  }

  /** Khách hàng: tổng, mới đăng ký, đang hoạt động */
  private async users(since: Date, prevSince: Date, today: Date, now: Date) {
    const customer = { deletedAt: null, role: { slug: 'customer' } };
    const [total, fresh, prev, todayCount, active7d, locked, recent] = await Promise.all([
      this.prisma.user.count({ where: customer }),
      this.prisma.user.count({ where: { ...customer, createdAt: { gte: since } } }),
      this.prisma.user.count({ where: { ...customer, createdAt: { gte: prevSince, lt: since } } }),
      this.prisma.user.count({ where: { ...customer, createdAt: { gte: today } } }),
      this.prisma.user.count({ where: { ...customer, lastLoginAt: { gte: new Date(now.getTime() - 7 * 86400_000) } } }),
      this.prisma.user.count({ where: { ...customer, status: { not: 'ACTIVE' } } }),
      this.prisma.user.findMany({
        where: customer,
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { id: true, name: true, email: true, createdAt: true, walletBalance: true, referredBy: { select: { name: true } } },
      }),
    ]);
    return { total, new: fresh, newChange: pct(fresh, prev), today: todayCount, active7d, locked, recent: recent.map((u) => ({ ...u, walletBalance: num(u.walletBalance) })) };
  }

  /** Tiếp thị liên kết: hoa hồng trong kỳ, yêu cầu rút chờ duyệt */
  private async affiliate(since: Date) {
    const [commission, pending, balance, referred] = await Promise.all([
      this.prisma.affiliateTransaction.aggregate({ where: { type: 'COMMISSION', createdAt: { gte: since } }, _sum: { amount: true } }),
      this.prisma.affiliatePayout.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      this.prisma.user.aggregate({ where: { deletedAt: null }, _sum: { affiliateBalance: true } }),
      this.prisma.user.count({ where: { deletedAt: null, referredById: { not: null }, createdAt: { gte: since } } }),
    ]);
    return {
      commission: num(commission._sum.amount),
      pendingPayouts: pending._count,
      pendingPayoutAmount: num(pending._sum.amount),
      balance: num(balance._sum.affiliateBalance),
      referred,
    };
  }

  /** Trạng thái kết nối nhà cung cấp AI (bật + có khoá API) */
  private async providers() {
    const rows = await Promise.all(AI_PROVIDERS.map((p) => this.settings.get<{ enabled?: boolean; apiKey?: string }>(`ai_${p.key}`)));
    const tools = await this.prisma.aiTool.groupBy({ by: ['provider'], where: { enabled: true }, _count: true });
    return AI_PROVIDERS.map((p, i) => ({
      key: p.key,
      name: p.name,
      enabled: rows[i].enabled === true,
      hasKey: !!rows[i].apiKey,
      tools: tools.find((t) => t.provider === p.key)?._count ?? 0,
    }));
  }

  /** Chuỗi theo ngày VN cho biểu đồ — chỉ truy vấn chuỗi người xem được phép */
  private async series(since: Date, allow: { money: boolean; credits: boolean; tasks: boolean; users: boolean }) {
    // "createdAt" lưu UTC (timestamp không múi giờ) -> đổi sang giờ VN rồi mới cắt theo ngày
    const day = (col: string) => `to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
    const q = (sql: string) => this.prisma.$queryRawUnsafe<{ day: string; v: number }[]>(sql, since);
    const [deposits, sales, tasks, credits, users] = await Promise.all([
      allow.money ? q(`SELECT ${day('"createdAt"')} AS day, SUM(amount)::float AS v FROM wallet_transactions WHERE type = 'DEPOSIT' AND meta->>'source' IN ('gateway', 'card_topup') AND "createdAt" >= $1 GROUP BY 1`) : [],
      allow.credits ? q(`SELECT ${day('"createdAt"')} AS day, SUM(paid)::float AS v FROM credit_purchases WHERE "createdAt" >= $1 GROUP BY 1`) : [],
      allow.tasks ? q(`SELECT ${day('"createdAt"')} AS day, COUNT(*)::float AS v FROM ai_tasks WHERE "createdAt" >= $1 GROUP BY 1`) : [],
      allow.credits ? q(`SELECT ${day('"createdAt"')} AS day, (-SUM(amount))::float AS v FROM credit_transactions WHERE type IN ('USAGE', 'REFUND') AND "createdAt" >= $1 GROUP BY 1`) : [],
      allow.users
        ? q(`SELECT ${day('u."createdAt"')} AS day, COUNT(*)::float AS v FROM users u JOIN roles r ON r.id = u."roleId" WHERE r.slug = 'customer' AND u."deletedAt" IS NULL AND u."createdAt" >= $1 GROUP BY 1`)
        : [],
    ]);
    const map = new Map<string, { deposits: number; sales: number; tasks: number; credits: number; users: number }>();
    const put = (rows: { day: string; v: number }[], k: 'deposits' | 'sales' | 'tasks' | 'credits' | 'users') => {
      for (const r of rows) {
        const cur = map.get(r.day) ?? { deposits: 0, sales: 0, tasks: 0, credits: 0, users: 0 };
        cur[k] = num(r.v);
        map.set(r.day, cur);
      }
    };
    put(deposits, 'deposits');
    put(sales, 'sales');
    put(tasks, 'tasks');
    put(credits, 'credits');
    put(users, 'users');
    return map;
  }

  /**
   * Thống kê doanh thu, chi phí nguồn, lợi nhuận và tổng số đơn hàng theo từng website nguồn (AI Provider),
   * hỗ trợ lọc nhanh (`today`, `yesterday`, `7d`, `30d`, `this_month`), khoảng ngày bất kỳ (`from`..`to` theo giờ VN),
   * và gộp real-time cả Web chính + toàn bộ Web con đang chạy (`scope`: `all` | `main` | `children` — T-375).
   */
  async sourceStats(query: { preset?: string; from?: string; to?: string; scope?: string }, user: AuthUser) {
    if (shouldHideAiProviders(user)) return null;
    const can = (p: string) => hasPermission(user.permissions, p);
    if (!can('payments.read') && !can('credits.read') && !can('ai.tasks') && !can('ai.tools')) {
      return null;
    }

    const scope: 'all' | 'main' | 'children' =
      query.scope === 'main' ? 'main' : query.scope === 'children' ? 'children' : 'all';

    const now = new Date();
    const todayStr = vnDay(now);
    const parseYmd = (s?: string): string | null => {
      const clean = String(s ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return null;
      const ms = Date.parse(`${clean}T00:00:00Z`);
      return Number.isFinite(ms) ? clean : null;
    };

    const customFrom = parseYmd(query.from);
    const customTo = parseYmd(query.to);
    let preset = String(query.preset ?? '').trim() || (customFrom || customTo ? 'custom' : 'today');
    let fromDay = todayStr;
    let toDay = todayStr;

    if (preset === 'custom' && (customFrom || customTo)) {
      const a = customFrom ?? customTo!;
      const b = customTo ?? customFrom!;
      fromDay = a <= b ? a : b;
      toDay = a <= b ? b : a;
    } else if (preset === 'yesterday') {
      const y = vnDay(new Date(now.getTime() - 86_400_000));
      fromDay = y;
      toDay = y;
    } else if (preset === '7d') {
      fromDay = vnDay(new Date(now.getTime() - 6 * 86_400_000));
      toDay = todayStr;
    } else if (preset === '30d') {
      fromDay = vnDay(new Date(now.getTime() - 29 * 86_400_000));
      toDay = todayStr;
    } else if (preset === 'this_month') {
      fromDay = `${todayStr.slice(0, 7)}-01`;
      toDay = todayStr;
    } else {
      preset = 'today';
      fromDay = todayStr;
      toDay = todayStr;
    }

    const startUtc = new Date(Date.parse(`${fromDay}T00:00:00Z`) - VN_OFFSET);
    const endUtc = new Date(Date.parse(`${toDay}T00:00:00Z`) - VN_OFFSET + 86_400_000);
    const refundLookaheadUtc = new Date(endUtc.getTime() + 2 * 86_400_000);

    // Chuỗi UTC không múi giờ khớp chính xác kiểu cột `TIMESTAMP WITHOUT TIME ZONE` trên cả Prisma và pg.Pool
    const toPgUtcLiteral = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');
    const startIso = toPgUtcLiteral(startUtc);
    const endIso = toPgUtcLiteral(endUtc);
    const refundIso = toPgUtcLiteral(refundLookaheadUtc);

    type GroupRow = {
      meta_provider: string | null;
      task_provider: string | null;
      tool_key: string | null;
      tool_name: string;
      total_orders: number;
      refunded_orders: number;
      processing_orders: number;
      completed_orders: number;
      processing_revenue: number;
      revenue: number;
      exact_cost: number;
      untracked_revenue: number;
    };

    const sql = `
      WITH refund_rows AS (
        SELECT
          "taskId" AS tid,
          substring(note from '^Hoàn tiền tác vụ (T[A-Za-z0-9]{5,12})$') AS code
        FROM credit_transactions
        WHERE type = 'REFUND'
          AND "createdAt" >= $1::timestamp
          AND "createdAt" < $3::timestamp
      ),
      refund_tids AS (
        SELECT DISTINCT tid FROM refund_rows WHERE tid IS NOT NULL
      ),
      refund_codes AS (
        SELECT DISTINCT code FROM refund_rows WHERE code IS NOT NULL
      ),
      usage_raw AS (
        SELECT
          ct.id,
          ct."taskId" AS tid,
          (-ct.amount)::float AS rev,
          ct.meta->>'provider' AS meta_provider,
          t.provider AS task_provider,
          COALESCE(ct.meta->>'toolKey', t."toolKey") AS tool_key,
          regexp_replace(COALESCE(ct.note, ''), ' · T[A-Za-z0-9]{5,12}$', '') AS tool_name,
          CASE WHEN ct.note LIKE '% · T%' THEN substring(ct.note from ' · (T[A-Za-z0-9]{5,12})$') ELSE NULL END AS task_code,
          ((ct.meta->>'providerCost') IS NOT NULL AND (ct.meta->>'providerCost')::float > 0) AS has_cost,
          COALESCE((ct.meta->>'providerCost')::float, 0) AS meta_cost,
          COALESCE(t.refunded, false) AS task_refunded,
          (t.id IS NOT NULL AND t.status IN ('PENDING', 'PROCESSING')) AS is_processing
        FROM credit_transactions ct
        LEFT JOIN ai_tasks t ON t.id = ct."taskId"
        WHERE ct.type = 'USAGE'
          AND ct."createdAt" >= $1::timestamp
          AND ct."createdAt" < $2::timestamp
      ),
      usage_rows AS (
        SELECT
          u.*,
          (u.task_refunded OR rt.tid IS NOT NULL OR rc.code IS NOT NULL) AS is_refunded
        FROM usage_raw u
        LEFT JOIN refund_tids rt ON u.tid IS NOT NULL AND rt.tid = u.tid
        LEFT JOIN refund_codes rc ON u.task_code IS NOT NULL AND rc.code = u.task_code
      )
      SELECT
        meta_provider,
        task_provider,
        tool_key,
        tool_name,
        COUNT(*)::int AS total_orders,
        COUNT(*) FILTER (WHERE is_refunded)::int AS refunded_orders,
        COUNT(*) FILTER (WHERE NOT is_refunded AND is_processing)::int AS processing_orders,
        COUNT(*) FILTER (WHERE NOT is_refunded AND NOT is_processing)::int AS completed_orders,
        COALESCE(SUM(rev) FILTER (WHERE NOT is_refunded AND is_processing), 0)::float AS processing_revenue,
        COALESCE(SUM(rev) FILTER (WHERE NOT is_refunded AND NOT is_processing), 0)::float AS revenue,
        COALESCE(SUM(meta_cost) FILTER (WHERE NOT is_refunded AND NOT is_processing AND has_cost), 0)::float AS exact_cost,
        COALESCE(SUM(rev) FILTER (WHERE NOT is_refunded AND NOT is_processing AND NOT has_cost), 0)::float AS untracked_revenue
      FROM usage_rows
      GROUP BY 1, 2, 3, 4
    `;

    const childTargets = this.getActiveChildPools();
    const [mainGroups, childResults, toolRows, providerSettings] = await Promise.all([
      scope === 'children'
        ? Promise.resolve([] as GroupRow[])
        : this.prisma.$queryRawUnsafe<GroupRow[]>(sql, startIso, endIso, refundIso),
      scope === 'main'
        ? Promise.resolve([] as GroupRow[][])
        : Promise.all(
            childTargets.map((c) =>
              c.pool
                .query<GroupRow>(sql, [startIso, endIso, refundIso])
                .then((r) => r.rows)
                .catch(() => [] as GroupRow[]),
            ),
          ),
      this.prisma.aiTool.findMany({
        select: { key: true, name: true, modelLabel: true, provider: true, enabled: true, pricing: true, options: true, createdAt: true },
      }),
      Promise.all(AI_PROVIDERS.map((p) => this.settings.get<{ enabled?: boolean; apiKey?: string }>(`ai_${p.key}`))),
    ]);

    const mainOrderCount = mainGroups.reduce((s, r) => s + num(r.total_orders), 0);
    const childGroupsFlat = childResults.flat();
    const childOrderCount = childGroupsFlat.reduce((s, r) => s + num(r.total_orders), 0);
    const groups: GroupRow[] = [...mainGroups, ...childGroupsFlat];

    // Bản đồ tra cứu công cụ theo key & tên để quy chiếu cả đơn lịch sử >24h đã dọn ai_tasks
    const defaultPricingByKey = new Map<string, AiPricing>();
    const websiteByProvider = new Map<string, string>();
    for (const p of ADAPTER_PROVIDERS) {
      if (p.website) websiteByProvider.set(p.key, p.website.replace(/^https?:\/\//, '').replace(/\/$/, ''));
      for (const t of p.tools) defaultPricingByKey.set(`${p.key}.${t.key}`, t.pricing);
    }

    const toolByKey = new Map(toolRows.map((r) => [r.key, r]));
    const sortedForName = [...toolRows].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const runsA = Number((a.options as Record<string, unknown> | null)?.archivedRuns ?? 0);
      const runsB = Number((b.options as Record<string, unknown> | null)?.archivedRuns ?? 0);
      if (runsB !== runsA) return runsB - runsA;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const toolByName = new Map<string, (typeof toolRows)[number]>();
    for (const r of sortedForName) {
      const n1 = r.name.trim();
      if (n1 && !toolByName.has(n1)) toolByName.set(n1, r);
      const n2 = (r.modelLabel ?? '').trim();
      if (n2 && !toolByName.has(n2)) toolByName.set(n2, r);
    }

    const effectivePricingOf = (row: (typeof toolRows)[number] | undefined): AiPricing | null => {
      if (!row) return null;
      const baseKey = row.key.includes('~') ? row.key.slice(0, row.key.indexOf('~')) : row.key;
      const defP = defaultPricingByKey.get(baseKey);
      return { ...(defP ?? { mode: 'fixed' }), ...((row.pricing ?? {}) as Partial<AiPricing>) } as AiPricing;
    };

    type Bucket = {
      key: string;
      name: string;
      website: string | null;
      enabled: boolean;
      totalOrders: number;
      completedOrders: number;
      processingOrders: number;
      refundedOrders: number;
      processingRevenue: number;
      revenue: number;
      cost: number;
    };

    const buckets = new Map<string, Bucket>();
    for (let i = 0; i < AI_PROVIDERS.length; i++) {
      const p = AI_PROVIDERS[i];
      buckets.set(p.key, {
        key: p.key,
        name: p.name,
        website: websiteByProvider.get(p.key) ?? null,
        enabled: providerSettings[i]?.enabled === true && !!providerSettings[i]?.apiKey,
        totalOrders: 0,
        completedOrders: 0,
        processingOrders: 0,
        refundedOrders: 0,
        processingRevenue: 0,
        revenue: 0,
        cost: 0,
      });
    }

    for (const g of groups) {
      const matched = (g.tool_key ? toolByKey.get(g.tool_key) : undefined) ?? toolByName.get(g.tool_name.trim());
      const pKey = g.meta_provider || g.task_provider || matched?.provider || 'other';
      let bucket = buckets.get(pKey);
      if (!bucket) {
        bucket = {
          key: pKey,
          name: pKey === 'other' ? 'Nguồn khác' : pKey,
          website: null,
          enabled: false,
          totalOrders: 0,
          completedOrders: 0,
          processingOrders: 0,
          refundedOrders: 0,
          processingRevenue: 0,
          revenue: 0,
          cost: 0,
        };
        buckets.set(pKey, bucket);
      }

      const isFlatRental = pKey === 'fable' || pKey === 'tavtavvideo';
      const p = effectivePricingOf(matched);
      const markup = Math.max(0, Number(p?.markup) || 0);
      let estUntrackedCost = 0;
      if (!isFlatRental && num(g.untracked_revenue) > 0) {
        if (markup > 0) {
          estUntrackedCost = Math.round(num(g.untracked_revenue) / (1 + markup / 100));
        } else if (p?.mode === 'cost') {
          estUntrackedCost = Math.round(num(g.untracked_revenue));
        }
      }

      bucket.totalOrders += num(g.total_orders);
      bucket.completedOrders += num(g.completed_orders);
      bucket.processingOrders += num(g.processing_orders);
      bucket.refundedOrders += num(g.refunded_orders);
      bucket.processingRevenue += Math.round(num(g.processing_revenue));
      bucket.revenue += Math.round(num(g.revenue));
      bucket.cost += Math.round(num(g.exact_cost)) + estUntrackedCost;
    }

    const items = [...buckets.values()]
      .filter((b) => b.enabled || b.totalOrders > 0)
      .map((b) => {
        const profit = b.revenue - b.cost;
        const marginPct = b.revenue > 0 ? Math.round((profit / b.revenue) * 1000) / 10 : 0;
        return {
          ...b,
          profit,
          marginPct,
          flatRental: b.key === 'fable' || b.key === 'tavtavvideo',
        };
      })
      .sort((a, b) => b.revenue - a.revenue || b.totalOrders - a.totalOrders || Number(b.enabled) - Number(a.enabled));

    const summary = items.reduce(
      (acc, x) => {
        acc.totalOrders += x.totalOrders;
        acc.completedOrders += x.completedOrders;
        acc.processingOrders += x.processingOrders;
        acc.refundedOrders += x.refundedOrders;
        acc.processingRevenue += x.processingRevenue;
        acc.revenue += x.revenue;
        acc.cost += x.cost;
        acc.profit += x.profit;
        return acc;
      },
      {
        totalOrders: 0,
        completedOrders: 0,
        processingOrders: 0,
        refundedOrders: 0,
        processingRevenue: 0,
        revenue: 0,
        cost: 0,
        profit: 0,
      },
    );
    const marginPct = summary.revenue > 0 ? Math.round((summary.profit / summary.revenue) * 1000) / 10 : 0;

    return {
      preset,
      scope,
      from: fromDay,
      to: toDay,
      updatedAt: new Date().toISOString(),
      childSiteCount: childTargets.length,
      mainOrders: mainOrderCount,
      childOrders: childOrderCount,
      summary: { ...summary, marginPct },
      items,
    };
  }
}
