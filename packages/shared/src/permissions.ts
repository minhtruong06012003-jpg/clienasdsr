import type { FeatureKey } from './content.js';

/** Danh mục con của mục Cài đặt (/admin/settings) — hiển thị để tích chọn chi tiết từng mục trong Vai trò & phân quyền */
export const SETTING_SECTIONS = [
  { key: 'site', label: 'Website' },
  { key: 'ai', label: 'AI Studio' },
  { key: 'commerce', label: 'Thanh toán' },
  { key: 'comms', label: 'Thông báo & thành viên' },
  { key: 'system', label: 'Hệ thống' },
] as const;

export type SettingSectionKey = (typeof SETTING_SECTIONS)[number]['key'];

export interface SettingPermissionItem {
  key: string;
  label: string;
  tabKey: string;
  section: SettingSectionKey;
  feature?: FeatureKey;
}

export const SETTING_PERMISSIONS = [
  // Website
  { key: 'settings.general', label: 'Chung', tabKey: 'general', section: 'site' },
  { key: 'settings.features', label: 'Tính năng', tabKey: 'features', section: 'site' },
  { key: 'settings.contact', label: 'Liên hệ', tabKey: 'contact', section: 'site' },
  { key: 'settings.appearance', label: 'Giao diện', tabKey: 'appearance', section: 'site' },
  { key: 'settings.contactButtons', label: 'Nút liên hệ nổi', tabKey: 'contactButtons', section: 'site' },
  { key: 'settings.popup', label: 'Thông báo nổi', tabKey: 'popup', section: 'site' },
  { key: 'settings.seo', label: 'SEO', tabKey: 'seo', section: 'site' },
  // AI Studio
  { key: 'settings.credits', label: 'Nạp tiền & khuyến mãi', tabKey: 'credits', section: 'ai' },
  { key: 'settings.ai_general', label: 'Xử lý tác vụ AI', tabKey: 'ai-general', section: 'ai' },
  // Thanh toán
  { key: 'settings.currency', label: 'Tiền tệ', tabKey: 'currency', section: 'commerce' },
  { key: 'settings.payments', label: 'Cổng thanh toán', tabKey: 'payments', section: 'commerce' },
  { key: 'settings.commerce', label: 'Bán hàng', tabKey: 'commerce', section: 'commerce', feature: 'shop' },
  { key: 'settings.tax', label: 'Thuế', tabKey: 'tax', section: 'commerce', feature: 'shop' },
  { key: 'settings.shipping', label: 'Vận chuyển', tabKey: 'shipping', section: 'commerce', feature: 'shop' },
  { key: 'settings.digital', label: 'Sản phẩm số', tabKey: 'digital', section: 'commerce', feature: 'shop' },
  { key: 'settings.einvoice', label: 'Hoá đơn điện tử', tabKey: 'einvoice', section: 'commerce', feature: 'shop' },
  // Thông báo & thành viên
  { key: 'settings.mail', label: 'Email SMTP', tabKey: 'mail', section: 'comms' },
  { key: 'settings.emails', label: 'Mẫu email', tabKey: 'emails', section: 'comms' },
  { key: 'settings.notifications', label: 'Thông báo email', tabKey: 'notifications', section: 'comms' },
  { key: 'settings.telegram_user', label: 'Bot Telegram khách', tabKey: 'telegram-user', section: 'comms' },
  { key: 'settings.telegram_admin', label: 'Bot Telegram admin', tabKey: 'telegram-admin', section: 'comms' },
  { key: 'settings.account', label: 'Tài khoản', tabKey: 'account', section: 'comms', feature: 'accounts' },
  { key: 'settings.comments', label: 'Bình luận', tabKey: 'comments', section: 'comms', feature: 'blog' },
  // Hệ thống
  { key: 'settings.security', label: 'Bảo mật', tabKey: 'security', section: 'system' },
  { key: 'settings.scripts', label: 'Mã nhúng', tabKey: 'scripts', section: 'system' },
  { key: 'settings.tracking', label: 'Mã theo dõi', tabKey: 'tracking', section: 'system' },
  { key: 'settings.analytics', label: 'Thống kê truy cập', tabKey: 'analytics', section: 'system' },
  { key: 'settings.demo', label: 'Chế độ demo', tabKey: 'demo', section: 'system' },
  { key: 'settings.logging', label: 'Nhật ký lỗi', tabKey: 'logging', section: 'system' },
] as const satisfies readonly SettingPermissionItem[];

/** Danh sách quyền trong hệ thống. "*" = toàn quyền. */
export const PERMISSION_GROUPS = [
  { key: 'admin', label: 'Quản trị', permissions: [{ key: 'admin.access', label: 'Truy cập trang quản trị' }, { key: 'dashboard.view', label: 'Xem tổng quan' }, { key: 'reports.view', label: 'Xem báo cáo website' }] },
  { key: 'users', label: 'Thành viên', permissions: [{ key: 'users.read', label: 'Xem' }, { key: 'users.write', label: 'Thêm / sửa' }, { key: 'users.delete', label: 'Xoá' }, { key: 'users.wallet', label: 'Nạp / trừ ví' }, { key: 'roles.manage', label: 'Quản lý vai trò' }] },
  { key: 'pages', label: 'Trang', permissions: [{ key: 'pages.read', label: 'Xem' }, { key: 'pages.write', label: 'Thêm / sửa' }, { key: 'pages.publish', label: 'Xuất bản' }, { key: 'pages.delete', label: 'Xoá' }] },
  { key: 'posts', label: 'Bài viết', permissions: [{ key: 'posts.read', label: 'Xem' }, { key: 'posts.write', label: 'Thêm / sửa' }, { key: 'posts.publish', label: 'Xuất bản' }, { key: 'posts.delete', label: 'Xoá' }, { key: 'posts.taxonomy', label: 'Quản lý chuyên mục / thẻ' }, { key: 'comments.manage', label: 'Duyệt bình luận' }] },
  {
    key: 'content',
    label: 'Nội dung tuỳ biến',
    permissions: [
      { key: 'entries.read', label: 'Xem' },
      { key: 'entries.write', label: 'Thêm / sửa' },
      { key: 'entries.publish', label: 'Xuất bản' },
      { key: 'entries.delete', label: 'Xoá' },
      { key: 'entries.taxonomy', label: 'Quản lý phân loại (term)' },
      { key: 'content_types.manage', label: 'Khai báo loại nội dung / taxonomy' },
    ],
  },
  // AI Studio: công cụ AI, nguồn cung cấp, tác vụ, gói cước credits, tiếp thị liên kết (modules/ai, credits, affiliate)
  { key: 'ai', label: 'AI Studio', permissions: [{ key: 'ai.tools', label: 'Quản lý công cụ AI' }, { key: 'ai.providers', label: 'Xem nguồn hàng & giá vốn AI' }, { key: 'ai.tasks', label: 'Xem tác vụ AI' }, { key: 'ai.tasks.manage', label: 'Huỷ / hoàn credits tác vụ' }, { key: 'credits.read', label: 'Xem doanh thu & giao dịch credits' }, { key: 'credits.plans', label: 'Quản lý gói cước' }, { key: 'affiliate.manage', label: 'Tiếp thị liên kết (duyệt rút hoa hồng)' }, { key: 'announcements.manage', label: 'Bảng tin (thêm / sửa / xoá thông báo)' }, { key: 'web_menu.manage', label: 'Menu website' }] },
  { key: 'products', label: 'Sản phẩm', permissions: [{ key: 'products.read', label: 'Xem' }, { key: 'products.write', label: 'Thêm / sửa' }, { key: 'products.publish', label: 'Xuất bản' }, { key: 'products.delete', label: 'Xoá' }, { key: 'products.taxonomy', label: 'Danh mục / thương hiệu' }, { key: 'reviews.manage', label: 'Duyệt đánh giá' }] },
  { key: 'orders', label: 'Đơn hàng', permissions: [{ key: 'orders.read', label: 'Xem' }, { key: 'orders.write', label: 'Cập nhật' }, { key: 'coupons.manage', label: 'Mã giảm giá' }, { key: 'payments.read', label: 'Xem giao dịch thanh toán' }] },
  // Kho mã số: key, tài khoản, thẻ... (xem nội dung mã là quyền riêng vì dữ liệu nhạy cảm)
  { key: 'digital_codes', label: 'Kho mã số', permissions: [{ key: 'digital_codes.read', label: 'Xem kho (đã che nội dung)' }, { key: 'digital_codes.manage', label: 'Nhập / sửa / giao / thu hồi mã' }, { key: 'digital_codes.reveal', label: 'Xem nội dung mã' }, { key: 'digital_codes.export', label: 'Xuất mã ra file' }] },
  { key: 'shipments', label: 'Vận đơn', permissions: [{ key: 'shipments.read', label: 'Xem vận đơn' }, { key: 'shipments.write', label: 'Tạo / huỷ vận đơn' }] },
  { key: 'einvoice', label: 'Hoá đơn điện tử', permissions: [{ key: 'einvoice.read', label: 'Xem hoá đơn' }, { key: 'einvoice.write', label: 'Lập / phát hành hoá đơn' }, { key: 'einvoice.cancel', label: 'Huỷ / thay thế / điều chỉnh' }, { key: 'einvoice.settings', label: 'Cấu hình nhà cung cấp HĐĐT' }] },
  { key: 'media', label: 'Media', permissions: [{ key: 'media.read', label: 'Xem' }, { key: 'media.write', label: 'Tải lên / sửa' }, { key: 'media.delete', label: 'Xoá' }] },
  { key: 'blocks', label: 'Block', permissions: [{ key: 'blocks.manage', label: 'Quản lý block' }] },
  { key: 'theme', label: 'Giao diện', permissions: [{ key: 'templates.manage', label: 'Theme Builder & vùng widget' }] },
  { key: 'fields', label: 'Trường tuỳ chỉnh', permissions: [{ key: 'fields.manage', label: 'Quản lý nhóm trường tuỳ chỉnh' }] },
  { key: 'menus', label: 'Menu', permissions: [{ key: 'menus.manage', label: 'Quản lý menu' }] },
  {
    key: 'system',
    label: 'Hệ thống',
    permissions: [
      { key: 'settings.manage', label: 'Cài đặt' },
      ...SETTING_PERMISSIONS,
      { key: 'languages.manage', label: 'Ngôn ngữ' },
      { key: 'seo.manage', label: 'SEO & chuyển hướng' },
      { key: 'activity.read', label: 'Nhật ký hoạt động' },
      { key: 'logs.read', label: 'Xem nhật ký lỗi' },
      { key: 'logs.manage', label: 'Xoá nhật ký lỗi' },
    ],
  },
  // Lưu HTML nguyên văn (block HTML tuỳ chỉnh, nhúng script/iframe bất kỳ...). Không có quyền này thì nội dung
  // bài viết / trang / sản phẩm / Page Builder / trường richtext bị lọc XSS khi lưu (apps/api/src/common/utils/sanitize-html.ts)
  { key: 'html', label: 'HTML nâng cao', permissions: [{ key: 'content.unfiltered_html', label: 'Chèn HTML/JS không lọc' }] },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]['permissions'][number]['key'] | '*';

/**
 * Slug vai trò "Nhà phát triển": toàn quyền như Quản trị viên, và thấy thêm các mục cấu hình kỹ thuật
 * (loại nội dung, trường tuỳ chỉnh, Theme Builder, webhooks, nhật ký lỗi...). Tài khoản giao cho chủ website
 * dùng vai trò "Quản trị viên" nên menu gọn hơn. Chỉ là ẩn giao diện cho đỡ rối, không phải lớp bảo mật.
 */
export const DEVELOPER_ROLE = 'developer';

export const ALL_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));

export const SETTING_PERMISSION_KEYS: Permission[] = SETTING_PERMISSIONS.map((p) => p.key);

/** 12 quyền cài đặt mặc định cho vai trò Cộng tác viên (collaborator) trên mọi website con */
export const CHILD_COLLABORATOR_SETTINGS_PERMISSIONS: Permission[] = [
  'settings.general',
  'settings.contact',
  'settings.appearance',
  'settings.contactButtons',
  'settings.popup',
  'settings.seo',
  'settings.credits',
  'settings.mail',
  'settings.emails',
  'settings.notifications',
  'settings.telegram_user',
  'settings.telegram_admin',
];

export const ALL_SETTINGS_ACCESS_PERMISSIONS: string[] = ['settings.manage', ...SETTING_PERMISSION_KEYS];

const TAB_TO_PERM: Record<string, string> = Object.fromEntries(SETTING_PERMISSIONS.map((p) => [p.tabKey, p.key]));

/** Ánh xạ mã tab của trang /admin/settings sang quyền tương ứng (vd: 'ai-general' -> 'settings.ai_general') */
export function settingTabPermission(tabKey: string): string {
  return TAB_TO_PERM[tabKey] ?? `settings.${tabKey}`;
}

export function hasPermission(userPermissions: readonly string[] | undefined, required: string | string[]): boolean {
  if (!userPermissions) return false;
  if (userPermissions.includes('*')) return true;
  const hasAllSettings = userPermissions.includes('settings.manage');
  const list = Array.isArray(required) ? required : [required];
  return list.every((p) => {
    if (userPermissions.includes(p)) return true;
    // Tương thích ngược: vai trò có 'settings.manage' có đầy đủ quyền trên mọi mục con của Cài đặt & Menu website
    if (hasAllSettings && ((p.startsWith('settings.') && p !== 'settings.manage') || p === 'web_menu.manage')) return true;
    return false;
  });
}

export function hasAnyPermission(userPermissions: readonly string[] | undefined, candidates: readonly string[]): boolean {
  if (!userPermissions) return false;
  if (userPermissions.includes('*')) return true;
  return candidates.some((p) => hasPermission(userPermissions, p));
}
