/**
 * Kiểu dữ liệu báo cáo website (API `/admin/analytics/*`, quyền `reports.view`).
 * Mọi endpoint nhận `from`, `to` (YYYY-MM-DD theo múi giờ website); endpoint chuỗi thời gian nhận thêm `interval`.
 * Phần trăm (`bounceRate`, `conversionRate`, `*Change`) là số 0–100 làm tròn 1 chữ số; thời lượng tính bằng giây.
 */
import type { ReportInterval } from './types';

export interface RangeMeta {
  from: string;
  to: string;
  timezone: string;
}

export interface NamedCount {
  name: string;
  value: number;
}

// ------------------------------------------------------------------ Tổng quan  GET /admin/analytics/overview

export interface TrafficSummary {
  /** khách (mã ẩn danh đổi mỗi ngày -> cộng dồn theo ngày) */
  visitors: number;
  pageviews: number;
  sessions: number;
  /** % phiên chỉ xem 1 trang */
  bounceRate: number;
  /** thời lượng phiên trung bình (giây) */
  avgDuration: number;
  pagesPerSession: number;
}

export interface SiteOverview {
  range: RangeMeta;
  traffic: TrafficSummary;
  /** % thay đổi so với kỳ trước, cùng khoá với `traffic`; riêng `bounceRate` là chênh lệch điểm % */
  trafficChange: Record<keyof TrafficSummary, number>;
  /** khách hoạt động trong 5 phút gần nhất */
  online: number;
  content: {
    pages: number;
    posts: number;
    products: number;
    /** xuất bản mới trong kỳ */
    newPages: number;
    newPosts: number;
    newProducts: number;
    media: number;
    mediaBytes: number;
  };
  members: { total: number; newUsers: number; newUsersChange: number; activeUsers: number };
  engagement: {
    comments: number;
    commentsChange: number;
    pendingComments: number;
    reviews: number;
    reviewsChange: number;
    /** điểm trung bình đánh giá trong kỳ, null nếu không có */
    avgRating: number | null;
  };
  emails: { sent: number; failed: number };
  /** null nếu người xem không có quyền `orders.read` */
  sales: { revenue: number; orders: number; revenueChange: number; ordersChange: number; /** đơn hợp lệ / phiên truy cập (%) */ conversionRate: number | null } | null;
}

// ------------------------------------------------------------------ Truy cập

/** GET /admin/analytics/traffic?interval= */
export interface TrafficSeries {
  range: RangeMeta;
  interval: ReportInterval;
  data: { period: string; visitors: number; pageviews: number; sessions: number }[];
}

/** GET /admin/analytics/hours — lượt xem theo thứ trong tuần × giờ (giờ website) */
export interface HoursReport {
  range: RangeMeta;
  /** dow: 0 = Thứ Hai … 6 = Chủ nhật */
  data: { dow: number; hour: number; pageviews: number }[];
}

/** GET /admin/analytics/realtime — 5 phút gần nhất (tự làm mới 30s) */
export interface RealtimeReport {
  online: number;
  pages: { path: string; title: string | null; visitors: number }[];
  recent: { createdAt: string; path: string; title: string | null; device: string; browser: string | null; os: string | null; referrerHost: string | null; country: string | null }[];
}

export interface PageRow {
  path: string;
  title: string | null;
  pageviews: number;
  visitors: number;
  /** số phiên bắt đầu ở trang này */
  entries: number;
  /** % phiên vào trang này rồi rời đi ngay */
  bounceRate: number;
}

/** GET /admin/analytics/pages?limit=&search= */
export interface PagesReport {
  range: RangeMeta;
  data: PageRow[];
  totals: { pageviews: number; visitors: number };
}

export type Channel = 'direct' | 'search' | 'social' | 'referral' | 'campaign' | 'email';

/** GET /admin/analytics/sources */
export interface SourcesReport {
  range: RangeMeta;
  channels: { channel: Channel; sessions: number; visitors: number }[];
  referrers: { host: string; sessions: number; visitors: number }[];
  campaigns: { source: string; medium: string | null; campaign: string | null; sessions: number; visitors: number }[];
}

/** GET /admin/analytics/devices — đếm theo khách */
export interface DevicesReport {
  range: RangeMeta;
  devices: NamedCount[];
  browsers: NamedCount[];
  os: NamedCount[];
  countries: NamedCount[];
  locales: NamedCount[];
}

// ------------------------------------------------------------------ Nội dung  GET /admin/analytics/content?interval=

export interface StatusCount {
  published: number;
  draft: number;
  scheduled: number;
  archived: number;
  trash: number;
  total: number;
}

export interface ContentReport {
  range: RangeMeta;
  interval: ReportInterval;
  counts: { pages: StatusCount; posts: StatusCount; products: StatusCount };
  /** nội dung xuất bản mới theo kỳ (publishedAt) */
  series: { period: string; pages: number; posts: number; products: number }[];
  /** bài viết xem nhiều nhất (tổng lượt xem từ trước tới nay) */
  topPosts: { id: string; title: string; viewCount: number; commentCount: number; publishedAt: string | null }[];
  /** số bài xuất bản trong kỳ theo tác giả */
  authors: { id: string | null; name: string; posts: number }[];
  postCategories: NamedCount[];
  productCategories: NamedCount[];
  media: { total: number; bytes: number; byType: { name: string; count: number; bytes: number }[] };
}

// ------------------------------------------------------------------ Thành viên  GET /admin/analytics/members?interval=

export interface MembersReport {
  range: RangeMeta;
  interval: ReportInterval;
  totals: { total: number; active: number; inactive: number; banned: number; pending: number; verified: number; twoFactor: number; newUsers: number; activeUsers: number };
  /** đăng ký mới & lượt đăng nhập theo kỳ */
  series: { period: string; signups: number; logins: number }[];
  byRole: NamedCount[];
  /** null nếu người xem không có quyền `users.read` (chứa tên + email) */
  recent: { id: string; name: string; email: string; role: string; createdAt: string }[] | null;
}

// ------------------------------------------------------------------ Tương tác  GET /admin/analytics/engagement?interval=

export interface EngagementReport {
  range: RangeMeta;
  interval: ReportInterval;
  series: { period: string; comments: number; reviews: number }[];
  /** tên trạng thái tiếng Việt: Đã duyệt, Chờ duyệt, Spam, Thùng rác */
  commentStatus: NamedCount[];
  /** đủ 5 mức 1..5 */
  ratings: { rating: number; count: number }[];
  topCommented: { id: string; title: string; comments: number }[];
}

// ------------------------------------------------------------------ Email  GET /admin/analytics/emails?interval=

export interface EmailsReport {
  range: RangeMeta;
  interval: ReportInterval;
  totals: { sent: number; failed: number; skipped: number };
  series: { period: string; sent: number; failed: number }[];
  /** skipped = không gửi (chưa cấu hình SMTP, mẫu tắt...) */
  templates: { key: string; sent: number; failed: number; skipped: number }[];
  /** null nếu người xem không có quyền `settings.manage` (chứa địa chỉ người nhận) */
  recentFailed: { id: string; to: string; subject: string; error: string | null; createdAt: string }[] | null;
}

/** GET /admin/analytics/export.csv?report=traffic|pages|sources&from&to&interval — tải file CSV */
export type SiteExportReport = 'traffic' | 'pages' | 'sources';
