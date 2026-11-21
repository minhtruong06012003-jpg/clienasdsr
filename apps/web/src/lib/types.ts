/**
 * Kiểu dữ liệu trả về từ API (theo docs/smm-panel.md và docs/api-public.md).
 * Phần SMM viết theo hợp đồng — API có thể chưa có, mọi trường nên coi là có thể thiếu khi hiển thị.
 */

/** Dạng phân trang chung `{ data, meta }` */
export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/* ---------------- Tài khoản ---------------- */

export interface MediaRef {
  url: string;
  urls?: Record<string, string>;
  alt?: string | null;
}

export interface User {
  id: string;
  email: string;
  /** Tên đăng nhập; null = tài khoản cũ / Google chưa đặt (tự đặt một lần ở trang Tài khoản) */
  name: string;
  phone?: string | null;
  bio?: string | null;
  avatar?: MediaRef | null;
  status?: string;
  twoFactorEnabled?: boolean;
  walletBalance?: string | number;
  emailVerifiedAt?: string | null;
  createdAt?: string;
  recoveryCodesLeft?: number;
  /** Ngôn ngữ / tiền tệ hiển thị / múi giờ khách đã chọn (null = theo mặc định website) */
  locale?: string | null;
  currency?: string | null;
  timezone?: string | null;
  role?: { slug: string; name?: string; permissions?: string[] };
}

/** Kết quả đăng nhập thành công (login, register, verify-email, 2fa/verify, refresh) */
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresInDays?: number;
  /** false = phiên ngắn (không tick "Ghi nhớ đăng nhập") */
  refreshPersistent?: boolean;
  user: User;
}

/** Login có thể trả nhánh 2FA hoặc nhánh yêu cầu xác minh email (register) */
export type LoginResponse = AuthResult | { requires2fa: true; challenge: string };
export type RegisterResponse = AuthResult | { requiresVerification: true; message: string };

export interface SessionView {
  id: string;
  ip?: string | null;
  userAgent?: string | null;
  browser?: string | null;
  os?: string | null;
  device?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string;
  current?: boolean;
}

/* ---------------- Bootstrap ---------------- */

export interface CaptchaConfig {
  provider: "none" | "turnstile" | "recaptcha-v2" | "recaptcha-v3" | "hcaptcha";
  siteKey: string;
  on?: string[];
}

export interface MenuItem {
  id: string;
  label: string;
  url: string;
  target?: string;
  children?: MenuItem[];
}

/** Một thông báo trong popup "Thông báo hệ thống": content mỗi dòng 1 đoạn, **chữ** = in đậm; date = ISO lúc admin tạo */
export interface PopupNotice {
  id: string;
  title: string;
  content: string;
  date: string;
}

export interface SmmSettings {
  currency?: string;
  affiliateEnabled?: boolean;
  affiliateCommission?: number;
  apiEnabled?: boolean;
  levels?: { name: string; minSpent: number; discount: number }[];
  orderNotice?: string;
  /** Bật thông báo nổi (popup "Thông báo hệ thống" khi vào khu thành viên) */
  popupEnabled?: boolean;
  /** Danh sách thông báo nổi, mới nhất trước */
  popupItems?: PopupNotice[];
  /** Tiêu đề hộp đỏ lưu ý ở thẻ Thông tin dịch vụ */
  orderWarningTitle?: string;
  /** Nội dung hộp lưu ý: mỗi dòng 1 gạch đầu dòng, **chữ** = in đậm; trống = ẩn hộp */
  orderWarnings?: string;
  /** Hiện ô nhập mã giảm giá ở form đặt đơn (false = ẩn) */
  showCouponInput?: boolean;
  /** Admin đã chọn nhà cung cấp chuyển link Facebook sang UID (hiện nút ⇄ cạnh ô Liên kết) */
  uidConvert?: boolean;
  /** Bật bán dịch vụ (false = ngừng nhận đơn mới) */
  sellEnabled?: boolean;
  /** Cho khách báo cáo đơn hàng (nút mở ticket kèm mã đơn) */
  allowOrderReport?: boolean;
  /** Bắt đăng nhập mới xem được bảng giá */
  servicesRequireLogin?: boolean;
  /** Hiện thời gian xử lý trung bình */
  showAvgTime?: boolean;
  /** Giá đổi sau khi mở form thì bắt khách xác nhận giá mới */
  confirmPriceChange?: boolean;
}

/** Một mục menu bên trái website (khớp WebMenuItem ở apps/api/src/modules/settings/web-menu.ts) */
export interface WebMenuItem {
  id: string;
  /** link = dòng menu; heading = tiêu đề nhóm; ai_tools = khối Công cụ AI (tiêu đề + các nhóm công cụ) */
  type: "link" | "heading" | "ai_tools";
  label: string;
  href: string;
  icon: string;
  badge: string;
  newTab: boolean;
  enabled: boolean;
}

export interface Bootstrap {
  locale: string;
  defaultLocale: string;
  /** Ngôn ngữ admin khai báo (web chỉ hiện ngôn ngữ có từ điển, xem lib/i18n/config) */
  languages?: { code: string; name?: string; nativeName?: string | null; flag?: string | null; enabled?: boolean; isDefault?: boolean }[];
  settings: {
    general?: {
      siteName?: Record<string, string> | string;
      logo?: MediaRef | null;
      logoDark?: MediaRef | null;
      /** Favicon tab trình duyệt (Cài đặt › Chung) */
      favicon?: MediaRef | null;
      siteUrl?: string;
      /** Bảo trì website (Cài đặt › Chung): khách thấy trang thông báo, quản trị viên vẫn dùng bình thường */
      maintenanceMode?: boolean;
      maintenanceMessage?: Record<string, string> | string;
    };
    contact?: Record<string, unknown>;
    social?: Record<string, unknown>;
    features?: Record<string, boolean>;
    account?: { allowRegistration?: boolean; requireEmailVerification?: boolean };
    smm?: SmmSettings;
    /** AI Studio: số ngày tự xoá tác vụ (Cài đặt › Xử lý tác vụ AI), 0 = giữ vĩnh viễn */
    ai?: { taskRetentionDays?: number };
    /** Menu bên trái khu vực thành viên (admin sửa ở trang Menu website) */
    web_menu?: { items?: WebMenuItem[] };
    [key: string]: unknown;
  };
  menus?: Record<string, MenuItem[]>;
  captcha?: CaptchaConfig;
  auth?: { google?: { enabled: boolean; clientId: string } };
  uiStrings?: Record<string, string>;
}

/* ---------------- SMM ---------------- */

export type Platform = "facebook" | "tiktok" | "instagram" | "youtube" | "telegram" | "twitter" | "shopee" | "google" | "other";

export interface SmmCategory {
  id: string;
  name: string;
  slug: string;
  platform: Platform | string;
  /** Ảnh biểu tượng admin đặt (link hoặc /uploads/icons/...); trống = icon theo nền tảng */
  icon?: string | null;
  description?: string | null;
  sortOrder?: number;
  servicesCount?: number;
}

export type ServiceType = "DEFAULT" | "CUSTOM_COMMENTS" | "PACKAGE" | "SUBSCRIPTIONS" | "MENTIONS" | "POLL";

/** Nhãn dịch vụ do admin tạo (tên có thể kèm emoji, màu hex #RRGGBB) */
export interface SmmServiceTag {
  id: string;
  name: string;
  color: string;
}

export interface SmmService {
  id: string;
  code: number;
  name: string;
  /** Tên theo ngôn ngữ khác { [mã ngôn ngữ]: tên } do admin nhập; useServices tự thay vào `name` theo ngôn ngữ đang chọn */
  names?: Record<string, string>;
  description?: string | null;
  type: ServiceType | string;
  categoryId: string;
  category?: { name: string; platform: Platform | string; icon?: string | null };
  /** Giá bán / 1000 (đã trừ giảm giá khi gửi Bearer) */
  rate: number | string;
  /** Giá gốc / 1000 khi có giảm giá */
  baseRate?: number | string;
  min: number;
  max: number;
  refill: boolean;
  /** Số ngày được bảo hành tính từ lúc đơn hoàn thành (null = không giới hạn) */
  refillDays?: number | null;
  cancel: boolean;
  dripfeed: boolean;
  /** Dịch vụ tự đổi link Facebook sang UID khi đặt đơn */
  autoUid?: boolean;
  averageTime?: string | number | null;
  /** Nhãn admin gắn cho dịch vụ, theo thứ tự hiển thị */
  tags?: SmmServiceTag[];
  /** Lượt bán — chỉ có khi admin bật "Hiển thị lượt bán" */
  soldCount?: number;
}

export type OrderStatus = "PENDING" | "PROCESSING" | "IN_PROGRESS" | "COMPLETED" | "PARTIAL" | "CANCELED" | "FAILED";

export interface SmmOrder {
  id: string;
  code: number;
  service: { code: number; name: string; type?: string; refill?: boolean; cancel?: boolean };
  link: string;
  quantity: number;
  charge: number | string;
  refunded?: number | string;
  status: OrderStatus | string;
  startCount?: number | null;
  remains?: number | null;
  comments?: string | null;
  runs?: number | null;
  interval?: number | null;
  /** Tham số riêng theo kiểu dịch vụ (Mentions / Poll / Subscriptions) */
  extra?: SmmOrderExtra | null;
  /** Hẹn giờ gửi nhà cung cấp ("Lên lịch"), null = gửi ngay */
  scheduledAt?: string | null;
  /** Lặp lại đơn hàng: số lần còn tạo thêm sau khi đơn này hoàn thành (null = không lặp) */
  repeatLeft?: number | null;
  /** Giãn cách (phút) giữa lúc đơn trước hoàn thành và lúc gửi đơn kế tiếp (null = gửi ngay) */
  repeatInterval?: number | null;
  /** Đơn gốc của chuỗi lặp lại */
  repeatOfId?: string | null;
  /** Mã giảm giá đã dùng + số tiền được giảm */
  couponCode?: string | null;
  discountAmount?: number | string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string | null;
  /** Hạn bảo hành (null = không giới hạn hoặc đơn chưa hoàn thành) */
  refillUntil?: string | null;
  canRefill?: boolean;
  canCancel?: boolean;
}

/** Tham số riêng của đơn theo kiểu dịch vụ (khớp SmmOrderExtra ở API) */
export interface SmmOrderExtra {
  /** MENTIONS: danh sách username, mỗi dòng một tên */
  usernames?: string;
  /** POLL: số thứ tự đáp án */
  answerNumber?: number;
  /** SUBSCRIPTIONS: số lượng tối thiểu / tối đa mỗi bài mới, số bài, độ trễ (phút), hạn dd/mm/yyyy */
  min?: number;
  max?: number;
  posts?: number;
  delay?: number;
  expiry?: string;
}

/** Loại thay đổi ở trang "Cập nhật dịch vụ" */
export type ServiceUpdateType = "NEW" | "ENABLED" | "DISABLED" | "PRICE_UP" | "PRICE_DOWN";

/** Một dòng lịch sử thay đổi dịch vụ (GET /public/smm/updates) */
export interface SmmServiceUpdate {
  id: string;
  type: ServiceUpdateType | string;
  serviceCode: number;
  serviceName: string;
  oldRate: number | null;
  newRate: number | null;
  createdAt: string;
}

export interface SmmRefill {
  id: string;
  code?: number;
  order?: { code: number; link?: string; service?: { name: string } } | null;
  orderCode?: number;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "REJECTED" | string;
  createdAt: string;
  updatedAt?: string;
}

export interface SmmSummary {
  balance: number | string;
  totalSpent: number | string;
  discount: number;
  level: { name: string; discount: number } | null;
  nextLevel?: { name: string; minSpent: number; discount: number } | null;
  orders: { total: number; pending: number; inProgress: number; completed: number; partial: number; canceled: number };
}

export interface MassOrderResult {
  created: SmmOrder[];
  errors: { line: number; message: string }[];
}

export interface ApiKeyInfo {
  hasKey: boolean;
  last4?: string | null;
  createdAt?: string | null;
  apiUrl?: string;
  /** Danh sách IP / dải CIDR được dùng key, cách nhau dấu phẩy ('' = mọi IP) */
  ipWhitelist?: string;
}

export interface AffiliateInfo {
  enabled: boolean;
  code: string;
  link: string;
  commission: number;
  referrals: number;
  /** tổng hoa hồng ròng đã nhận (đã trừ phần bị thu hồi) */
  earned: number | string;
  /** số dư ví hoa hồng (rút được) */
  balance?: number | string;
  /** đang chờ duyệt rút */
  pendingPayout?: number | string;
  /** đã rút thành công */
  paidOut?: number | string;
  /** quy định rút: tối thiểu, cho rút vào ví / ngân hàng */
  payout?: { min: number; wallet: boolean; bank: boolean };
  recent: { name: string; createdAt: string; earned: number | string }[];
}

/** Một dòng lịch sử ví hoa hồng (GET /account/affiliate/transactions) */
export interface AffiliateTransaction {
  id: string;
  type: "COMMISSION" | "REVOKE" | "PAYOUT" | "PAYOUT_REFUND" | "ADJUST";
  amount: number | string;
  balanceAfter: number | string;
  note: string | null;
  createdAt: string;
  fromUser: { name: string } | null;
  payout: { code: number } | null;
}

/** Yêu cầu rút hoa hồng (GET /account/affiliate/payouts) */
export interface AffiliatePayout {
  id: string;
  code: number;
  amount: number | string;
  method: "WALLET" | "BANK";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  bankName: string | null;
  bankAccount: string | null;
  bankHolder: string | null;
  note: string | null;
  adminNote: string | null;
  processedAt: string | null;
  createdAt: string;
}

export type TicketStatus = "OPEN" | "ANSWERED" | "CUSTOMER_REPLY" | "CLOSED";
export type TicketCategory = "ORDER" | "PAYMENT" | "SERVICE" | "API" | "OTHER";
export type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

/** Ảnh / video đính kèm trong tin nhắn ticket */
export interface TicketAttachment {
  url: string;
  name: string;
  size?: number;
  mimeType?: string;
  kind?: "image" | "video";
  width?: number;
  height?: number;
}

export interface TicketMessage {
  id: string;
  body: string;
  isStaff: boolean;
  authorName?: string | null;
  attachments?: TicketAttachment[];
  createdAt: string;
}

export interface Ticket {
  id: string;
  code: number;
  subject: string;
  category: TicketCategory | string;
  status: TicketStatus | string;
  priority?: TicketPriority | string;
  createdAt: string;
  updatedAt?: string;
  lastReplyAt?: string | null;
  closedAt?: string | null;
  /** Có trả lời mới của nhân viên mà khách chưa xem */
  customerUnread?: boolean;
  /** Mã đơn liên quan khách nhập khi mở ticket, dạng "123, 456" */
  orderCodes?: string | null;
  /** Tin cuối (chỉ có ở danh sách) */
  lastMessage?: { body: string; isStaff: boolean; hasImage: boolean } | null;
  /** Đánh giá của khách */
  rating?: number | null;
  ratingComment?: string | null;
  ratedAt?: string | null;
  /** Chi tiết: còn được trả lời để mở lại / còn được đánh giá */
  canReopen?: boolean;
  canRate?: boolean;
  messages?: TicketMessage[];
}

/** Danh sách ticket kèm đếm theo trạng thái và số ticket có trả lời chưa xem */
export interface TicketList extends Paginated<Ticket> {
  counts?: Record<string, number>;
  unread?: number;
}

/* ---------------- Ví & nạp tiền ---------------- */

export interface WalletSummary {
  balance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalSpent: number;
  totalRefunded?: number;
  transactionCount?: number;
}

export interface WalletTransaction {
  id: string;
  type: string;
  amount: string | number;
  balanceAfter: string | number;
  note?: string | null;
  createdAt: string;
  order?: { id: string; code: string } | null;
  meta?: Record<string, unknown>;
}

export interface UsdtNetworkOption {
  walletId: string;
  network: string;
  label: string;
  kind?: "chain" | "binance" | string;
  address?: string;
  memo?: string;
  qr?: string;
  payUri?: string;
}

export interface TopupOptions {
  enabled: boolean;
  min: number;
  max: number;
  /** Tỉ giá VND cho 1 USDT và mức USDT tối thiểu của cổng USDT Gateway */
  usdtRate?: number;
  minUsdt?: number;
  /** Danh sách các mạng lưới / ví USDT đang bật trên cổng (TRC20, BEP20, Binance Pay...) */
  usdtNetworks?: UsdtNetworkOption[];
  /** Mốc bonus nạp tiền: nạp từ `min` đ được thưởng thêm `percent`% (mốc cao nhất đạt được) */
  bonuses?: { min: number; percent: number }[];
  /** Có hiện mục "Tên chuyển khoản" không */
  transferNameEnabled?: boolean;
  /** Tiền tố nội dung chuyển khoản theo họ tên (vd "CHUYEN TIEN") */
  transferPrefix?: string;
  /** nameContent: cổng dùng nội dung "<tiền tố> <họ tên>" -> khách phải nhập họ tên trước khi nạp */
  /** manual: phương thức nạp thủ công (quản trị viên duyệt tay) -> có nút "Tôi đã chuyển khoản" */
  /** icon: URL ảnh admin đặt cho cổng (null = icon mặc định) */
  /** crypto: cổng crypto (Binance Pay) -> khách nhập USD; rate = VND cho 1 USD, min/max = hạn mức đã quy đổi sang USD */
  providers: { key: string; label: string; icon?: string | null; description?: string; nameContent?: boolean; manual?: boolean; crypto?: { currency: string; rate: number; min: number; max: number } | null }[];
}

/** Giao dịch nạp ví qua cổng (payments.service.ts → presentTopup) */
export interface Topup {
  id: string;
  provider: string;
  status: "PENDING" | "PAID" | "FAILED" | "CANCELLED" | "EXPIRED" | string;
  amount: number;
  checkoutUrl?: string | null;
  qrData?: string | null;
  transferContent?: string | null;
  /** Mã tham chiếu phía cổng / ngân hàng */
  reference?: string | null;
  bank?: { bankName: string; accountNumber: string; accountName: string } | null;
  qrImageUrl?: string | null;
  /** Cổng crypto (Binance Pay): số coin phải chuyển (đúng từng chữ số), coin, tỉ giá, Binance Pay ID nhận tiền, mã ghi vào ô Ghi chú (giao dịch cũ không có) */
  crypto?: { amount: string; currency: string; rate: number; payId: string; memo?: string } | null;
  /** Cổng USDT: số USDT phải chuyển (đã cộng phần lẻ phân biệt hoá đơn), tỉ giá VND / 1 USDT đã chốt lúc tạo + danh sách ví/mạng lưới */
  usdt?: { amount: string; currency: string; rate: number; networks?: UsdtNetworkOption[] } | null;
  /** Nạp thủ công: hướng dẫn của quản trị viên + lúc khách bấm "Tôi đã chuyển khoản" (null = chưa báo) */
  manual?: { note: string | null; notifiedAt: string | null } | null;
  expiresAt?: string | null;
  paidAt?: string | null;
  /** Tiền thưởng nạp theo mốc đã cộng thêm (0 = không có) */
  bonus?: number;
  note?: string | null;
  serverNow?: string;
  createdAt: string;
}

export interface CardConfig {
  enabled: boolean;
  creditMode: "discount" | string;
  telcos: { code: string; name: string; discount: number | null }[];
  amounts: number[];
  wrongValuePenalty: number;
  notice: string;
}

export interface CardTopup {
  id: string;
  code?: string | number;
  telco: string;
  serial: string;
  pin: string;
  declaredValue: number;
  realValue?: number | null;
  credited: number;
  status: "PENDING" | "SUCCESS" | "WRONG_VALUE" | "FAILED" | string;
  message?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

/* ---------------- Nội dung CMS ---------------- */

export interface PostCard {
  id: string;
  title: string;
  slug: string;
  excerpt?: string | null;
  readingTime?: number;
  publishedAt?: string | null;
  author?: { id: string; name: string } | null;
  featuredImage?: MediaRef | null;
  categories?: { id: string; name: string; slug: string }[];
}

/* ---------------- AI Studio: số dư (VND), gói nạp, công cụ, tác vụ ---------------- */
/* Đã bỏ đơn vị "credits": số dư chạy công cụ AI chính là số dư ví VND (1 credit cũ = 1đ); tên trường API giữ nguyên. */

/** GET /account/credits — số dư ví (VND), gói cước cũ (nếu còn), giảm giá */
export interface CreditSummary {
  /** Số dư ví (VND, làm tròn xuống) — dùng để chạy công cụ AI */
  credits: number;
  /** Số dư ví (VND) — cùng giá trị với `credits` */
  wallet: number;
  /** Gói cước cũ (cơ chế trước khi chuyển sang nạp tiền) — cycle: chu kỳ lần mua gần nhất */
  plan: { id: string; name: string; slug: string; concurrency: number; expiresAt: string | null; active: boolean; cycle: PlanCycle } | null;
  /** Gói năm cũ: lần cộng tiền kế tiếp (thời điểm, số tiền VND, số lần còn lại) */
  nextRefill: { at: string | null; credits: number; left: number } | null;
  concurrency: number;
  /** Tổng tiền (VND) đã dùng cho công cụ AI */
  totalUsed: number;
  /** Tổng đã nạp (VND), giảm giá riêng (%) của khách */
  pricing: { spent: number; customDiscount: number };
}

/** Chu kỳ của gói cước cũ (tháng / năm) */
export type PlanCycle = "month" | "year";

/** Một gói nạp tiền: trả `price`, nhận `credits` VND vào ví (có thể kèm % tặng thêm), số dư vĩnh viễn */
export interface CreditPlan {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Giá niêm yết và giá sau giảm giá riêng của khách đang đăng nhập (VND) */
  price: number;
  finalPrice: number;
  /** % giảm giá riêng đang áp */
  discount: number;
  /** Số tiền (VND) cộng vào ví khi mua gói */
  credits: number;
  /** % tặng thêm so với gói có đơn giá cao nhất */
  bonus: number;
  badge: string | null;
  highlight: boolean;
}

/** Cấu hình nạp tiền theo số tiền tự do (API: credits.service.ts › publicTopup) */
export interface TopupConfig {
  /** Số tiền (VND) vào ví cho mỗi 1đ thanh toán (thường = 1) */
  rate: number;
  /** Hạn mức mỗi lần nạp (VND) */
  min: number;
  max: number;
  /** Mức tiền gợi ý (nút chọn nhanh) */
  presets: number[];
  /** Mốc khuyến mãi: nạp từ `min`đ được tặng thêm `bonus`%, sắp tăng dần */
  tiers: { min: number; bonus: number }[];
  /** Chương trình khuyến mãi đang chạy (null = không có) */
  promo: { bonus: number; label: string; endsAt: string | null } | null;
  /** % tặng thêm riêng của khách đang đăng nhập */
  personal: number;
}

/** GET /public/plans — gói nạp (không còn bán trên website) + cấu hình nạp tiền tự do + quyền lợi chung + ghi chú */
export interface CreditPlanList {
  data: CreditPlan[];
  topup?: TopupConfig;
  features: string[];
  note: string;
}

/** Một dòng nhật ký sử dụng AI: `amount`, `balanceAfter` tính bằng VND (số dư ví) */
export interface CreditTransaction {
  id: string;
  type: "PURCHASE" | "USAGE" | "REFUND" | "BONUS" | "ADJUST";
  amount: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
  task?: { id: string; code: string; toolKey: string } | null;
  purchase?: { id: string; code: number; planName: string } | null;
}

/** Kiểu ô nhập trên form công cụ (khớp AiFieldDef của API) */
export type AiFieldType = "text" | "textarea" | "select" | "number" | "boolean" | "image" | "video" | "audio" | "file";

export interface AiFieldOption {
  value: string;
  label: string;
  /** Mô tả phụ dưới nhãn; có ở mọi lựa chọn thì web hiện dạng thẻ 2 cột */
  hint?: string;
  /** Ô picker "voice": hãng, giới tính, ngôn ngữ (mã ISO), phong cách của giọng đọc */
  badge?: string;
  gender?: "male" | "female" | "neutral";
  langs?: string[];
  tags?: string[];
  /** Ô picker "template": nhóm (tab), ảnh bìa và video xem trước của mẫu */
  group?: string;
  image?: string;
  video?: string;
}

export interface AiField {
  name: string;
  label: string;
  type: AiFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  options?: AiFieldOption[];
  min?: number;
  max?: number;
  step?: number;
  multiple?: boolean;
  maxFiles?: number;
  accept?: string;
  showIf?: { field: string; in: string[] };
  optionsBy?: { field: string; map: Record<string, AiFieldOption[]> };
  /** textarea: nhóm gợi ý bấm nhanh hiện trên ô (vd thể loại nhạc) — bấm thì điền `value` vào ô mô tả */
  suggestions?: { label: string; options: AiFieldOption[] };
  /** select: "voice" = hộp chọn giọng đọc có tìm kiếm, lọc và nút nghe thử */
  picker?: "voice" | "template";
  /** picker "voice": mẫu URL file nghe thử, `{value}` thay bằng mã giọng */
  preview?: string;
  /** picker "voice": danh sách mã ngôn ngữ ISO hiển thị đầy đủ ở bộ lọc ngôn ngữ */
  filterLangs?: string[];
  /** picker "voice": cho phép chọn giọng từ Kho giọng đã nhân bản cá nhân (`uvoice_<id>`) */
  allowClonedVoices?: boolean;
  /** Ô ẩn (giá trị cố định = default) — vd ô Model AI của công cụ đã tách theo từng model */
  hidden?: boolean;
}

export interface UserClonedVoice {
  id: string;
  value: string;
  name: string;
  description: string;
  language: string;
  gender: "male" | "female";
  refText: string;
  previewUrl: string;
  createdAt: string;
}

export type AiOutputType = "image" | "video" | "audio" | "text";

/** Ví dụ đầu ra của công cụ: `compare` = cặp ảnh trước / sau, `image` = một ảnh kết quả */
export type AiSample =
  | { type: "compare"; before: string; after: string; caption?: string; hint?: string }
  | { type: "image"; url: string; caption?: string; hint?: string };

/** Công cụ AI (GET /public/ai/tools) */
export interface AiTool {
  key: string;
  name: string;
  description: string | null;
  category: string;
  icon: string | null;
  badge: string | null;
  featured: boolean;
  /** Chế độ bảo trì: vẫn hiển thị gói cho khách nhưng khoá nút Tạo ngay -> Đang bảo trì */
  maintenance?: boolean;
  /** Các nhóm model công cụ thuộc (một công cụ ở được nhiều nhóm): công cụ cùng nhóm gộp thành 1 trên website, khách chọn model trong nhóm */
  groups?: string[];
  /**
   * Nhóm model đang xét: từ API = nhóm đầu tiên; dòng đã gộp (`mergeModelGroups`) = nhóm của dòng đó (null = đứng riêng).
   * Đọc danh sách nhóm bằng `groupsOf()` (API cũ chỉ có `group`)
   */
  group?: string | null;
  /** Tên model hiện trong ô chọn model của nhóm */
  modelLabel?: string;
  output: AiOutputType;
  fields: AiField[];
  /** Form nhiều cặp (vd [Ảnh nhân vật + Video mẫu]): mỗi hàng đủ file là một tác vụ; `linkField` có ô dán link video */
  pairs?: { fields: string[]; max?: number; linkField?: string } | null;
  /** Số lượng nhân bản tối đa (mỗi bản một tác vụ); null = không có ô này */
  copies?: number | null;
  /** Ví dụ đầu ra (ảnh trước / sau hoặc ảnh kết quả) hiện trên trang công cụ */
  samples?: AiSample[];
  /** Video / ảnh mẫu tham khảo hiện ở đầu bảng Thiết lập trên trang công cụ */
  demoVideo?: string | null;
  /** Ảnh bìa thẻ "Quy trình AI" ở trang tổng quan (null = công cụ thường) */
  cover?: string | null;
  /** Giá một lượt theo lựa chọn mặc định của form (VND, chưa trừ giảm giá cấp bậc); null = chưa tính được. Dùng để xếp model rẻ nhất lên đầu */
  price?: number | null;
  pricing:
    | { mode: "fixed"; base: number; perUnit: number; unitLabel: string | null; min: number; hint?: string }
    | { mode: "tiers"; base: number; tier10to20: number; tier20to30: number; min: number; hint?: string }
    | { mode: "dynamic"; min: number; perUnit?: number; unitLabel?: string | null; hint?: string }
    | { mode: "free"; min: number };
}

export interface AiPriceOptionItem {
  label: string;
  price: number;
  unit?: string | null;
}

export interface AiPriceMatrixTable {
  title?: string;
  rowHeader: string;
  columns: string[];
  rows: { label: string; prices: (number | null)[] }[];
}

export interface AiToolPriceBreakdown {
  minPrice: number | null;
  maxPrice: number | null;
  defaultPrice: number | null;
  unitLabel: string | null;
  items: AiPriceOptionItem[];
  tables?: AiPriceMatrixTable[];
  note?: string | null;
}

export type AiTaskStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface AiOutputFile {
  url: string;
  type: AiOutputType;
  name?: string;
}

/** Tác phẩm công khai trên trang Cộng đồng (đã bỏ ô tải file, chi phí, lỗi) */
export interface CommunityTask {
  id: string;
  code: string;
  toolKey: string;
  tool: { name: string; icon: string | null; category: string; output: AiOutputType } | null;
  status: AiTaskStatus;
  input: Record<string, unknown>;
  output: { files?: AiOutputFile[]; text?: string };
  /** Tên gọi của tác giả */
  author: string | null;
  createdAt: string;
}

/** Tác vụ AI của khách */
export interface AiTask {
  id: string;
  code: string;
  toolKey: string;
  tool: { name: string; icon: string | null; category: string; output: AiOutputType } | null;
  status: AiTaskStatus;
  progress: number;
  input: Record<string, unknown>;
  output: { files?: AiOutputFile[]; text?: string };
  /** Chi phí tác vụ (VND, trừ vào số dư ví) */
  credits: number;
  refunded: boolean;
  error: string | null;
  /** Video Muse bị từ chối nhưng Muse hỏi lại: câu hỏi + mã tác vụ trả lời (mỗi tác vụ chỉ trả lời 1 lần) */
  museReply?: { question: string; replyTask: string | null; replied: boolean };
  /** Hiển thị công khai (trang cộng đồng) hay riêng tư */
  isPublic?: boolean;
  /** Quản trị viên đã ẩn khỏi Cộng đồng (không bật Công khai lại được) */
  publicBlocked?: boolean;
  /** Khách đã gửi yêu cầu đăng lên Cộng đồng và đang chờ quản trị viên duyệt */
  communityPending?: boolean;
  /** Tên file tuỳ chọn khách đặt để khi tải video / ảnh về máy lưu theo tên này */
  customName?: string | null;
  startedAt?: string | null;
  createdAt: string;
  completedAt: string | null;
}
