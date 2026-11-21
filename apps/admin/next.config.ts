import path from "node:path";
import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4317";
// Chạy admin dưới đường dẫn con khi dùng chung 1 domain với website/frontend riêng (vd: DDEV → /admin)
const basePath = (process.env.NEXT_PUBLIC_ADMIN_BASE_PATH ?? "").replace(/\/+$/, "");

/**
 * Header bảo mật cho mọi trang quản trị.
 * - Chống clickjacking: cấm mọi trang (kể cả chính admin) nhúng admin vào iframe (DENY / frame-ancestors 'none') —
 *   admin không có trang nào tự nhúng chính nó (iframe xem trước email dùng srcDoc, bản đồ trỏ Google Maps: không bị ảnh hưởng).
 *   Chỉ đặt frame-ancestors, KHÔNG đặt script-src/style-src để không làm hỏng app.
 * - Không gửi URL trang admin (có id, query) sang site khác qua Referer.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // `next build` xoá sạch thư mục build trước khi biên dịch, nên build thẳng vào `.next` là rút chân
  // thang của bản đang phục vụ: tiến trình admin cũ mất hết chunk static suốt mấy phút build. Khi build lại
  // trên máy đang chạy, đặt biến này để build vào `.next-staging`, rồi chỉ đổi tên vào đúng chỗ
  // ngay trước khi khởi động lại. Bỏ trống thì mọi thứ chạy y như cũ (dev, Docker, build tay).
  distDir: process.env.CMSNT_ADMIN_DIST_DIR?.trim() || ".next",
  basePath: basePath || undefined,
  // cho phép mở dev server qua domain proxy (DDEV: *.ddev.site)
  allowedDevOrigins: ["*.ddev.site"],
  // monorepo: gom cả packages/* vào bản build standalone
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // Gọi API qua cùng domain (/api/*) để cookie refresh token hoạt động và không cần CORS
  async rewrites() {
    return [
      // basePath: false -> giữ /api, /uploads ở gốc domain kể cả khi admin chạy dưới /admin
      { source: "/api/:path*", destination: `${API_URL}/api/:path*`, basePath: false },
      { source: "/uploads/:path*", destination: `${API_URL}/uploads/:path*`, basePath: false },
    ];
  },
  // source tự cộng basePath (vd /admin/:path*) nên áp đúng cho mọi trang admin
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  transpilePackages: ["@cmsnt/blocks"],
  images: { unoptimized: true },
};

export default nextConfig;
