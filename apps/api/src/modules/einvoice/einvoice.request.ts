import { BadRequestException } from '@nestjs/common';
import { isValidTaxCode } from './einvoice.calc.js';

/** Khách yêu cầu xuất HĐ lưu ở Order.invoiceRequest */
export interface InvoiceRequest {
  requested: boolean;
  /** company = đơn vị có MST; personal = cá nhân */
  type?: 'company' | 'personal';
  /** Tên công ty (company) hoặc họ tên người mua (personal) */
  name?: string;
  taxCode?: string;
  address?: string;
  /** Email nhận hoá đơn (bỏ trống = email đơn hàng) */
  email?: string;
  /** CCCD (cá nhân không có MST) */
  idNumber?: string;
}

export interface InvoiceRequestInput {
  requested?: boolean;
  type?: string;
  name?: string;
  taxCode?: string;
  address?: string;
  email?: string;
  idNumber?: string;
}

/**
 * Chuẩn hoá & kiểm tra yêu cầu xuất HĐ từ checkout / tài khoản.
 * Trả về null khi không gửi, `{ requested: false }` khi khách bỏ tick; ném BadRequestException khi thiếu dữ liệu.
 */
export function normalizeInvoiceRequest(dto: InvoiceRequestInput | null | undefined, requireTaxCode = true): InvoiceRequest | null {
  if (!dto) return null;
  if (!dto.requested) return { requested: false };
  const type = dto.type === 'personal' ? 'personal' : 'company';
  const taxCode = dto.taxCode?.replace(/\s+/g, '') || undefined;
  if (!dto.name?.trim()) throw new BadRequestException(type === 'company' ? 'Vui lòng nhập tên công ty nhận hoá đơn' : 'Vui lòng nhập tên người mua trên hoá đơn');
  if (type === 'company' && requireTaxCode && !taxCode) throw new BadRequestException('Vui lòng nhập mã số thuế');
  if (taxCode && !isValidTaxCode(taxCode)) throw new BadRequestException('Mã số thuế không hợp lệ (10 số hoặc 10 số-3 số)');
  if (!dto.address?.trim()) throw new BadRequestException('Vui lòng nhập địa chỉ xuất hoá đơn');
  if (dto.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dto.email.trim())) throw new BadRequestException('Email nhận hoá đơn không hợp lệ');
  return { requested: true, type, name: dto.name.trim().slice(0, 255), taxCode, address: dto.address.trim().slice(0, 500), email: dto.email?.trim() || undefined, idNumber: dto.idNumber?.trim() || undefined };
}
