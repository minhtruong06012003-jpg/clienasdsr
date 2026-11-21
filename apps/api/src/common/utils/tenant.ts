import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Web con: dùng chung code và bản build với web chính nhưng DB, env, tiến trình riêng (do novai-hub tạo, TENANT_ROLE=child).
 * Web con dùng chung khoá nhà cung cấp AI và cổng thanh toán của web chính nên các cấu hình đó bị khoá với admin web con.
 */
export const isChildSite = () => process.env.TENANT_ROLE === 'child';

/**
 * Ẩn toàn bộ tên / link / mã tác vụ / giá vốn của các nhà cung cấp AI đầu nguồn:
 * - Bắt buộc ẩn 100% trên mọi Web con (kể cả khi mở qua khung quản trị của Hub `hub.nov.ai.vn/sites/<code>` lẫn CTV đăng nhập `/admin`).
 * - Trên Web chính: chỉ hiển thị cho Siêu quản trị (`*`) hoặc vai trò có quyền quản lý công cụ nguồn (`ai.tools`); ẩn với mọi CTV / nhân sự chỉ xem.
 */
export const shouldHideAiProviders = (user?: { permissions?: string[] } | null): boolean => {
  if (isChildSite()) return true;
  const perms = user?.permissions ?? [];
  return !(perms.includes('*') || perms.includes('ai.providers'));
};

/** Vé đăng nhập một chạm từ Hub đã dùng (chống dùng lại trong thời hạn vé) */
const usedHubTickets = new Map<string, number>();

/**
 * Vé đăng nhập admin web con do novai-hub ký: `base64url(JSON { e: email, x: hạn (giây epoch), n: nonce }).base64url(HMAC-SHA256)`
 * bằng khoá HUB_SSO_SECRET riêng của web con (chỉ Hub và env.json của web con có). Web chính không có khoá -> luôn null.
 * Trả email khi vé đúng chữ ký, còn hạn và chưa dùng.
 */
export function verifyHubTicket(ticket: string): string | null {
  const secret = process.env.HUB_SSO_SECRET ?? '';
  if (!isChildSite() || secret.length < 32 || typeof ticket !== 'string') return null;
  const [body, sig] = ticket.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  let p: { e?: string; x?: number; n?: string };
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!p.e || !p.n || !p.x || p.x < now || p.x > now + 300) return null;
  for (const [n, exp] of usedHubTickets) if (exp < now) usedHubTickets.delete(n);
  if (usedHubTickets.has(p.n)) return null;
  usedHubTickets.set(p.n, p.x);
  return p.e.toLowerCase();
}
