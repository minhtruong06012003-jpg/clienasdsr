/**
 * Trường tuỳ chỉnh (Custom Fields) — kiểu dùng chung cho API, admin, blocks và storefront.
 *
 * Ý tưởng giống Advanced Custom Fields của WordPress nhưng gọn hơn:
 *  - Admin tạo "nhóm trường" (FieldGroup) gắn với một loại nội dung (entity).
 *  - Mỗi nhóm có danh sách trường (CustomFieldDef) và điều kiện hiển thị (FieldGroupRules).
 *  - Giá trị lưu ở cột JSON `customFields` của từng bản ghi: { [fieldKey]: value }.
 *  - Trường `i18n: true` lưu giá trị dạng { vi: "...", en: "..." }; API public tự chọn theo locale.
 */

/** Các loại nội dung có thể gắn trường tuỳ chỉnh */
export const CUSTOM_FIELD_ENTITIES = ['page', 'post', 'product', 'post_category', 'product_category', 'user', 'entry', 'term'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntity, string> = {
  page: 'Trang',
  post: 'Bài viết',
  product: 'Sản phẩm',
  post_category: 'Chuyên mục bài viết',
  product_category: 'Danh mục sản phẩm',
  user: 'Thành viên',
  entry: 'Nội dung tuỳ biến (Custom Post Type)',
  term: 'Phân loại tuỳ biến (Taxonomy)',
};

/** Loại trường hỗ trợ. Giá trị lưu tương ứng ghi ở chú thích. */
export const CUSTOM_FIELD_TYPES = [
  'text', // string
  'textarea', // string
  'richtext', // HTML string
  'number', // number | null
  'boolean', // boolean
  'select', // string (một trong options)
  'multiselect', // string[]
  'date', // "YYYY-MM-DD"
  'datetime', // ISO string
  'color', // "#rrggbb"
  'image', // media id (string) -> public: object media
  'gallery', // media id[] -> public: object media[]
  'file', // media id (mọi loại file) -> public: object media
  'url', // string
  'email', // string
  'link', // { label, url, target }
  'repeater', // object[] theo fields con (1 cấp)
  'products', // product id[] -> public: thẻ sản phẩm rút gọn
  'posts', // post id[] -> public: thẻ bài viết rút gọn
  'pages', // page id[] -> public: { id, title, slug }
  'post_category', // category id -> public: { id, name, slug }
  'product_category', // category id -> public: { id, name, slug }
  'entries', // entry id[] -> public: EntryCard[] (bài của loại nội dung tuỳ biến; options.contentType lọc loại)
  'terms', // term id[] -> public: { id, name, slug, path }[] (options.taxonomy lọc taxonomy)
  'json', // object/array bất kỳ (nâng cao)
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Văn bản ngắn',
  textarea: 'Văn bản dài',
  richtext: 'Soạn thảo (HTML)',
  number: 'Số',
  boolean: 'Bật / tắt',
  select: 'Chọn một',
  multiselect: 'Chọn nhiều',
  date: 'Ngày',
  datetime: 'Ngày giờ',
  color: 'Màu sắc',
  image: 'Ảnh',
  gallery: 'Bộ sưu tập ảnh',
  file: 'Tệp tin',
  url: 'Đường dẫn (URL)',
  email: 'Email',
  link: 'Liên kết (nhãn + URL)',
  repeater: 'Danh sách lặp (repeater)',
  products: 'Chọn sản phẩm',
  posts: 'Chọn bài viết',
  pages: 'Chọn trang',
  post_category: 'Chọn chuyên mục bài viết',
  product_category: 'Chọn danh mục sản phẩm',
  entries: 'Chọn nội dung tuỳ biến',
  terms: 'Chọn phân loại tuỳ biến',
  json: 'JSON (nâng cao)',
};

/** Loại trường có thể bật đa ngôn ngữ (giá trị { vi, en }) */
export const I18N_CAPABLE_TYPES: readonly CustomFieldType[] = ['text', 'textarea', 'richtext', 'link'];

/** Định nghĩa một trường trong nhóm */
export interface CustomFieldDef {
  /** Mã trường: a-z, 0-9, _ ; bắt đầu bằng chữ. Dùng làm key trong customFields và trong theme */
  key: string;
  label: string;
  type: CustomFieldType;
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** Giá trị khác nhau theo ngôn ngữ (chỉ text/textarea/richtext/link) */
  i18n?: boolean;
  /** Cho select / multiselect */
  options?: { value: string; label: string }[];
  /** entries: chỉ cho chọn bài của loại nội dung này (key) */
  contentType?: string;
  /** terms: chỉ cho chọn term của taxonomy này (key) */
  taxonomy?: string;
  default?: unknown;
  /** number: min/max/step; text: độ dài tối đa (max); repeater: số mục tối đa (max) */
  min?: number;
  max?: number;
  step?: number;
  /** textarea/richtext: số dòng gợi ý */
  rows?: number;
  /** Trường con của repeater (không lồng repeater trong repeater) */
  fields?: CustomFieldDef[];
  /** Nhãn mỗi mục repeater lấy từ trường con này */
  itemLabelField?: string;
  /** Chỉ hiện khi trường khác (cùng nhóm) có giá trị tương ứng */
  showIf?: { field: string; equals: unknown | unknown[] };
  /** Chiếm cả hàng hay nửa hàng trong form admin */
  width?: 'full' | 'half';
  /** false = chỉ dùng nội bộ, không trả ra API public (vd ghi chú cho nhân viên) */
  public?: boolean;
}

/** Điều kiện để một nhóm trường hiện trong trang soạn thảo. Mảng rỗng / không có = không ràng buộc. */
export interface FieldGroupRules {
  /** page: bố cục (default, landing...) */
  templates?: string[];
  /** post / product: thuộc một trong các danh mục này */
  categoryIds?: string[];
  /** product: SIMPLE | VARIABLE | DIGITAL */
  productTypes?: string[];
  /** user: slug vai trò */
  roleSlugs?: string[];
  /** entry: key loại nội dung (bắt buộc nên chọn, rỗng = mọi loại) */
  contentTypes?: string[];
  /** term: key taxonomy */
  taxonomies?: string[];
}

export type FieldGroupPlacement = 'main' | 'sidebar';

/** Nhóm trường (bản ghi field_groups hoặc nhóm khai báo sẵn trong code của module) */
export interface FieldGroupDef {
  id?: string;
  key: string;
  name: string;
  description?: string | null;
  entity: CustomFieldEntity;
  fields: CustomFieldDef[];
  rules?: FieldGroupRules;
  placement?: FieldGroupPlacement;
  sortOrder?: number;
  isActive?: boolean;
  /** 'db' = tạo trong admin; khác = key module khai báo trong code (chỉ đọc trong admin) */
  source?: string;
}

/** Ngữ cảnh bản ghi đang soạn, để lọc nhóm theo rules */
export interface CustomFieldContext {
  template?: string | null;
  categoryIds?: string[] | null;
  productType?: string | null;
  roleSlug?: string | null;
  /** entry: key loại nội dung */
  contentType?: string | null;
  /** term: key taxonomy */
  taxonomy?: string | null;
}

/** Nhóm trường có áp dụng cho bản ghi này không (theo rules) */
export function fieldGroupApplies(rules: FieldGroupRules | null | undefined, ctx: CustomFieldContext | null | undefined): boolean {
  if (!rules) return true;
  const c = ctx ?? {};
  if (rules.templates?.length && !rules.templates.includes(c.template ?? 'default')) return false;
  if (rules.categoryIds?.length && !rules.categoryIds.some((id) => (c.categoryIds ?? []).includes(id))) return false;
  if (rules.productTypes?.length && !rules.productTypes.includes(c.productType ?? 'SIMPLE')) return false;
  if (rules.roleSlugs?.length && !rules.roleSlugs.includes(c.roleSlug ?? '')) return false;
  if (rules.contentTypes?.length && !rules.contentTypes.includes(c.contentType ?? '')) return false;
  if (rules.taxonomies?.length && !rules.taxonomies.includes(c.taxonomy ?? '')) return false;
  return true;
}

/** Mã trường / mã nhóm hợp lệ */
export const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Chuyển nhãn bất kỳ thành mã trường hợp lệ (bỏ dấu tiếng Việt, khoảng trắng -> _) */
export function toCustomFieldKey(label: string): string {
  const base = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  const key = /^[a-z]/.test(base) ? base : base ? `f_${base}` : '';
  return key.slice(0, 64);
}

/** Giá trị trống mặc định theo loại trường (dùng khi tạo bản ghi mới / thêm mục repeater) */
export function emptyCustomFieldValue(def: CustomFieldDef): unknown {
  if (def.default !== undefined) return def.default;
  switch (def.type) {
    case 'boolean':
      return false;
    case 'number':
      return null;
    case 'multiselect':
    case 'gallery':
    case 'repeater':
    case 'products':
    case 'posts':
    case 'pages':
    case 'entries':
    case 'terms':
      return [];
    case 'link':
      return { label: '', url: '', target: '_self' };
    case 'image':
    case 'file':
    case 'post_category':
    case 'product_category':
    case 'json':
      return null;
    default:
      return def.i18n ? {} : '';
  }
}

/** Kiểm tra điều kiện showIf của một trường với dữ liệu hiện tại */
export function customFieldVisible(def: CustomFieldDef, values: Record<string, unknown> | null | undefined): boolean {
  if (!def.showIf) return true;
  const v = values?.[def.showIf.field];
  return Array.isArray(def.showIf.equals) ? def.showIf.equals.includes(v) : v === def.showIf.equals;
}

/** Định nghĩa nhóm trả ra API public (đã bỏ trường nội bộ) để theme render nhãn */
export interface PublicFieldGroup {
  key: string;
  name: string;
  placement: FieldGroupPlacement;
  fields: { key: string; label: string; type: CustomFieldType; options?: { value: string; label: string }[]; fields?: { key: string; label: string; type: CustomFieldType }[] }[];
}
