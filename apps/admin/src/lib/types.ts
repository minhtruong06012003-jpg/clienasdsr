/** Kiểu dữ liệu dùng chung trong admin (khớp với response của API) */
export interface Media {
  id: string;
  filename: string;
  originalName: string;
  path: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  urls: Record<string, string>;
  alt: Record<string, string>;
  caption: Record<string, string>;
  folderId: string | null;
  createdAt: string;
  uploader?: { id: string; name: string } | null;
}

export interface Language {
  code: string;
  name: string;
  nativeName?: string;
  flag?: string;
  isDefault: boolean;
  enabled: boolean;
  sortOrder: number;
}

export type ContentStatus = 'DRAFT' | 'PUBLISHED' | 'SCHEDULED' | 'ARCHIVED';

export interface SeoFields {
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string | null;
  canonicalUrl?: string | null;
  ogImageId?: string | null;
  noindex?: boolean;
  nofollow?: boolean;
  /** JSON-LD: object hoặc mảng object */
  schemaJson?: Record<string, unknown> | unknown[] | null;
}

export type I18nText = Record<string, string>;
