import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { hasPermission } from '@cmsnt/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SessionsService } from '../security/sessions.service.js';
import { CurrentUser, type AuthUser } from '../../common/decorators/current-user.decorator.js';
import { RequireFeature } from '../../common/decorators/feature.decorator.js';

class AddressBodyDto {
  @IsString() @MaxLength(120) fullName: string;
  @IsString() @MaxLength(30) phone: string;
  @IsString() @MaxLength(255) line1: string;
  @IsOptional() @IsString() line2?: string;
  @IsOptional() @IsString() ward?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() city?: string;
  /** mã tỉnh "VN-HN" và mã quận/phường trong danh mục vận chuyển (để báo giá hãng nhanh khi dùng lại địa chỉ) */
  @IsOptional() @IsString() @MaxLength(10) province?: string;
  @IsOptional() @IsString() @MaxLength(40) districtCode?: string;
  @IsOptional() @IsString() @MaxLength(60) wardCode?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

/** Câu khách phải gõ đúng để xác nhận xoá tài khoản */
export const DELETE_ACCOUNT_CONFIRM = 'XOA TAI KHOAN';

class DeleteAccountDto {
  /** Bắt buộc khi tài khoản có mật khẩu do khách tự đặt (tài khoản tạo qua Google thì không cần) */
  @IsOptional() @IsString() @MaxLength(128) password?: string;
  @IsString() @MaxLength(50) confirm: string;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly sessions: SessionsService,
  ) {}

  addresses(userId: string) {
    return this.prisma.address.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] });
  }

  async save(userId: string, id: string | undefined, dto: AddressBodyDto) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      if (id) {
        await tx.address.findFirstOrThrow({ where: { id, userId } });
        return tx.address.update({ where: { id }, data: dto });
      }
      const count = await tx.address.count({ where: { userId } });
      return tx.address.create({ data: { ...dto, userId, isDefault: dto.isDefault ?? count === 0 } });
    });
  }

  async remove(userId: string, id: string) {
    await this.prisma.address.deleteMany({ where: { id, userId } });
    return { success: true };
  }

  /**
   * Khách tự xoá tài khoản: ẩn danh hoá thông tin cá nhân (email, tên, SĐT, Google, 2FA, meta), đặt deletedAt,
   * thu hồi mọi phiên / API key / link đặt lại mật khẩu, xoá địa chỉ, wishlist, giỏ hàng, thông báo khách.
   * GIỮ đơn hàng và giao dịch ví (nghĩa vụ kế toán). Không cho xoá khi ví còn tiền, và không áp dụng cho nhân sự quản trị.
   * Tài khoản có mật khẩu do khách đặt phải nhập mật khẩu; tài khoản tạo qua Google (meta.passwordSet=false) chỉ cần câu xác nhận.
   */
  async deleteAccount(actor: { id: string; permissions?: string[] }, dto: DeleteAccountDto, ip?: string) {
    if (String(dto.confirm ?? '').trim().toUpperCase() !== DELETE_ACCOUNT_CONFIRM) throw new BadRequestException(`Vui lòng nhập chính xác "${DELETE_ACCOUNT_CONFIRM}" để xác nhận`);
    if (hasPermission(actor.permissions ?? [], 'admin.access')) throw new ForbiddenException('Tài khoản nhân sự quản trị không thể tự xoá, vui lòng liên hệ quản trị viên');
    const user = await this.prisma.user.findFirst({ where: { id: actor.id, deletedAt: null }, select: { id: true, email: true, passwordHash: true, meta: true } });
    if (!user) throw new NotFoundException('Tài khoản không tồn tại');
    const hasPassword = ((user.meta ?? {}) as Record<string, unknown>).passwordSet !== false;
    if (hasPassword) {
      if (!dto.password) throw new BadRequestException('Vui lòng nhập mật khẩu để xác nhận xoá tài khoản');
      if (!(await argon2.verify(user.passwordHash, dto.password).catch(() => false))) throw new BadRequestException('Mật khẩu không đúng');
    }
    const id = user.id;
    const now = new Date();
    // mật khẩu ngẫu nhiên không ai biết -> tài khoản đã xoá không thể đăng nhập lại kể cả khi bị khôi phục nhầm
    const placeholderHash = await argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });
    await this.prisma.$transaction(async (tx) => {
      // khoá dòng user: tiền vào ví song song (nạp thẻ, hoàn tiền) không lọt giữa lúc kiểm tra số dư và lúc xoá
      const rows = await tx.$queryRaw<{ walletBalance: string }[]>`SELECT "walletBalance" FROM "users" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Tài khoản không tồn tại');
      const balance = Number(rows[0].walletBalance);
      if (balance > 0) throw new BadRequestException(`Ví của bạn còn ${balance.toLocaleString('vi-VN')}đ. Vui lòng sử dụng hết số dư hoặc liên hệ hỗ trợ trước khi xoá tài khoản`);
      // thẻ cào / nạp ví qua cổng còn chờ kết quả -> tiền có thể vào ví SAU khi xoá (ví đã xoá vẫn được cộng) -> chặn
      const [pendingCards, pendingTopups] = await Promise.all([
        tx.cardTopup.count({ where: { userId: id, status: 'PENDING' } }),
        tx.paymentTransaction.count({ where: { userId: id, purpose: 'wallet', status: 'PENDING' } }),
      ]);
      if (pendingCards || pendingTopups) throw new BadRequestException('Bạn còn thẻ cào/giao dịch nạp ví đang chờ xử lý. Vui lòng chờ hoàn tất rồi thử lại.');
      await tx.user.update({
        where: { id },
        data: {
          email: `deleted+${id}@deleted.local`,
          name: 'Đã xoá',
          phone: null,
          googleId: null,
          avatarId: null,
          meta: {},
          passwordHash: placeholderHash,
          twoFactorEnabled: false,
          twoFactorSecret: null,
          recoveryCodes: [],
          totpLastStep: null,
          lastLoginIp: null,
          failedLogins: 0,
          status: 'INACTIVE',
          deletedAt: now,
        },
      });
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      await tx.apiKey.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      await tx.passwordReset.updateMany({ where: { email: user.email, usedAt: null }, data: { usedAt: now } });
      await tx.address.deleteMany({ where: { userId: id } });
      await tx.wishlistItem.deleteMany({ where: { userId: id } });
      await tx.cart.deleteMany({ where: { userId: id } });
    });
    // guard tra lại DB ngay: phiên + cache thông tin user trên instance này hết hiệu lực
    this.sessions.forgetAll();
    this.events.emit('user.changed', { id });
    this.events.emit('activity', { userId: id, action: 'account.deleted', entityType: 'user', entityId: id, ip, meta: { method: hasPassword ? 'password' : 'confirm' } });
    return { success: true };
  }
}

/** API cho thành viên đã đăng nhập trên storefront */
@Controller('account')
@RequireFeature('accounts')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /** Khách tự xoá tài khoản: body `{ password?, confirm: 'XOA TAI KHOAN' }` */
  // nhận mật khẩu -> giới hạn chặt để phiên bị lộ không dò được mật khẩu
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('delete')
  @HttpCode(200)
  deleteAccount(@CurrentUser() user: AuthUser, @Body() dto: DeleteAccountDto, @Req() req: Request) {
    return this.account.deleteAccount(user, dto, req.ip);
  }

  @Get('addresses')
  list(@CurrentUser() user: AuthUser) {
    return this.account.addresses(user.id);
  }

  @Post('addresses')
  create(@CurrentUser() user: AuthUser, @Body() dto: AddressBodyDto) {
    return this.account.save(user.id, undefined, dto);
  }

  @Patch('addresses/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddressBodyDto) {
    return this.account.save(user.id, id, dto);
  }

  @Delete('addresses/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.account.remove(user.id, id);
  }
}

@Module({ controllers: [AccountController], providers: [AccountService] })
export class AccountModule {}
