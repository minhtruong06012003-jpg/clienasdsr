import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

export const EINVOICE_STATUSES = ['DRAFT', 'QUEUED', 'ISSUING', 'ISSUED', 'CANCELLED', 'REPLACED', 'ADJUSTED', 'FAILED'] as const;
export type EInvoiceStatusValue = (typeof EINVOICE_STATUSES)[number];

/** Thông tin người mua trên hoá đơn (admin sửa trước khi phát hành / khách khai ở checkout) */
export class InvoiceBuyerDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(255) legalName?: string;
  @IsOptional() @IsString() @MaxLength(20) taxCode?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(30) idNumber?: string;
  @IsOptional() @IsString() @MaxLength(50) bankAccount?: string;
  @IsOptional() @IsString() @MaxLength(255) bankName?: string;
  @IsOptional() @IsString() @MaxLength(20) budgetCode?: string;
  @IsOptional() @IsBoolean() anonymous?: boolean;
}

/** Khách yêu cầu xuất HĐ khi đặt hàng (gắn vào CheckoutDto.invoiceRequest và PUT /account/orders/:orderId/invoice-request — orderId là UUID của đơn, không phải mã đơn) */
export class InvoiceRequestDto {
  @IsBoolean() requested: boolean;
  /** company | personal */
  @IsOptional() @IsIn(['company', 'personal']) type?: 'company' | 'personal';
  /** Tên công ty (company) hoặc họ tên người mua (personal) */
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(20) taxCode?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsEmail() email?: string;
  /** CCCD (cá nhân không có MST) */
  @IsOptional() @IsString() @MaxLength(30) idNumber?: string;
}

/** Dòng hàng admin sửa tay trên hoá đơn nháp / điều chỉnh */
export class InvoiceLineInputDto {
  @IsString() @MaxLength(500) name: string;
  @IsOptional() @IsString() @MaxLength(50) sku?: string;
  @IsOptional() @IsString() @MaxLength(50) unit?: string;
  @Type(() => Number) @IsNumber() quantity: number;
  /** Đơn giá chưa VAT */
  @Type(() => Number) @IsNumber() unitPrice: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discount?: number;
  /** 0,5,8,10 | -1 KCT | -2 KKKNT | -3 KHAC */
  @Type(() => Number) @IsInt() @Min(-3) @Max(100) vatRate: number;
  /** product | shipping | discount | note */
  @IsOptional() @IsIn(['product', 'shipping', 'discount', 'note']) kind?: 'product' | 'shipping' | 'discount' | 'note';
  /** Hoá đơn điều chỉnh: increase | decrease */
  @IsOptional() @IsIn(['increase', 'decrease']) adjustment?: 'increase' | 'decrease';
}

export class EInvoiceQueryDto extends PaginationQueryDto {
  /** all | DRAFT | ISSUED | ... | needsAction (FAILED + DRAFT) */
  @IsOptional() @IsString() declare status?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['ORIGINAL', 'REPLACEMENT', 'ADJUSTMENT']) kind?: string;
}

/** Tạo hoá đơn nháp từ đơn hàng (hoặc tự nhập không gắn đơn) */
export class CreateEInvoiceDto {
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @ValidateNested() @Type(() => InvoiceBuyerDto) buyer?: InvoiceBuyerDto;
  /** Ghi đè dòng hàng (bỏ trống = dựng từ đơn hàng) */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => InvoiceLineInputDto) items?: InvoiceLineInputDto[];
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsString() @MaxLength(20) paymentMethod?: string;
  @IsOptional() @IsDateString() invoiceDate?: string;
  @IsOptional() @IsString() @MaxLength(20) templateCode?: string;
  @IsOptional() @IsString() @MaxLength(20) serial?: string;
  /** Tạo xong phát hành ngay */
  @IsOptional() @IsBoolean() issueNow?: boolean;
}

export class UpdateEInvoiceDto {
  @IsOptional() @ValidateNested() @Type(() => InvoiceBuyerDto) buyer?: InvoiceBuyerDto;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => InvoiceLineInputDto) items?: InvoiceLineInputDto[];
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsString() @MaxLength(20) paymentMethod?: string;
  @IsOptional() @IsDateString() invoiceDate?: string;
  @IsOptional() @IsString() @MaxLength(20) templateCode?: string;
  @IsOptional() @IsString() @MaxLength(20) serial?: string;
}

export class CancelEInvoiceDto {
  @IsString() @MaxLength(500) reason: string;
  /** Chỉ đánh dấu huỷ trong hệ thống, không gọi NCC (khi đã huỷ tay trên cổng NCC) */
  @IsOptional() @IsBoolean() localOnly?: boolean;
}

/** Lập hoá đơn thay thế: dữ liệu mới (bỏ trống = sao chép hoá đơn gốc) */
export class ReplaceEInvoiceDto {
  @IsString() @MaxLength(500) reason: string;
  @IsOptional() @ValidateNested() @Type(() => InvoiceBuyerDto) buyer?: InvoiceBuyerDto;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => InvoiceLineInputDto) items?: InvoiceLineInputDto[];
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsBoolean() issueNow?: boolean;
}

/** Lập hoá đơn điều chỉnh: các dòng điều chỉnh (tăng/giảm) */
export class AdjustEInvoiceDto {
  @IsString() @MaxLength(500) reason: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => InvoiceLineInputDto) items: InvoiceLineInputDto[];
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsBoolean() issueNow?: boolean;
}

/** Nhập tay kết quả phát hành (provider manual hoặc đồng bộ tay) */
export class ManualResultDto {
  @IsString() @MaxLength(20) invoiceNo: string;
  @IsOptional() @IsString() @MaxLength(20) serial?: string;
  @IsOptional() @IsString() @MaxLength(20) templateCode?: string;
  @IsOptional() @IsString() @MaxLength(100) taxAuthorityCode?: string;
  @IsOptional() @IsString() @MaxLength(100) lookupCode?: string;
  @IsOptional() @IsString() @MaxLength(500) lookupUrl?: string;
  @IsOptional() @IsDateString() issuedAt?: string;
}

export class SendEInvoiceEmailDto {
  @IsOptional() @IsEmail() to?: string;
  @IsOptional() @IsBoolean() attachPdf?: boolean;
}

export class BulkIssueDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) orderIds: string[];
}

export class BulkInvoiceActionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) ids: string[];
}

export class TestConnectionDto {
  @IsString() @MaxLength(50) provider: string;
  /** Cấu hình thử (chưa lưu); bỏ trống = dùng cấu hình đã lưu */
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsIn(['sandbox', 'production']) environment?: 'sandbox' | 'production';
}

export class PreviewEInvoiceDto {
  @IsUUID() orderId: string;
  @IsOptional() @ValidateNested() @Type(() => InvoiceBuyerDto) buyer?: InvoiceBuyerDto;
}
