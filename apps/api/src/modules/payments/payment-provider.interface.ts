import type { Order, PaymentTransaction } from '../../generated/prisma/client.js';

export type I18n = Record<string, string>;

export interface CreatePaymentInput {
  order: Order;
  transaction: PaymentTransaction;
  amount: number;
  /** Nội dung ngắn gửi sang cổng (đã bỏ dấu, giới hạn độ dài theo cổng) */
  description: string;
  /** Storefront: trang khách quay về sau khi thanh toán */
  returnUrl: string;
  cancelUrl: string;
  /** API: URL cổng gọi về (IPN/webhook) */
  webhookUrl: string;
  locale: string;
}

export interface CreatePaymentResult {
  /** Chuyển khách sang trang thanh toán của cổng */
  checkoutUrl?: string;
  /** Chuỗi VietQR (EMVCo) hoặc URL ảnh QR */
  qrData?: string;
  qrImageUrl?: string;
  /** Thông tin chuyển khoản thủ công (cổng theo dõi biến động số dư) */
  bank?: { bankName: string; accountNumber: string; accountName: string };
  transferContent?: string;
  reference?: string;
  expiresAt?: Date;
  raw?: unknown;
}

export interface WebhookInput {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Nội dung gốc (Buffer) của request — dùng khi cổng ký trên raw body */
  rawBody?: Buffer;
  query: Record<string, unknown>;
  ip?: string;
}

/** Một khoản tiền nhận được trong webhook (một webhook có thể chứa nhiều giao dịch) */
export interface WebhookPayment {
  providerOrderCode?: string;
  transferContent?: string;
  amount: number;
  reference?: string;
  /** Mã duy nhất của lần nhận tiền phía cổng/ngân hàng — dùng chống xử lý trùng khi webhook gửi lại */
  txnId?: string;
}

export interface WebhookResult {
  /** Chữ ký / khoá xác thực hợp lệ */
  valid: boolean;
  /** Thanh toán thành công (tiền đã vào) */
  success: boolean;
  /** Khớp giao dịch theo mã gửi sang cổng ... */
  providerOrderCode?: string;
  /** ... hoặc theo nội dung chuyển khoản (cổng biến động số dư) */
  transferContent?: string;
  amount?: number;
  reference?: string;
  txnId?: string;
  /** Nhiều khoản tiền trong cùng webhook (vd lô giao dịch ngân hàng); nếu có thì bỏ qua các field đơn lẻ ở trên */
  payments?: WebhookPayment[];
  note?: string;
  /** Body trả lời cho cổng (mỗi cổng yêu cầu định dạng khác nhau) */
  response?: unknown;
  /** HTTP status trả lời (mặc định 200) */
  statusCode?: number;
}

/**
 * Một cổng thanh toán. Module `payment-gateways` đăng ký provider qua `PaymentsService.register(provider)`.
 * Cổng chỉ hiện cho khách khi `isEnabled()` (công tắc trong Cài đặt › Cổng thanh toán) và `isConfigured()` đều = true.
 */
export interface PaymentProvider {
  key: string;
  label: I18n;
  description?: I18n;
  /** Cổng bị ẩn: không hiện cho khách / trang Cài đặt, không tạo được giao dịch mới — chỉ còn nhận webhook của giao dịch cũ */
  hidden?: boolean;
  /** Cổng gọi webhook bằng GET kèm dữ liệu trên query string (vd USDT Gateway / NTPAY) — mặc định GET chỉ trả "endpoint OK" */
  acceptsGet?: boolean;
  /** Số tiền (VND) tối thiểu cổng nhận được, vd USDT Gateway tối thiểu 1 USDT — kiểm trước khi tạo giao dịch */
  minAmount?(): Promise<number>;
  /** Admin đã bật cổng trong Cài đặt chưa */
  isEnabled(): Promise<boolean>;
  isConfigured(): Promise<boolean>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  handleWebhook(input: WebhookInput): Promise<WebhookResult>;
  /** Danh sách mạng lưới / ví thanh toán công khai (dùng cho cổng Crypto / USDT hiển thị chọn ngay ngoài trang nạp) */
  publicNetworks?(): Promise<{ walletId: string; network: string; label: string; kind: string }[]>;
  /** Hỏi trạng thái trực tiếp từ cổng (dùng khi khách quay về trước khi webhook tới) */
  fetchStatus?(tx: PaymentTransaction, walletId?: string): Promise<'PAID' | 'PENDING' | 'CANCELLED' | 'EXPIRED' | 'FAILED'>;
  cancel?(tx: PaymentTransaction): Promise<void>;
  /** Hoàn tiền (một phần / toàn bộ) qua cổng. Không khai báo = cổng không hỗ trợ hoàn tiền tự động. */
  refund?(input: RefundInput): Promise<RefundResult>;
}

export interface RefundInput {
  order: Order;
  /** Giao dịch đã PAID cần hoàn */
  transaction: PaymentTransaction;
  amount: number;
  reason?: string;
}

export interface RefundResult {
  /** Mã hoàn tiền phía cổng */
  providerRef?: string;
  /** PENDING khi cổng xử lý bất đồng bộ (mặc định COMPLETED) */
  status?: 'COMPLETED' | 'PENDING';
  raw?: unknown;
}
