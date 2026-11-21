import { ALL_SETTINGS_ACCESS_PERMISSIONS, type FeatureKey } from '@cmsnt/shared';
import {
  BarChart3,
  Megaphone,
  MessageSquareText,
  Bot,
  Coins,
  Gift,
  Globe,
  Sparkles,
  Wallet,
  Boxes,
  PanelLeft,
  PanelsTopLeft,
  LayoutDashboard,
  Blocks,
  FilePlus2,
  Gauge,
  Image,
  Languages,
  LayoutTemplate,
  ListTree,
  type LucideIcon,
  Newspaper,
  Package,
  PackagePlus,
  PenSquare,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  TicketPercent,
  TrendingUp,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';

/** Số đếm việc cần xử lý (API /admin/dashboard/badges) hiện cạnh menu */
export type BadgeKey = 'pendingOrders' | 'pendingReviews' | 'pendingComments' | 'einvoiceNeedsAction' | 'newErrors' | 'digitalCodesAttention' | 'openTickets';
export type Badges = Partial<Record<BadgeKey, number>>;

export interface NavItem {
  title: string;
  href: string;
  icon?: LucideIcon;
  /** Cần quyền này để thấy menu. Mảng = cần MỘT TRONG các quyền */
  permission?: string | string[];
  /** Từ khoá phụ cho ô Tìm nhanh (Ctrl/⌘ K) */
  keywords?: string;
  badge?: BadgeKey;
  /** Ẩn khi mảng tính năng này bị tắt (Cài đặt › Tính năng) */
  feature?: FeatureKey;
  /**
   * Mục cấu hình kỹ thuật, chỉ vai trò "Nhà phát triển" thấy (chủ website dùng "Quản trị viên" sẽ không thấy,
   * vào thẳng URL cũng bị chuyển về Bảng điều khiển). Muốn khách thấy lại mục nào thì bỏ cờ này.
   */
  devOnly?: boolean;
  /** Chỉ hiện trên menu của các Website con (ẩn khỏi thanh menu của Web chính nov.ai.vn) */
  childOnly?: boolean;
  /** Chỉ hiện trên menu của Web chính nov.ai.vn (ẩn khỏi thanh menu của mọi Website con) */
  mainOnly?: boolean;
  /**
   * Ẩn khỏi menu / Tìm nhanh vì website AI hiện tại không dùng (web khách là Next.js tự dựng,
   * không đọc Theme Builder, widget, menu CMS...). Trang vẫn còn, vào thẳng URL được; bỏ cờ này để hiện lại.
   */
  hidden?: boolean;
  children?: NavItem[];
}

export interface NavGroup {
  label: string;
  /** Ẩn cả nhóm khi tính năng bị tắt */
  feature?: FeatureKey;
  /** Ẩn cả nhóm (xem NavItem.hidden) */
  hidden?: boolean;
  items: NavItem[];
}

/** Menu sắp theo công việc hằng ngày của chủ shop: bán hàng → nội dung → giao diện → hệ thống */
export const NAV: NavGroup[] = [
  {
    label: 'Tổng quan',
    items: [
      { title: 'Bảng điều khiển', href: '/dashboard', icon: Gauge, permission: 'dashboard.view', keywords: 'dashboard trang chu thong ke doanh thu' },
      { title: 'Lợi nhuận', href: '/profit', icon: TrendingUp, childOnly: true, permission: ['dashboard.view', 'payments.read'], keywords: 'loi nhuan hoa hong ctv tien nap chiet khau' },
      {
        // Báo cáo website (truy cập, nội dung, thành viên...) + báo cáo bán hàng — đã chuyển thẻ Thành viên sang Bảng điều khiển và ẩn khỏi menu
        title: 'Báo cáo',
        href: '/reports',
        icon: BarChart3,
        hidden: true,
        permission: ['reports.view', 'orders.read'],
        keywords: 'bao cao thong ke analytics report',
        children: [
          { title: 'Tổng quan website', href: '/reports', permission: 'reports.view', keywords: 'bao cao thong ke truy cap luot xem analytics' },
          { title: 'Bán hàng', href: '/reports/sales', permission: 'orders.read', feature: 'shop', keywords: 'bao cao doanh thu report' },
        ],
      },
    ],
  },
  {
    // AI Studio: vận hành sản phẩm & đơn chạy AI hằng ngày
    label: 'AI Studio',
    items: [
      { title: 'Tác vụ AI', href: '/ai/tasks', icon: Sparkles, permission: 'ai.tasks', keywords: 'tac vu ai video anh giong noi lich su tao task' },
      { title: 'Công cụ AI', href: '/ai/tools', icon: Bot, permission: 'ai.tools', keywords: 'cong cu ai gia tien credits nhom model' },
      { title: 'Nhà cung cấp API', href: '/ai/providers', icon: Server, mainOnly: true, permission: 'ai.providers', keywords: 'nha cung cap api nguon ai key khoa api so du ti gia sv1 sv2 sv3 sv4 sv5 sv6 sv7 sv8 sv9 sv10 sv11 sv12 sv13 sv14' },
      { title: 'Cộng đồng', href: '/ai/community', icon: Globe, permission: ['ai.tasks.manage', 'ai.tools'], keywords: 'cong dong community video anh duyet ghim trang chu showcase' },
    ],
  },
  {
    // Tài chính & Đối tác: giao dịch thanh toán, cấu hình gói nạp, hoa hồng giới thiệu, đại lý site con
    label: 'Tài chính & Đối tác',
    items: [
      { title: 'Giao dịch thanh toán', href: '/orders/payments', icon: Wallet, permission: 'payments.read', keywords: 'thanh toan payment chuyen khoan web2m qr goi cuoc nap vi' },
      { title: 'Gói nạp tiền', href: '/ai/plans', icon: Coins, permission: ['credits.plans', 'credits.read'], keywords: 'goi nap tien vi credits bang gia doanh thu mua goi' },
      { title: 'Tiếp thị liên kết', href: '/ai/affiliate', icon: Gift, permission: 'affiliate.manage', keywords: 'affiliate gioi thieu hoa hong rut tien' },
      { title: 'Website con', href: '/ai/child-panels', icon: Globe, devOnly: true, permission: 'settings.manage', keywords: 'website con child panel dai ly doi tac' },
      { title: 'Lợi nhuận', href: '/ai/child-profit', icon: TrendingUp, mainOnly: true, devOnly: true, permission: 'settings.manage', keywords: 'loi nhuan web con ctv hoa hong tien nap chiet khau child profit' },
    ],
  },
  {
    // Hỗ trợ & Nội dung: chăm sóc khách hàng, thông báo bảng tin, menu thanh trái, trang tĩnh & media
    label: 'Hỗ trợ & Nội dung',
    items: [
      { title: 'Ticket hỗ trợ', href: '/ai/tickets', icon: MessageSquareText, badge: 'openTickets', permission: ['ai.tasks', 'users.read'], keywords: 'ticket ho tro khach hang khieu nai bao loi don support' },
      { title: 'Bảng tin', href: '/ai/announcements', icon: Megaphone, permission: 'announcements.manage', keywords: 'bang tin thong bao cap nhat tin tuc announcement' },
      { title: 'Menu website', href: '/web-menu', icon: PanelLeft, permission: ['web_menu.manage', 'settings.general', 'settings.appearance'], keywords: 'menu website sidebar dieu huong thanh ben trai khach' },
      { title: 'Trang', href: '/pages', icon: LayoutTemplate, permission: 'pages.read', keywords: 'page builder landing' },
      {
        title: 'Bài viết',
        href: '/posts',
        icon: Newspaper,
        hidden: true,
        feature: 'blog',
        permission: ['posts.read', 'posts.taxonomy', 'comments.manage'],
        badge: 'pendingComments',
        children: [
          { title: 'Tất cả bài viết', href: '/posts', permission: 'posts.read', keywords: 'blog tin tuc post' },
          { title: 'Viết bài mới', href: '/posts/new', permission: 'posts.write' },
          { title: 'Chuyên mục', href: '/posts/categories', permission: 'posts.taxonomy', keywords: 'category' },
          { title: 'Thẻ', href: '/posts/tags', permission: 'posts.taxonomy', keywords: 'tag' },
          { title: 'Bình luận', href: '/posts/comments', permission: 'comments.manage', badge: 'pendingComments', keywords: 'comment binh luan duyet spam' },
        ],
      },
      { title: 'Loại nội dung', href: '/content-types', icon: Boxes, devOnly: true, hidden: true, permission: 'content_types.manage', keywords: 'custom post type cpt loai noi dung taxonomy phan loai du an dich vu tuyen dung' },
      { title: 'Thư viện media', href: '/media', icon: Image, permission: 'media.read', keywords: 'anh hinh video upload file' },
    ],
  },
  {
    label: 'Bán hàng',
    feature: 'shop',
    items: [
      {
        title: 'Đơn hàng',
        href: '/orders',
        icon: ShoppingCart,
        permission: ['orders.read', 'payments.read', 'coupons.manage', 'einvoice.read', 'shipments.read'],
        badge: 'pendingOrders',
        children: [
          { title: 'Tất cả đơn hàng', href: '/orders', permission: 'orders.read', badge: 'pendingOrders', keywords: 'don hang order' },
          { title: 'Vận đơn', href: '/orders/shipments', permission: 'shipments.read', keywords: 'van don shipping ghn ghtk viettel post giao hang shipment' },
          { title: 'Giao dịch thanh toán', href: '/orders/payments', permission: 'payments.read', keywords: 'thanh toan payment chuyen khoan web2m' },
          { title: 'Nạp thẻ cào', href: '/orders/card-topups', permission: 'payments.read', keywords: 'nap the cao card topup doi the viettel mobifone vinaphone card24h thesieure' },
          { title: 'Giỏ hàng bỏ dở', href: '/orders/abandoned-carts', permission: 'orders.read', keywords: 'gio hang bo do abandoned cart nhac email khoi phuc' },
          { title: 'Hoá đơn điện tử', href: '/orders/einvoices', permission: 'einvoice.read', badge: 'einvoiceNeedsAction', keywords: 'hoa don dien tu einvoice vat thue' },
          { title: 'Mã giảm giá', href: '/orders/coupons', permission: 'coupons.manage', keywords: 'coupon voucher khuyen mai' },
        ],
      },
      {
        title: 'Sản phẩm',
        href: '/products',
        icon: Package,
        permission: ['products.read', 'products.taxonomy', 'reviews.manage'],
        badge: 'pendingReviews',
        children: [
          { title: 'Tất cả sản phẩm', href: '/products', permission: 'products.read', keywords: 'san pham product' },
          { title: 'Thêm sản phẩm', href: '/products/new', permission: 'products.write' },
          { title: 'Danh mục', href: '/products/categories', permission: 'products.taxonomy', keywords: 'category' },
          { title: 'Thương hiệu', href: '/products/brands', permission: 'products.taxonomy', keywords: 'brand' },
          { title: 'Kho mã số', href: '/digital-codes', permission: 'digital_codes.read', badge: 'digitalCodesAttention', keywords: 'kho ma key ban quyen tai khoan acc game the cao gift card license serial' },
          { title: 'Thuộc tính', href: '/products/attributes', permission: 'products.taxonomy', keywords: 'attribute mau sac size kich co bien the swatch' },
          { title: 'Đánh giá', href: '/products/reviews', permission: 'reviews.manage', badge: 'pendingReviews', keywords: 'review binh luan sao' },
        ],
      },
    ],
  },
  {
    // web khách không dùng Theme Builder / widget / menu / block / trường tuỳ chỉnh của CMS -> ẩn cả nhóm
    label: 'Giao diện',
    hidden: true,
    items: [
      // Theme Builder: mẫu trang chi tiết / lưu trữ / header / footer dựng bằng Page Builder
      { title: 'Theme Builder', href: '/theme-builder', icon: PanelsTopLeft, devOnly: true, permission: 'templates.manage', keywords: 'theme builder mau giao dien template single archive header footer elementor' },
      { title: 'Vùng widget', href: '/widget-areas', icon: LayoutDashboard, devOnly: true, permission: 'templates.manage', keywords: 'widget sidebar cot phai vung' },
      { title: 'Menu điều hướng', href: '/menus', icon: ListTree, permission: 'menus.manage', keywords: 'menu header footer' },
      { title: 'Block dùng chung', href: '/blocks', icon: Blocks, permission: 'blocks.manage', keywords: 'global block header footer' },
      // Trường tuỳ chỉnh (giống ACF): nhóm trường gắn vào trang / bài viết / sản phẩm / danh mục / thành viên
      { title: 'Trường tuỳ chỉnh', href: '/custom-fields', icon: SlidersHorizontal, devOnly: true, permission: 'fields.manage', keywords: 'custom field acf truong tuy chinh meta thuoc tinh khoa hoc tai khoan' },
    ],
  },
  {
    label: 'Hệ thống',
    items: [
      {
        title: 'Thành viên',
        href: '/users',
        icon: Users,
        permission: 'users.read',
        children: [
          { title: 'Tất cả thành viên', href: '/users', permission: 'users.read', keywords: 'user khach hang nhan vien' },
          { title: 'Vai trò & quyền', href: '/users/roles', permission: 'roles.manage', keywords: 'role phan quyen' },
        ],
      },
      { title: 'Cài đặt', href: '/settings', icon: Settings, permission: ALL_SETTINGS_ACCESS_PERMISSIONS, keywords: 'setting logo lien he smtp email thanh toan web2m ma theo doi nut lien he' },
      // Trung tâm bảo mật: điểm bảo mật, nhật ký đăng nhập, chặn / cho phép IP
      { title: 'Bảo mật', href: '/security', icon: ShieldCheck, permission: 'settings.security', keywords: 'bao mat security ip chan dang nhap login brute force 2fa' },
      { title: 'SEO', href: '/seo', icon: Search, hidden: true, permission: 'seo.manage', keywords: 'redirect chuyen huong sitemap' },
      { title: 'Ngôn ngữ', href: '/languages', icon: Languages, devOnly: true, permission: 'languages.manage', keywords: 'language da ngon ngu' },
      { title: 'Công cụ', href: '/tools', icon: Wrench, devOnly: true, hidden: true, permission: 'settings.manage', keywords: 'xuat nhap export import backup sao luu storefront giao dien' },
      // Nhật ký hệ thống: một trang nhiều tab (hoạt động, số dư, mã giảm giá, đăng nhập, email, lỗi).
      // Thấy menu khi có quyền xem ít nhất một tab; badge = số lỗi mới (tab Lỗi chỉ dành cho Nhà phát triển)
      {
        title: 'Nhật ký hệ thống',
        href: '/system-logs',
        icon: ScrollText,
        permission: ['activity.read', 'users.read', 'payments.read', 'coupons.manage', 'settings.manage', 'settings.security', 'settings.emails', 'settings.mail', 'logs.read'],
        badge: 'newErrors',
        keywords: 'nhat ky log lich su hoat dong so du vi giao dich thanh toan payment nap the cao card topup webhook callback ma giam gia coupon dang nhap email loi error exception bug debug laravel',
      },
    ],
  },
];

/** Đường dẫn các mục devOnly (kể cả trang con, vd /custom-fields/123) — layout chặn khi không phải Nhà phát triển */
export const DEV_ONLY_PATHS: string[] = NAV.flatMap((g) => g.items.flatMap((i) => [i, ...(i.children ?? [])])).filter((i) => i.devOnly).map((i) => i.href);

/** Đường dẫn có thuộc mục chỉ dành cho Nhà phát triển không */
export const isDevOnlyPath = (pathname: string) => DEV_ONLY_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** Tạo nhanh (nút "+ Tạo mới" và ô Tìm nhanh) */
export const QUICK_CREATE: NavItem[] = [
  { title: 'Sản phẩm mới', href: '/products/new', icon: PackagePlus, permission: 'products.write', feature: 'shop' },
  { title: 'Bài viết mới', href: '/posts/new', icon: PenSquare, hidden: true, permission: 'posts.write', feature: 'blog' },
  { title: 'Trang mới', href: '/pages/new', icon: FilePlus2, permission: 'pages.write' },
  { title: 'Mã giảm giá', href: '/orders/coupons?new=1', icon: TicketPercent, permission: 'coupons.manage', feature: 'shop' },
  { title: 'Thành viên mới', href: '/users/new', icon: UserPlus, permission: 'users.write' },
];
