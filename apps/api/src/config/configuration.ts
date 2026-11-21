export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4317', 10),
  apiPublicUrl: (process.env.API_PUBLIC_URL ?? 'http://localhost:4317').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    // production bắt buộc đặt secret mạnh (main.ts dừng khởi động nếu thiếu); 'dev-secret' chỉ dùng khi phát triển
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-secret',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10),
  },
  // URL công khai của trang quản trị (link đặt lại mật khẩu admin)
  adminUrl: (process.env.ADMIN_URL ?? 'http://localhost:3317').replace(/\/$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  web: {
    url: (process.env.WEB_URL ?? '').replace(/\/$/, ''),
    // URL nội bộ để API gọi frontend riêng (revalidate) khi WEB_URL đi qua proxy/HTTPS máy chủ không gọi tới được
    internalUrl: (process.env.WEB_INTERNAL_URL || process.env.WEB_URL || '').replace(/\/$/, ''),
    revalidateSecret: process.env.REVALIDATE_SECRET ?? '',
  },
  upload: {
    dir: process.env.UPLOAD_DIR ?? 'uploads',
    maxMb: parseInt(process.env.UPLOAD_MAX_MB ?? '20', 10),
  },
});

export type AppConfig = ReturnType<typeof import('./configuration.js').default>;
