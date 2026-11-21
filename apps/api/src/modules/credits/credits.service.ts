import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { CreditTxnType, Prisma, WalletTxnType } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { clampPercent, packBonus, promoActive, quoteTopup, readCreditSettings, readTopupSettings, roundVnd } from './credits.settings.js';
import { publicToolKey } from '../ai/ai-public-key.js';
import type { AdjustCreditsDto, CheckoutPlanDto, CheckoutTopupDto, CreditTxnQueryDto, PlanCycle, PurchaseQueryDto, UpsertPlanDto } from './credits.dto.js';

type Tx = Prisma.TransactionClient;

/** Một thay đổi credits (đi qua `apply()` để luôn khoá dòng user và ghi sổ cái) */
export interface CreditChange {
  userId: string;
  type: CreditTxnType;
  /** Số credits có dấu: dương = cộng, âm = trừ */
  amount: number;
  note?: string | null;
  taskId?: string | null;
  purchaseId?: string | null;
  createdById?: string | null;
  meta?: Record<string, unknown>;
  /** Khoá chống trùng (unique) — cùng khoá chỉ ghi được một lần */
  idempotencyKey?: string | null;
}

/** Gói năm (cơ chế gói cước cũ) = trả một lần cho 12 chu kỳ; các lần mua năm cũ vẫn được `refillYearly()` cộng nốt credits */
const YEAR_CYCLES = 12;
const DAY_MS = 86_400_000;

/** Việc cần làm sau khi khách trả tiền gói qua cổng (lưu ở payment_transactions.rawRequest.checkout) */
interface PlanCheckout {
  kind: 'credit_plan';
  planId: string;
  /** Giữ để đọc giao dịch cũ (gói tháng / năm); gói credits luôn là 'pack' */
  cycle?: PlanCycle | 'pack';
  /** Ghi lại sau khi đã kích hoạt gói (chống chạy lại) */
  purchaseId?: string;
  purchaseCode?: number;
  /** Tiền đã vào ví nhưng không mua được gói (vd admin vừa tăng giá) */
  error?: string;
}

/** Việc cần làm sau khi khách nạp credits theo số tiền tự do qua cổng: đổi `amount` đồng trong ví ra credits */
interface TopupCheckout {
  kind: 'credit_topup';
  amount: number;
  purchaseId?: string;
  purchaseCode?: number;
  /** Số credits đã cộng (để trang thanh toán báo khách) */
  credits?: number;
  error?: string;
}

/** Tên hiển thị của lần mua kiểu nạp tự do (credit_purchases.planName) */
const TOPUP_NAME = 'Nạp tiền';

/** Hiển thị số có dấu chấm ngăn cách kiểu Việt Nam */
const fmt = (n: number) => n.toLocaleString('vi-VN');

/** Loại giao dịch ví tương ứng một biến động số dư AI: trừ khi chạy = PAYMENT, hoàn = REFUND, còn lại theo dấu */
function walletTypeOf(type: CreditTxnType, amount: number): WalletTxnType {
  if (type === 'USAGE') return 'PAYMENT';
  if (type === 'REFUND') return 'REFUND';
  return amount > 0 ? 'DEPOSIT' : 'WITHDRAW';
}

/** Thông tin giá của một khách: tổng đã chi, giảm giá riêng admin đặt */
export interface PricingContext {
  spent: number;
  customDiscount: number;
}

/**
 * Số dư AI + gói nạp tiền (đã bỏ đơn vị credits, mọi thứ tính bằng VND):
 * - số dư chạy AI chính là số dư ví `users.walletBalance`; mọi thay đổi do AI qua `apply()` (ghi wallet_transactions + nhật ký credit_transactions);
 * - khách mua gói (bảng credit_plans, cột `credits` = số tiền cộng vào ví) → trả tiền (ví hoặc cổng QR) → cộng tiền gói vào ví;
 * - giá gói chỉ giảm theo giảm giá riêng admin đặt cho từng khách.
 * Người còn gói cước cũ (tháng / năm) vẫn giữ số luồng tới hết hạn và được cộng nốt credits gói năm.
 */
@Injectable()
export class CreditsService {
  private readonly logger = new Logger('Credits');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
    private readonly events: EventEmitter2,
    private readonly payments: PaymentsService,
  ) {}

  // ---------------- sổ cái credits ----------------

  /**
   * Thay đổi số dư AI trong một transaction đang mở. Từ khi bỏ credits, số dư dùng chạy AI chính là số dư ví (VND):
   * ghi một dòng wallet_transactions (khoá dòng user, không cho âm) + một dòng credit_transactions làm nhật ký AI
   * (giữ liên kết tác vụ / lần mua cho trang lịch sử). Ném lỗi nếu trừ quá số dư ví.
   */
  async apply(tx: Tx, c: CreditChange) {
    const amount = Math.round(c.amount);
    if (!Number.isFinite(amount) || amount === 0) throw new BadRequestException('Số tiền không hợp lệ');
    const walletTxn = (await this.wallet.apply(tx, {
      userId: c.userId,
      type: walletTypeOf(c.type, amount),
      amount,
      note: c.note,
      createdById: c.createdById ?? null,
      meta: { ...(c.meta ?? {}), source: 'ai_balance', aiType: c.type, taskId: c.taskId ?? null, purchaseId: c.purchaseId ?? null },
      idempotencyKey: c.idempotencyKey ? `ai:${c.idempotencyKey}` : null,
    })) as Awaited<ReturnType<WalletService['apply']>> & { __replayed?: boolean };
    if (walletTxn.__replayed && c.idempotencyKey) {
      const existingCredit = await tx.creditTransaction.findUnique({ where: { idempotencyKey: c.idempotencyKey } });
      if (existingCredit) return existingCredit;
    }
    const txn = await tx.creditTransaction.create({
      data: {
        userId: c.userId,
        type: c.type,
        amount,
        balanceAfter: Math.round(Number(walletTxn.balanceAfter)),
        note: c.note?.trim() || null,
        taskId: c.taskId ?? null,
        purchaseId: c.purchaseId ?? null,
        createdById: c.createdById ?? null,
        meta: { ...(c.meta ?? {}), walletTxnId: walletTxn.id } as object,
        idempotencyKey: c.idempotencyKey ?? null,
      },
    });
    return Object.assign(txn, { walletTxn });
  }

  /** Phát sự kiện sau khi số dư đổi (gọi ngoài transaction) */
  afterChange(
    txn: { id: string; userId: string; type: CreditTxnType; amount: number; balanceAfter: number; walletTxn?: Parameters<WalletService['afterChange']>[0] },
    actor?: AuthUser | null,
  ) {
    this.events.emit('credits.changed', { transactionId: txn.id, userId: txn.userId, type: txn.type, amount: txn.amount, balance: txn.balanceAfter });
    // trừ / hoàn khi chạy tác vụ không ghi nhật ký hoạt động ví (mỗi lần chạy một dòng sẽ làm ngập nhật ký)
    if (txn.walletTxn && txn.type !== 'USAGE' && txn.type !== 'REFUND') void this.wallet.afterChange(txn.walletTxn, actor ?? undefined).catch(() => undefined);
    if (txn.type === 'ADJUST' || txn.type === 'PURCHASE') {
      this.events.emit('activity', {
        userId: actor && actor.id !== 'system' ? actor.id : txn.userId,
        action: `credits.${txn.type.toLowerCase()}`,
        entityType: 'user',
        entityId: txn.userId,
        meta: { amount: txn.amount, balance: txn.balanceAfter },
      });
    }
  }

  // ---------------- thông tin của khách ----------------

  /** Số luồng chạy đồng thời hiện tại: theo gói còn hạn, không thì theo cài đặt mặc định */
  async concurrencyOf(userId: string) {
    const [s, user] = await Promise.all([
      readCreditSettings(this.settings),
      this.prisma.user.findUnique({ where: { id: userId }, select: { planExpiresAt: true, plan: { select: { concurrency: true } } } }),
    ]);
    const active = user?.plan && user.planExpiresAt && user.planExpiresAt > new Date();
    return Math.max(s.defaultConcurrency, active ? user!.plan!.concurrency : 0);
  }

  /** Thông tin để tính giá gói cho khách (chưa đăng nhập = không giảm) */
  async pricingOf(userId?: string | null): Promise<PricingContext> {
    const user = userId ? await this.prisma.user.findUnique({ where: { id: userId }, select: { totalSpent: true, customDiscount: true } }) : null;
    return { spent: Number(user?.totalSpent ?? 0), customDiscount: Number(user?.customDiscount ?? 0) };
  }

  /** Tổng quan credits của khách: số dư, gói, số luồng, giảm giá */
  async summary(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { walletBalance: true, planExpiresAt: true, plan: { select: { id: true, name: true, slug: true, concurrency: true } } },
    });
    if (!user) throw new NotFoundException('Không tìm thấy thành viên');
    const [pricing, concurrency, used] = await Promise.all([
      this.pricingOf(userId),
      this.concurrencyOf(userId),
      // đã dùng ròng = trừ khi chạy − hoàn khi lỗi
      this.prisma.creditTransaction.aggregate({ where: { userId, type: { in: ['USAGE', 'REFUND'] }, taskId: { not: null } }, _sum: { amount: true } }),
    ]);
    const planActive = !!user.plan && !!user.planExpiresAt && user.planExpiresAt > new Date();
    const [last, refill] = await Promise.all([
      // chu kỳ của lần mua gần nhất đúng gói đang dùng (tháng / năm)
      user.plan ? this.prisma.creditPurchase.findFirst({ where: { userId, planId: user.plan.id }, orderBy: { createdAt: 'desc' }, select: { cycle: true } }) : null,
      // lần cộng credits kế tiếp của gói năm (nếu có)
      this.prisma.creditPurchase.findFirst({ where: { userId, refillsLeft: { gt: 0 } }, orderBy: { nextRefillAt: 'asc' }, select: { nextRefillAt: true, refillsLeft: true, credits: true } }),
    ]);
    return {
      // số dư chạy AI = số dư ví (VND); giữ tên trường `credits` cho client cũ
      credits: Math.floor(Number(user.walletBalance)),
      wallet: Number(user.walletBalance),
      plan: user.plan ? { ...user.plan, expiresAt: user.planExpiresAt, active: planActive, cycle: last?.cycle ?? 'month' } : null,
      nextRefill: refill ? { at: refill.nextRefillAt, credits: Math.round(refill.credits / YEAR_CYCLES), left: refill.refillsLeft } : null,
      concurrency,
      totalUsed: Math.abs(Number(used._sum.amount ?? 0)),
      pricing: { spent: pricing.spent, customDiscount: pricing.customDiscount },
    };
  }

  /** Lịch sử credits (mới nhất trước) */
  async transactions(userId: string | null, q: CreditTxnQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const search = q.search?.trim();
    const where: Prisma.CreditTransactionWhereInput = {
      ...(userId ? { userId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(!userId && search ? { user: { OR: [{ email: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          task: { select: { id: true, code: true, toolKey: true } },
          purchase: { select: { id: true, code: true, planName: true } },
          ...(userId ? {} : { user: { select: { id: true, name: true, email: true } }, createdBy: { select: { id: true, name: true } } }),
        },
      }),
      this.prisma.creditTransaction.count({ where }),
    ]);
    // khách không cần thấy khoá chống trùng / meta nội bộ
    // khoá công cụ của tác vụ đổi sang khoá công khai để khách không thấy tên nhà cung cấp
    const data = userId ? rows.map(({ idempotencyKey: _k, meta: _m, createdById: _c, ...r }) => ({ ...r, task: r.task && { ...r.task, toolKey: publicToolKey(r.task.toolKey) } })) : rows;
    return paginate(data, total, page, limit);
  }

  // ---------------- gói credits ----------------

  /**
   * Gói credits đang bán (bảng giá công khai, chỉ gói có giá > 0). Mỗi gói kèm `bonus` (% credits tặng thêm so với gói có
   * đơn giá cao nhất), `discount` (% giảm giá riêng của khách đang đăng nhập) và `finalPrice` (giá sau giảm).
   * Kèm `features` / `note` chung cho khung "Mọi gói credits đều bao gồm".
   */
  async publicPlans(userId?: string | null) {
    const [plans, ctx, s] = await Promise.all([
      this.prisma.creditPlan.findMany({ where: { active: true, price: { gt: 0 }, credits: { gt: 0 } }, orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }] }),
      this.pricingOf(userId),
      readCreditSettings(this.settings),
    ]);
    // đơn giá gốc = đơn giá cao nhất (gói nhỏ nhất thường là gói gốc, không tặng thêm)
    const base = Math.max(0, ...plans.map((p) => Number(p.price) / p.credits));
    const discount = ctx.customDiscount;
    const topup = await this.publicTopup(0);
    return {
      features: s.packFeatures,
      note: s.packNote,
      topup,
      data: plans.map((p) => {
        const price = Number(p.price);
        return {
          id: p.id,
          slug: p.slug,
          name: p.name,
          description: p.description,
          credits: p.credits,
          badge: p.badge,
          highlight: p.highlight,
          price,
          finalPrice: roundVnd(price * (1 - discount / 100)),
          discount,
          bonus: packBonus({ price, credits: p.credits }, base),
        };
      }),
    };
  }

  /** Danh sách gói cho admin (kèm số lượt mua, % tặng thêm tính như bảng giá) */
  async adminPlans() {
    const plans = await this.prisma.creditPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }], include: { _count: { select: { purchases: true, users: true } } } });
    const selling = plans.filter((p) => p.active && Number(p.price) > 0 && p.credits > 0);
    const base = Math.max(0, ...selling.map((p) => Number(p.price) / p.credits));
    return plans.map((p) => ({ ...p, price: Number(p.price), yearlyPrice: Number(p.yearlyPrice), bonus: packBonus({ price: Number(p.price), credits: p.credits }, base) }));
  }

  /** Thêm / sửa gói */
  async savePlan(dto: UpsertPlanDto, id?: string) {
    const data = {
      slug: dto.slug.trim().toLowerCase(),
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      price: dto.price,
      // gói credits không bán theo năm, không có thời hạn / số luồng (các cột cũ giữ giá trị mặc định)
      yearlyPrice: 0,
      credits: dto.credits,
      features: (dto.features ?? []).map((f) => f.trim()).filter(Boolean),
      badge: dto.badge?.trim() || null,
      highlight: !!dto.highlight,
      active: dto.active !== false,
      sortOrder: dto.sortOrder ?? 0,
    };
    try {
      return id ? await this.prisma.creditPlan.update({ where: { id }, data }) : await this.prisma.creditPlan.create({ data });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException('Mã gói (slug) đã tồn tại');
      if ((err as { code?: string }).code === 'P2025') throw new NotFoundException('Không tìm thấy gói');
      throw err;
    }
  }

  /** Xoá gói: gói đã có người mua thì chỉ ẩn để giữ lịch sử */
  async deletePlan(id: string) {
    const plan = await this.prisma.creditPlan.findUnique({ where: { id }, include: { _count: { select: { purchases: true } } } });
    if (!plan) throw new NotFoundException('Không tìm thấy gói');
    if (plan._count.purchases > 0) {
      await this.prisma.creditPlan.update({ where: { id }, data: { active: false } });
      return { hidden: true };
    }
    await this.prisma.creditPlan.delete({ where: { id } });
    return { deleted: true };
  }

  /** Giá khách phải trả cho một gói credits (đã trừ giảm giá riêng) */
  private async quote(userId: string, planId: string) {
    const plan = await this.prisma.creditPlan.findFirst({ where: { id: planId, active: true } });
    if (!plan) throw new NotFoundException('Gói không tồn tại hoặc đã ngừng bán');
    const listPrice = Number(plan.price);
    if (listPrice <= 0 || plan.credits <= 0) throw new BadRequestException('Gói này không bán');
    const { customDiscount: discount } = await this.pricingOf(userId);
    return { plan, listPrice, discount, paid: roundVnd(listPrice * (1 - discount / 100)) };
  }

  /**
   * Khách mua gói credits bằng số dư ví (một transaction):
   * trừ ví (PAYMENT) → ghi lần mua → cộng credits (PURCHASE, vĩnh viễn) → cộng tổng chi.
   * Không đổi gói / hạn gói của khách (gói cước cũ còn hạn vẫn giữ nguyên tới khi hết hạn).
   */
  async purchase(user: AuthUser, planId: string) {
    const { plan, listPrice, discount, paid } = await this.quote(user.id, planId);
    const label = `${plan.name} (nhận ${fmt(plan.credits)}đ)`;

    const result = await this.prisma.$transaction(async (tx) => {
      // giảm giá 100% -> không trừ ví (WalletService không nhận số tiền 0)
      const walletTxn =
        paid > 0
          ? await this.wallet.apply(tx, {
              userId: user.id,
              type: 'PAYMENT',
              amount: -paid,
              note: `Mua gói ${label}${discount > 0 ? ` (giảm ${discount}%)` : ''}`,
              meta: { source: 'credit_plan', planId: plan.id, cycle: 'pack' },
            })
          : null;
      const purchase = await tx.creditPurchase.create({
        data: {
          userId: user.id,
          planId: plan.id,
          planName: plan.name,
          listPrice,
          discount,
          paid,
          credits: plan.credits,
          expiresAt: null,
          cycle: 'pack',
          walletTxnId: walletTxn?.id ?? null,
        },
      });
      const creditTxn = await this.apply(tx, {
        userId: user.id,
        type: 'PURCHASE',
        amount: plan.credits,
        purchaseId: purchase.id,
        note: `Cộng tiền gói ${label} #${purchase.code}`,
        idempotencyKey: `purchase:${purchase.id}`,
      });
      await tx.user.update({ where: { id: user.id }, data: { totalSpent: { increment: paid } } });
      return { walletTxn, purchase, creditTxn };
    });

    if (result.walletTxn) await this.wallet.afterChange(result.walletTxn);
    this.afterChange(result.creditTxn, user);
    this.events.emit('credits.purchased', { userId: user.id, purchaseId: result.purchase.id, planId: plan.id, cycle: 'pack', paid });
    return { purchase: { ...result.purchase, listPrice, paid }, credits: result.creditTxn.balanceAfter, wallet: result.creditTxn.balanceAfter };
  }

  /**
   * Trang thanh toán: ví chưa đủ -> tạo giao dịch nạp ví qua cổng cho đúng số còn thiếu (tối thiểu bằng hạn mức nạp của cổng),
   * kèm việc cần làm `checkout` -> khi cổng báo nhận tiền, `onTopupCompleted()` tự mua gói credits. Phần dư (nếu có) nằm lại trong ví.
   */
  async checkout(user: AuthUser, dto: CheckoutPlanDto, locale?: string | null) {
    const { plan, paid } = await this.quote(user.id, dto.planId);
    const owner = await this.prisma.user.findUnique({ where: { id: user.id }, select: { walletBalance: true } });
    const need = Math.ceil(paid - Number(owner?.walletBalance ?? 0));
    if (need <= 0) throw new BadRequestException('Số dư ví đã đủ, vui lòng chọn thanh toán bằng số dư ví');
    const { min } = await this.payments.planCheckoutOptions();
    const checkout: PlanCheckout = { kind: 'credit_plan', planId: plan.id, cycle: 'pack' };
    return this.payments.createTopup(user, { amount: Math.max(need, min), provider: dto.provider }, locale, {
      checkout: checkout as unknown as Record<string, unknown>,
      returnPath: `/checkout?plan=${encodeURIComponent(plan.slug)}`,
    });
  }

  /** Cổng thanh toán cho trang thanh toán gói (website không có trang nạp tiền riêng, khách trả gói thẳng qua cổng) */
  checkoutOptions(locale?: string) {
    return this.payments.planCheckoutOptions(locale);
  }

  /** Trạng thái thanh toán qua cổng: tiền đã vào ví chưa, đã cộng credits chưa (trang thanh toán hỏi định kỳ) */
  async checkoutStatus(userId: string, topupId: string) {
    const tx = await this.prisma.paymentTransaction.findFirst({ where: { id: topupId, userId, purpose: 'wallet' }, select: { status: true, rawRequest: true } });
    if (!tx) throw new NotFoundException('Không tìm thấy giao dịch thanh toán');
    const c = (tx.rawRequest as { checkout?: PlanCheckout | TopupCheckout } | null)?.checkout;
    const known = c?.kind === 'credit_plan' || c?.kind === 'credit_topup';
    // đã nhận tiền nhưng giao dịch không còn gắn việc mua credits (vd khách tạo lệnh nạp ví cùng số tiền, dùng lại mã chờ) -> báo luôn, không để trang chờ mãi
    const orphan = tx.status === 'PAID' && !known ? 'Giao dịch này đã được dùng để nạp ví, không gắn với lần mua gói' : null;
    return {
      status: tx.status,
      planId: c?.kind === 'credit_plan' ? c.planId : null,
      cycle: c?.kind === 'credit_plan' ? (c.cycle ?? null) : null,
      amount: c?.kind === 'credit_topup' ? c.amount : null,
      credits: c?.kind === 'credit_topup' ? (c.credits ?? null) : null,
      purchaseCode: c?.purchaseCode ?? null,
      error: c?.error ?? orphan,
    };
  }

  /** Tiền nạp qua trang thanh toán đã vào ví -> mua gói / đổi ra credits luôn; lỗi thì ghi lại để trang thanh toán báo khách (tiền vẫn trong ví) */
  @OnEvent('wallet.topup_completed', { async: true })
  async onTopupCompleted(e: { userId: string; amount?: number; transactionId: string }) {
    const tx = await this.prisma.paymentTransaction.findUnique({ where: { id: e.transactionId }, select: { rawRequest: true } });
    const c = (tx?.rawRequest as { checkout?: PlanCheckout | TopupCheckout } | null)?.checkout;
    if (!c || c.purchaseId || (c.kind !== 'credit_plan' && c.kind !== 'credit_topup')) return;
    let next: PlanCheckout | TopupCheckout;
    try {
      if (c.kind === 'credit_topup') {
        const paidAmount = e.amount && e.amount > 0 ? Math.round(e.amount) : c.amount;
        const r = await this.buyCredits({ id: e.userId } as AuthUser, paidAmount);
        next = { ...c, amount: paidAmount, purchaseId: r.purchase.id, purchaseCode: r.purchase.code, credits: r.purchase.credits, error: undefined };
      } else {
        const r = await this.purchase({ id: e.userId } as AuthUser, c.planId);
        next = { ...c, purchaseId: r.purchase.id, purchaseCode: r.purchase.code, error: undefined };
      }
    } catch (err) {
      this.logger.warn(`Tự cộng credits sau thanh toán ${e.transactionId} lỗi: ${(err as Error).message}`);
      next = { ...c, error: (err as Error).message };
    }
    await this.prisma.paymentTransaction.update({ where: { id: e.transactionId }, data: { rawRequest: { checkout: next } as object } });
  }

  // ---------------- nạp credits theo số tiền tự do ----------------

  /**
   * Cấu hình nạp credits cho website: tỉ lệ đổi, hạn mức, mức gợi ý, mốc khuyến mãi, chương trình khuyến mãi đang chạy
   * và ưu đãi riêng (% tặng thêm = giảm giá riêng admin đặt cho khách đang đăng nhập).
   */
  async publicTopup(personal = 0) {
    const s = await readTopupSettings(this.settings);
    const active = promoActive(s.promo);
    return {
      rate: s.rate,
      min: s.min,
      max: s.max,
      presets: s.presets,
      tiers: s.tiers,
      promo: active ? { bonus: s.promo.bonus, label: s.promo.label, endsAt: s.promo.endsAt || null } : null,
      personal: clampPercent(personal),
    };
  }

  /** Kiểm tra số tiền nạp và tính số credits nhận được (theo cấu hình + ưu đãi riêng của khách) */
  private async quoteAmount(userId: string, amount: number) {
    const s = await readTopupSettings(this.settings);
    const a = Math.round(Number(amount));
    if (!Number.isFinite(a) || a < s.min || a > s.max) throw new BadRequestException(`Số tiền nạp phải từ ${fmt(s.min)}đ đến ${fmt(s.max)}đ`);
    const q = quoteTopup(a, s, 0);
    if (q.credits <= 0) throw new BadRequestException('Số tiền quá nhỏ');
    return q;
  }

  /**
   * Khách đổi `amount` đồng trong ví ra credits (một transaction): trừ ví (PAYMENT) → ghi lần mua (không gắn gói)
   * → cộng credits gốc + khuyến mãi (PURCHASE, vĩnh viễn) → cộng tổng chi.
   */
  async buyCredits(user: AuthUser, amount: number) {
    const q = await this.quoteAmount(user.id, amount);
    const bonusPct = q.tierBonus + q.promoBonus + q.personalBonus;
    const label = `${fmt(q.credits)}đ${q.bonusCredits > 0 ? ` (tặng ${bonusPct}%)` : ''}`;

    const result = await this.prisma.$transaction(async (tx) => {
      const walletTxn = await this.wallet.apply(tx, {
        userId: user.id,
        type: 'PAYMENT',
        amount: -q.amount,
        note: `Đổi ${fmt(q.amount)}đ lấy ${label}`,
        meta: { source: 'credit_topup', ...q },
      });
      const purchase = await tx.creditPurchase.create({
        data: {
          userId: user.id,
          planId: null,
          planName: TOPUP_NAME,
          listPrice: q.amount,
          discount: 0,
          paid: q.amount,
          credits: q.credits,
          expiresAt: null,
          cycle: 'topup',
          walletTxnId: walletTxn.id,
        },
      });
      const creditTxn = await this.apply(tx, {
        userId: user.id,
        type: 'PURCHASE',
        amount: q.credits,
        purchaseId: purchase.id,
        note: `Cộng ${label} #${purchase.code}`,
        meta: { ...q },
        idempotencyKey: `purchase:${purchase.id}`,
      });
      await tx.user.update({ where: { id: user.id }, data: { totalSpent: { increment: q.amount } } });
      return { walletTxn, purchase, creditTxn };
    });

    await this.wallet.afterChange(result.walletTxn);
    this.afterChange(result.creditTxn, user);
    this.events.emit('credits.purchased', { userId: user.id, purchaseId: result.purchase.id, planId: null, cycle: 'topup', paid: q.amount });
    return { purchase: { ...result.purchase, listPrice: q.amount, paid: q.amount }, quote: q, credits: result.creditTxn.balanceAfter, wallet: result.creditTxn.balanceAfter };
  }

  /**
   * Nạp credits qua cổng: tạo giao dịch nạp ví cho phần còn thiếu (trừ số dư ví sẵn có, tối thiểu bằng hạn mức của cổng),
   * kèm việc cần làm `credit_topup` -> cổng báo nhận tiền thì `onTopupCompleted()` tự đổi `amount` ra credits. Phần dư nằm lại trong ví.
   */
  async checkoutTopup(user: AuthUser, dto: CheckoutTopupDto, locale?: string | null) {
    const q = await this.quoteAmount(user.id, dto.amount);
    // nạp tiền = thêm tiền mới vào số dư: luôn thu đủ số tiền khách chọn qua cổng (không trừ vào số dư sẵn có)
    const { min } = await this.payments.planCheckoutOptions();
    const checkout: TopupCheckout = { kind: 'credit_topup', amount: q.amount };
    return this.payments.createTopup(user, { amount: Math.max(q.amount, min), provider: dto.provider }, locale, {
      checkout: checkout as unknown as Record<string, unknown>,
      returnPath: `/checkout?amount=${q.amount}`,
      replacePending: dto.replacePending === true,
    });
  }

  /**
   * Gói năm: cộng credits của chu kỳ kế tiếp khi tới hạn. Mỗi lần cộng "giành" đúng trạng thái đang đọc (refillsLeft, nextRefillAt)
   * nên hai tiến trình chạy cùng lúc không cộng trùng; khoá chống trùng `refill:<lần mua>:<thứ tự>` chặn thêm một lớp.
   * Máy chủ tắt lâu: mỗi lượt cron cộng một chu kỳ, các lượt sau cộng tiếp phần còn nợ.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async refillYearly() {
    const due = await this.prisma.creditPurchase.findMany({ where: { refillsLeft: { gt: 0 }, nextRefillAt: { lte: new Date() } }, orderBy: { nextRefillAt: 'asc' }, take: 200 });
    for (const p of due) {
      const n = YEAR_CYCLES - p.refillsLeft + 1;
      try {
        const txn = await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.creditPurchase.updateMany({
            where: { id: p.id, refillsLeft: p.refillsLeft, nextRefillAt: p.nextRefillAt },
            data: { refillsLeft: p.refillsLeft - 1, nextRefillAt: p.refillsLeft > 1 ? new Date(p.nextRefillAt!.getTime() + Math.max(1, p.refillDays) * DAY_MS) : null },
          });
          if (!claimed.count) return null;
          const key = `refill:${p.id}:${n}`;
          if (await tx.creditTransaction.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return null;
          return this.apply(tx, { userId: p.userId, type: 'PURCHASE', amount: Math.round(p.credits / YEAR_CYCLES), purchaseId: p.id, note: `Gói năm ${p.planName} #${p.code}: tiền tháng ${n}/${YEAR_CYCLES}`, idempotencyKey: key });
        });
        if (txn) this.afterChange(txn);
      } catch (err) {
        // tài khoản đã xoá -> dừng cộng cho lần mua này
        if (err instanceof NotFoundException) {
          await this.prisma.creditPurchase.update({ where: { id: p.id }, data: { refillsLeft: 0, nextRefillAt: null } });
          continue;
        }
        this.logger.warn(`Cộng credits gói năm #${p.code} lỗi: ${(err as Error).message}`);
      }
    }
  }

  /** Lịch sử mua gói (của một khách hoặc toàn hệ thống) */
  async purchases(userId: string | null, q: PurchaseQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const search = q.search?.trim();
    const where: Prisma.CreditPurchaseWhereInput = {
      ...(userId ? { userId } : {}),
      ...(!userId && search ? { user: { OR: [{ email: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.creditPurchase.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: userId ? undefined : { user: { select: { id: true, name: true, email: true } } } }),
      this.prisma.creditPurchase.count({ where }),
    ]);
    const data = rows.map((r) => ({ ...r, listPrice: Number(r.listPrice), paid: Number(r.paid), discount: Number(r.discount) }));
    return paginate(data, total, page, limit);
  }

  // ---------------- quản trị ----------------

  /** Admin cộng / trừ credits thủ công (có khoá chống bấm trùng) */
  async adjust(userId: string, dto: AdjustCreditsDto, actor: AuthUser) {
    const key = dto.idempotencyKey?.trim() ? `adjust:${dto.idempotencyKey.trim()}` : null;
    if (key) {
      const existing = await this.prisma.creditTransaction.findUnique({ where: { idempotencyKey: key } });
      if (existing) return this.replayAdjust(existing, userId);
    }
    const amount = dto.type === 'add' ? Math.abs(dto.amount) : -Math.abs(dto.amount);
    try {
      const txn = await this.prisma.$transaction((tx) => this.apply(tx, { userId, type: 'ADJUST', amount, note: dto.note, createdById: actor.id === 'system' ? null : actor.id, idempotencyKey: key }));
      this.afterChange(txn, actor);
      return { transaction: txn, balance: txn.balanceAfter };
    } catch (err) {
      if (key && (err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.creditTransaction.findUnique({ where: { idempotencyKey: key } });
        if (existing) return this.replayAdjust(existing, userId);
      }
      throw err;
    }
  }

  /** Trả lại giao dịch đã ghi với cùng khoá chống trùng (khoá phải thuộc đúng thành viên này) */
  private replayAdjust(existing: { userId: string; balanceAfter: number }, userId: string) {
    if (existing.userId !== userId) throw new ConflictException('Khoá chống trùng (idempotencyKey) đã được dùng cho thành viên khác');
    return { transaction: existing, balance: existing.balanceAfter, duplicate: true };
  }

  /** Admin đặt giảm giá riêng (%) cho một khách */
  async setCustomDiscount(userId: string, discount: number) {
    const value = clampPercent(Number(discount) || 0);
    await this.prisma.user.update({ where: { id: userId }, data: { customDiscount: value } });
    return this.pricingOf(userId);
  }

  /** Số liệu tổng quan cho trang admin */
  async adminStats() {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [revenue, revenue30, sold, used, outstanding, buyers] = await Promise.all([
      this.prisma.creditPurchase.aggregate({ _sum: { paid: true }, _count: true }),
      this.prisma.creditPurchase.aggregate({ where: { createdAt: { gte: since } }, _sum: { paid: true }, _count: true }),
      this.prisma.creditTransaction.aggregate({ where: { type: 'PURCHASE' }, _sum: { amount: true } }),
      this.prisma.creditTransaction.aggregate({ where: { type: { in: ['USAGE', 'REFUND'] }, taskId: { not: null } }, _sum: { amount: true } }),
      this.prisma.user.aggregate({ where: { deletedAt: null }, _sum: { walletBalance: true } }),
      this.prisma.creditPurchase.groupBy({ by: ['userId'] }),
    ]);
    return {
      revenue: Number(revenue._sum.paid ?? 0),
      purchases: revenue._count,
      revenue30d: Number(revenue30._sum.paid ?? 0),
      purchases30d: revenue30._count,
      creditsSold: Number(sold._sum.amount ?? 0),
      creditsUsed: Math.abs(Number(used._sum.amount ?? 0)),
      creditsOutstanding: Number(outstanding._sum.walletBalance ?? 0),
      buyers: buyers.length,
    };
  }

  // ---------------- sự kiện ----------------

  /** Tặng credits khi có thành viên mới đăng ký (Cài đặt › Credits › Tặng khi đăng ký) */
  @OnEvent('user.registered', { async: true })
  async onRegistered(e: { user: { id: string } }) {
    try {
      const s = await readCreditSettings(this.settings);
      if (s.signupBonus <= 0) return;
      const txn = await this.prisma.$transaction((tx) =>
        this.apply(tx, { userId: e.user.id, type: 'BONUS', amount: s.signupBonus, note: 'Quà tặng thành viên mới', idempotencyKey: `signup:${e.user.id}` }),
      );
      this.afterChange(txn);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return;
      this.logger.warn(`Tặng credits đăng ký lỗi: ${(err as Error).message}`);
    }
  }
}
