/**
 * Loại nội dung tuỳ biến (Custom Post Type), phân loại (Taxonomy), Theme Builder, công tắc tính năng,
 * vị trí menu / vùng widget — kiểu dùng chung cho API, admin, blocks và storefront.
 *
 * URL công khai (API tính sẵn vào trường `path`, client không tự ghép):
 *   - lưu trữ loại nội dung:   /{slug loại}            vd /du-an        (/en/projects)
 *   - bài của loại nội dung:   /{slug loại}/{slug bài}  vd /du-an/vinhomes
 *   - lưu trữ một term:        /{slug taxonomy}/{slug term}  vd /linh-vuc/bat-dong-san
 * Slug loại nội dung và taxonomy phải khác nhau và không trùng RESERVED_SLUGS / slug trang.
 */
import type { BlockNode, MediaRef } from './types.js';

// ---------------------------------------------------------------------------- Loại nội dung

/** Tính năng một loại nội dung có thể bật */
export const CONTENT_TYPE_SUPPORTS = ['editor', 'blocks', 'excerpt', 'featuredImage', 'author', 'revisions', 'hierarchical', 'featured', 'order'] as const;
export type ContentTypeSupport = (typeof CONTENT_TYPE_SUPPORTS)[number];

export const CONTENT_TYPE_SUPPORT_LABELS: Record<ContentTypeSupport, string> = {
  editor: 'Trình soạn thảo nội dung',
  blocks: 'Dựng nội dung bằng Page Builder',
  excerpt: 'Mô tả ngắn',
  featuredImage: 'Ảnh đại diện',
  author: 'Tác giả',
  revisions: 'Lịch sử phiên bản',
  hierarchical: 'Bài cha / con (dạng cây)',
  featured: 'Đánh dấu nổi bật',
  order: 'Sắp xếp thủ công',
};

export const CONTENT_TYPE_ORDERS = ['publishedAt_desc', 'publishedAt_asc', 'title_asc', 'sortOrder_asc'] as const;
export type ContentTypeOrder = (typeof CONTENT_TYPE_ORDERS)[number];

/** Nhãn theo locale */
export type TypeLabels = Record<string, { singular: string; plural: string }>;

/** Mã loại nội dung / taxonomy hợp lệ */
export const CONTENT_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * Slug gốc KHÔNG được dùng cho loại nội dung / taxonomy (trùng route lõi của storefront).
 * Lõi thêm route mới phải bổ sung vào đây.
 */
export const RESERVED_SLUGS = [
  'api', 'admin', '_next', 'uploads', 'preview', 'rss.xml', 'sitemap.xml', 'robots.txt',
  'blog', 'products', 'product-category', 'cart', 'checkout', 'account', 'search',
  'order-success', 'order-tracking', 'reset-password', 'verify-email', 'wishlist',
] as const;

/** Loại nội dung (admin) */
export interface ContentTypeView {
  id: string;
  key: string;
  labels: TypeLabels;
  slugs: Record<string, string>;
  description: string | null;
  icon: string;
  supports: ContentTypeSupport[];
  isPublic: boolean;
  hasArchive: boolean;
  searchable: boolean;
  perPage: number;
  orderBy: ContentTypeOrder;
  listColumns: string[];
  source: string;
  isActive: boolean;
  sortOrder: number;
  /** key các taxonomy gắn với loại này */
  taxonomies: string[];
  /** số bài (không tính thùng rác) — chỉ có ở danh sách admin */
  entryCount?: number;
}

/** Loại nội dung rút gọn cho storefront (bootstrap.contentTypes) */
export interface PublicContentType {
  key: string;
  /** nhãn theo locale hiện tại */
  label: string;
  singularLabel: string;
  /** đường dẫn lưu trữ theo locale hiện tại (đã có tiền tố ngôn ngữ), null nếu không public / không có lưu trữ */
  archivePath: string | null;
  /** slug gốc theo từng locale (để storefront dựng alternates) */
  slugs: Record<string, string>;
  supports: ContentTypeSupport[];
  hasArchive: boolean;
  perPage: number;
  taxonomies: string[];
  /** taxonomy hiện làm bộ lọc ở trang lưu trữ (showInFilter), nhãn theo locale hiện tại */
  filters?: { key: string; label: string }[];
}

// ---------------------------------------------------------------------------- Taxonomy

export interface TaxonomyView {
  id: string;
  key: string;
  labels: TypeLabels;
  slugs: Record<string, string>;
  description: string | null;
  hierarchical: boolean;
  contentTypes: string[];
  isPublic: boolean;
  showInFilter: boolean;
  source: string;
  sortOrder: number;
  termCount?: number;
}

/** Term (admin): translations đủ các locale */
export interface TermAdminView {
  id: string;
  taxonomyId: string;
  parentId: string | null;
  imageId: string | null;
  image?: MediaRef | null;
  sortOrder: number;
  customFields: Record<string, unknown>;
  translations: { locale: string; name: string; slug: string; description: string | null; seoTitle: string | null; seoDescription: string | null }[];
  entryCount?: number;
}

/** Term (public) theo một locale */
export interface PublicTerm {
  id: string;
  taxonomy: string;
  parentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  image: MediaRef | null;
  /** /{slug taxonomy}/{slug term} (có tiền tố ngôn ngữ); null nếu taxonomy không public */
  path: string | null;
  count?: number;
  seoTitle?: string | null;
  seoDescription?: string | null;
  customFields?: Record<string, unknown>;
  /** {locale: path} các bản dịch */
  alternates?: Record<string, string>;
}

// ---------------------------------------------------------------------------- Entry

/** Thẻ bài (danh sách, block, liên quan) */
export interface EntryCard {
  id: string;
  type: string;
  title: string;
  slug: string;
  excerpt: string | null;
  featuredImage: MediaRef | null;
  publishedAt: string | null;
  isFeatured: boolean;
  /** /{slug loại}/{slug bài}; null nếu loại không public */
  path: string | null;
  /** term theo taxonomy: { linh_vuc: [{ name, slug, path }] } */
  terms: Record<string, { id: string; name: string; slug: string; path: string | null }[]>;
  /** trường tuỳ chỉnh public (đã trình bày theo locale) — để thẻ hiện giá, vị trí... */
  customFields: Record<string, unknown>;
}

/** Chi tiết bài (public) */
export interface EntryDetail extends EntryCard {
  content: string;
  blocks: BlockNode[];
  parentId: string | null;
  author: { id: string; name: string; avatar: string | null } | null;
  updatedAt: string;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  canonicalUrl: string | null;
  ogImage: MediaRef | null;
  noindex: boolean;
  nofollow: boolean;
  schemaJson: unknown;
  /** nhóm trường để storefront hiển thị theo nhóm (giống post/product) */
  customFieldGroups: { key: string; name: string; fields: { key: string; label: string; type: string }[] }[];
  alternates: Record<string, string>;
  related: EntryCard[];
  /** bài trước / sau trong cùng loại (theo thứ tự mặc định) */
  prev: { title: string; path: string | null } | null;
  next: { title: string; path: string | null } | null;
  /** loại nội dung của bài */
  contentType: PublicContentType;
}

/** Kết quả GET /public/resolve?path=... — storefront dùng cho route catch-all */
export type PublicResolveResult =
  | { kind: 'archive'; contentType: PublicContentType }
  | { kind: 'entry'; contentType: PublicContentType; slug: string }
  | { kind: 'term'; taxonomy: { key: string; label: string; slugs: Record<string, string> }; slug: string }
  | { kind: 'page'; slug: string }
  | { kind: 'none' };

// ---------------------------------------------------------------------------- Theme Builder

/** Loại mẫu giao diện */
export const TEMPLATE_KINDS = ['single', 'archive', 'header', 'footer', 'search', 'not_found'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  single: 'Trang chi tiết',
  archive: 'Trang lưu trữ / danh sách',
  header: 'Header',
  footer: 'Footer',
  search: 'Trang tìm kiếm',
  not_found: 'Trang 404',
};

/**
 * Đối tượng áp dụng: "*" | page | post | product | post_category | post_tag | product_category
 * | entry:<typeKey> | term:<taxonomyKey>
 * - single: page | post | product | entry:<type>
 * - archive: post (trang blog) | product (trang sản phẩm) | post_category | post_tag | product_category | entry:<type> | term:<tax>
 * - header / footer: "*" hoặc bất kỳ target nào ở trên (áp khi đang xem đối tượng đó)
 */
export type TemplateTarget = string;

export interface TemplateConditions {
  /** chỉ áp cho các bản ghi này */
  ids?: string[];
  /** chỉ áp cho bản ghi thuộc một trong các term / chuyên mục / danh mục này */
  termIds?: string[];
  /** loại trừ các bản ghi này */
  excludeIds?: string[];
}

export interface ThemeTemplateView {
  id: string;
  name: string;
  kind: TemplateKind;
  target: TemplateTarget;
  conditions: TemplateConditions;
  priority: number;
  isActive: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
  /** chỉ có ở GET chi tiết: blocks theo locale */
  translations?: { locale: string; blocks: BlockNode[] }[];
}

/** Mẫu đang bật, gửi kèm bootstrap để storefront biết khi nào cần gọi render (không gửi blocks) */
export interface TemplateIndexItem {
  id: string;
  kind: TemplateKind;
  target: TemplateTarget;
  conditions: TemplateConditions;
  priority: number;
}

/**
 * Bản ghi đang hiển thị — ngữ cảnh cho block động (dynamic-title, dynamic-field, query-loop...).
 * API (ThemeTemplatesService) dựng từ page/post/product/entry/term rồi gắn vào `block.resolved`.
 */
export interface TemplateRecord {
  /** page | post | product | entry | post_category | post_tag | product_category | term */
  entity: string;
  /** target của record, vd "entry:project", "post" */
  target: string;
  id: string;
  title: string;
  slug: string;
  path: string | null;
  excerpt: string | null;
  /** HTML (post/entry/product mô tả) */
  content: string | null;
  featuredImage: MediaRef | null;
  gallery?: MediaRef[];
  publishedAt: string | null;
  updatedAt: string | null;
  author: { name: string; avatar: string | null } | null;
  /** term / chuyên mục: { [taxonomyKey | 'category' | 'tag']: [{ name, path }] } */
  terms: Record<string, { name: string; slug: string; path: string | null }[]>;
  customFields: Record<string, unknown>;
  /** sản phẩm: giá hiển thị */
  price?: number | null;
  salePrice?: number | null;
  breadcrumbs: { label: string; path: string | null }[];
}

/** Danh sách đang hiển thị (trang lưu trữ) — ngữ cảnh cho query-loop nguồn "current" */
export interface TemplateListing {
  target: string;
  title: string;
  description: string | null;
  items: (EntryCard | Record<string, unknown>)[];
  /** loại thẻ: entry | post | product */
  itemKind: 'entry' | 'post' | 'product';
  page: number;
  totalPages: number;
  total: number;
  basePath: string | null;
}

/** Kết quả GET /public/theme-templates/render */
export interface RenderedTemplate {
  id: string;
  name: string;
  kind: TemplateKind;
  blocks: BlockNode[];
}

// ---------------------------------------------------------------------------- Công tắc tính năng

/**
 * Bật/tắt cả mảng tính năng theo loại website (Cài đặt › Tính năng, nhóm settings "features", public).
 * Tắt = ẩn menu admin, storefront trả 404 cho route liên quan, API công khai từ chối.
 */
export const FEATURE_KEYS = ['shop', 'blog', 'accounts', 'comments', 'reviews', 'wallet', 'wishlist', 'search'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureFlags = Record<FeatureKey, boolean>;

export const FEATURE_LABELS: Record<FeatureKey, { label: string; description: string }> = {
  shop: { label: 'Bán hàng', description: 'Sản phẩm, giỏ hàng, thanh toán, đơn hàng, vận chuyển, hoá đơn điện tử, mã giảm giá' },
  blog: { label: 'Blog / Tin tức', description: 'Bài viết, chuyên mục, thẻ, RSS' },
  accounts: { label: 'Tài khoản thành viên', description: 'Đăng ký, đăng nhập, trang tài khoản trên website' },
  comments: { label: 'Bình luận', description: 'Bình luận dưới bài viết' },
  reviews: { label: 'Đánh giá sản phẩm', description: 'Khách đánh giá sản phẩm đã mua' },
  wallet: { label: 'Ví thành viên', description: 'Số dư ví, thanh toán bằng ví' },
  wishlist: { label: 'Sản phẩm yêu thích', description: 'Khách lưu sản phẩm yêu thích' },
  search: { label: 'Tìm kiếm', description: 'Trang và ô tìm kiếm trên website' },
};

export const DEFAULT_FEATURES: FeatureFlags = { shop: true, blog: true, accounts: true, comments: true, reviews: true, wallet: true, wishlist: true, search: true };

/** Đọc công tắc từ settings (thiếu khoá = bật, giữ tương thích website cũ) */
export function readFeatures(raw: unknown): FeatureFlags {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<FeatureKey, unknown>>;
  const out = { ...DEFAULT_FEATURES };
  for (const k of FEATURE_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  return out;
}

// ---------------------------------------------------------------------------- Vị trí menu / vùng widget

export interface MenuLocationDef {
  key: string;
  label: string;
  /** core | theme | <key module> (giá trị `plugin:<key>` cũ vẫn có thể còn trong dữ liệu) */
  source?: string;
}

/** Vị trí menu lõi luôn có */
export const CORE_MENU_LOCATIONS: MenuLocationDef[] = [
  { key: 'header', label: 'Menu chính (header)', source: 'core' },
  { key: 'footer', label: 'Menu chân trang', source: 'core' },
  { key: 'footer-2', label: 'Menu chân trang 2', source: 'core' },
  { key: 'mobile', label: 'Menu di động', source: 'core' },
  { key: 'topbar', label: 'Thanh trên cùng', source: 'core' },
];

export interface WidgetAreaDef {
  key: string;
  label: string;
  description?: string;
  source?: string;
}

/**
 * Vùng widget lõi (storefront mặc định đã đặt sẵn). Nội dung mỗi vùng = global block có key
 * `widgetAreaBlockKey(area)` soạn bằng Page Builder (admin › Giao diện › Vùng widget).
 */
export const CORE_WIDGET_AREAS: WidgetAreaDef[] = [
  { key: 'blog-sidebar', label: 'Cột phải blog', description: 'Dưới danh sách chuyên mục ở trang blog / bài viết', source: 'core' },
  { key: 'shop-sidebar', label: 'Cột lọc sản phẩm', description: 'Dưới bộ lọc ở trang danh sách sản phẩm', source: 'core' },
  { key: 'product-after-summary', label: 'Dưới nút mua hàng', description: 'Trang chi tiết sản phẩm, dưới khu vực mua', source: 'core' },
  { key: 'entry-sidebar', label: 'Cột phải nội dung tuỳ biến', description: 'Trang chi tiết loại nội dung tuỳ biến (khi không dùng mẫu Theme Builder)', source: 'core' },
  { key: 'footer-widgets', label: 'Khu widget chân trang', description: 'Phía trên footer trên mọi trang', source: 'core' },
];

/** Key global block chứa nội dung của một vùng widget */
export function widgetAreaBlockKey(area: string): string {
  return `area-${area}`;
}

/** Ghép đường dẫn công khai: tiền tố ngôn ngữ + các đoạn (bỏ đoạn rỗng) */
export function joinPublicPath(locale: string, defaultLocale: string, ...segments: (string | null | undefined)[]): string {
  const prefix = locale && locale !== defaultLocale ? `/${locale}` : '';
  const rest = segments.filter((s): s is string => !!s).join('/');
  return `${prefix}/${rest}` || '/';
}
