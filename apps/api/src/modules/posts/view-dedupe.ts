/**
 * Chống đếm trùng lượt xem đơn giản, lưu trong bộ nhớ tiến trình:
 * cùng một khoá (vd `IP + id bài`) trong cửa sổ `windowMs` chỉ được tính 1 lần.
 *
 * - Giới hạn số khoá `maxKeys` để không phình bộ nhớ khi bị spam nhiều IP/id: vượt ngưỡng thì dọn khoá hết hạn,
 *   vẫn đầy thì bỏ các khoá cũ nhất (Map giữ thứ tự chèn).
 * - Chạy nhiều instance API thì mỗi instance giữ map riêng -> có thể đếm dư tối đa (số instance - 1) lần / cửa sổ;
 *   chấp nhận được với số liệu "lượt xem" (không phải dữ liệu tiền).
 */
export class ViewDeduper {
  /** khoá -> thời điểm (ms) được tính gần nhất */
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = 30 * 60_000,
    private readonly maxKeys = 50_000,
  ) {}

  /** Khoá đã được tính trong cửa sổ hiện tại chưa (không ghi nhận) */
  isDuplicate(key: string, now = Date.now()): boolean {
    const at = this.seen.get(key);
    return at !== undefined && now - at < this.windowMs;
  }

  /** Ghi nhận khoá vừa được tính lượt xem */
  mark(key: string, now = Date.now()): void {
    // xoá rồi chèn lại để khoá mới nhất nằm cuối Map (dọn theo thứ tự cũ -> mới)
    this.seen.delete(key);
    this.seen.set(key, now);
    if (this.seen.size > this.maxKeys) this.prune(now);
  }

  /** Số khoá đang giữ (phục vụ test / theo dõi) */
  get size(): number {
    return this.seen.size;
  }

  /** Dọn khoá hết hạn; nếu vẫn vượt ngưỡng thì bỏ khoá cũ nhất cho tới khi còn ~90% maxKeys */
  private prune(now: number): void {
    for (const [k, at] of this.seen) {
      if (now - at >= this.windowMs) this.seen.delete(k);
    }
    const target = Math.floor(this.maxKeys * 0.9);
    if (this.seen.size <= target) return;
    for (const k of this.seen.keys()) {
      if (this.seen.size <= target) break;
      this.seen.delete(k);
    }
  }
}
