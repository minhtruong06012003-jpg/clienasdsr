import type { ComponentType, ReactNode } from 'react';
import type { BlockNode, BlockSettings, MediaRef } from '@cmsnt/shared';

export type { BlockNode, BlockSettings, MediaRef };

/** Kiểu trường để Page Builder tự sinh form chỉnh sửa */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'number'
  | 'select'
  | 'boolean'
  | 'color'
  | 'image'
  | 'images'
  | 'url'
  | 'icon'
  | 'repeater'
  | 'products'
  | 'product-category'
  | 'product-categories'
  | 'post-category'
  | 'global-block'
  | 'code'
  /** chọn loại nội dung tuỳ biến (giá trị = key, vd "project") */
  | 'content-type'
  /** chọn taxonomy (giá trị = key) */
  | 'taxonomy'
  /** chọn term của taxonomy ở field `taxonomyField` (giá trị = id[]) */
  | 'terms'
  /** nhập / gợi ý mã trường tuỳ chỉnh (giá trị = key) */
  | 'custom-field-key'
  /** chọn vùng giao diện riêng của storefront cho block "storefront-slot" (giá trị = tên slot) */
  | 'storefront-slot';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Trường con của repeater */
  fields?: FieldDef[];
  /** Nhãn của 1 item repeater, vd lấy theo field "title" */
  itemLabelField?: string;
  min?: number;
  max?: number;
  default?: unknown;
  /** type "terms": tên field chứa key taxonomy (vd "taxonomy") */
  taxonomyField?: string;
  /** Chỉ hiển thị khi điều kiện đúng */
  showIf?: { field: string; equals: unknown | unknown[] };
}

export type BlockCategory = 'layout' | 'content' | 'media' | 'commerce' | 'marketing' | 'advanced';

export interface BlockDefinition<D = Record<string, any>> {
  type: string;
  label: string;
  description?: string;
  /** tên icon lucide (kebab-case) để hiển thị trong thư viện block */
  icon: string;
  category: BlockCategory;
  fields: FieldDef[];
  defaults: D;
  /** Cài đặt section mặc định khi thêm block */
  defaultSettings?: BlockSettings;
  component: ComponentType<BlockProps<D>>;
}

export interface LinkProps {
  href: string;
  className?: string;
  children?: ReactNode;
  target?: string;
  rel?: string;
  'aria-label'?: string;
}

export interface ImageProps {
  src: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  className?: string;
  sizes?: string;
  priority?: boolean;
  fill?: boolean;
}

/** Ngữ cảnh render: storefront và admin truyền vào cách render link, ảnh, giá... */
export interface RenderContext {
  locale: string;
  defaultLocale: string;
  /** 'edit' = đang ở Page Builder (cho phép sửa trực tiếp trên giao diện) */
  mode: 'view' | 'edit';
  apiUrl: string;
  formatPrice: (value: number) => string;
  /** Thêm tiền tố ngôn ngữ vào đường dẫn nội bộ */
  href: (path: string) => string;
  Link: ComponentType<LinkProps>;
  Image: ComponentType<ImageProps>;
  /** Nút thêm vào giỏ (storefront cung cấp). Không có -> chỉ hiện link sản phẩm */
  AddToCart?: ComponentType<{ productId: string; type: string; slug: string; /** sản phẩm có ô khách phải nhập khi mua -> nút thành link tới trang sản phẩm */ hasPurchaseFields?: boolean }>;
  /** Chuỗi giao diện đã dịch */
  t: (key: string) => string;
  /** Render danh sách block lồng nhau (global block, columns) */
  renderBlocks?: (blocks: BlockNode[]) => ReactNode;
  /**
   * Render vùng chức năng có sẵn của storefront cho block "storefront-slot" (bộ ảnh sản phẩm, nút mua,
   * bình luận...). Storefront cung cấp theo bản ghi đang xem; trả null/undefined = không hiển thị được ở đây.
   * Admin (Page Builder) không truyền -> block hiện ô giữ chỗ.
   */
  renderSlot?: (slot: string, block: BlockNode) => ReactNode;
}

export interface BlockProps<D = Record<string, any>> {
  block: BlockNode;
  data: D;
  resolved: Record<string, any>;
  ctx: RenderContext;
}
