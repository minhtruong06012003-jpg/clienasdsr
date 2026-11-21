/**
 * Hoàn thiện bản build `output: 'standalone'` của Next cho website khách.
 *
 * Next không copy `.next/static` và `public/` vào bản standalone (giả định CDN phục vụ),
 * nhưng trên VPS website chạy `server.js` trần qua PM2 nên phải tự copy — thiếu thì mọi
 * JS/CSS/ảnh đều 404. Chạy tự động sau `next build` (script `build` trong package.json).
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.env.CMSNT_WEB_DIST_DIR?.trim() || '.next';
// Workspace pnpm: bản standalone lồng thêm tầng `apps/web`
const standaloneApp = join(appRoot, distDir, 'standalone', 'apps', 'web');

if (!existsSync(join(standaloneApp, 'server.js'))) {
  console.error(`Chưa có bản standalone ở ${standaloneApp}; chạy \`next build\` trước đã.`);
  process.exit(1);
}

const copies = [
  { from: join(appRoot, distDir, 'static'), to: join(standaloneApp, distDir, 'static') },
  { from: join(appRoot, 'public'), to: join(standaloneApp, 'public') },
];

for (const { from, to } of copies) {
  if (!existsSync(from)) continue;
  // Xoá đích trước để build lặp lại không chồng bản cũ lên bản mới.
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
console.log('Đã copy static + public vào bản standalone của web.');
