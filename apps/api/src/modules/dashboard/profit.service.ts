import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { hasPermission } from '@cmsnt/shared';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { isChildSite } from '../../common/utils/tenant.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';

const VN_OFFSET = 7 * 3600_000;
const DAY_MS = 86_400_000;

const vnDay = (d: Date) => new Date(d.getTime() + VN_OFFSET).toISOString().slice(0, 10);
const parseVnStart = (ymd: string): number | null => {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(ms) ? ms - VN_OFFSET : null;
};

export interface ProfitMilestone {
  id: string;
  /** Thời điểm bắt đầu áp dụng (ISO UTC) */
  effectiveAt: string;
  /** % lợi nhuận mặc định (mặc định 10%) */
  basePercent: number;
  /** % tăng/giảm giá của website con so với giá gốc (vd +10% => tổng nhận 20%) */
  markupExtra: number;
  /** Tổng % lợi nhuận thực nhận = max(0, basePercent + markupExtra) */
  totalPercent: number;
  note?: string;
}

export interface ChildProfitConfig {
  basePercent: number;
  markupExtra: number;
  milestones: ProfitMilestone[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundMoney = (n: number) => Math.round(n);

function normalizeConfig(raw: Record<string, unknown> | null | undefined): ChildProfitConfig {
  const basePercent = Number.isFinite(Number(raw?.basePercent)) ? Math.max(0, Math.min(100, round2(Number(raw?.basePercent)))) : 10;
  const markupExtra = Number.isFinite(Number(raw?.markupExtra)) ? Math.max(-100, Math.min(1000, round2(Number(raw?.markupExtra)))) : 0;
  const rawList = Array.isArray(raw?.milestones) ? (raw!.milestones as Record<string, unknown>[]) : [];
  const milestones: ProfitMilestone[] = [];
  for (const m of rawList) {
    if (!m || typeof m !== 'object') continue;
    const ms = Date.parse(String(m.effectiveAt ?? ''));
    if (!Number.isFinite(ms)) continue;
    const b = Number.isFinite(Number(m.basePercent)) ? Math.max(0, Math.min(100, round2(Number(m.basePercent)))) : basePercent;
    const mk = Number.isFinite(Number(m.markupExtra)) ? Math.max(-100, Math.min(1000, round2(Number(m.markupExtra)))) : 0;
    const tot = Number.isFinite(Number(m.totalPercent)) ? Math.max(0, round2(Number(m.totalPercent))) : Math.max(0, round2(b + mk));
    milestones.push({
      id: typeof m.id === 'string' && m.id.trim() ? m.id.trim() : randomUUID(),
      effectiveAt: new Date(ms).toISOString(),
      basePercent: b,
      markupExtra: mk,
      totalPercent: tot,
      note: typeof m.note === 'string' && m.note.trim() ? m.note.trim().slice(0, 200) : undefined,
    });
  }
  milestones.sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));
  if (!milestones.length) {
    const tot = Math.max(0, round2(basePercent + markupExtra));
    milestones.push({
      id: 'initial',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      basePercent,
      markupExtra,
      totalPercent: tot,
      note: markupExtra !== 0 ? `Mức khởi tạo (gốc ${basePercent}% ${markupExtra > 0 ? `+ ${markupExtra}%` : `${markupExtra}%`} giá bán)` : `Mức mặc định ${basePercent}%`,
    });
  }
  const latest = milestones[milestones.length - 1];
  return {
    basePercent: latest.basePercent,
    markupExtra: latest.markupExtra,
    milestones,
  };
}

function findMilestoneAt(milestones: ProfitMilestone[], tsMs: number): ProfitMilestone {
  let chosen = milestones[0];
  for (const m of milestones) {
    if (Date.parse(m.effectiveAt) <= tsMs) chosen = m;
    else break;
  }
  return chosen;
}

@Injectable()
export class ProfitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async getStats(q: { preset?: string; from?: string; to?: string; month?: string }, user: AuthUser) {
    const canView = hasPermission(user.permissions, 'dashboard.view') || hasPermission(user.permissions, 'payments.read');
    if (!canView) throw new ForbiddenException('Bạn không có quyền xem thống kê lợi nhuận');

    const rawCfg = await this.settings.get<Record<string, unknown>>('child_profit');
    const cfg = normalizeConfig(rawCfg);

    const now = new Date();
    const vnNow = new Date(now.getTime() + VN_OFFSET);
    const vnYear = vnNow.getUTCFullYear();
    const vnMonth = vnNow.getUTCMonth(); // 0-11
    const todayYmd = vnDay(now);
    const todayStartMs = parseVnStart(todayYmd)!;

    let preset = q.preset || 'this_month';
    let startMs = parseVnStart(`${vnYear}-${String(vnMonth + 1).padStart(2, '0')}-01`)!;
    let endMs = todayStartMs + DAY_MS;

    if (q.month && /^\d{4}-\d{2}$/.test(q.month)) {
      preset = 'month';
      const [y, m] = q.month.split('-').map(Number);
      startMs = parseVnStart(`${y}-${String(m).padStart(2, '0')}-01`)!;
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      endMs = parseVnStart(`${nextY}-${String(nextM).padStart(2, '0')}-01`)!;
    } else if (preset === 'last_month') {
      const prevY = vnMonth === 0 ? vnYear - 1 : vnYear;
      const prevM = vnMonth === 0 ? 12 : vnMonth;
      startMs = parseVnStart(`${prevY}-${String(prevM).padStart(2, '0')}-01`)!;
      endMs = parseVnStart(`${vnYear}-${String(vnMonth + 1).padStart(2, '0')}-01`)!;
    } else if (preset === 'today') {
      startMs = todayStartMs;
      endMs = todayStartMs + DAY_MS;
    } else if (preset === '7d') {
      startMs = todayStartMs - 6 * DAY_MS;
      endMs = todayStartMs + DAY_MS;
    } else if (preset === '30d') {
      startMs = todayStartMs - 29 * DAY_MS;
      endMs = todayStartMs + DAY_MS;
    } else if (preset === 'all') {
      const firstRow = await this.prisma.$queryRaw<{ min_at: Date | null }[]>`
        SELECT MIN("createdAt") AS min_at
        FROM wallet_transactions
        WHERE type = 'DEPOSIT' AND amount > 0 AND meta->>'source' IN ('gateway', 'card_topup')
      `;
      const minAt = firstRow[0]?.min_at ? vnDay(new Date(firstRow[0].min_at)) : `${vnYear}-${String(vnMonth + 1).padStart(2, '0')}-01`;
      startMs = parseVnStart(minAt)!;
      endMs = todayStartMs + DAY_MS;
    } else if (preset === 'custom' && (q.from || q.to)) {
      const a = q.from ? parseVnStart(q.from) : null;
      const b = q.to ? parseVnStart(q.to) : null;
      const s = a ?? b ?? startMs;
      const e = b ?? a ?? todayStartMs;
      startMs = Math.min(s, e);
      endMs = Math.max(s, e) + DAY_MS;
    }

    const fromDate = new Date(startMs);
    const toDate = new Date(endMs);

    interface RawDepositRow {
      id: string;
      amount: number;
      createdAt: Date;
      provider: string | null;
      source: string;
      userId: string;
      userName: string;
      userEmail: string;
      userDiscount: number;
      planDiscount: number | null;
      listPrice: number | null;
      creditsAmount: number | null;
      purchaseCycle: string | null;
      tierBonus: number;
      promoBonus: number;
      personalBonus: number;
    }

    const calcAdjustments = (r: {
      userDiscount?: number | null;
      planDiscount?: number | null;
      listPrice?: number | null;
      creditsAmount?: number | null;
      purchaseCycle?: string | null;
      tierBonus?: number | null;
      promoBonus?: number | null;
      personalBonus?: number | null;
    }) => {
      let bonusPercent = round2(
        Math.max(0, (Number(r.tierBonus) || 0) + (Number(r.promoBonus) || 0) + (Number(r.personalBonus) || 0)),
      );
      if (
        bonusPercent <= 0 &&
        r.purchaseCycle === 'pack' &&
        Number(r.listPrice) > 0 &&
        Number(r.creditsAmount) > Number(r.listPrice)
      ) {
        bonusPercent = round2(((Number(r.creditsAmount) - Number(r.listPrice)) / Number(r.listPrice)) * 100);
      }
      const discountPercent = round2(
        Math.max(0, Math.min(100, Math.max(Number(r.userDiscount) || 0, Number(r.planDiscount) || 0))),
      );
      return { bonusPercent, discountPercent };
    };

    const [periodRows, allRows] = await Promise.all([
      this.prisma.$queryRaw<RawDepositRow[]>`
        SELECT w.id, w.amount::float AS amount, w."createdAt",
               w.meta->>'provider' AS provider,
               COALESCE(w.meta->>'source', 'gateway') AS source,
               u.id AS "userId", u.name AS "userName", u.email AS "userEmail",
               COALESCE(u."customDiscount"::float, 0) AS "userDiscount",
               cp.discount::float AS "planDiscount",
               cp."listPrice"::float AS "listPrice",
               cp.credits::float AS "creditsAmount",
               cp.cycle AS "purchaseCycle",
               COALESCE((COALESCE(wt_pay.meta, wt_lat.meta)->>'tierBonus')::float, 0) AS "tierBonus",
               COALESCE((COALESCE(wt_pay.meta, wt_lat.meta)->>'promoBonus')::float, 0) AS "promoBonus",
               COALESCE((COALESCE(wt_pay.meta, wt_lat.meta)->>'personalBonus')::float, 0) AS "personalBonus"
        FROM wallet_transactions w
        JOIN users u ON u.id = w."userId"
        LEFT JOIN payment_transactions pt ON pt.id::text = (w.meta->>'transactionId')
        LEFT JOIN credit_purchases cp ON cp.id::text = (pt."rawRequest"->'checkout'->>'purchaseId')
        LEFT JOIN wallet_transactions wt_pay ON wt_pay.id = cp."walletTxnId"
        LEFT JOIN LATERAL (
          SELECT wt2.meta
          FROM wallet_transactions wt2
          WHERE cp.id IS NULL
            AND wt2."userId" = w."userId"
            AND wt2.type = 'PAYMENT'
            AND wt2.meta->>'source' = 'credit_topup'
            AND wt2."createdAt" >= w."createdAt" - interval '5 seconds'
            AND wt2."createdAt" <= w."createdAt" + interval '24 hours'
          ORDER BY ABS(EXTRACT(EPOCH FROM (wt2."createdAt" - w."createdAt"))) ASC
          LIMIT 1
        ) wt_lat ON true
        WHERE w.type = 'DEPOSIT'
          AND w.amount > 0
          AND w.meta->>'source' IN ('gateway', 'card_topup')
          AND w."createdAt" >= ${fromDate}
          AND w."createdAt" < ${toDate}
        ORDER BY w."createdAt" ASC
      `,
      this.prisma.$queryRaw<{
        amount: number;
        createdAt: Date;
        userDiscount: number;
        planDiscount: number | null;
        listPrice: number | null;
        creditsAmount: number | null;
        purchaseCycle: string | null;
        tierBonus: number;
        promoBonus: number;
        personalBonus: number;
      }[]>`
        SELECT w.amount::float AS amount, w."createdAt",
               COALESCE(u."customDiscount"::float, 0) AS "userDiscount",
               cp.discount::float AS "planDiscount",
               cp."listPrice"::float AS "listPrice",
               cp.credits::float AS "creditsAmount",
               cp.cycle AS "purchaseCycle",
               COALESCE((COALESCE(wt_pay.meta, wt_lat.meta)->>'tierBonus')::float, 0) AS "tierBonus",
               COALESCE((COALESCE(wt_pay.meta, wt_lat.meta)->>'promoBonus')::float, 0) AS "promoBonus",
               COALESCE((COALESCE(wt_pay.meta, wt_lat.meta)->>'personalBonus')::float, 0) AS "personalBonus"
        FROM wallet_transactions w
        JOIN users u ON u.id = w."userId"
        LEFT JOIN payment_transactions pt ON pt.id::text = (w.meta->>'transactionId')
        LEFT JOIN credit_purchases cp ON cp.id::text = (pt."rawRequest"->'checkout'->>'purchaseId')
        LEFT JOIN wallet_transactions wt_pay ON wt_pay.id = cp."walletTxnId"
        LEFT JOIN LATERAL (
          SELECT wt2.meta
          FROM wallet_transactions wt2
          WHERE cp.id IS NULL
            AND wt2."userId" = w."userId"
            AND wt2.type = 'PAYMENT'
            AND wt2.meta->>'source' = 'credit_topup'
            AND wt2."createdAt" >= w."createdAt" - interval '5 seconds'
            AND wt2."createdAt" <= w."createdAt" + interval '24 hours'
          ORDER BY ABS(EXTRACT(EPOCH FROM (wt2."createdAt" - w."createdAt"))) ASC
          LIMIT 1
        ) wt_lat ON true
        WHERE w.type = 'DEPOSIT'
          AND w.amount > 0
          AND w.meta->>'source' IN ('gateway', 'card_topup')
        ORDER BY w."createdAt" ASC
      `,
    ]);

    // Tính tích luỹ toàn thời gian theo đúng mốc % của từng thời điểm nạp (trừ KM nạp & giảm giá khách)
    let allTimeDeposits = 0;
    let allTimeGrossProfit = 0;
    let allTimeDeduct = 0;
    let allTimeProfit = 0;
    for (const r of allRows) {
      const amt = Number(r.amount) || 0;
      const m = findMilestoneAt(cfg.milestones, new Date(r.createdAt).getTime());
      const { bonusPercent, discountPercent } = calcAdjustments(r);
      const gross = (amt * m.totalPercent) / 100;
      const deduct = (amt * (bonusPercent + discountPercent)) / 100;
      allTimeDeposits += amt;
      allTimeGrossProfit += gross;
      allTimeDeduct += deduct;
      allTimeProfit += gross - deduct;
    }

    // Dựng các khúc / cột cắt thống kê giao thoa tăng giảm % trong khoảng [startMs, effectiveEndMs]
    const effectiveEndMs = Math.min(endMs, Math.max(startMs + 1, now.getTime()));
    const milestones = cfg.milestones;
    const baseAtStart = findMilestoneAt(milestones, startMs);
    const activeMilestones: { m: ProfitMilestone; segStartMs: number; prevPercent: number | null }[] = [
      { m: baseAtStart, segStartMs: startMs, prevPercent: null },
    ];
    let prevPct = baseAtStart.totalPercent;
    for (const m of milestones) {
      const mMs = Date.parse(m.effectiveAt);
      if (mMs > startMs && mMs < endMs) {
        activeMilestones.push({ m, segStartMs: mMs, prevPercent: prevPct });
        prevPct = m.totalPercent;
      }
    }

    const segments = activeMilestones.map((entry, idx) => {
      const nextStartMs = idx + 1 < activeMilestones.length ? activeMilestones[idx + 1].segStartMs : effectiveEndMs;
      return {
        index: idx + 1,
        milestoneId: entry.m.id,
        milestoneEffectiveAt: entry.m.effectiveAt,
        fromAt: new Date(entry.segStartMs).toISOString(),
        toAt: new Date(Math.max(entry.segStartMs, nextStartMs)).toISOString(),
        isCurrent: idx === activeMilestones.length - 1 && endMs > now.getTime(),
        isCutPoint: idx > 0,
        prevTotalPercent: entry.prevPercent,
        deltaPercent: entry.prevPercent !== null ? round2(entry.m.totalPercent - entry.prevPercent) : 0,
        basePercent: entry.m.basePercent,
        markupExtra: entry.m.markupExtra,
        totalPercent: entry.m.totalPercent,
        note: entry.m.note ?? null,
        depositCount: 0,
        depositTotal: 0,
        grossProfitRaw: 0,
        deductRaw: 0,
        profitRaw: 0,
        grossProfitAmount: 0,
        deductAmount: 0,
        profitAmount: 0,
        segStartMs: entry.segStartMs,
        segEndMs: idx + 1 < activeMilestones.length ? activeMilestones[idx + 1].segStartMs : endMs,
      };
    });

    const dailyMap = new Map<string, { date: string; deposits: number; profitRaw: number; count: number; rates: Set<number> }>();
    const totalDays = Math.min(400, Math.max(1, Math.round((endMs - startMs) / DAY_MS)));
    if (totalDays <= 120) {
      for (let i = 0; i < totalDays; i++) {
        const dKey = vnDay(new Date(startMs + i * DAY_MS));
        dailyMap.set(dKey, { date: dKey, deposits: 0, profitRaw: 0, count: 0, rates: new Set() });
      }
    }

    let periodDeposits = 0;
    let periodGrossProfitRaw = 0;
    let periodBonusDeductRaw = 0;
    let periodDiscountDeductRaw = 0;
    let periodProfitRaw = 0;

    const enrichedDeposits = periodRows.map((r) => {
      const ts = new Date(r.createdAt).getTime();
      const amt = Number(r.amount) || 0;
      let seg = segments[0];
      for (const s of segments) {
        if (ts >= s.segStartMs && ts < s.segEndMs) {
          seg = s;
          break;
        }
      }
      const { bonusPercent, discountPercent } = calcAdjustments(r);
      const deductPercent = round2(bonusPercent + discountPercent);
      const netPercent = round2(seg.totalPercent - deductPercent);
      const grossProfit = (amt * seg.totalPercent) / 100;
      const bonusDeduction = (amt * bonusPercent) / 100;
      const discountDeduction = (amt * discountPercent) / 100;
      const deductAmount = bonusDeduction + discountDeduction;
      const profit = grossProfit - deductAmount;

      seg.depositCount += 1;
      seg.depositTotal += amt;
      seg.grossProfitRaw += grossProfit;
      seg.deductRaw += deductAmount;
      seg.profitRaw += profit;

      periodDeposits += amt;
      periodGrossProfitRaw += grossProfit;
      periodBonusDeductRaw += bonusDeduction;
      periodDiscountDeductRaw += discountDeduction;
      periodProfitRaw += profit;

      const dKey = vnDay(new Date(ts));
      let dBucket = dailyMap.get(dKey);
      if (!dBucket) {
        dBucket = { date: dKey, deposits: 0, profitRaw: 0, count: 0, rates: new Set() };
        dailyMap.set(dKey, dBucket);
      }
      dBucket.deposits += amt;
      dBucket.profitRaw += profit;
      dBucket.count += 1;
      dBucket.rates.add(netPercent);

      return {
        id: r.id,
        amount: roundMoney(amt),
        grossProfit: roundMoney(grossProfit),
        deductAmount: roundMoney(deductAmount),
        profit: roundMoney(profit),
        grossPercent: seg.totalPercent,
        bonusPercent,
        discountPercent,
        percent: netPercent,
        markupExtra: seg.markupExtra,
        segmentIndex: seg.index,
        source: r.source,
        provider: r.provider,
        createdAt: new Date(r.createdAt).toISOString(),
        user: { id: r.userId, name: r.userName, email: r.userEmail },
      };
    });

    for (const s of segments) {
      s.depositTotal = roundMoney(s.depositTotal);
      s.grossProfitAmount = roundMoney(s.grossProfitRaw);
      s.deductAmount = roundMoney(s.deductRaw);
      s.profitAmount = roundMoney(s.profitRaw);
    }

    const latestMilestone = cfg.milestones[cfg.milestones.length - 1];
    const daily = [...dailyMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        date: d.date,
        deposits: roundMoney(d.deposits),
        profit: roundMoney(d.profitRaw),
        count: d.count,
        rates: [...d.rates].sort((a, b) => a - b),
      }));

    return {
      preset,
      from: vnDay(fromDate),
      to: vnDay(new Date(endMs - DAY_MS)),
      canManageRate: user.permissions.includes('*'),
      currentRate: {
        basePercent: latestMilestone.basePercent,
        markupExtra: latestMilestone.markupExtra,
        totalPercent: latestMilestone.totalPercent,
        effectiveAt: latestMilestone.effectiveAt,
      },
      summary: {
        depositTotal: roundMoney(periodDeposits),
        depositCount: periodRows.length,
        grossProfitAmount: roundMoney(periodGrossProfitRaw),
        bonusDeductionAmount: roundMoney(periodBonusDeductRaw),
        discountDeductionAmount: roundMoney(periodDiscountDeductRaw),
        deductAmount: roundMoney(periodBonusDeductRaw + periodDiscountDeductRaw),
        profitAmount: roundMoney(periodProfitRaw),
        allTimeDeposits: roundMoney(allTimeDeposits),
        allTimeDepositCount: allRows.length,
        allTimeGrossProfit: roundMoney(allTimeGrossProfit),
        allTimeDeduct: roundMoney(allTimeDeduct),
        allTimeProfit: roundMoney(allTimeProfit),
        cutCount: Math.max(0, segments.length - 1),
      },
      segments: segments.map(
        ({ segStartMs: _a, segEndMs: _b, grossProfitRaw: _c, deductRaw: _d, profitRaw: _e, ...rest }) => rest,
      ),
      milestones: cfg.milestones,
      daily,
      recentDeposits: enrichedDeposits.reverse().slice(0, 60),
    };
  }

  /** Chỉ Siêu quản trị (`*`) được điều chỉnh % và thêm mốc cắt giao thoa */
  async addMilestone(
    body: { basePercent?: number; markupExtra?: number; effectiveAt?: string; note?: string },
    user: AuthUser,
  ) {
    if (!user.permissions.includes('*')) {
      throw new ForbiddenException('Chỉ chủ hệ thống mới được điều chỉnh mức % lợi nhuận');
    }
    const rawCfg = await this.settings.get<Record<string, unknown>>('child_profit');
    const cfg = normalizeConfig(rawCfg);

    const basePercent =
      body.basePercent !== undefined && Number.isFinite(Number(body.basePercent))
        ? Math.max(0, Math.min(100, round2(Number(body.basePercent))))
        : cfg.basePercent;
    const markupExtra =
      body.markupExtra !== undefined && Number.isFinite(Number(body.markupExtra))
        ? Math.max(-100, Math.min(1000, round2(Number(body.markupExtra))))
        : cfg.markupExtra;
    const totalPercent = Math.max(0, round2(basePercent + markupExtra));

    let effectiveMs = Date.now();
    if (body.effectiveAt && String(body.effectiveAt).trim()) {
      const parsed = Date.parse(String(body.effectiveAt).trim());
      if (!Number.isFinite(parsed)) throw new BadRequestException('Thời điểm áp dụng không hợp lệ');
      effectiveMs = parsed;
    }

    const prev = findMilestoneAt(cfg.milestones, effectiveMs);
    const autoNote =
      body.note?.trim() ||
      (prev
        ? `Điều chỉnh từ ${prev.totalPercent}% → ${totalPercent}% (mặc định ${basePercent}% ${markupExtra >= 0 ? `+ ${markupExtra}%` : `${markupExtra}%`} giá bán)`
        : `Áp dụng mức ${totalPercent}%`);

    const nextMilestones = [
      ...cfg.milestones,
      {
        id: randomUUID(),
        effectiveAt: new Date(effectiveMs).toISOString(),
        basePercent,
        markupExtra,
        totalPercent,
        note: autoNote.slice(0, 200),
      },
    ].sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));

    const latest = nextMilestones[nextMilestones.length - 1];
    const nextCfg: ChildProfitConfig = {
      basePercent: latest.basePercent,
      markupExtra: latest.markupExtra,
      milestones: nextMilestones,
    };

    await this.settings.update('child_profit', nextCfg as unknown as Record<string, unknown>, user.id || null);
    return nextCfg;
  }

  /** Cập nhật trực tiếp mức % hiện tại của mốc cuối cùng (không tách thêm cột cắt mới) */
  async updateCurrentRate(
    body: { basePercent?: number; markupExtra?: number; note?: string },
    user: AuthUser,
  ) {
    if (!user.permissions.includes('*')) {
      throw new ForbiddenException('Chỉ chủ hệ thống mới được điều chỉnh mức % lợi nhuận');
    }
    const rawCfg = await this.settings.get<Record<string, unknown>>('child_profit');
    const cfg = normalizeConfig(rawCfg);

    const basePercent =
      body.basePercent !== undefined && Number.isFinite(Number(body.basePercent))
        ? Math.max(0, Math.min(100, round2(Number(body.basePercent))))
        : cfg.basePercent;
    const markupExtra =
      body.markupExtra !== undefined && Number.isFinite(Number(body.markupExtra))
        ? Math.max(-100, Math.min(1000, round2(Number(body.markupExtra))))
        : cfg.markupExtra;
    const totalPercent = Math.max(0, round2(basePercent + markupExtra));

    const nextMilestones = [...cfg.milestones];
    const lastIdx = nextMilestones.length - 1;
    nextMilestones[lastIdx] = {
      ...nextMilestones[lastIdx],
      basePercent,
      markupExtra,
      totalPercent,
      ...(body.note !== undefined ? { note: body.note.trim().slice(0, 200) || undefined } : {}),
    };

    const nextCfg: ChildProfitConfig = {
      basePercent,
      markupExtra,
      milestones: nextMilestones,
    };
    await this.settings.update('child_profit', nextCfg as unknown as Record<string, unknown>, user.id || null);
    return nextCfg;
  }

  /** Xoá 1 mốc cắt bị nhập nhầm (giữ ít nhất 1 mốc gốc) */
  async removeMilestone(id: string, user: AuthUser) {
    if (!user.permissions.includes('*')) {
      throw new ForbiddenException('Chỉ chủ hệ thống mới được xoá mốc điều chỉnh %');
    }
    const rawCfg = await this.settings.get<Record<string, unknown>>('child_profit');
    const cfg = normalizeConfig(rawCfg);
    if (cfg.milestones.length <= 1) {
      throw new BadRequestException('Phải giữ lại ít nhất 1 mốc cấu hình gốc');
    }
    const filtered = cfg.milestones.filter((m) => m.id !== id);
    const latest = filtered[filtered.length - 1];
    const nextCfg: ChildProfitConfig = {
      basePercent: latest.basePercent,
      markupExtra: latest.markupExtra,
      milestones: filtered,
    };
    await this.settings.update('child_profit', nextCfg as unknown as Record<string, unknown>, user.id || null);
    return nextCfg;
  }

  // ---------------- T-477 & T-478: Bảng tổng hợp & chỉnh sửa Lợi nhuận toàn bộ Web con trên nov.ai.vn ----------------

  private childSitesCache: {
    at: number;
    items: {
      code: string;
      port: number;
      apiBase: string;
      publicOrigin: string;
      domain: string;
      siteName: string;
      serverSecret: string;
    }[];
  } | null = null;

  private assertSuperAdminOnMain(user: AuthUser) {
    if (isChildSite() || !user.permissions.includes('*')) {
      throw new ForbiddenException('Chỉ Siêu quản trị trên Web chính mới được truy cập quản lý lợi nhuận toàn hệ thống web con');
    }
  }

  private async discoverChildSites() {
    if (isChildSite()) return [];
    if (this.childSitesCache && Date.now() - this.childSitesCache.at < 30_000) {
      return this.childSitesCache.items;
    }
    const sitesDir = process.env.NOVAI_SITES_DIR || '/var/www/novai-sites';
    const items: NonNullable<typeof this.childSitesCache>['items'] = [];
    try {
      const entries = await readdir(sitesDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const code = ent.name.trim();
        if (!/^[a-z0-9_-]{1,40}$/i.test(code)) continue;
        try {
          const raw = await readFile(join(sitesDir, code, 'env.json'), 'utf8');
          const parsed = JSON.parse(raw) as {
            api?: { PORT?: string | number; API_PUBLIC_URL?: string; WEB_URL?: string; SERVER_API_SECRET?: string };
            web?: { NEXT_PUBLIC_SITE_NAME?: string };
          };
          const port = Number(parsed.api?.PORT);
          const serverSecret = String(parsed.api?.SERVER_API_SECRET ?? '').trim();
          const publicOrigin = String(parsed.api?.API_PUBLIC_URL || parsed.api?.WEB_URL || '').replace(/\/$/, '');
          if (!port || !serverSecret || !publicOrigin) continue;
          const domain = publicOrigin.replace(/^https?:\/\//, '');
          items.push({
            code,
            port,
            apiBase: `http://127.0.0.1:${port}`,
            publicOrigin,
            domain,
            siteName: String(parsed.web?.NEXT_PUBLIC_SITE_NAME || domain),
            serverSecret,
          });
        } catch {
          /* bỏ qua thư mục không có env.json hợp lệ */
        }
      }
      items.sort((a, b) => a.domain.localeCompare(b.domain));
    } catch {
      /* dev local */
    }
    this.childSitesCache = { at: Date.now(), items };
    return items;
  }

  private async callChildProfit<T = any>(
    child: { apiBase: string; serverSecret: string; domain: string },
    subPath: string,
    init?: RequestInit,
  ): Promise<T> {
    const res = await fetch(`${child.apiBase}/api/internal/hub-profit${subPath}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-server-secret': child.serverSecret,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
    const payload: any = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = payload?.error?.message ?? payload?.message ?? `Web con ${child.domain} phản hồi HTTP ${res.status}`;
      throw new BadRequestException(Array.isArray(msg) ? msg.join(', ') : String(msg));
    }
    return (payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload) as T;
  }

  private sysStatsCache: {
    at: number;
    system: {
      mem: { total: number; used: number; available: number; pct: number };
      swap: { total: number; used: number; pct: number };
      disk: { size: number; used: number; avail: number; pct: number };
      cpus: number;
      room: number;
    } | null;
    pm2MemBySite: Record<string, number>;
  } | null = null;

  private async getVpsSystemAndPm2Stats() {
    if (this.sysStatsCache && Date.now() - this.sysStatsCache.at < 15_000) {
      return this.sysStatsCache;
    }
    let system: NonNullable<typeof this.sysStatsCache>['system'] = null;
    try {
      let memTotalMb = Math.round(totalmem() / 1_048_576);
      let memAvailMb = Math.round(freemem() / 1_048_576);
      let swapTotalMb = 0;
      let swapUsedMb = 0;

      const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
      if (meminfo) {
        const kbOf = (k: string): number | null => {
          const m = meminfo.match(new RegExp(`^${k}:\\s*(\\d+)`, 'm'));
          return m ? Number(m[1]) : null;
        };
        const mt = kbOf('MemTotal');
        const ma = kbOf('MemAvailable') ?? kbOf('MemFree');
        const st = kbOf('SwapTotal');
        const sf = kbOf('SwapFree');
        if (mt !== null) memTotalMb = Math.round(mt / 1024);
        if (ma !== null) memAvailMb = Math.round(ma / 1024);
        if (st !== null) swapTotalMb = Math.round(st / 1024);
        if (st !== null && sf !== null) swapUsedMb = Math.max(0, Math.round((st - sf) / 1024));
      }

      const memUsedMb = Math.max(0, memTotalMb - memAvailMb);
      const memPct = memTotalMb > 0 ? Math.min(100, Math.round((memUsedMb / memTotalMb) * 100)) : 0;
      const swapPct = swapTotalMb > 0 ? Math.min(100, Math.round((swapUsedMb / swapTotalMb) * 100)) : 0;

      let diskSizeGb = 0;
      let diskUsedGb = 0;
      let diskAvailGb = 0;
      try {
        const fsInfo = await statfs('/');
        const bsize = Number(fsInfo.bsize) || 4096;
        const blocks = Number(fsInfo.blocks) || 0;
        const bfree = Number(fsInfo.bfree) || 0;
        const bavail = Number(fsInfo.bavail) || 0;
        diskSizeGb = Math.round((blocks * bsize) / 1_073_741_824);
        diskAvailGb = Math.round((bavail * bsize) / 1_073_741_824);
        diskUsedGb = Math.max(0, Math.round(((blocks - bfree) * bsize) / 1_073_741_824));
      } catch {
        /* fallback */
      }
      const diskPct = diskSizeGb > 0 ? Math.min(100, Math.round((diskUsedGb / diskSizeGb) * 100)) : 0;
      const cpuCount = cpus().length || 1;
      const room = Math.max(0, Math.floor((memAvailMb - 300) / 500));

      system = {
        mem: { total: memTotalMb, used: memUsedMb, available: memAvailMb, pct: memPct },
        swap: { total: swapTotalMb, used: swapUsedMb, pct: swapPct },
        disk: { size: diskSizeGb, used: diskUsedGb, avail: diskAvailGb, pct: diskPct },
        cpus: cpuCount,
        room,
      };
    } catch {
      system = null;
    }

    const pm2MemBySite: Record<string, number> = {};
    try {
      const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 3_500, maxBuffer: 8 * 1024 * 1024 });
      const list = JSON.parse(stdout) as { name?: string; monit?: { memory?: number }; pm2_env?: { status?: string } }[];
      if (Array.isArray(list)) {
        for (const proc of list) {
          if (proc?.pm2_env?.status !== 'online') continue;
          const nm = String(proc?.name ?? '');
          const m = nm.match(/^novai-(?:api|admin|web)-([a-z0-9_-]+)$/i);
          if (!m) continue;
          const code = m[1];
          const bytes = Number(proc?.monit?.memory) || 0;
          pm2MemBySite[code] = (pm2MemBySite[code] ?? 0) + bytes;
        }
        for (const k of Object.keys(pm2MemBySite)) {
          pm2MemBySite[k] = Math.round(pm2MemBySite[k] / 1_048_576);
        }
      }
    } catch {
      /* không có pm2 trên máy dev */
    }

    this.sysStatsCache = { at: Date.now(), system, pm2MemBySite };
    return this.sysStatsCache;
  }

  async getAllChildProfits(
    query: { preset?: string; from?: string; to?: string; month?: string },
    user: AuthUser,
  ) {
    this.assertSuperAdminOnMain(user);
    const [children, vpsInfo] = await Promise.all([
      this.discoverChildSites(),
      this.getVpsSystemAndPm2Stats(),
    ]);
    const qs = new URLSearchParams();
    if (query.preset) qs.set('preset', query.preset);
    if (query.from) qs.set('from', query.from);
    if (query.to) qs.set('to', query.to);
    if (query.month) qs.set('month', query.month);
    const qsStr = qs.toString() ? `?${qs.toString()}` : '';

    // Ghép thêm thông tin chủ sở hữu từ bảng child_panel_requests trên web mẹ nếu khớp tên miền
    const panels = await this.prisma
      .$queryRaw<{ domain: string; user_id: string; admin_name: string; admin_email: string }[]>`
        SELECT domain, user_id, admin_name, admin_email
        FROM child_panel_requests
        ORDER BY created_at DESC
      `
      .catch(() => [] as { domain: string; user_id: string; admin_name: string; admin_email: string }[]);
    const ownerByDomain = new Map<string, { id: string; name: string; email: string }>();
    for (const p of panels) {
      const dKey = String(p.domain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (dKey && !ownerByDomain.has(dKey)) {
        ownerByDomain.set(dKey, { id: p.user_id, name: p.admin_name, email: p.admin_email });
      }
    }

    const results = await Promise.all(
      children.map(async (c) => {
        try {
          const st = await this.callChildProfit<Awaited<ReturnType<ProfitService['getStats']>>>(c, `/stats${qsStr}`);
          const owner = ownerByDomain.get(c.domain.toLowerCase()) ?? null;
          return {
            siteCode: c.code,
            domain: c.domain,
            siteName: c.siteName,
            publicOrigin: c.publicOrigin,
            online: true,
            ramMb: vpsInfo.pm2MemBySite[c.code] ?? null,
            error: null as string | null,
            owner,
            currentRate: st.currentRate,
            summary: {
              ...st.summary,
              parentRetained: roundMoney(st.summary.depositTotal - st.summary.profitAmount),
              allTimeParentRetained: roundMoney(st.summary.allTimeDeposits - st.summary.allTimeProfit),
            },
            segments: st.segments,
            milestones: st.milestones,
            daily: st.daily,
            recentDeposits: st.recentDeposits,
            from: st.from,
            to: st.to,
            preset: st.preset,
          };
        } catch (err) {
          const owner = ownerByDomain.get(c.domain.toLowerCase()) ?? null;
          return {
            siteCode: c.code,
            domain: c.domain,
            siteName: c.siteName,
            publicOrigin: c.publicOrigin,
            online: false,
            ramMb: vpsInfo.pm2MemBySite[c.code] ?? null,
            error: (err as Error).message,
            owner,
            currentRate: { basePercent: 10, markupExtra: 0, totalPercent: 10, effectiveAt: new Date(0).toISOString() },
            summary: {
              depositTotal: 0,
              depositCount: 0,
              grossProfitAmount: 0,
              bonusDeductionAmount: 0,
              discountDeductionAmount: 0,
              deductAmount: 0,
              profitAmount: 0,
              parentRetained: 0,
              allTimeDeposits: 0,
              allTimeDepositCount: 0,
              allTimeGrossProfit: 0,
              allTimeDeduct: 0,
              allTimeProfit: 0,
              allTimeParentRetained: 0,
              cutCount: 0,
            },
            segments: [],
            milestones: [],
            daily: [],
            recentDeposits: [],
            from: query.from ?? '',
            to: query.to ?? '',
            preset: query.preset ?? 'this_month',
          };
        }
      }),
    );

    const firstOnline = results.find((r) => r.online);
    const totals = results.reduce(
      (acc, r) => {
        acc.siteCount += 1;
        if (r.online) acc.onlineCount += 1;
        if (r.summary.depositCount > 0) acc.activeDepositSites += 1;
        acc.depositTotal += r.summary.depositTotal;
        acc.depositCount += r.summary.depositCount;
        acc.grossProfitAmount += r.summary.grossProfitAmount;
        acc.bonusDeductionAmount += r.summary.bonusDeductionAmount;
        acc.discountDeductionAmount += r.summary.discountDeductionAmount;
        acc.deductAmount += r.summary.deductAmount;
        acc.childProfitTotal += r.summary.profitAmount;
        acc.parentRetainedTotal += r.summary.parentRetained;
        acc.allTimeDeposits += r.summary.allTimeDeposits;
        acc.allTimeDepositCount += r.summary.allTimeDepositCount;
        acc.allTimeChildProfit += r.summary.allTimeProfit;
        acc.allTimeParentRetained += r.summary.allTimeParentRetained;
        return acc;
      },
      {
        siteCount: 0,
        onlineCount: 0,
        activeDepositSites: 0,
        depositTotal: 0,
        depositCount: 0,
        grossProfitAmount: 0,
        bonusDeductionAmount: 0,
        discountDeductionAmount: 0,
        deductAmount: 0,
        childProfitTotal: 0,
        parentRetainedTotal: 0,
        allTimeDeposits: 0,
        allTimeDepositCount: 0,
        allTimeChildProfit: 0,
        allTimeParentRetained: 0,
      },
    );

    return {
      preset: firstOnline?.preset ?? query.preset ?? 'this_month',
      from: firstOnline?.from ?? query.from ?? '',
      to: firstOnline?.to ?? query.to ?? '',
      system: vpsInfo.system,
      totals,
      sites: results,
    };
  }

  private async mustFindChild(siteCode: string) {
    const children = await this.discoverChildSites();
    const child = children.find((c) => c.code === siteCode);
    if (!child) throw new NotFoundException(`Không tìm thấy cấu hình web con "${siteCode}"`);
    return child;
  }

  async addChildSiteMilestone(
    siteCode: string,
    body: { basePercent?: number; markupExtra?: number; effectiveAt?: string; note?: string },
    user: AuthUser,
  ) {
    this.assertSuperAdminOnMain(user);
    const child = await this.mustFindChild(siteCode);
    return this.callChildProfit(child, '/milestones', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updateChildSiteRate(
    siteCode: string,
    body: { basePercent?: number; markupExtra?: number; note?: string },
    user: AuthUser,
  ) {
    this.assertSuperAdminOnMain(user);
    const child = await this.mustFindChild(siteCode);
    return this.callChildProfit(child, '/rate', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async removeChildSiteMilestone(siteCode: string, milestoneId: string, user: AuthUser) {
    this.assertSuperAdminOnMain(user);
    const child = await this.mustFindChild(siteCode);
    return this.callChildProfit(child, `/milestones/${encodeURIComponent(milestoneId)}`, {
      method: 'DELETE',
    });
  }

  async bulkUpdateChildSitesRate(
    body: {
      siteCodes?: string[];
      mode?: 'update' | 'milestone';
      basePercent?: number;
      markupExtra?: number;
      effectiveAt?: string;
      note?: string;
    },
    user: AuthUser,
  ) {
    this.assertSuperAdminOnMain(user);
    const children = await this.discoverChildSites();
    const targetSet = Array.isArray(body.siteCodes) && body.siteCodes.length > 0 ? new Set(body.siteCodes) : null;
    const targets = targetSet ? children.filter((c) => targetSet.has(c.code)) : children;
    if (!targets.length) throw new BadRequestException('Không có web con nào được chọn');

    const updated: string[] = [];
    const failed: { siteCode: string; error: string }[] = [];
    await Promise.all(
      targets.map(async (child) => {
        try {
          if (body.mode === 'milestone') {
            await this.callChildProfit(child, '/milestones', {
              method: 'POST',
              body: JSON.stringify(body),
            });
          } else {
            await this.callChildProfit(child, '/rate', {
              method: 'PUT',
              body: JSON.stringify(body),
            });
          }
          updated.push(child.code);
        } catch (err) {
          failed.push({ siteCode: child.code, error: (err as Error).message });
        }
      }),
    );
    return { updatedCount: updated.length, updated, failed };
  }
}
