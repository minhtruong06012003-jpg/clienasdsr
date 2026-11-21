/**
 * Kiểm tra đường dẫn chuyển hướng sau đăng nhập (?next=): chỉ chấp nhận đường dẫn nội bộ
 * để tránh open redirect sang site lạ (vd //evil.com, https://...).
 */
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  const cleanPath = next.split(/[?#]/)[0];
  if (cleanPath === "/login" || cleanPath === "/register") return fallback;
  return next;
}
