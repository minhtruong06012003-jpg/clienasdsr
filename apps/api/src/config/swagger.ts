import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * Tài liệu API (Swagger UI), tách hai bộ:
 * - `/api/docs`        API công khai + tài khoản thành viên + đăng nhập (frontend riêng của dự án dùng)  — JSON: `/api/docs-json`
 * - `/api/docs/admin`  API quản trị (`/api/admin/*`, gọi bằng JWT admin hoặc API key)               — JSON: `/api/docs/admin-json`
 * Bật mặc định khi không phải production; production chỉ bật khi đặt `SWAGGER_ENABLED=true` (tương thích cũ: `SWAGGER=1`).
 */
export function swaggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true;
  const flag = String(env.SWAGGER_ENABLED ?? env.SWAGGER ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/** Đường dẫn thuộc nhóm quản trị */
const isAdminPath = (path: string) => path === '/api/admin' || path.startsWith('/api/admin/');

/**
 * Tag mặc định theo đường dẫn cho operation chưa gắn @ApiTags (đa số controller của dự án):
 * `/api/admin/products/...` -> "products" (trong bộ admin), `/api/public/posts/...` -> "public/posts",
 * `/api/account/orders` -> "account/orders", `/api/auth/login` -> "auth".
 */
export function tagForPath(path: string): string {
  const segs = path
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter((s) => s && !s.startsWith('{') && !s.startsWith(':'));
  if (!segs.length) return 'khác';
  if (segs[0] === 'admin') return segs[1] ?? 'admin';
  if ((segs[0] === 'public' || segs[0] === 'account') && segs[1]) return `${segs[0]}/${segs[1]}`;
  return segs[0];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

/** Lọc document theo đường dẫn, gắn tag mặc định, thay phần info; giữ nguyên components (schema DTO dùng chung) */
export function subDocument(full: OpenAPIObject, keep: (path: string) => boolean, info: Partial<OpenAPIObject['info']>): OpenAPIObject {
  const paths: OpenAPIObject['paths'] = {};
  const tags = new Set<string>();
  for (const [path, item] of Object.entries(full.paths ?? {})) {
    if (!keep(path)) continue;
    const copy = { ...item } as Record<string, unknown>;
    for (const m of HTTP_METHODS) {
      const op = copy[m] as { tags?: string[] } | undefined;
      if (!op) continue;
      const opTags = op.tags?.length ? op.tags : [tagForPath(path)];
      opTags.forEach((t) => tags.add(t));
      copy[m] = { ...op, tags: opTags };
    }
    paths[path] = copy as OpenAPIObject['paths'][string];
  }
  return {
    ...full,
    info: { ...full.info, ...info },
    paths,
    tags: [...tags].sort().map((name) => ({ name })),
  };
}

/** Gắn hai bộ tài liệu Swagger vào app (document dựng lười ở lần mở đầu tiên, dùng chung cho cả hai bộ) */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('CMSNT Panel API')
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'API key cá nhân (cmsnt_...) tạo trong Quản trị › API key' }, 'api-key')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-server-secret', description: 'Bí mật máy chủ frontend SSR (env SERVER_API_SECRET) — miễn giới hạn request toàn cục' }, 'server-secret')
    .build();
  let full: OpenAPIObject | null = null;
  const build = () => (full ??= SwaggerModule.createDocument(app, config));

  // đăng ký bộ admin trước: đường dẫn /api/docs/admin nằm "bên trong" /api/docs
  SwaggerModule.setup(
    'api/docs/admin',
    app,
    () =>
      subDocument(build(), isAdminPath, {
        title: 'CMSNT Panel API — Quản trị',
        description: 'API trang quản trị (`/api/admin/*`). Xác thực bằng JWT (đăng nhập admin) hoặc API key (`X-API-Key`). Bộ công khai: [/api/docs](/api/docs).',
      }),
    { customSiteTitle: 'CMSNT Panel API — Quản trị', swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' } },
  );
  SwaggerModule.setup(
    'api/docs',
    app,
    () =>
      subDocument(build(), (p) => !isAdminPath(p), {
        title: 'CMSNT Panel API — Công khai',
        description:
          'API cho frontend riêng của từng dự án: `/api/public/*` (không cần đăng nhập), `/api/auth/*`, `/api/account/*` (thành viên, Bearer JWT). ' +
          'Frontend SSR gửi kèm `x-server-secret` (+ `x-client-ip` = IP thật của khách) để không bị giới hạn request toàn cục. Bộ quản trị: [/api/docs/admin](/api/docs/admin).',
      }),
    { customSiteTitle: 'CMSNT Panel API', swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' } },
  );
}
