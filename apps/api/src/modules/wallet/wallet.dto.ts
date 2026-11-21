import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

/** Admin nạp / trừ tiền ví thành viên */
export class AdjustWalletDto {
  /** deposit = cộng tiền, withdraw = trừ tiền */
  @IsIn(['deposit', 'withdraw']) type: 'deposit' | 'withdraw';

  /** Số tiền (luôn dương, dấu do `type` quyết định) */
  @Type(() => Number) @IsNumber() @Min(1) amount: number;

  /** Ghi chú hiển thị cho cả admin và thành viên (vd. "Nạp qua chuyển khoản", "Hoàn tiền sự cố") */
  @IsOptional() @IsString() @MaxLength(500) note?: string;

  /** Khoá chống bấm trùng do client sinh (vd uuid mỗi lần mở form): gửi lại cùng khoá -> trả giao dịch cũ, không ghi thêm */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) idempotencyKey?: string;
}

/** Khách tạo giao dịch nạp tiền vào ví qua cổng thanh toán */
export class CreateTopupDto {
  /** Số tiền nạp (VND, số nguyên) — giới hạn theo Cài đặt › Ví (topupMin / topupMax) */
  @Type(() => Number) @IsInt() @Min(1) amount: number;

  /** Khoá cổng: web2m, usdt (PayOS / SePay / Pay2S đã ẩn) */
  @IsString() @MaxLength(40) provider: string;
}

/** Lọc lịch sử nạp ví qua cổng của khách */
export class TopupQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED']) declare status?: string;
}

/** Lọc lịch sử giao dịch ví */
export class WalletQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['DEPOSIT', 'WITHDRAW', 'PAYMENT', 'REFUND']) type?: 'DEPOSIT' | 'WITHDRAW' | 'PAYMENT' | 'REFUND';
}
