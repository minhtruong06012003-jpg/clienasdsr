/** Kiểu nội dung có URL công khai trên storefront. */
export type ContentType = 'page' | 'post' | 'post_category' | 'post_tag' | 'product' | 'product_category' | 'home';

export const ROUTE_PREFIX: Record<Exclude<ContentType, 'page' | 'home'>, string> = {
  post: 'blog',
  post_category: 'blog/category',
  post_tag: 'blog/tag',
  product: 'products',
  product_category: 'product-category',
};

/**
 * Dựng đường dẫn công khai. Ngôn ngữ mặc định không có tiền tố,
 * ngôn ngữ khác có dạng /en/...
 */
export function buildPath(type: ContentType, slug: string | null | undefined, locale: string, defaultLocale: string): string {
  const prefix = locale && locale !== defaultLocale ? `/${locale}` : '';
  if (type === 'home' || (type === 'page' && !slug)) return prefix || '/';
  if (type === 'page') return `${prefix}/${slug}`;
  return `${prefix}/${ROUTE_PREFIX[type]}/${slug}`;
}

export function localePrefix(locale: string, defaultLocale: string): string {
  return locale && locale !== defaultLocale ? `/${locale}` : '';
}
