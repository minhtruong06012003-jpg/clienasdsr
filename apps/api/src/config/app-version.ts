import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Gốc dự án (monorepo), tính từ file này: `apps/api/{src,dist}/config` lùi bốn cấp.
 * Không dùng `process.cwd()` vì PM2 đặt cwd của tiến trình API vào `apps/api`.
 */
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Số dùng khi không đọc nổi package.json (vd. chạy trong Docker image chỉ chép dist). */
const FALLBACK_VERSION = '1.1.0';

let cached: string | null = null;

/**
 * Phiên bản lõi đang chạy, đọc từ `package.json` ở GỐC dự án — nguồn duy nhất
 * cho cả API, Site Health, frontend riêng (qua /api/capabilities) và script
 * đóng gói. Không lấy từ `npm_package_version` vì PM2 gọi thẳng
 * `node dist/main.js` nên biến đó rỗng. Đọc một lần rồi giữ: phiên bản chỉ đổi
 * khi tiến trình được dựng lại.
 */
export function appVersion(): string {
  if (cached) return cached;
  cached = readProjectVersion() ?? FALLBACK_VERSION;
  return cached;
}

function readProjectVersion(): string | null {
  // Thứ tự: package.json gốc monorepo (PM2/dev) → bản sao `root-package.json` mà Dockerfile chép vào cạnh dist (Docker)
  for (const file of [join(PROJECT_ROOT, 'package.json'), join(process.cwd(), 'root-package.json')]) {
    try {
      const raw = readFileSync(file, 'utf8');
      const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof version === 'string' && version) return version;
    } catch {
      // thử file kế tiếp
    }
  }
  return null;
}
