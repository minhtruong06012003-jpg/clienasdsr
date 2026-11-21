import path from "node:path";
import type { NextConfig } from "next";

// Địa chỉ API NestJS — chỉ dùng phía máy chủ Next để rewrite, trình duyệt luôn gọi cùng origin (/api/*)
const API_URL = process.env.API_URL ?? "http://localhost:4317";

/**
 * Header bảo mật cơ bản cho website khách: chống nhúng iframe (clickjacking), không lộ URL qua Referer sang site khác.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Giữ kết nối window.opener giữa trang đăng nhập và cửa sổ popup Google trên Safari / WebKit (T-252)
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Build vào thư mục tạm `.next-staging` khi deploy trên máy chủ đang chạy để không xoá mất CSS/JS của phiên đang phục vụ (T-241)
  distDir: process.env.CMSNT_WEB_DIST_DIR?.trim() || ".next",
  // monorepo: gom cả packages/* vào bản build standalone
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  // cho phép mở dev server qua domain proxy (DDEV)
  allowedDevOrigins: ["*.ddev.site"],
  // Chuyển hướng an toàn nếu quản trị viên mở nhầm đường dẫn quản trị thiếu tiền tố `/admin` từ lịch sử trình duyệt (`T-330`)
  async redirects() {
    return [
      {
        source: "/ai/:sub(tasks|tools|plans|affiliate|tickets|announcements|child-panels|community)",
        destination: "/admin/ai/:sub",
        permanent: false,
      },
      {
        source: "/tasks",
        has: [{ type: "query", key: "provider" }],
        destination: "/admin/ai/tasks",
        permanent: false,
      },
    ];
  },
  // Gọi API qua cùng domain (/api/*) để không cần CORS; media /uploads/* cũng đi qua đây
  async rewrites() {
    return {
      // Đổi luôn URL ảnh bìa tĩnh cũ sang ảnh bìa động theo thương hiệu riêng từng domain (T-372)
      beforeFiles: [{ source: "/images/home/og-cover.jpg", destination: "/og-banner.png" }],
      afterFiles: [
        { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
        { source: "/uploads/:path*", destination: `${API_URL}/uploads/:path*` },
      ],
      fallback: [],
    };
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // thư viện block dùng chung viết bằng TS/TSX chưa biên dịch
  transpilePackages: ["@cmsnt/blocks"],
  images: { unoptimized: true },
};

export default nextConfig;
