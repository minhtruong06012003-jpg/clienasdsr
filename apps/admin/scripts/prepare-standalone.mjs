/**
 * Hoàn thiện bản build `output: 'standalone'` của Next cho trang quản trị.
 *
 * Next cố ý không copy hai thư mục này vào bản standalone (họ giả định CDN sẽ
 * phục vụ chúng), nhưng CMSNT Panel chạy `server.js` trần qua PM2/Docker nên
 * phải tự copy: thiếu chúng thì server vẫn lên nhưng mọi JS/CSS/ảnh public đều
 * 404 — trang trắng, rất khó lần ra vì build "thành công".
 *
 * Chạy tự động sau `next build` (xem script `build` trong package.json), làm
 * việc trên đường dẫn tương đối với thư mục `apps/admin` nên dùng chung được
 * cho cả Docker lẫn build tay trên máy. Dockerfile vẫn tự copy hai thư mục này
 * — copy trùng không sao.
 *
 * `basePath` (NEXT_PUBLIC_ADMIN_BASE_PATH) không ảnh hưởng tới vị trí file:
 * Next vẫn tìm static ở `<distDir>/static` và public ở `public/`, chỉ URL
 * phục vụ ra ngoài là có tiền tố.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Phải đọc đúng biến mà `next.config.ts` dùng cho `distDir`: khi build lại trên
// máy đang chạy có thể build vào thư mục tạm để không phá bản đang phục vụ, và script này chạy ngay
// sau `next build` nên nếu vẫn nhìn vào `.next` thì nó sẽ báo "chưa có bản
// standalone" ngay sau bước build.
const distDir = process.env.CMSNT_ADMIN_DIST_DIR?.trim() || '.next';
// Vì repo là workspace pnpm (`outputFileTracingRoot` = gốc repo), bản standalone
// lồng thêm một tầng `apps/admin`. Thư mục build lồng bên trong bản standalone
// mang CHÍNH tên tạm đó, vì Next nhúng `distDir` vào `server.js`. Đó là chủ ý:
// lúc tráo đổi chỉ thư mục ngoài cùng được đổi tên, nên hai bên vẫn khớp nhau
// và không phải sửa file do Next sinh ra.
const standaloneApp = join(appRoot, distDir, 'standalone', 'apps', 'admin');

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
console.log(`Đã copy static + public vào bản standalone (${distDir}).`);
