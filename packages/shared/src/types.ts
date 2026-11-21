/** Chuỗi đa ngôn ngữ: { vi: "Xin chào", en: "Hello" } */
export type I18nText = Record<string, string>;

export function t(value: I18nText | string | null | undefined, locale: string, fallback?: string): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return value[locale] ?? (fallback ? value[fallback] : undefined) ?? Object.values(value).find(Boolean) ?? '';
}

/** Một block trong page builder */
export interface BlockNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  /** Cài đặt hiển thị chung: khoảng cách, nền, ẩn theo thiết bị, anchor, class... */
  settings?: BlockSettings;
  /** Dữ liệu động do API gắn vào khi render (sản phẩm, bài viết, form...) */
  resolved?: Record<string, unknown>;
}

export interface BlockSettings {
  anchor?: string;
  className?: string;
  paddingTop?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  paddingBottom?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  background?: string;
  textColor?: string;
  container?: 'default' | 'wide' | 'full' | 'narrow';
  hideOn?: Array<'mobile' | 'tablet' | 'desktop'>;
}

export interface MediaRef {
  id?: string;
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface LinkValue {
  label?: I18nText | string;
  url: string;
  target?: '_self' | '_blank';
}

export interface MenuItemNode {
  id: string;
  label: I18nText;
  /** entry: bài loại nội dung tuỳ biến (refId = id), term: phân loại (refId = id), content_type_archive: trang lưu trữ (refId = key loại) */
  type: 'custom' | 'page' | 'post' | 'product' | 'product_category' | 'post_category' | 'home' | 'entry' | 'term' | 'content_type_archive';
  refId?: string | null;
  url?: string | null;
  target?: '_self' | '_blank';
  icon?: string | null;
  cssClass?: string | null;
  children: MenuItemNode[];
}

export type FormFieldType = 'text' | 'email' | 'tel' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'date' | 'url' | 'hidden' | 'heading' | 'paragraph';

export interface FormFieldDef {
  id: string;
  name: string;
  type: FormFieldType;
  label: I18nText;
  placeholder?: I18nText;
  helpText?: I18nText;
  required?: boolean;
  options?: Array<{ value: string; label: I18nText }>;
  width?: 'full' | 'half' | 'third';
  defaultValue?: string;
  validation?: { min?: number; max?: number; pattern?: string; message?: I18nText };
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}
