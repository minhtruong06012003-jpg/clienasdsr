/**
 * Hợp đồng chung cho mọi nhà cung cấp đổi thẻ cào (Card24h, TheSieuRe, Doithe1s...).
 * Thêm nhà cung cấp mới:
 *  - Cùng giao thức `chargingws/v2` (đa số site đổi thẻ ở VN) → chỉ thêm một dòng preset trong `providers/index.ts`.
 *  - Giao thức khác → viết file `providers/<ten>.provider.ts` triển khai `CardProvider` rồi thêm vào `CARD_PROVIDERS`.
 */

/** Kết quả chuẩn hoá của một thẻ (dùng chung cho gửi thẻ, kiểm tra trạng thái và callback) */
export type CardResultStatus = 'PENDING' | 'SUCCESS' | 'WRONG_VALUE' | 'FAILED';

/** Cấu hình kết nối nhà cung cấp — đọc từ nhóm cài đặt `card_topup` */
export interface CardProviderConfig {
  partnerId: string;
  partnerKey: string;
  /** Tên miền (chỉ dùng cho nhà cung cấp "tuỳ chỉnh") */
  domain?: string;
  /** Cách gửi request (chỉ dùng cho nhà cung cấp "tuỳ chỉnh") */
  method?: 'GET' | 'POST';
}

/** Thông tin một thẻ gửi sang nhà cung cấp */
export interface CardInput {
  /** Mã yêu cầu duy nhất phía mình (request_id) */
  code: string;
  telco: string;
  serial: string;
  pin: string;
  /** Mệnh giá khai báo */
  amount: number;
}

export interface CardResult {
  status: CardResultStatus;
  /** Mệnh giá thật (nhà cung cấp xác nhận) */
  realValue?: number;
  /** Số tiền nhà cung cấp trả cho shop */
  providerAmount?: number;
  /** Mã giao dịch phía nhà cung cấp */
  providerRef?: string;
  message?: string;
  /**
   * Nhà cung cấp KHÔNG nhận yêu cầu (bảo trì, sai partner, sai tham số...) — lỗi phía hệ thống, không phải thẻ lỗi.
   * Khi gửi thẻ: bản ghi bị bỏ, không tính vào giới hạn "thẻ lỗi / ngày" của khách.
   * Khi kiểm tra: nhà cung cấp chưa từng nhận thẻ → chốt lỗi nhưng đánh dấu systemError (khách gửi lại được, không bị tính lỗi).
   */
  rejected?: boolean;
  raw?: unknown;
}

export interface CardCallbackInput {
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface CardCallbackResult extends CardResult {
  /** Chữ ký hợp lệ */
  valid: boolean;
  /** Mã yêu cầu phía mình mà callback trỏ tới */
  code?: string;
  /** Mã thẻ + serial trong callback (để đối chiếu với bản ghi) */
  serial?: string;
  pin?: string;
}

export interface CardProvider {
  /** Khoá lưu trong cài đặt + DB (vd card24h) */
  key: string;
  label: string;
  /** Trang chủ nhà cung cấp (hiển thị ở admin, lấy favicon) */
  website: string;
  /** Nhà cung cấp cần admin nhập tên miền (dạng "tuỳ chỉnh") */
  needsDomain?: boolean;
  /** Gửi thẻ sang nhà cung cấp */
  submit(cfg: CardProviderConfig, card: CardInput): Promise<CardResult>;
  /** Hỏi lại trạng thái thẻ (cron gọi khi chưa nhận được callback) */
  check?(cfg: CardProviderConfig, card: CardInput): Promise<CardResult>;
  /** Xác thực + chuẩn hoá callback nhà cung cấp gửi về */
  parseCallback(cfg: CardProviderConfig, input: CardCallbackInput): CardCallbackResult;
}
