// Hằng màu biểu đồ dùng chung — file thuần (không import recharts) nên import tĩnh được ở mọi trang
// mà không làm phình bundle; component biểu đồ thật nằm ở charts.tsx (nạp động khi cần).

/**
 * Bảng màu biểu đồ (đã kiểm tra bằng validator của skill dataviz ở cả 2 chế độ):
 * sáng = token --chart-1..5 của dự án; tối = cùng tông nhưng hạ độ sáng để đạt tương phản 3:1 trên nền tối.
 * Thứ tự cố định theo thực thể, không xoay vòng; quá 5 mục -> gộp "Khác" (xám).
 */
export const VIZ_CLASS =
  '[--viz-1:#2165ec] [--viz-2:#15ba81] [--viz-3:#ed990e] [--viz-4:#9b61ea] [--viz-5:#f14d4c] [--viz-other:#9ca3af] ' +
  'dark:[--viz-1:#3b82f6] dark:[--viz-2:#00a76f] dark:[--viz-3:#cb7f00] dark:[--viz-4:#a76ef8] dark:[--viz-5:#e54c4a] dark:[--viz-other:#6b7280]';

export const SERIES_COLORS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)'] as const;
export const OTHER_COLOR = 'var(--viz-other)';
