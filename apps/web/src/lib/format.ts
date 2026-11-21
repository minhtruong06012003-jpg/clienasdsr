/**
 * Tiện ích số thuần (không phụ thuộc ngôn ngữ).
 * Định dạng tiền / số / thời gian theo ngôn ngữ, tiền tệ, múi giờ khách chọn: dùng `useI18n().fmt` (lib/i18n/formatters).
 */

/** Chuyển giá trị API (số hoặc chuỗi Decimal) sang number, giá trị lỗi -> 0 */
export function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Đếm số dòng không rỗng (số lượng của dịch vụ bình luận tuỳ chỉnh) */
export function countLines(text: string): number {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
}
