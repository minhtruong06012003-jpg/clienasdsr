/**
 * Gọi API từ server component (trang nội dung CMS: /p/[slug], /blog).
 * Gọi thẳng API_URL (không qua rewrite), cache 60 giây; lỗi mạng / API tắt -> trả { error } để trang tự xử lý.
 */
import { SERVER_API_URL } from "./site";

export type ServerResult<T> = { data: T; status: number } | { data: null; status: number; error: string };

export async function serverGet<T>(path: string, revalidate = 60): Promise<ServerResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  // SSR gọi từ một IP duy nhất -> gửi secret để API miễn giới hạn toàn cục (docs/api-public.md 1.3)
  if (process.env.SERVER_API_SECRET) headers["x-server-secret"] = process.env.SERVER_API_SECRET;
  const bases = [SERVER_API_URL];
  if (SERVER_API_URL.includes(":4317")) bases.push(SERVER_API_URL.replace(":4317", ":4318"));

  let lastStatus = 0;
  let lastError = "Không kết nối được máy chủ nội dung";
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/api${path}`, { headers, next: { revalidate } });
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastStatus = res.status;
        lastError = `Lỗi ${res.status}`;
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = json && typeof json === "object" ? (json as { message?: string | string[] }).message : undefined;
        return { data: null, status: res.status, error: Array.isArray(msg) ? msg.join(". ") : msg || `Lỗi ${res.status}` };
      }
      return { data: json as T, status: res.status };
    } catch {
      /* chuyển sang cổng dự phòng nếu có */
    }
  }
  return { data: null, status: lastStatus, error: lastError };
}
