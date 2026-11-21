import { DEFAULT_UI_STRINGS } from '@cmsnt/shared';

/**
 * Chuỗi giao diện mặc định của block (storefront có thể ghi đè qua ctx.t).
 * Giữ tên cũ để tương thích; nguồn thật nằm ở DEFAULT_UI_STRINGS của @cmsnt/shared.
 */
export const BLOCK_STRINGS: Record<string, Record<string, string>> = DEFAULT_UI_STRINGS;

/**
 * Tạo hàm dịch cho block.
 * `strings` = bảng đã ghép sẵn (GET /public/ui-strings hoặc `uiStrings` trong /public/bootstrap),
 * gồm cả bản admin dịch cho ngôn ngữ mới; không truyền thì dùng bản có sẵn trong code.
 */
export function blockT(locale: string, strings?: Record<string, string> | null) {
  return (key: string) => strings?.[key] || BLOCK_STRINGS[locale]?.[key] || BLOCK_STRINGS.en[key] || key;
}
