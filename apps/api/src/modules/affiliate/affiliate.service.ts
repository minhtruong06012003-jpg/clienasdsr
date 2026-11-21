import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import { frontendBaseUrl } from '../../common/utils/frontend-url.js';
import type { AffiliateTxnType, Prisma } from '../../generated/prisma/client.js';
import type { AdjustAffiliateDto, AffiliatePayoutQuery, AffiliateTxnQuery, CreateAffiliatePayoutDto } from './affiliate.dto.js';

type Tx = Prisma.TransactionClient;

/** Nguồn nạp tiền được tính hoa hồng (meta.source của giao dịch ví): cổng thanh toán, thẻ cào */
const COMMISSION_SOURCES = ['gateway', 'card_topup'];

/** Nhóm cài đặt `affiliate` đã chuẩn hoá */
export interface AffiliateSettings {
  enabled: boolean;
  /** % hoa hồng trên mỗi lần người được giới thiệu nạp tiền */
  commission: number;
  /** Số tiền rút tối thiểu (VND) */
  minPayout: number;
  walletPayout: boolean;
  bankPayout: boolean;
  /** Chặn gắn người giới thiệu khi tài khoản mới đăng ký từ IP người giới thiệu từng đăng nhập */
  blockSameIp: boolean;
  /** Tự động phát hiện & chặn cộng hoa hồng khi 2 nick trùng IP đăng nhập / OAuth / chạy AI / họ tên (T-431) */
  blockSelfReferral: boolean;
}

/** Số ngày xét IP người giới thiệu đã đăng nhập (chống tự giới thiệu) */
const SAME_IP_WINDOW_DAYS = 30;

/** Chuẩn hoá email về "hộp thư thật": chữ thường, bỏ phần +nhãn, Gmail bỏ dấu chấm ("Nguyen.Van+alt@gmail.com" -> "nguyenvan@gmail.com") */
export function mailboxKey(email: string) {
  const e = String(email ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

export async function readAffiliateSettings(settings: SettingsService): Promise<AffiliateSettings> {
  const s = await settings.get<Partial<AffiliateSettings>>('affiliate');
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: s.enabled !== false,
    commission: Math.min(100, Math.max(0, n(s.commission, 0))),
    minPayout: Math.max(0, n(s.minPayout, 50_000)),
    walletPayout: s.walletPayout !== false,
    bankPayout: s.bankPayout !== false,
    blockSameIp: s.blockSameIp !== false,
    blockSelfReferral: s.blockSelfReferral !== false,
  };
}

/** Chuẩn hoá họ tên bỏ dấu để phát hiện tự lập 2 nick trùng tên thật (T-431) */
function normalizePersonName(raw?: string | null): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Gốc email bỏ số đuôi (vd ngohuyendieu564 -> ngohuyendieu) để phát hiện lập nhiều mail seri */
function emailSerialStem(email?: string | null): string {
  const mk = mailboxKey(email ?? '');
  const at = mk.indexOf('@');
  if (at <= 0) return '';
  const local = mk.slice(0, at).replace(/\d+$/, '').replace(/[._-]+$/, '');
  return local.length >= 7 ? `${local}@${mk.slice(at + 1)}` : '';
}

/** Một thay đổi ví hoa hồng */
export interface AffiliateChange {
  userId: string;
  type: AffiliateTxnType;
  /** Số tiền có dấu: dương = cộng vào ví hoa hồng, âm = trừ */
  amount: number;
  note?: string | null;
  fromUserId?: string | null;
  sourceTxnId?: string | null;
  payoutId?: string | null;
  meta?: Record<string, unknown>;
  idempotencyKey?: string | null;
  createdById?: string | null;
}

const userSelect = { id: true, name: true, email: true } as const;
const roundMoney = (n: number) => Math.round(n * 100) / 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableTxError(err: unknown): boolean {
  const code = String((err as { code?: string } | null)?.code ?? '');
  if (code === 'P2034' || code === '40001' || code === '40P01') return true;
  const msg = String((err as { message?: string } | null)?.message ?? '');
  return /write conflict|deadlock|could not serialize/i.test(msg);
}

async function withDeadlockRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableTxError(err) || attempt === maxAttempts) throw err;
      await sleep(100 * attempt + Math.floor(Math.random() * 120));
    }
  }
  throw lastErr;
}

/** "Nguyễn Văn An" -> "Ng***An" (che tên người được giới thiệu khi hiện cho khách) */
export function maskName(name: string) {
  const s = String(name ?? '').trim();
  if (s.length <= 3) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * Tiếp thị liên kết (giới thiệu bạn bè):
 * mã / link giới thiệu, ví hoa hồng riêng (users.affiliateBalance + sổ cái affiliate_transactions),
 * cộng hoa hồng khi người được giới thiệu nạp tiền, thu hồi khi admin rút lại tiền nạp,
 * yêu cầu rút hoa hồng về số dư ví / ngân hàng (admin duyệt).
 */
@Injectable()
export class AffiliateService implements OnModuleInit {
  private readonly logger = new Logger('Affiliate');
  private reconciling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    const t = setTimeout(() => {
      void this.reconcileMissingCommissions().catch((err: Error) => this.logger.warn(`Đối soát hoa hồng lúc khởi động lỗi: ${err.message}`));
    }, 4_000);
    t.unref?.();
  }

  /** Đối soát tự động mỗi 5 phút: bù ngay mọi giao dịch nạp tiền hợp lệ chưa kịp cộng hoa hồng do tranh chấp khoá DB */
  @Cron('*/5 * * * *')
  async reconcileMissingCommissions() {
    if (process.env.NODE_ENV === 'test' || this.reconciling) return;
    this.reconciling = true;
    try {
      const s = await readAffiliateSettings(this.settings);
      if (!s.enabled || s.commission <= 0) return;
      const missed = await this.prisma.$queryRaw<{ id: string; userId: string; amount: string }[]>`
        SELECT w.id, w."userId", w.amount::text AS amount
        FROM wallet_transactions w
        JOIN users u ON u.id = w."userId"
        JOIN users r ON r.id = u."referredById"
        WHERE w.type = 'DEPOSIT'
          AND w.amount > 0
          AND w."createdAt" >= NOW() - INTERVAL '60 days'
          AND w.meta->>'source' IN ('gateway', 'card_topup')
          AND r.status = 'ACTIVE'
          AND r."deletedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM affiliate_transactions a WHERE a."idempotencyKey" = 'aff:' || w.id
          )
        ORDER BY w."createdAt" ASC
        LIMIT 100
      `;
      for (const row of missed) {
        await this.payCommission({ transactionId: row.id, userId: row.userId, amount: Number(row.amount) });
      }
      if (missed.length) {
        this.logger.log(`Đã đối soát & cộng bù hoa hồng cho ${missed.length} giao dịch nạp tiền`);
      }
    } catch (err) {
      this.logger.warn(`Đối soát hoa hồng định kỳ lỗi: ${(err as Error).message}`);
    } finally {
      this.reconciling = false;
    }
  }

  // ---------------- sổ cái ví hoa hồng ----------------

  /** Thay đổi số dư hoa hồng trong một transaction đang mở (khoá dòng user FOR UPDATE). Ném lỗi nếu trừ quá số dư. */
  async apply(tx: Tx, c: AffiliateChange) {
    const amount = roundMoney(c.amount);
    if (!Number.isFinite(amount) || amount === 0) throw new BadRequestException('Số tiền không hợp lệ');
    const rows = await tx.$queryRaw<{ affiliateBalance: string }[]>`SELECT "affiliateBalance" FROM users WHERE id = ${c.userId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Không tìm thấy thành viên');
    const before = Number(rows[0].affiliateBalance);
    const after = roundMoney(before + amount);
    if (after < 0) throw new BadRequestException(`Số dư hoa hồng không đủ (hiện có ${before.toLocaleString('vi-VN')}đ)`);
    await tx.user.update({ where: { id: c.userId }, data: { affiliateBalance: after } });
    return tx.affiliateTransaction.create({
      data: {
        userId: c.userId,
        type: c.type,
        amount,
        balanceAfter: after,
        note: c.note?.trim() || null,
        fromUserId: c.fromUserId ?? null,
        sourceTxnId: c.sourceTxnId ?? null,
        payoutId: c.payoutId ?? null,
        meta: (c.meta ?? {}) as object,
        idempotencyKey: c.idempotencyKey ?? null,
        createdById: c.createdById ?? null,
      },
    });
  }

  // ---------------- mã giới thiệu ----------------

  /** Mã giới thiệu của khách (tạo khi lần đầu cần) */
  async referralCode(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    if (u?.referralCode) return u.referralCode;
    for (let i = 0; i < 5; i++) {
      const code = randomBytes(4).toString('hex').toUpperCase();
      try {
        await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
        return code;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new Error('Không tạo được mã giới thiệu');
  }

  /**
   * Gắn người giới thiệu cho tài khoản vừa đăng ký (gọi từ AuthService).
   * Bỏ qua nếu mã sai, chương trình tắt, hoặc tự giới thiệu chính mình.
   */
  async attachReferrer(userId: string, code?: string | null, ip?: string | null) {
    const ref = code?.trim().toUpperCase();
    if (!ref) return;
    const s = await readAffiliateSettings(this.settings);
    if (!s.enabled) return;
    const [referrer, me] = await Promise.all([
      this.prisma.user.findFirst({ where: { referralCode: ref, deletedAt: null, status: 'ACTIVE' }, select: { id: true, email: true, lastLoginIp: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    if (!referrer || referrer.id === userId || !me) return;
    // chống tự giới thiệu: cùng hộp thư (biến thể email) luôn chặn; cùng IP người giới thiệu từng đăng nhập trong 30 ngày (tuỳ cài đặt)
    if (mailboxKey(referrer.email) === mailboxKey(me.email)) return this.logger.warn(`Bỏ giới thiệu ${referrer.id} -> ${userId}: cùng hộp thư`);
    if (s.blockSameIp && ip) {
      const since = new Date(Date.now() - SAME_IP_WINDOW_DAYS * 86_400_000);
      const [loginCnt, tokenCnt, taskCnt] = await Promise.all([
        referrer.lastLoginIp === ip
          ? Promise.resolve(1)
          : this.prisma.loginAttempt.count({ where: { userId: referrer.id, ip, success: true, createdAt: { gte: since } } }),
        this.prisma.refreshToken.count({ where: { userId: referrer.id, ip, createdAt: { gte: since } } }),
        this.prisma.aiTask.count({ where: { userId: referrer.id, ip, createdAt: { gte: since } } }),
      ]);
      if (loginCnt > 0 || tokenCnt > 0 || taskCnt > 0) {
        return this.logger.warn(`Bỏ giới thiệu ${referrer.id} -> ${userId}: đăng ký cùng IP người giới thiệu (${ip})`);
      }
    }
    await this.prisma.user.updateMany({ where: { id: userId, referredById: null }, data: { referredById: referrer.id } });
  }

  /** Thành viên mới đăng ký kèm mã giới thiệu (`ref` trong sự kiện user.registered) */
  @OnEvent('user.registered', { async: true })
  async onRegistered(e: { user: { id: string }; ref?: string; ip?: string | null }) {
    try {
      await this.attachReferrer(e.user.id, e.ref, e.ip);
    } catch (err) {
      this.logger.warn(`Gắn người giới thiệu lỗi: ${(err as Error).message}`);
    }
  }

  // ---------------- trang của khách ----------------

  /** Trang "Tiếp thị liên kết" của khách: link, số dư hoa hồng, thống kê, người được giới thiệu gần đây */
  async overview(userId: string) {
    const s = await readAffiliateSettings(this.settings);
    const code = await this.referralCode(userId);
    const web = await frontendBaseUrl(this.config, this.settings);
    const [user, referrals, earned, pending, paidOut, recent] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { affiliateBalance: true } }),
      this.prisma.user.count({ where: { referredById: userId } }),
      this.prisma.affiliateTransaction.aggregate({ where: { userId, type: { in: ['COMMISSION', 'REVOKE'] } }, _sum: { amount: true } }),
      this.prisma.affiliatePayout.aggregate({ where: { userId, status: 'PENDING' }, _sum: { amount: true } }),
      this.prisma.affiliatePayout.aggregate({ where: { userId, status: 'APPROVED' }, _sum: { amount: true } }),
      this.prisma.user.findMany({ where: { referredById: userId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, name: true, createdAt: true } }),
    ]);
    const byRef = recent.length
      ? await this.prisma.affiliateTransaction.groupBy({ by: ['fromUserId'], where: { userId, fromUserId: { in: recent.map((r) => r.id) }, type: { in: ['COMMISSION', 'REVOKE'] } }, _sum: { amount: true } })
      : [];
    return {
      enabled: s.enabled,
      code,
      link: web ? `${web}/register?ref=${code}` : `/register?ref=${code}`,
      commission: s.commission,
      referrals,
      earned: Number(earned._sum.amount ?? 0),
      balance: Number(user?.affiliateBalance ?? 0),
      pendingPayout: Number(pending._sum.amount ?? 0),
      paidOut: Number(paidOut._sum.amount ?? 0),
      payout: { min: s.minPayout, wallet: s.walletPayout, bank: s.bankPayout },
      recent: recent.map((r) => ({ name: maskName(r.name), createdAt: r.createdAt, earned: Number(byRef.find((g) => g.fromUserId === r.id)?._sum.amount ?? 0) })),
    };
  }

  /** Lịch sử ví hoa hồng của khách */
  async myTransactions(userId: string, q: AffiliateTxnQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.AffiliateTransactionWhereInput = { userId, ...(q.type ? { type: q.type } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.affiliateTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { fromUser: { select: { name: true } }, payout: { select: { code: true } } } }),
      this.prisma.affiliateTransaction.count({ where }),
    ]);
    // khách chỉ thấy tên đã che của người được giới thiệu
    const data = rows.map(({ fromUser, meta: _meta, createdById: _c, idempotencyKey: _k, ...r }) => ({ ...r, fromUser: fromUser ? { name: maskName(fromUser.name) } : null }));
    return paginate(data, total, page, limit);
  }

  /** Yêu cầu rút của khách */
  async myPayouts(userId: string, q: AffiliatePayoutQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.AffiliatePayoutWhereInput = { userId, ...(q.status ? { status: q.status as 'PENDING' } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.affiliatePayout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: { id: true, code: true, amount: true, method: true, status: true, bankName: true, bankAccount: true, bankHolder: true, note: true, adminNote: true, processedAt: true, createdAt: true },
      }),
      this.prisma.affiliatePayout.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  /** Khách gửi yêu cầu rút: trừ ngay ví hoa hồng (giữ tiền chờ duyệt). Mỗi khách chỉ có một yêu cầu đang chờ. */
  async requestPayout(userId: string, dto: CreateAffiliatePayoutDto) {
    const s = await readAffiliateSettings(this.settings);
    if (!s.enabled) throw new BadRequestException('Chương trình giới thiệu đang tạm dừng');
    if (dto.method === 'WALLET' && !s.walletPayout) throw new BadRequestException('Website chưa cho rút hoa hồng vào số dư ví');
    if (dto.method === 'BANK' && !s.bankPayout) throw new BadRequestException('Website chưa cho rút hoa hồng về ngân hàng');
    const amount = roundMoney(dto.amount);
    if (amount < s.minPayout) throw new BadRequestException(`Số tiền rút tối thiểu là ${s.minPayout.toLocaleString('vi-VN')}đ`);
    const bank = dto.method === 'BANK';
    if (bank && (!dto.bankName?.trim() || !dto.bankAccount?.trim() || !dto.bankHolder?.trim())) throw new BadRequestException('Vui lòng nhập đủ ngân hàng, số tài khoản và chủ tài khoản');
    const payout = await this.prisma.$transaction(async (tx) => {
      // khoá dòng user trước khi kiểm tra yêu cầu đang chờ để hai request song song không cùng lọt
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const open = await tx.affiliatePayout.count({ where: { userId, status: 'PENDING' } });
      if (open) throw new ConflictException('Bạn đang có một yêu cầu rút chờ duyệt, vui lòng đợi xử lý xong');
      const p = await tx.affiliatePayout.create({
        data: {
          userId,
          amount,
          method: dto.method,
          bankName: bank ? dto.bankName?.trim() : null,
          bankAccount: bank ? dto.bankAccount?.replace(/\s+/g, '') : null,
          bankHolder: bank ? dto.bankHolder?.trim().toUpperCase() : null,
          note: dto.note?.trim() || null,
        },
      });
      await this.apply(tx, { userId, type: 'PAYOUT', amount: -amount, payoutId: p.id, note: `Yêu cầu rút #${p.code} (${bank ? 'ngân hàng' : 'vào ví'})`, idempotencyKey: `aff-payout:${p.id}` });
      return p;
    });
    this.events.emit('activity', { userId, action: 'affiliate.payout_requested', entityType: 'affiliate_payout', entityId: payout.id, meta: { amount, method: dto.method } });
    return payout;
  }

  /** Khách tự huỷ yêu cầu đang chờ -> trả lại ví hoa hồng */
  async cancelPayout(userId: string, id: string) {
    const p = await this.prisma.affiliatePayout.findFirst({ where: { id, userId } });
    if (!p) throw new NotFoundException('Không tìm thấy yêu cầu rút');
    await this.closeWithRefund(p.id, 'CANCELLED', { note: `Huỷ yêu cầu rút #${p.code}` });
    return this.prisma.affiliatePayout.findUnique({ where: { id } });
  }

  /** Đóng yêu cầu PENDING (từ chối / huỷ) và trả tiền về ví hoa hồng — cập nhật có điều kiện chống xử lý hai lần */
  private async closeWithRefund(id: string, status: 'REJECTED' | 'CANCELLED', o: { note: string; actorId?: string | null; adminNote?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.affiliatePayout.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Không tìm thấy yêu cầu rút');
      const done = await tx.affiliatePayout.updateMany({
        where: { id, status: 'PENDING' },
        data: { status, processedAt: new Date(), processedById: o.actorId ?? null, ...(o.adminNote !== undefined ? { adminNote: o.adminNote?.trim() || null } : {}) },
      });
      if (!done.count) throw new ConflictException('Yêu cầu rút này đã được xử lý');
      await this.apply(tx, { userId: p.userId, type: 'PAYOUT_REFUND', amount: Number(p.amount), payoutId: p.id, note: o.note, createdById: o.actorId ?? null, idempotencyKey: `aff-payout-refund:${p.id}` });
    });
  }

  // ---------------- cộng / thu hồi hoa hồng ----------------

  /** Ví thay đổi: nạp tiền -> cộng hoa hồng; admin trừ tiền đánh dấu "rút lại tiền nạp" -> thu hồi hoa hồng */
  @OnEvent('wallet.changed', { async: true })
  async onWalletChanged(e: { transactionId: string; userId: string; type: string; amount: number }) {
    if (e.type === 'DEPOSIT' && e.amount > 0) {
      // Nhường ~300ms để luồng `wallet.topup_completed` (cộng khuyến mãi nạp vào users[fromUserId]) hoàn tất trước, tránh tranh chấp khoá FK trên bảng users
      await sleep(300);
      return this.payCommission(e);
    }
    if (e.type === 'WITHDRAW' && e.amount < 0) return this.revokeCommission(e);
  }

  /**
   * Cộng hoa hồng cho người giới thiệu khi người được giới thiệu nạp tiền qua cổng / thẻ cào.
   * Người giới thiệu bị khoá / đã xoá thì không nhận. idempotencyKey theo giao dịch nạp nên event bắn lại không cộng hai lần.
   */
  private async payCommission(e: { transactionId: string; userId: string; amount: number }) {
    try {
      const s = await readAffiliateSettings(this.settings);
      if (!s.enabled || s.commission <= 0) return;
      const [txn, user] = await Promise.all([
        this.prisma.walletTransaction.findUnique({ where: { id: e.transactionId }, select: { meta: true } }),
        this.prisma.user.findUnique({ where: { id: e.userId }, select: { referredById: true, name: true, referredBy: { select: { status: true, deletedAt: true } } } }),
      ]);
      const source = (txn?.meta as { source?: string } | null)?.source;
      if (!user?.referredById || !source || !COMMISSION_SOURCES.includes(source)) return;
      if (user.referredBy?.status !== 'ACTIVE' || user.referredBy.deletedAt) return;
      if (s.blockSelfReferral) {
        const selfSignals = await this.checkPairSelfReferralSignals(user.referredById, e.userId);
        if (selfSignals.highConfidence) {
          this.logger.warn(`[T-431 Chặn Aff 2 nick] Bỏ cộng hoa hồng ${user.referredById} <- ${e.userId}: ${selfSignals.reasons.join('; ')}`);
          return;
        }
      }
      const amount = roundMoney((e.amount * s.commission) / 100);
      if (amount <= 0) return;
      await withDeadlockRetry(() =>
        this.prisma.$transaction((tx) =>
          this.apply(tx, {
            userId: user.referredById!,
            type: 'COMMISSION',
            amount,
            fromUserId: e.userId,
            sourceTxnId: e.transactionId,
            note: `Hoa hồng ${s.commission}% từ ${maskName(user.name)} nạp ${e.amount.toLocaleString('vi-VN')}đ`,
            meta: { percent: s.commission, deposit: e.amount },
            idempotencyKey: `aff:${e.transactionId}`,
          }),
        ),
      );
      // báo người giới thiệu (bot Telegram khách) — chỉ bắn sau khi cộng thành công, bắn lại event cũ sẽ dừng ở lỗi trùng khoá phía trên
      this.events.emit('affiliate.commission', { userId: user.referredById, amount, percent: s.commission, fromName: maskName(user.name), deposit: e.amount });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return;
      this.logger.warn(`Cộng hoa hồng lỗi: ${(err as Error).message}`);
    }
  }

  /**
   * Thu hồi hoa hồng khi admin trừ tiền khách với tuỳ chọn "rút lại tiền nạp" (meta.revokeCommission).
   * Số thu hồi = tiền bị trừ × tỉ lệ hoa hồng đã trả trên tiền nạp, không vượt phần hoa hồng chưa thu hồi
   * và không vượt số dư ví hoa hồng hiện có (phần thiếu chỉ ghi log).
   */
  private async revokeCommission(e: { transactionId: string; userId: string; amount: number }) {
    try {
      const [txn, user] = await Promise.all([
        this.prisma.walletTransaction.findUnique({ where: { id: e.transactionId }, select: { meta: true } }),
        this.prisma.user.findUnique({ where: { id: e.userId }, select: { referredById: true, name: true } }),
      ]);
      if (!(txn?.meta as { revokeCommission?: boolean } | null)?.revokeCommission || !user?.referredById) return;
      const referrerId = user.referredById;
      await withDeadlockRetry(() =>
        this.prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ affiliateBalance: string }[]>`SELECT "affiliateBalance" FROM users WHERE id = ${referrerId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
          if (!rows.length) return;
          const hist = await tx.affiliateTransaction.findMany({ where: { userId: referrerId, fromUserId: e.userId, type: { in: ['COMMISSION', 'REVOKE'] } }, select: { type: true, amount: true, meta: true } });
          let paid = 0;
          let revoked = 0;
          let deposited = 0;
          for (const r of hist) {
            if (r.type === 'COMMISSION') {
              paid += Number(r.amount);
              deposited += Number((r.meta as { deposit?: number } | null)?.deposit ?? 0);
            } else revoked += -Number(r.amount);
          }
          const remaining = roundMoney(paid - revoked);
          if (remaining <= 0 || deposited <= 0) return;
          const target = Math.min(roundMoney((Math.abs(e.amount) * paid) / deposited), remaining);
          const take = Math.min(target, roundMoney(Number(rows[0].affiliateBalance)));
          if (take <= 0) {
            this.logger.warn(`Thu hồi hoa hồng: người giới thiệu ${referrerId} hết số dư hoa hồng, thiếu ${target}đ`);
            return;
          }
          await this.apply(tx, {
            userId: referrerId,
            type: 'REVOKE',
            amount: -take,
            fromUserId: e.userId,
            sourceTxnId: e.transactionId,
            note: `Thu hồi hoa hồng do ${maskName(user.name)} bị rút lại tiền nạp${take < target ? ` (còn thiếu ${(target - take).toLocaleString('vi-VN')}đ)` : ''}`,
            meta: { target, shortfall: roundMoney(target - take) },
            idempotencyKey: `aff-revoke:${e.transactionId}`,
          });
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return;
      this.logger.warn(`Thu hồi hoa hồng lỗi: ${(err as Error).message}`);
    }
  }

  // ---------------- quản trị ----------------

  /** Tổng quan cho trang admin Tiếp thị liên kết */
  async adminStats() {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const sum = (v: { _sum: { amount: Prisma.Decimal | null } }) => Number(v._sum.amount ?? 0);
    const [commAll, comm30, revoked, balances, pending, approved, referred, top] = await Promise.all([
      this.prisma.affiliateTransaction.aggregate({ where: { type: 'COMMISSION' }, _sum: { amount: true } }),
      this.prisma.affiliateTransaction.aggregate({ where: { type: 'COMMISSION', createdAt: { gte: since } }, _sum: { amount: true } }),
      this.prisma.affiliateTransaction.aggregate({ where: { type: 'REVOKE' }, _sum: { amount: true } }),
      this.prisma.user.aggregate({ where: { deletedAt: null }, _sum: { affiliateBalance: true } }),
      this.prisma.affiliatePayout.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      this.prisma.affiliatePayout.groupBy({ by: ['method'], where: { status: 'APPROVED' }, _sum: { amount: true } }),
      this.prisma.user.count({ where: { referredById: { not: null }, deletedAt: null } }),
      this.prisma.affiliateTransaction.groupBy({ by: ['userId'], where: { type: { in: ['COMMISSION', 'REVOKE'] } }, _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 10 }),
    ]);
    const users = top.length ? await this.prisma.user.findMany({ where: { id: { in: top.map((t) => t.userId) } }, select: { ...userSelect, affiliateBalance: true, referralCode: true, _count: { select: { referrals: true } } } }) : [];
    return {
      settings: await readAffiliateSettings(this.settings),
      commissionTotal: sum(commAll),
      commission30d: sum(comm30),
      revokedTotal: Math.abs(sum(revoked)),
      outstanding: Number(balances._sum.affiliateBalance ?? 0),
      pendingCount: pending._count,
      pendingAmount: sum(pending),
      paidToWallet: Number(approved.find((a) => a.method === 'WALLET')?._sum.amount ?? 0),
      paidToBank: Number(approved.find((a) => a.method === 'BANK')?._sum.amount ?? 0),
      referred,
      // số người đang có ít nhất một người được giới thiệu
      referrers: (await this.prisma.user.groupBy({ by: ['referredById'], where: { referredById: { not: null }, deletedAt: null } })).length,
      top: top
        .map((t) => {
          const u = users.find((x) => x.id === t.userId);
          return u ? { id: u.id, name: u.name, email: u.email, referralCode: u.referralCode, affiliateBalance: Number(u.affiliateBalance), referrals: u._count.referrals, earned: Number(t._sum.amount ?? 0) } : null;
        })
        .filter(Boolean),
    };
  }

  /** Lịch sử ví hoa hồng toàn hệ thống (lọc loại / khách / tìm theo tên, email) */
  async adminTransactions(q: AffiliateTxnQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const search = q.search?.trim();
    const where: Prisma.AffiliateTransactionWhereInput = {
      ...(q.type ? { type: q.type } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(search ? { user: { OR: [{ email: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.affiliateTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { user: { select: userSelect }, fromUser: { select: userSelect }, createdBy: { select: { id: true, name: true } }, payout: { select: { id: true, code: true } } },
      }),
      this.prisma.affiliateTransaction.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  /** Danh sách yêu cầu rút + đếm theo trạng thái cho tab lọc */
  async adminPayouts(q: AffiliatePayoutQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const search = q.search?.trim();
    const where: Prisma.AffiliatePayoutWhereInput = {
      ...(q.status ? { status: q.status as 'PENDING' } : {}),
      ...(q.method ? { method: q.method } : {}),
      ...(search
        ? {
            OR: [
              { user: { email: { contains: search, mode: 'insensitive' } } },
              { user: { name: { contains: search, mode: 'insensitive' } } },
              { bankAccount: { contains: search } },
              ...(/^\d+$/.test(search.replace(/^#/, '')) ? [{ code: Number(search.replace(/^#/, '')) }] : []),
            ],
          }
        : {}),
    };
    const [rows, total, counts] = await Promise.all([
      this.prisma.affiliatePayout.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: { user: { select: { ...userSelect, affiliateBalance: true } }, processedBy: { select: { id: true, name: true } } },
      }),
      this.prisma.affiliatePayout.count({ where }),
      this.prisma.affiliatePayout.groupBy({ by: ['status'], _count: true }),
    ]);
    return { ...paginate(rows, total, page, limit), counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
  }

  /**
   * Duyệt yêu cầu rút. Rút vào ví: cộng số dư ví ngay (DEPOSIT, meta.source = affiliate_payout — không sinh hoa hồng).
   * Rút ngân hàng: admin đã tự chuyển khoản, bấm duyệt để đánh dấu đã trả.
   */
  async approvePayout(id: string, actorId: string, adminNote?: string) {
    const walletTxn = await this.prisma.$transaction(async (tx) => {
      const p = await tx.affiliatePayout.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Không tìm thấy yêu cầu rút');
      const done = await tx.affiliatePayout.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPROVED', processedAt: new Date(), processedById: actorId, adminNote: adminNote?.trim() || null } });
      if (!done.count) throw new ConflictException('Yêu cầu rút này đã được xử lý');
      if (p.method !== 'WALLET') return null;
      const w = await this.wallet.apply(tx, {
        userId: p.userId,
        type: 'DEPOSIT',
        amount: Number(p.amount),
        note: `Rút hoa hồng giới thiệu #${p.code} vào ví`,
        createdById: actorId,
        meta: { source: 'affiliate_payout', payoutId: p.id },
        idempotencyKey: `aff-payout-wallet:${p.id}`,
      });
      await tx.affiliatePayout.update({ where: { id }, data: { walletTxnId: w.id } });
      return w;
    });
    if (walletTxn) await this.wallet.afterChange(walletTxn);
    this.events.emit('activity', { userId: actorId, action: 'affiliate.payout_approved', entityType: 'affiliate_payout', entityId: id });
    return this.prisma.affiliatePayout.findUnique({ where: { id } });
  }

  /** Từ chối yêu cầu rút -> trả tiền về ví hoa hồng của khách */
  async rejectPayout(id: string, actorId: string, adminNote?: string) {
    const p = await this.prisma.affiliatePayout.findUnique({ where: { id }, select: { code: true } });
    if (!p) throw new NotFoundException('Không tìm thấy yêu cầu rút');
    await this.closeWithRefund(id, 'REJECTED', { note: `Hoàn tiền yêu cầu rút #${p.code} bị từ chối`, actorId, adminNote: adminNote ?? null });
    this.events.emit('activity', { userId: actorId, action: 'affiliate.payout_rejected', entityType: 'affiliate_payout', entityId: id });
    return this.prisma.affiliatePayout.findUnique({ where: { id } });
  }

  /** Admin cộng / trừ tay ví hoa hồng (khoá chống bấm trùng) */
  async adjust(userId: string, dto: AdjustAffiliateDto, actorId: string) {
    const key = dto.idempotencyKey?.trim() ? `aff-adjust:${dto.idempotencyKey.trim()}` : null;
    try {
      const t = await this.prisma.$transaction((tx) => this.apply(tx, { userId, type: 'ADJUST', amount: dto.amount, note: dto.note, createdById: actorId, idempotencyKey: key }));
      this.events.emit('activity', { userId: actorId, action: 'affiliate.adjust', entityType: 'user', entityId: userId, meta: { amount: Number(t.amount) } });
      return { transaction: t, balance: Number(t.balanceAfter) };
    } catch (err) {
      if (key && (err as { code?: string }).code === 'P2002') {
        const t = await this.prisma.affiliateTransaction.findUnique({ where: { idempotencyKey: key } });
        if (t && t.userId === userId) return { transaction: t, balance: Number(t.balanceAfter), duplicate: true };
      }
      throw err;
    }
  }

  // ---------------- phát hiện & lọc khách tự lập 2 nick cày Affiliate (T-431) ----------------

  /** Kiểm tra nhanh cặp (người giới thiệu, người được giới thiệu) có dấu hiệu cùng 1 người (Aff 2 nick) không */
  private async checkPairSelfReferralSignals(referrerId: string, childId: string): Promise<{ highConfidence: boolean; reasons: string[] }> {
    const [refUser, childUser, sharedIpRows, sharedBankRows] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: referrerId },
        select: { name: true, email: true, lastLoginIp: true, telegramChatId: true },
      }),
      this.prisma.user.findUnique({
        where: { id: childId },
        select: { name: true, email: true, lastLoginIp: true, telegramChatId: true },
      }),
      this.prisma.$queryRawUnsafe<{ ip: string }[]>(
        `WITH ref_ips AS (
           SELECT "lastLoginIp" AS ip FROM users WHERE id = $1::uuid AND "lastLoginIp" IS NOT NULL
           UNION SELECT ip FROM refresh_tokens WHERE "userId" = $1::uuid AND ip IS NOT NULL
           UNION SELECT ip FROM login_attempts WHERE "userId" = $1::uuid AND success = TRUE AND ip IS NOT NULL
           UNION SELECT ip FROM ai_tasks WHERE "userId" = $1::uuid AND ip IS NOT NULL
         ),
         child_ips AS (
           SELECT "lastLoginIp" AS ip FROM users WHERE id = $2::uuid AND "lastLoginIp" IS NOT NULL
           UNION SELECT ip FROM refresh_tokens WHERE "userId" = $2::uuid AND ip IS NOT NULL
           UNION SELECT ip FROM login_attempts WHERE "userId" = $2::uuid AND success = TRUE AND ip IS NOT NULL
           UNION SELECT ip FROM ai_tasks WHERE "userId" = $2::uuid AND ip IS NOT NULL
         )
         SELECT r.ip FROM ref_ips r JOIN child_ips c ON c.ip = r.ip WHERE r.ip <> '' LIMIT 3`,
        referrerId,
        childId,
      ),
      this.prisma.$queryRawUnsafe<{ bank: string }[]>(
        `SELECT p1."bankAccount" AS bank
         FROM affiliate_payouts p1
         JOIN affiliate_payouts p2 ON p2."bankAccount" = p1."bankAccount"
         WHERE p1."userId" = $1::uuid AND p2."userId" = $2::uuid AND p1."bankAccount" IS NOT NULL AND p1."bankAccount" <> ''
         LIMIT 1`,
        referrerId,
        childId,
      ),
    ]);

    const reasons: string[] = [];
    if (sharedIpRows.length > 0) {
      reasons.push(`Trùng IP thiết bị (${sharedIpRows.map((x) => x.ip).join(', ')})`);
    }
    if (sharedBankRows.length > 0) {
      reasons.push(`Trùng STK ngân hàng (${sharedBankRows[0].bank})`);
    }
    if (refUser?.telegramChatId && childUser?.telegramChatId && refUser.telegramChatId === childUser.telegramChatId) {
      reasons.push(`Trùng Telegram ID (${refUser.telegramChatId})`);
    }
    if (refUser && childUser) {
      if (mailboxKey(refUser.email) === mailboxKey(childUser.email)) {
        reasons.push('Trùng hộp thư gốc');
      }
      const n1 = normalizePersonName(refUser.name);
      const n2 = normalizePersonName(childUser.name);
      if (n1.length >= 6 && n1.includes(' ') && n1 === n2) {
        reasons.push(`Trùng họ tên ("${childUser.name}")`);
      }
    }

    return { highConfidence: reasons.length > 0, reasons };
  }

  /**
   * Danh sách rà soát các cặp giới thiệu & bộ lọc tự động phát hiện khách lập 2 nick tự ăn hoa hồng (T-431)
   */
  async adminSelfReferralAudit(onlySuspicious = true, search?: string) {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        child_id: string;
        child_name: string;
        child_email: string;
        child_created: Date;
        child_wallet: string;
        child_deposited: string;
        ref_id: string;
        ref_name: string;
        ref_email: string;
        ref_code: string | null;
        ref_created: Date;
        ref_aff_balance: string;
        ref_spent_tasks: number;
        earned_from_child: string;
        shared_ips: string[] | null;
        shared_banks: string[] | null;
        same_telegram: boolean;
      }[]
    >(`
      SELECT
        u.id AS child_id,
        u.name AS child_name,
        u.email AS child_email,
        u."createdAt" AS child_created,
        u."walletBalance"::text AS child_wallet,
        COALESCE((
          SELECT SUM(w.amount) FROM wallet_transactions w
          WHERE w."userId" = u.id AND w.type = 'DEPOSIT' AND w.amount > 0 AND w.meta->>'source' IN ('gateway', 'card_topup')
        ), 0)::text AS child_deposited,
        r.id AS ref_id,
        r.name AS ref_name,
        r.email AS ref_email,
        r."referralCode" AS ref_code,
        r."createdAt" AS ref_created,
        r."affiliateBalance"::text AS ref_aff_balance,
        (SELECT COUNT(*)::int FROM ai_tasks t WHERE t."userId" = r.id) AS ref_spent_tasks,
        COALESCE((
          SELECT SUM(atx.amount) FROM affiliate_transactions atx
          WHERE atx."userId" = r.id AND atx."fromUserId" = u.id AND atx.type IN ('COMMISSION', 'REVOKE')
        ), 0)::text AS earned_from_child,
        ARRAY(
          SELECT DISTINCT ip FROM (
            SELECT u."lastLoginIp" AS ip WHERE u."lastLoginIp" IS NOT NULL AND u."lastLoginIp" <> ''
            UNION SELECT ip FROM refresh_tokens WHERE "userId" = u.id AND ip IS NOT NULL AND ip <> ''
            UNION SELECT ip FROM login_attempts WHERE "userId" = u.id AND success = TRUE AND ip IS NOT NULL AND ip <> ''
            UNION SELECT ip FROM ai_tasks WHERE "userId" = u.id AND ip IS NOT NULL AND ip <> ''
          ) ci
          INTERSECT
          SELECT DISTINCT ip FROM (
            SELECT r."lastLoginIp" AS ip WHERE r."lastLoginIp" IS NOT NULL AND r."lastLoginIp" <> ''
            UNION SELECT ip FROM refresh_tokens WHERE "userId" = r.id AND ip IS NOT NULL AND ip <> ''
            UNION SELECT ip FROM login_attempts WHERE "userId" = r.id AND success = TRUE AND ip IS NOT NULL AND ip <> ''
            UNION SELECT ip FROM ai_tasks WHERE "userId" = r.id AND ip IS NOT NULL AND ip <> ''
          ) ri
        ) AS shared_ips,
        ARRAY(
          SELECT DISTINCT p1."bankAccount"
          FROM affiliate_payouts p1
          JOIN affiliate_payouts p2 ON p2."bankAccount" = p1."bankAccount"
          WHERE p1."userId" = r.id AND p2."userId" = u.id AND p1."bankAccount" IS NOT NULL AND p1."bankAccount" <> ''
        ) AS shared_banks,
        (u."telegramChatId" IS NOT NULL AND u."telegramChatId" <> '' AND u."telegramChatId" = r."telegramChatId") AS same_telegram
      FROM users u
      JOIN users r ON r.id = u."referredById"
      WHERE u."deletedAt" IS NULL AND r."deletedAt" IS NULL
      ORDER BY u."createdAt" DESC
      LIMIT 500
    `);

    const q = (search ?? '').trim().toLowerCase();
    const mapped = rows.map((row) => {
      const flags: { code: string; label: string; severity: 'high' | 'medium' }[] = [];
      let riskScore = 0;

      const ips = Array.isArray(row.shared_ips) ? row.shared_ips.filter(Boolean) : [];
      if (ips.length > 0) {
        riskScore += 70;
        flags.push({ code: 'shared_ip', label: `Trùng IP: ${ips.slice(0, 2).join(', ')}`, severity: 'high' });
      }
      const banks = Array.isArray(row.shared_banks) ? row.shared_banks.filter(Boolean) : [];
      if (banks.length > 0) {
        riskScore += 80;
        flags.push({ code: 'shared_bank', label: `Trùng STK rút: ${banks[0]}`, severity: 'high' });
      }
      if (row.same_telegram) {
        riskScore += 80;
        flags.push({ code: 'same_telegram', label: 'Trùng Telegram liên kết', severity: 'high' });
      }
      if (mailboxKey(row.ref_email) === mailboxKey(row.child_email)) {
        riskScore += 80;
        flags.push({ code: 'same_mailbox', label: 'Trùng hộp thư Gmail gốc', severity: 'high' });
      } else {
        const s1 = emailSerialStem(row.ref_email);
        const s2 = emailSerialStem(row.child_email);
        if (s1 && s1 === s2) {
          riskScore += 55;
          flags.push({ code: 'serial_email', label: `Email seri cùng gốc (${s1.split('@')[0]}*)`, severity: 'medium' });
        }
      }

      const nRef = normalizePersonName(row.ref_name);
      const nChild = normalizePersonName(row.child_name);
      if (nRef.length >= 5 && nRef === nChild) {
        riskScore += 65;
        flags.push({ code: 'same_name', label: `Trùng họ tên ("${row.child_name}")`, severity: 'high' });
      }

      const diffMin = Math.abs(new Date(row.child_created).getTime() - new Date(row.ref_created).getTime()) / 60_000;
      if (diffMin <= 20 && Number(row.ref_spent_tasks) === 0) {
        riskScore += 45;
        flags.push({
          code: 'shell_referrer',
          label: `Lập 2 nick cách nhau ${Math.max(1, Math.round(diffMin))}p · Nick gốc 0 lượt dùng AI`,
          severity: 'medium',
        });
      }

      return {
        child: {
          id: row.child_id,
          name: row.child_name,
          email: row.child_email,
          createdAt: row.child_created,
          walletBalance: Number(row.child_wallet ?? 0),
          totalDeposited: Number(row.child_deposited ?? 0),
        },
        referrer: {
          id: row.ref_id,
          name: row.ref_name,
          email: row.ref_email,
          referralCode: row.ref_code,
          createdAt: row.ref_created,
          affiliateBalance: Number(row.ref_aff_balance ?? 0),
          aiTaskCount: Number(row.ref_spent_tasks ?? 0),
        },
        earnedFromChild: Number(row.earned_from_child ?? 0),
        riskScore: Math.min(100, riskScore),
        suspicious: riskScore >= 40,
        flags,
      };
    });

    const searched = q
      ? mapped.filter(
          (x) =>
            x.child.email.toLowerCase().includes(q) ||
            x.child.name.toLowerCase().includes(q) ||
            x.referrer.email.toLowerCase().includes(q) ||
            x.referrer.name.toLowerCase().includes(q) ||
            x.flags.some((f) => f.label.toLowerCase().includes(q)),
        )
      : mapped;

    const suspiciousCount = searched.filter((x) => x.suspicious).length;
    const list = onlySuspicious ? searched.filter((x) => x.suspicious) : searched;
    list.sort((a, b) => b.riskScore - a.riskScore || b.earnedFromChild - a.earnedFromChild);

    return {
      totalPairs: searched.length,
      suspiciousCount,
      items: list,
    };
  }

  /**
   * Admin bấm gỡ liên kết giới thiệu của cặp Aff 2 nick (tuỳ chọn thu hồi luôn phần hoa hồng đã nhận từ nick phụ)
   */
  async adminUnlinkSelfReferral(childId: string, revokeEarned: boolean, actorId: string) {
    const child = await this.prisma.user.findUnique({
      where: { id: childId },
      select: { id: true, name: true, email: true, referredById: true },
    });
    if (!child || !child.referredById) {
      throw new BadRequestException('Tài khoản này không còn gắn người giới thiệu');
    }
    const referrerId = child.referredById;
    let revokedAmount = 0;

    await withDeadlockRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id, "affiliateBalance" FROM users WHERE id = ${referrerId}::uuid FOR UPDATE`;
        await tx.user.update({ where: { id: child.id }, data: { referredById: null } });

        if (revokeEarned) {
          const hist = await tx.affiliateTransaction.findMany({
            where: { userId: referrerId, fromUserId: child.id, type: { in: ['COMMISSION', 'REVOKE'] } },
            select: { amount: true },
          });
          const netEarned = roundMoney(hist.reduce((s, r) => s + Number(r.amount), 0));
          if (netEarned > 0) {
            const refRow = await tx.user.findUnique({ where: { id: referrerId }, select: { affiliateBalance: true } });
            const take = Math.min(netEarned, Math.max(0, roundMoney(Number(refRow?.affiliateBalance ?? 0))));
            if (take > 0) {
              revokedAmount = take;
              await this.apply(tx, {
                userId: referrerId,
                type: 'REVOKE',
                amount: -take,
                fromUserId: child.id,
                createdById: actorId,
                note: `Thu hồi hoa hồng tự giới thiệu 2 nick (${child.email})`,
                idempotencyKey: `aff-selfref-revoke:${referrerId}:${child.id}:${Date.now()}`,
              });
            }
          }
        }
      }),
    );

    this.events.emit('activity', {
      userId: actorId,
      action: 'affiliate.self_referral_unlinked',
      entityType: 'user',
      entityId: child.id,
      meta: { referrerId, revokedAmount },
    });

    return { ok: true, unlinkedChildId: child.id, referrerId, revokedAmount };
  }
}
