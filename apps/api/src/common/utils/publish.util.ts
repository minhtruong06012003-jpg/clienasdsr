/**
 * Ngày xuất bản khi lưu: có ngày -> dùng ngày đó (tương lai = hẹn giờ);
 * trạng thái PUBLISHED mà không có ngày -> giữ ngày cũ hoặc lấy thời điểm hiện tại.
 */
export function resolvePublishedAt(input: string | null | undefined, status: string | undefined, existing: Date | null | undefined): Date | null | undefined {
  if (input) return new Date(input);
  if (status === 'PUBLISHED' || status === 'SCHEDULED') return existing ?? (status === 'PUBLISHED' ? new Date() : null);
  return input === null ? null : undefined;
}

/**
 * Điều kiện nội dung đang hiển thị công khai (gồm cả nội dung hẹn giờ đã tới giờ).
 * Dùng chung cho Page/Post/Product (cùng cấu trúc status + publishedAt).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function publishedCondition(): { OR: any[] } {
  const now = new Date();
  return {
    OR: [
      { status: 'PUBLISHED', OR: [{ publishedAt: null }, { publishedAt: { lte: now } }] },
      { status: 'SCHEDULED', publishedAt: { lte: now } },
    ],
  };
}
