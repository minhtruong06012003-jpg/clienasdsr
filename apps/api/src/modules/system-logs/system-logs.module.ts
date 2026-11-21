import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { PaginationQueryDto, pageArgs, paginate } from '../../common/dto/pagination.dto.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Nhật ký hệ thống (trang /system-logs của admin): các nhật ký chưa có API xem tập trung.
 * - Nhật ký số dư: mọi biến động ví thành viên (trước đây chỉ xem được trong trang từng thành viên)
 * - Nhật ký dùng mã giảm giá: mỗi lượt mã được áp vào đơn hàng
 * Các tab còn lại (hoạt động, lỗi, đăng nhập, email) dùng lại API sẵn có của module tương ứng.
 */

/** Lọc khoảng ngày from/to (yyyy-mm-dd hoặc ISO); `to` chỉ có ngày thì tính tới hết ngày đó */
function dateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  const r: Prisma.DateTimeFilter = {};
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) r.gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) d.setHours(23, 59, 59, 999);
      r.lte = d;
    }
  }
  return Object.keys(r).length ? r : undefined;
}

class WalletLogQuery extends PaginationQueryDto {
  @IsOptional() @IsIn(['DEPOSIT', 'WITHDRAW', 'PAYMENT', 'REFUND']) type?: 'DEPOSIT' | 'WITHDRAW' | 'PAYMENT' | 'REFUND';
  /** in = chỉ giao dịch cộng tiền, out = chỉ giao dịch trừ tiền */
  @IsOptional() @IsIn(['in', 'out']) direction?: 'in' | 'out';
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

class CouponUsageQuery extends PaginationQueryDto {
  @IsOptional() @IsUUID() couponId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

@Injectable()
export class SystemLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Nhật ký số dư toàn hệ thống + tổng cộng/trừ theo đúng bộ lọc (để đối soát nhanh) */
  async walletTransactions(q: WalletLogQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const s = q.search?.trim();
    const createdAt = dateRange(q.from, q.to);
    const where: Prisma.WalletTransactionWhereInput = {
      ...(q.type ? { type: q.type } : {}),
      ...(q.direction === 'in' ? { amount: { gt: 0 } } : q.direction === 'out' ? { amount: { lt: 0 } } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(createdAt ? { createdAt } : {}),
      // tìm theo tên / email thành viên, mã đơn hoặc ghi chú
      ...(s
        ? {
            OR: [
              { user: { email: { contains: s, mode: 'insensitive' } } },
              { user: { name: { contains: s, mode: 'insensitive' } } },
              { order: { code: { contains: s, mode: 'insensitive' } } },
              { note: { contains: s, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total, credit, debit] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { id: true, name: true, email: true } },
          order: { select: { id: true, code: true } },
          createdBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.aggregate({ where: { AND: [where, { amount: { gt: 0 } }] }, _sum: { amount: true } }),
      this.prisma.walletTransaction.aggregate({ where: { AND: [where, { amount: { lt: 0 } }] }, _sum: { amount: true } }),
    ]);
    return {
      ...paginate(rows, total, page, limit),
      summary: { credit: Number(credit._sum.amount ?? 0), debit: Math.abs(Number(debit._sum.amount ?? 0)) },
    };
  }

  /** Nhật ký lượt dùng mã giảm giá, kèm đơn hàng (mã đơn, số tiền giảm, tổng tiền) */
  async couponUsages(q: CouponUsageQuery) {
    const { skip, take, page, limit } = pageArgs(q);
    const s = q.search?.trim();
    const createdAt = dateRange(q.from, q.to);
    const where: Prisma.CouponUsageWhereInput = {
      ...(q.couponId ? { couponId: q.couponId } : {}),
      ...(createdAt ? { createdAt } : {}),
      // tìm theo mã giảm giá, email khách hoặc mã đơn
      ...(s
        ? {
            OR: [
              { coupon: { code: { contains: s, mode: 'insensitive' } } },
              { email: { contains: s, mode: 'insensitive' } },
              { order: { code: { contains: s, mode: 'insensitive' } } },
              { order: { customerName: { contains: s, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total, discount] = await Promise.all([
      this.prisma.couponUsage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          coupon: { select: { id: true, code: true, type: true, value: true } },
          order: { select: { id: true, code: true, customerName: true, customerEmail: true, discountTotal: true, total: true, status: true, paymentStatus: true, userId: true } },
        },
      }),
      this.prisma.couponUsage.count({ where }),
      // tổng tiền đã giảm trên các đơn khớp bộ lọc
      this.prisma.order.aggregate({ where: { couponUsages: { some: where } }, _sum: { discountTotal: true } }),
    ]);
    return { ...paginate(rows, total, page, limit), summary: { discount: Number(discount._sum.discountTotal ?? 0) } };
  }
}

@Controller('admin/system-logs')
export class SystemLogsController {
  constructor(private readonly logs: SystemLogsService) {}

  /** Nhật ký số dư: cùng quyền với xem ví trong trang thành viên */
  @RequirePermissions('users.read')
  @Get('wallet')
  wallet(@Query() q: WalletLogQuery) {
    return this.logs.walletTransactions(q);
  }

  /** Nhật ký dùng mã giảm giá: cùng quyền với quản lý mã giảm giá */
  @RequirePermissions('coupons.manage')
  @Get('coupon-usages')
  couponUsages(@Query() q: CouponUsageQuery) {
    return this.logs.couponUsages(q);
  }
}

@Module({ controllers: [SystemLogsController], providers: [SystemLogsService] })
export class SystemLogsModule {}
