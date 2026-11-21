import { slugify } from '@cmsnt/shared';

/**
 * Tạo slug duy nhất trong phạm vi (locale) bằng cách thêm hậu tố -2, -3...
 * `exists(slug)` trả về true nếu slug đã bị bản ghi KHÁC sử dụng.
 */
export async function uniqueSlug(source: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  const base = slugify(source) || 'item';
  let slug = base;
  let i = 2;
  while (await exists(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

export { slugify };
