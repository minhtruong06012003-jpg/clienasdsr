import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

/** Loại giao dịch ví hoa hồng (lọc lịch sử) */
export const AFFILIATE_TXN_TYPES = ['COMMISSION', 'REVOKE', 'PAYOUT', 'PAYOUT_REFUND', 'ADJUST'] as const;
export const AFFILIATE_PAYOUT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

/** Khách gửi yêu cầu rút hoa hồng */
export class CreateAffiliatePayoutDto {
  /** Số tiền rút (≥ mức tối thiểu ở Cài đặt, ≤ số dư hoa hồng) */
  @Type(() => Number) @IsNumber() @Min(1) amount: number;

  /** WALLET = vào số dư ví, BANK = chuyển khoản ngân hàng */
  @IsIn(['WALLET', 'BANK']) method: 'WALLET' | 'BANK';

  /** Thông tin ngân hàng — bắt buộc khi method = BANK */
  @ValidateIf((o: CreateAffiliatePayoutDto) => o.method === 'BANK') @IsString() @MinLength(2) @MaxLength(100) bankName?: string;
  @ValidateIf((o: CreateAffiliatePayoutDto) => o.method === 'BANK') @IsString() @MinLength(4) @MaxLength(40) bankAccount?: string;
  @ValidateIf((o: CreateAffiliatePayoutDto) => o.method === 'BANK') @IsString() @MinLength(2) @MaxLength(120) bankHolder?: string;

  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/** Lịch sử ví hoa hồng (khách xem của mình, admin xem tất cả / lọc theo khách) */
export class AffiliateTxnQuery extends PaginationQueryDto {
  @IsOptional() @IsIn(AFFILIATE_TXN_TYPES) type?: (typeof AFFILIATE_TXN_TYPES)[number];
  /** Chỉ admin: lọc theo chủ ví hoa hồng */
  @IsOptional() @IsUUID() userId?: string;
}

/** Danh sách yêu cầu rút */
export class AffiliatePayoutQuery extends PaginationQueryDto {
  @IsOptional() @IsIn(AFFILIATE_PAYOUT_STATUSES) declare status?: string;
  @IsOptional() @IsIn(['WALLET', 'BANK']) method?: 'WALLET' | 'BANK';
}

/** Admin duyệt / từ chối yêu cầu rút: ghi chú khách nhìn thấy (vd mã giao dịch ngân hàng, lý do từ chối) */
export class ProcessAffiliatePayoutDto {
  @IsOptional() @IsString() @MaxLength(500) adminNote?: string;
}

/** Admin cộng (+) / trừ (−) ví hoa hồng của khách */
export class AdjustAffiliateDto {
  @Type(() => Number) @IsNumber() amount: number;
  @IsString() @MinLength(1) @MaxLength(500) note: string;
  /** Khoá chống bấm trùng do client sinh mỗi lần mở form */
  @IsOptional() @IsString() @MaxLength(100) idempotencyKey?: string;
}
