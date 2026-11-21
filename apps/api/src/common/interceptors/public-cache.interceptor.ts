import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/**
 * Endpoint public NHƯNG cá nhân hoá theo người gọi -> luôn `private, no-store` (CDN / trình duyệt không được lưu):
 * - `/api/public/cart/...`        giỏ hàng theo token
 * - `/api/public/orders/...`      tra cứu đơn, trạng thái thanh toán, file tải về / mã số của đơn (theo mã đơn + SĐT)
 * - `/api/public/downloads/...`   tải file sản phẩm số theo token
 * - `/api/public/preview/...`     xem trước bản nháp (token xem trước)
 * - `/api/public/track`, `/api/public/client-errors`, `/api/public/redirects/hit`  (ghi nhận, không phải dữ liệu đọc)
 */
export const PRIVATE_PUBLIC_PREFIXES = ['/cart', '/orders', '/downloads', '/preview', '/track', '/client-errors', '/redirects/hit'];

/** Query mang token / chế độ xem trước -> cũng coi là cá nhân hoá */
const PRIVATE_QUERY = /(?:^|&)(?:token|preview|previewToken)=/i;

/** s-maxage (giây) cho response public dùng chung được: env PUBLIC_CACHE_SMAXAGE, mặc định 60; 0 = tắt cache dùng chung */
export function publicCacheSMaxAge(): number {
  const n = Number.parseInt(process.env.PUBLIC_CACHE_SMAXAGE ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/**
 * Quyết định header Cache-Control cho một request. Trả null = không đụng tới (ngoài /api/public/*).
 * - Method ghi (POST/PUT/PATCH/DELETE) dưới /api/public -> `private, no-store`.
 * - Có Authorization / X-API-Key (đã đăng nhập hoặc gọi bằng key) -> `private, no-store` (dữ liệu có thể khác theo người dùng).
 * - Thuộc danh sách cá nhân hoá ở trên, hoặc query có token/preview -> `private, no-store`.
 * - Còn lại -> `public, max-age=0, s-maxage=N, stale-while-revalidate=300`: trình duyệt luôn hỏi lại, CDN/proxy giữ N giây.
 */
export function publicCacheControl(method: string, url: string, headers: Record<string, unknown>, sMaxAge = publicCacheSMaxAge()): string | null {
  const m = method.toUpperCase();
  const [path, query = ''] = url.split('?');
  const prefix = '/api/public';
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  // POST/PUT/PATCH/DELETE (tra cứu đơn bằng SĐT trong body, đếm lượt xem, gửi form...) -> không bao giờ lưu
  if (m !== 'GET' && m !== 'HEAD') return 'private, no-store';
  const rest = path.slice(prefix.length);
  const isPrivate =
    !!headers.authorization ||
    !!headers['x-api-key'] ||
    PRIVATE_PUBLIC_PREFIXES.some((p) => rest === p || rest.startsWith(`${p}/`)) ||
    PRIVATE_QUERY.test(query);
  if (isPrivate || sMaxAge <= 0) return 'private, no-store';
  return `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=300`;
}

/** Thêm giá trị vào header Vary sẵn có (CORS đã đặt `Vary: Origin`) mà không ghi đè / lặp */
export function mergeVary(current: unknown, add: string[]): string {
  const list = String(current ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const h of add) if (!list.some((x) => x.toLowerCase() === h.toLowerCase())) list.push(h);
  return list.join(', ');
}

/**
 * Interceptor toàn cục gắn Cache-Control cho /api/public/* (GET/HEAD có thể cache, method ghi luôn no-store) để CDN / reverse proxy cache được dữ liệu công khai
 * (frontend SSR của từng dự án đỡ gọi lặp). Không ghi đè header route đã tự đặt bằng @Header('Cache-Control', ...).
 * Header `public` chỉ gắn khi response thành công; lỗi (404...) không được CDN giữ lại.
 */
@Injectable()
export class PublicCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<{ method: string; originalUrl?: string; url: string; headers: Record<string, unknown> }>();
    const res = http.getResponse<{ headersSent: boolean; getHeader(n: string): unknown; setHeader(n: string, v: string): void }>();
    const value = publicCacheControl(req.method, req.originalUrl ?? req.url, req.headers);
    if (!value) return next.handle();
    // @Header của route đã đặt trước khi interceptor chạy -> tôn trọng
    if (res.getHeader('Cache-Control') !== undefined) return next.handle();
    // nội dung khác nhau theo người gọi -> cache dùng chung phải tách theo các header này
    res.setHeader('Vary', mergeVary(res.getHeader('Vary'), ['Authorization', 'X-API-Key']));
    if (value.startsWith('private')) {
      // cá nhân hoá: đặt ngay để cả response lỗi cũng không bị lưu
      res.setHeader('Cache-Control', value);
      return next.handle();
    }
    return next.handle().pipe(
      tap(() => {
        if (!res.headersSent && res.getHeader('Cache-Control') === undefined) res.setHeader('Cache-Control', value);
      }),
    );
  }
}
