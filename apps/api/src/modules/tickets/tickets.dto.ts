import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export const TICKET_CATEGORIES = ['ORDER', 'PAYMENT', 'SERVICE', 'API', 'OTHER'] as const;
export type TicketCategoryType = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriorityType = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['OPEN', 'ANSWERED', 'CUSTOMER_REPLY', 'CLOSED'] as const;
export type TicketStatusType = (typeof TICKET_STATUSES)[number];

export class TicketAttachmentDto {
  @IsString()
  @MaxLength(1000)
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  mimeType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  size?: number;

  @IsOptional()
  @IsIn(['image', 'video'])
  kind?: 'image' | 'video';
}

export class CreateTicketDto {
  @IsString()
  @MinLength(3, { message: 'Tiêu đề tối thiểu 3 ký tự' })
  @MaxLength(200)
  subject: string;

  @IsOptional()
  @IsIn(TICKET_CATEGORIES)
  category?: TicketCategoryType;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriorityType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  orderCodes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  message?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6, { message: 'Đính kèm tối đa 6 ảnh/video mỗi tin nhắn' })
  @ValidateNested({ each: true })
  @Type(() => TicketAttachmentDto)
  attachments?: TicketAttachmentDto[];
}

export class ReplyTicketDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  message?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6, { message: 'Đính kèm tối đa 6 ảnh/video mỗi tin nhắn' })
  @ValidateNested({ each: true })
  @Type(() => TicketAttachmentDto)
  attachments?: TicketAttachmentDto[];
}

export class UpdateTicketStatusDto {
  @IsIn(TICKET_STATUSES)
  status: TicketStatusType;
}

export class TicketQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  site?: string;
}

export class AdminSiteUserUpdateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'PENDING', 'INACTIVE', 'BANNED'])
  status?: 'ACTIVE' | 'PENDING' | 'INACTIVE' | 'BANNED';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  customDiscount?: number;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Mật khẩu mới tối thiểu 8 ký tự' })
  @MaxLength(120)
  password?: string;

  @IsOptional()
  @IsBoolean()
  forceLogout?: boolean;
}

export class AdminSiteUserWalletDto {
  @IsIn(['deposit', 'withdraw'])
  type: 'deposit' | 'withdraw';

  @Type(() => Number)
  @IsNumber()
  @Min(1, { message: 'Số tiền tối thiểu 1đ' })
  @Max(500_000_000)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  idempotencyKey: string;
}

export class CascadeRefundDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  parentCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerTaskId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
