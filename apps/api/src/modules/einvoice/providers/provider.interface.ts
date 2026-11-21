/**
 * Giao diện chung cho adapter nhà cung cấp hoá đơn điện tử (HĐĐT) Việt Nam.
 *
 * Mỗi nhà cung cấp (Viettel S-Invoice, VNPT, MISA meInvoice, BKAV, EasyInvoice, FPT, MobiFone, ...)
 * cài một class implements `EInvoiceProvider`, nhận `ProviderConfig` (do admin nhập ở Cài đặt › Hoá đơn điện tử)
 * và `InvoicePayload` (dữ liệu hoá đơn đã chuẩn hoá từ đơn hàng) rồi gọi API của họ.
 *
 * Thêm nhà cung cấp mới: viết class trong thư mục này rồi đăng ký trong `registry.ts` (danh sách adapter lõi).
 */

/** Kiểu input của một trường cấu hình nhà cung cấp (admin render form theo meta này) */
export type ProviderFieldType = 'text' | 'password' | 'url' | 'select' | 'boolean' | 'number' | 'textarea';

export interface ProviderField {
  key: string;
  label: string;
  type: ProviderFieldType;
  required?: boolean;
  placeholder?: string;
  /** Gợi ý ngắn dưới ô nhập */
  help?: string;
  /** Cho type = select */
  options?: { value: string; label: string }[];
  /** Giá trị mặc định khi chưa nhập */
  default?: unknown;
  /** Chỉ hiện khi môi trường khớp (sandbox | production); bỏ trống = luôn hiện */
  env?: 'sandbox' | 'production';
}

/** Khả năng adapter hỗ trợ — admin ẩn/hiện nút tương ứng */
export interface ProviderCapabilities {
  /** Tạo nháp trên hệ thống NCC trước khi ký (không bắt buộc) */
  draft?: boolean;
  cancel: boolean;
  replace: boolean;
  adjust: boolean;
  pdf: boolean;
  xml: boolean;
  /** Đồng bộ trạng thái / mã CQT từ NCC */
  sync: boolean;
  testConnection: boolean;
  /** Có trang tra cứu công khai cho khách */
  lookup: boolean;
}

export interface ProviderMeta {
  key: string;
  name: string;
  /** Mô tả ngắn hiển thị khi chọn nhà cung cấp */
  description: string;
  website?: string;
  docsUrl?: string;
  /** Cách ký số: hsm (ký máy chủ NCC) | server (NCC ký bằng chứng thư đã cấu hình) | usb (cần USB token phía khách, chỉ tạo nháp) | none */
  signing: 'hsm' | 'server' | 'usb' | 'none';
  fields: ProviderField[];
  capabilities: ProviderCapabilities;
  /** Ghi chú quan trọng (sandbox, đăng ký đối tác, ...) */
  notes?: string[];
}

/** Cấu hình admin nhập cho nhà cung cấp (key theo `fields`) + môi trường */
export interface ProviderConfig {
  environment: 'sandbox' | 'production';
  [key: string]: unknown;
}

/** Người bán (snapshot từ cài đặt) */
export interface InvoiceSeller {
  name: string;
  taxCode: string;
  address: string;
  phone?: string;
  email?: string;
  bankAccount?: string;
  bankName?: string;
}

/** Người mua */
export interface InvoiceBuyer {
  /** Tên người mua (cá nhân) / người đại diện */
  name: string;
  /** Tên đơn vị (công ty) — bỏ trống nếu cá nhân */
  legalName?: string;
  taxCode?: string;
  address?: string;
  email?: string;
  phone?: string;
  /** CMND/CCCD/hộ chiếu (bán cho cá nhân không có MST) */
  idNumber?: string;
  bankAccount?: string;
  bankName?: string;
  /** Mã quan hệ ngân sách (khách là đơn vị nhà nước) */
  budgetCode?: string;
  /** Không lấy hoá đơn (khách lẻ) — ghi "Người mua không lấy hoá đơn" */
  anonymous?: boolean;
}

/**
 * Thuế suất GTGT theo quy ước số:
 *  0, 5, 8, 10 = phần trăm; -1 = KCT (không chịu thuế); -2 = KKKNT (không kê khai, tính nộp thuế); -3 = KHAC (khác)
 */
export type VatRate = number;

/** Loại dòng trên hoá đơn */
export type InvoiceLineKind = 'product' | 'shipping' | 'discount' | 'note';

export interface InvoiceLine {
  /** Số thứ tự 1.. */
  index: number;
  kind: InvoiceLineKind;
  name: string;
  sku?: string;
  unit: string;
  quantity: number;
  /** Đơn giá chưa VAT */
  unitPrice: number;
  /** Thành tiền chưa VAT (quantity × unitPrice − discount) */
  amount: number;
  /** Chiết khấu trên dòng (chưa VAT) */
  discount: number;
  vatRate: VatRate;
  vatAmount: number;
  /** Tổng dòng đã gồm VAT */
  total: number;
  /** Dòng điều chỉnh: increase | decrease (chỉ hoá đơn điều chỉnh) */
  adjustment?: 'increase' | 'decrease';
}

/** Tổng hợp theo từng thuế suất (NCC thường bắt buộc) */
export interface VatBreakdown {
  vatRate: VatRate;
  /** Tiền hàng chưa thuế */
  amount: number;
  vatAmount: number;
}

export interface InvoiceTotals {
  /** Tổng tiền hàng chưa thuế (sau chiết khấu) */
  subtotal: number;
  discountTotal: number;
  vatTotal: number;
  /** Tổng thanh toán */
  total: number;
  /** Số tiền bằng chữ (tiếng Việt) */
  totalInWords: string;
  breakdown: VatBreakdown[];
}

/** Tham chiếu hoá đơn gốc khi lập hoá đơn thay thế / điều chỉnh */
export interface OriginalInvoiceRef {
  invoiceNo: string;
  serial: string;
  templateCode: string;
  issuedAt: Date;
  providerRef?: string | null;
  taxAuthorityCode?: string | null;
  /** Lý do thay thế / điều chỉnh */
  reason: string;
  /** Số/ngày biên bản thoả thuận (nếu có) */
  agreementNo?: string;
  agreementDate?: Date;
}

/** Dữ liệu hoá đơn đã chuẩn hoá — đầu vào của adapter */
export interface InvoicePayload {
  /** id EInvoice trong hệ thống (dùng làm mã tham chiếu/dedupe phía NCC) */
  id: string;
  /** Mã tham chiếu duy nhất gửi NCC (vd mã đơn hàng + hậu tố) */
  refCode: string;
  orderCode?: string | null;
  kind: 'ORIGINAL' | 'REPLACEMENT' | 'ADJUSTMENT';
  templateCode: string;
  serial: string;
  invoiceDate: Date;
  currency: string;
  exchangeRate: number;
  /** TM | CK | TM/CK | ... */
  paymentMethod: string;
  seller: InvoiceSeller;
  buyer: InvoiceBuyer;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  note?: string | null;
  original?: OriginalInvoiceRef | null;
}

/** Kết quả phát hành / thay thế / điều chỉnh */
export interface IssueResult {
  /** issued = đã có số HĐ; pending = NCC đã nhận, đang chờ ký / cấp mã (cần sync) */
  status: 'issued' | 'pending';
  providerRef: string;
  invoiceNo?: string | null;
  serial?: string | null;
  templateCode?: string | null;
  taxAuthorityCode?: string | null;
  lookupCode?: string | null;
  lookupUrl?: string | null;
  issuedAt?: Date | null;
  /** Link PDF/XML trực tiếp nếu NCC trả về */
  pdfUrl?: string | null;
  xmlUrl?: string | null;
  /** Response thô (ghi log, không hiển thị cho khách) */
  raw?: unknown;
}

export interface SyncResult {
  status: 'pending' | 'issued' | 'cancelled' | 'replaced' | 'adjusted' | 'rejected' | 'unknown';
  invoiceNo?: string | null;
  serial?: string | null;
  templateCode?: string | null;
  taxAuthorityCode?: string | null;
  lookupCode?: string | null;
  lookupUrl?: string | null;
  issuedAt?: Date | null;
  message?: string | null;
  raw?: unknown;
}

export interface CancelResult {
  ok: boolean;
  message?: string | null;
  raw?: unknown;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  /** Thông tin thêm (tên đơn vị, danh sách ký hiệu...) */
  details?: Record<string, unknown>;
}

/** Tham chiếu tới hoá đơn đã lưu (để huỷ / sync / tải file) */
export interface InvoiceRef {
  id: string;
  providerRef?: string | null;
  invoiceNo?: string | null;
  serial?: string | null;
  templateCode?: string | null;
  lookupCode?: string | null;
  issuedAt?: Date | null;
  meta?: Record<string, unknown>;
}

export interface FileResult {
  /** Nội dung file (Buffer của Node cũng là Uint8Array) */
  buffer: Uint8Array;
  mimeType: string;
  fileName?: string;
}

/** Adapter nhà cung cấp HĐĐT */
export interface EInvoiceProvider {
  readonly meta: ProviderMeta;
  /** Kiểm tra tài khoản/kết nối (đăng nhập thử, lấy danh sách ký hiệu...) */
  testConnection(cfg: ProviderConfig): Promise<TestConnectionResult>;
  /** Lập + ký + phát hành hoá đơn gốc (gửi CQT cấp mã nếu loại có mã) */
  issue(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult>;
  /** Huỷ hoá đơn đã phát hành */
  cancel(cfg: ProviderConfig, ref: InvoiceRef, reason: string): Promise<CancelResult>;
  /** Lập hoá đơn thay thế cho `payload.original` */
  replace?(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult>;
  /** Lập hoá đơn điều chỉnh cho `payload.original` */
  adjust?(cfg: ProviderConfig, payload: InvoicePayload): Promise<IssueResult>;
  /** Lấy trạng thái mới nhất từ NCC (số HĐ, mã CQT, đã huỷ...) */
  sync?(cfg: ProviderConfig, ref: InvoiceRef): Promise<SyncResult>;
  /** Tải PDF thể hiện hoá đơn */
  getPdf?(cfg: ProviderConfig, ref: InvoiceRef): Promise<FileResult>;
  /** Tải XML hoá đơn */
  getXml?(cfg: ProviderConfig, ref: InvoiceRef): Promise<FileResult>;
  /** URL tra cứu công khai cho khách (nếu NCC có cổng tra cứu) */
  lookupUrl?(cfg: ProviderConfig, ref: InvoiceRef): string | null;
}

/** Lỗi từ nhà cung cấp — message hiển thị cho admin, `raw` ghi log */
export class EInvoiceProviderError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
    /** Lỗi tạm thời (timeout, 5xx) -> job thử lại; false = lỗi dữ liệu, không thử lại */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'EInvoiceProviderError';
  }
}
