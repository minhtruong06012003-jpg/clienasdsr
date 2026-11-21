import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppLogger } from './modules/logs/app-logger.js';
import { logWriter } from './modules/logs/log-writer.js';
import { validationExceptionFactory } from './common/validation/validation-messages.js';
import { setupSwagger, swaggerEnabled } from './config/swagger.js';
import { clientIpMiddleware } from './common/utils/client-ip.js';

// Logger toàn cục: in console + ghi nhật ký lỗi ra file (Hệ thống › Nhật ký lỗi)
const appLogger = new AppLogger();
Logger.overrideLogger(appLogger);

/** Lỗi không ai bắt làm sập tiến trình: ghi đồng bộ vào nhật ký trước khi thoát (PM2 sẽ khởi động lại) */
process.on('uncaughtException', (err) => {
  logWriter.write({ level: 'fatal', source: 'process', context: 'uncaughtException', message: err?.message ?? String(err), stack: err?.stack }, { sync: true });
  console.error(err);
  process.exit(1);
});
/** Promise bị reject mà không có catch: ghi lại và giữ API tiếp tục chạy */
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
  logWriter.write({ level: 'error', source: 'process', context: 'unhandledRejection', message: err.message, stack: err.stack });
  console.error('Unhandled rejection:', reason);
});

/** Secret mẫu trong .env.example / mặc định trong code — ai cũng biết, dùng là ký được token đăng nhập bất kỳ */
const WEAK_SECRETS = ['dev-secret', 'change-me-access-secret', 'chuoi-ngau-nhien-dai-it-nhat-32-ky-tu'];

/**
 * Production: dừng khởi động khi JWT_ACCESS_SECRET thiếu / ngắn / là giá trị mẫu.
 * Secret yếu = kẻ tấn công tự ký token với id quản trị (id lộ qua API bài viết công khai) -> toàn quyền quản trị.
 */
function assertProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  const jwt = process.env.JWT_ACCESS_SECRET ?? '';
  if (jwt.length < 32 || WEAK_SECRETS.includes(jwt)) {
    throw new Error('JWT_ACCESS_SECRET chưa đặt, ngắn hơn 32 ký tự hoặc đang là giá trị mẫu. Tạo bằng `openssl rand -hex 32` rồi đặt vào apps/api/.env');
  }
}

/**
 * Danh sách origin được gọi API kèm cookie. Không khai báo CORS_ORIGINS thì lấy theo WEB_URL + ADMIN_URL;
 * production mà vẫn rỗng thì dừng (không phản chiếu mọi origin kèm credentials).
 */
function resolveCorsOrigins(): string[] {
  const list = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const derived = [process.env.WEB_URL, process.env.ADMIN_URL]
    .map((u) => {
      try {
        return u ? new URL(u).origin : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  if (process.env.NODE_ENV === 'production') {
    if (!derived.length) throw new Error('Chưa đặt CORS_ORIGINS (hoặc WEB_URL/ADMIN_URL) cho production');
    Logger.warn(`CORS_ORIGINS trống — dùng tạm ${derived.join(', ')}`, 'Bootstrap');
    return derived;
  }
  return [];
}

/** Request có body JSON không (application/json hoặc kiểu +json như application/merge-patch+json) */
const isJsonRequest = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
};

/** Request vào API quản trị (/api/admin/*): được gửi JSON lớn hơn (nhập liệu, khôi phục, Page Builder...) */
const isAdminRequest = (req: { originalUrl?: string; url?: string }) => String(req.originalUrl ?? req.url ?? '').startsWith('/api/admin/');

async function bootstrap() {
  assertProductionSecrets();
  const { AppModule } = await import('./app.module.js');
  const { IpRulesService } = await import('./modules/security/ip-rules.service.js');
  const { createIpFilter } = await import('./modules/security/ip-filter.middleware.js');
  // rawBody: cần cho webhook xác thực HMAC trên nội dung gốc (vd SePay)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false, rawBody: true, logger: appLogger });
  const port = Number(process.env.PORT ?? 4317);
  const origins = resolveCorsOrigins();
  // Express mặc định khớp route KHÔNG phân biệt hoa/thường (/api/Admin/... vẫn vào route admin), làm các bộ lọc theo
  // đường dẫn (lọc IP quản trị, chặn API key ở /auth/*) bị vượt qua. Bật phân biệt để URL chỉ có một cách viết.
  app.set('case sensitive routing', true);
  // Router của Express đã được tạo (lúc Nest gắn middleware) trước dòng trên nên cài đặt app không còn tác dụng;
  // route của Nest chỉ được đăng ký ở app.init()/listen() và đọc router.caseSensitive lúc đó -> đặt thẳng trên router.
  const expressRouter = (app.getHttpAdapter().getInstance() as { router?: { caseSensitive?: boolean } }).router;
  if (expressRouter) expressRouter.caseSensitive = true;

  // Chỉ tin X-Forwarded-For từ proxy được cấu hình (mặc định: chỉ proxy trên chính máy chủ),
  // tránh giả IP để vượt giới hạn tần suất. Đặt TRUST_PROXY=1 nếu API nằm sau 1 reverse proxy (nginx...).
  const trustProxy = process.env.TRUST_PROXY ?? 'loopback';
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'false' ? false : trustProxy);
  // Frontend SSR có x-server-secret khai IP thật của khách qua x-client-ip -> req.ip là IP khách (trừ /api/admin/*)
  app.use(clientIpMiddleware());
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
  app.use(compression({ filter: (req, res) => (req.url?.startsWith('/uploads') ? false : compression.filter(req, res)) }));
  app.use(cookieParser());
  // Giới hạn body JSON: mặc định BODY_LIMIT (1mb) cho mọi route; riêng /api/admin/* dùng ADMIN_BODY_LIMIT (10mb)
  // vì nhập cấu hình / bundle site-kit / Page Builder / nhập kho mã số gửi JSON lớn. Parser admin đứng trước:
  // nó đọc xong body thì parser thứ hai tự bỏ qua (body-parser không đọc lại stream đã kết thúc).
  // Cả hai tên hàm là `jsonParser` nên Nest không gắn thêm parser JSON mặc định (100kb) lúc init.
  app.useBodyParser('json', { limit: process.env.ADMIN_BODY_LIMIT || '10mb', type: (req) => isJsonRequest(req as never) && isAdminRequest(req as never) });
  app.useBodyParser('json', { limit: process.env.BODY_LIMIT || '1mb', type: (req) => isJsonRequest(req as never) });
  // dev chưa khai báo origin: phản chiếu mọi origin cho tiện; production luôn có danh sách (resolveCorsOrigins)
  app.enableCors({ origin: origins.length ? origins : true, credentials: true });
  // Trung tâm bảo mật: chặn IP / chỉ cho phép IP vào trang quản trị — đặt sau trust proxy (đọc đúng IP thật)
  // và sau CORS (trình duyệt đọc được câu báo lỗi 403)
  app.use(createIpFilter(app.get(IpRulesService)));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // lỗi validate trả tiếng Việt kèm tên trường (giữ nguyên thông báo tiếng Việt tự gắn trong DTO)
      exceptionFactory: validationExceptionFactory,
    }),
  );

  // File riêng tư trong storage (hoá đơn điện tử, file sản phẩm số…) không bao giờ phục vụ tĩnh — chỉ tải qua API có kiểm quyền.
  // `einvoices/` là vị trí cũ của PDF/XML hoá đơn trước khi chuyển sang `private/` (file cũ chuyển dần khi được tải lại).
  app.use('/uploads', (req: { path: string }, res: { status: (c: number) => { end: () => void } }, next: () => void) => {
    let p: string;
    try {
      // giải mã %2e%2e, đổi \ thành /, chuẩn hoá ../ và // để không lách được bằng /2026/../private/x
      p = posix.normalize('/' + decodeURIComponent(req.path).replace(/\\/g, '/')).toLowerCase();
    } catch {
      return res.status(400).end();
    }
    if (p.startsWith('/private/') || p.startsWith('/einvoices/')) return res.status(404).end();
    next();
  });

  // Thư viện biểu tượng có sẵn trong mã nguồn (apps/api/assets/icons, vd icon MXH cho nút liên hệ nổi): /uploads/icons/social/zalo.svg
  // — đặt dưới /uploads để admin và website khách dùng lại rewrite /uploads/* sẵn có.
  app.useStaticAssets(resolve(dirname(fileURLToPath(import.meta.url)), '../assets/icons'), {
    prefix: '/uploads/icons',
    maxAge: '7d',
    index: false,
  });

  // File upload công khai: /uploads/2026/10/abc.webp
  const uploadDir = process.env.UPLOAD_DIR ?? 'uploads';
  app.useStaticAssets(isAbsolute(uploadDir) ? uploadDir : resolve(process.cwd(), uploadDir), {
    prefix: '/uploads',
    maxAge: '365d',
    immutable: true,
    index: false,
    // File người dùng tải lên: không cho trình duyệt đoán kiểu, không chạy script (kể cả SVG),
    // file không phải ảnh/video luôn tải xuống thay vì mở trên origin của API
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      if (!/\.(jpe?g|png|webp|avif|gif|svg|ico|tiff|mp4|webm|mp3)$/i.test(filePath)) res.setHeader('Content-Disposition', 'attachment');
    },
  });

  // Tài liệu API: /api/docs (công khai + tài khoản + đăng nhập) và /api/docs/admin (quản trị).
  // Production tắt mặc định; bật bằng SWAGGER_ENABLED=true.
  const docs = swaggerEnabled();
  if (docs) setupSwagger(app);

  app.enableShutdownHooks();
  await app.listen(port);
  Logger.log(`🚀 API: http://localhost:${port}/api${docs ? `  |  Docs: http://localhost:${port}/api/docs (quản trị: /api/docs/admin)` : ''}`, 'Bootstrap');
}
await bootstrap().catch((err: Error) => {
  // lỗi khi khởi động (DB không kết nối được, cổng bị chiếm...) cũng phải nằm trong nhật ký
  logWriter.write({ level: 'fatal', source: 'process', context: 'Bootstrap', message: `API không khởi động được: ${err?.message ?? err}`, stack: err?.stack }, { sync: true });
  console.error(err);
  process.exit(1);
});
