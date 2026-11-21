import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service.js';
import { HooksService } from '../hooks/hooks.service.js';
import { pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { Prisma, WalletTxnType } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import type { AdjustWalletDto, WalletQueryDto } from './wallet.dto.js';

/** Client Prisma trong transaction (để gọi được từ checkout / hoàn tiền đang mở $transaction) */
type Tx = Prisma.TransactionClient;

export interface WalletChange {
  userId: string;
  type: WalletTxnType;
  /** Số tiền có dấu: dương = cộng vào ví, âm = trừ khỏi ví */
  amount: number;
  note?: string | null;
  orderId?: string | null;
  /** Admin thực hiện; null = hệ thống / khách tự thanh toán */
  createdById?: string | null;
  meta?: Record<string, unknown>;
  /** Khoá chống trùng (unique) — cùng khoá chỉ ghi được một giao dịch */
  idempotencyKey?: string | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Ví thành viên: số dư lưu ở `users.walletBalance`, mọi thay đổi đều đi qua `apply()`
 * (khoá dòng user FOR UPDATE + ghi một dòng wallet_transactions) nên không bao giờ trừ quá số dư.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly hooks: HooksService,
  ) {}

  /** Số dư hiện tại + thống kê nhanh */
  async summary(userId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, walletBalance: true } });
    if (!user) throw new NotFoundException('Không tìm thấy thành viên');
    const [agg, count] = await Promise.all([
      this.prisma.walletTransaction.groupBy({ by: ['type'], where: { userId }, _sum: { amount: true } }),
      this.prisma.walletTransaction.count({ where: { userId } }),
    ]);
    const sum = (t: WalletTxnType) => Math.abs(Number(agg.find((a) => a.type === t)?._sum.amount ?? 0));
    return {
      balance: Number(user.walletBalance),
      totalDeposited: sum('DEPOSIT'),
      totalWithdrawn: sum('WITHDRAW'),
      totalSpent: sum('PAYMENT'),
      totalRefunded: sum('REFUND'),
      transactionCount: count,
    };
  }

  /** Lịch sử giao dịch (mới nhất trước), kèm mã đơn và tên admin thao tác */
  async transactions(userId: string, q: WalletQueryDto) {
    const { skip, take, page, limit } = pageArgs(q);
    const where: Prisma.WalletTransactionWhereInput = { userId, ...(q.type ? { type: q.type } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { order: { select: { id: true, code: true } }, createdBy: { select: { id: true, name: true } } },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);
    return paginate(rows, total, page, limit);
  }

  /**
   * Thay đổi số dư trong một transaction DB đang mở. Ném lỗi nếu trừ quá số dư.
   * Trả về giao dịch ví vừa tạo (kèm balanceAfter).
   */
  async apply(tx: Tx, change: WalletChange) {
    const amount = round(change.amount);
    if (!Number.isFinite(amount) || amount === 0) throw new BadRequestException('Số tiền không hợp lệ');
    // khoá dòng user để hai giao dịch song song không cùng đọc một số dư cũ
    const rows = await tx.$queryRaw<{ walletBalance: string }[]>`SELECT "walletBalance" FROM users WHERE id = ${change.userId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Không tìm thấy thành viên');
    // T-436: Kiểm tra lại khoá chống trùng NGAY BÊN TRONG khoá dòng FOR UPDATE (chống tuyệt đối 2 tiến trình PM2 chạy song song trừ/cộng lặp 2 lần)
    const cleanKey = change.idempotencyKey?.trim() || null;
    if (cleanKey) {
      const existingInTx = await tx.walletTransaction.findUnique({ where: { idempotencyKey: cleanKey } });
      if (existingInTx) {
        if (existingInTx.userId !== change.userId) {
          throw new ConflictException('Khoá chống trùng (idempotencyKey) đã được dùng cho giao dịch khác');
        }
        return Object.assign(existingInTx, { __replayed: true as const });
      }
    }
    const before = Number(rows[0].walletBalance);
    const after = round(before + amount);
    if (after < 0) throw new BadRequestException(`Số dư ví không đủ (hiện có ${before.toLocaleString('vi-VN')}đ)`);
    await tx.user.update({ where: { id: change.userId }, data: { walletBalance: after } });
    return tx.walletTransaction.create({
      data: {
        userId: change.userId,
        type: change.type,
        amount,
        balanceAfter: after,
        note: change.note?.trim() || null,
        orderId: change.orderId ?? null,
        createdById: change.createdById ?? null,
        meta: (change.meta ?? {}) as object,
        idempotencyKey: cleanKey,
      },
    });
  }

  /**
   * Admin nạp / trừ tiền thủ công.
   * Có `idempotencyKey` (client sinh mỗi lần mở form): bấm trùng / gửi lại request -> trả lại giao dịch đã ghi,
   * không cộng/trừ lần hai (kiểm tra trước + bắt lỗi unique P2002 khi hai request chạy song song).
   */
  async adjust(userId: string, dto: AdjustWalletDto, actor: AuthUser) {
    const key = dto.idempotencyKey?.trim() || null;
    if (key) {
      const existing = await this.prisma.walletTransaction.findUnique({ where: { idempotencyKey: key } });
      if (existing) return this.replay(existing, userId);
    }
    const signed = dto.type === 'deposit' ? Math.abs(dto.amount) : -Math.abs(dto.amount);
    let txn: Awaited<ReturnType<WalletService['apply']>> & { __replayed?: boolean };
    try {
      txn = await this.prisma.$transaction(async (tx) => {
        // T-436: Nếu client cũ không truyền idempotencyKey mà bấm đúp trong 4 giây cùng số tiền + cùng ghi chú -> chặn lặp
        if (!key) {
          const dupRecent = await tx.walletTransaction.findFirst({
            where: {
              userId,
              type: dto.type === 'deposit' ? 'DEPOSIT' : 'WITHDRAW',
              amount: signed,
              note: dto.note?.trim() || null,
              createdById: actor.id === 'system' ? null : actor.id,
              createdAt: { gte: new Date(Date.now() - 4_000) },
            },
          });
          if (dupRecent) return Object.assign(dupRecent, { __replayed: true as const });
        }
        return this.apply(tx, {
          userId,
          type: dto.type === 'deposit' ? 'DEPOSIT' : 'WITHDRAW',
          amount: signed,
          note: dto.note,
          createdById: actor.id === 'system' ? null : actor.id,
          idempotencyKey: key,
        });
      });
    } catch (err) {
      // request song song cùng khoá: bản kia đã ghi xong -> trả giao dịch đó (transaction này đã rollback, số dư không đổi)
      if (key && (err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.walletTransaction.findUnique({ where: { idempotencyKey: key } });
        if (existing) return this.replay(existing, userId);
      }
      throw err;
    }
    if (txn.__replayed) {
      return { transaction: txn, balance: Number(txn.balanceAfter), duplicate: true };
    }
    await this.afterChange(txn, actor);
    return { transaction: txn, balance: Number(txn.balanceAfter) };
  }

  /** Trả lại kết quả của giao dịch đã ghi với cùng idempotencyKey (khoá phải thuộc đúng thành viên này) */
  private replay(existing: { userId: string; balanceAfter: Prisma.Decimal }, userId: string) {
    if (existing.userId !== userId) throw new ConflictException('Khoá chống trùng (idempotencyKey) đã được dùng cho giao dịch khác');
    return { transaction: existing, balance: Number(existing.balanceAfter), duplicate: true };
  }

  /** Phát event/hook + nhật ký sau khi số dư đổi (gọi ngoài transaction) */
  async afterChange(txn: { id: string; userId: string; type: WalletTxnType; amount: Prisma.Decimal | number; balanceAfter: Prisma.Decimal | number; orderId: string | null }, actor?: AuthUser) {
    const payload = { transactionId: txn.id, userId: txn.userId, type: txn.type, amount: Number(txn.amount), balance: Number(txn.balanceAfter), orderId: txn.orderId };
    this.events.emit('wallet.changed', payload);
    await this.hooks.doAction('wallet.changed', payload);
    this.events.emit('activity', {
      userId: actor && actor.id !== 'system' ? actor.id : null,
      action: `wallet.${txn.type.toLowerCase()}`,
      entityType: 'user',
      entityId: txn.userId,
      meta: { amount: Number(txn.amount), balance: Number(txn.balanceAfter), orderId: txn.orderId },
    });
  }
}
