/**
 * Sinh UUID v4 chạy được cả ngoài secure context (admin mở qua http://IP nội bộ):
 * crypto.randomUUID chỉ có trên HTTPS/localhost, nên lần lượt thử
 * randomUUID → crypto.getRandomValues (tự dựng UUID v4) → Date.now + Math.random (dự phòng cuối).
 */
export function uuid(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // không phải secure context -> thử cách sau
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else {
    // dự phòng cuối: trộn thời gian hiện tại với Math.random (đủ dùng làm khoá chống trùng)
    const seed = Date.now();
    for (let i = 0; i < 16; i++) bytes[i] = (Math.floor(Math.random() * 256) ^ (seed >> ((i % 6) * 8))) & 0xff;
  }
  // đặt bit phiên bản (4) và biến thể (10xx) theo RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
