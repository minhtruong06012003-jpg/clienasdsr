/**
 * Mã giới thiệu (affiliate): khách mở link `/?ref=CODE` -> lưu localStorage 30 ngày,
 * form đăng ký gửi kèm `referralCode` (API bỏ qua trường lạ nếu chưa hỗ trợ — ValidationPipe whitelist).
 */
const KEY = "smm_ref";
const TTL = 30 * 24 * 3600 * 1000;

export function saveReferral(code: string) {
  const c = code.trim().slice(0, 64);
  if (!c) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ code: c, at: Date.now() }));
  } catch {
    /* storage bị chặn */
  }
}

export function readReferral(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { code?: string; at?: number };
    if (!v.code || !v.at || Date.now() - v.at > TTL) return null;
    return v.code;
  } catch {
    return null;
  }
}
