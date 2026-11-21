import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

const STATUSES = ['PENDING', 'SUCCESS', 'WRONG_VALUE', 'FAILED'] as const;
type Status = (typeof STATUSES)[number];

/** Thành viên gửi thẻ cào */
export class SubmitCardDto {
  /** Mã nhà mạng (VIETTEL, MOBIFONE...) — phải nằm trong danh sách admin bật */
  @IsString() @MaxLength(30) telco: string;
  /** Mệnh giá khai báo */
  @Type(() => Number) @IsInt() @Min(1000) amount: number;
  @IsString() @MaxLength(40) serial: string;
  @IsString() @MaxLength(40) pin: string;
}

/** Lịch sử nạp thẻ của thành viên */
export class CardTopupQuery extends PaginationQueryDto {
  @IsOptional() @IsIn(STATUSES) declare status?: Status;
}

/** Admin lọc danh sách thẻ */
export class AdminCardTopupQuery extends CardTopupQuery {
  @IsOptional() @IsString() @MaxLength(30) telco?: string;
  @IsOptional() @IsUUID() userId?: string;
}

/** Admin duyệt tay một thẻ đang chờ */
export class ApproveCardDto {
  /** Mệnh giá thật (mặc định = mệnh giá khai báo) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) realValue?: number;
  /** Số tiền cộng ví (mặc định tính theo chiết khấu đã cấu hình) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) credited?: number;
  @IsOptional() @IsString() @MaxLength(255) note?: string;
}

export class RejectCardDto {
  @IsOptional() @IsString() @MaxLength(255) reason?: string;
}
