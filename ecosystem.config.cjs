// Cấu hình PM2 cho CMSNT Panel chạy trên VPS (không Docker): 2 tiến trình
// api / admin (API headless + Admin Panel; frontend của khách triển khai riêng).
// Dùng: `pm2 startOrRestart ecosystem.config.cjs` (install.sh gọi sẵn).
//
// File này là CommonJS (.cjs) vì PM2 nạp nó bằng `require`.
const fs = require('fs');
const path = require('path');

/**
 * Đọc một file .env thành object mà KHÔNG `source` nó: file do người deploy
 * sửa tay, một dấu backtick lạc chỗ trong đó không được phép biến thành lệnh
 * chạy dưới quyền của PM2. Hỗ trợ dòng trống, dòng `#` chú thích, tiền tố
 * `export `, giá trị bọc trong "..." hoặc '...'. Không có file thì trả {}.
 */
function parseEnvFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const result = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) {
      value = value.slice(1, -1);
    } else {
      // Giá trị không bọc nháy: bỏ phần chú thích đi sau (`KEY=1 # ghi chú`).
      value = value.replace(/\s+#.*$/, '').trim();
    }
    result[match[1]] = value;
  }
  return result;
}

// `.env` ở GỐC dự án chỉ chứa cấu hình của riêng PM2 (tiền tố tên tiến trình,
// cổng admin) — xem `.env.example`. Mỗi app vẫn có `.env` riêng trong thư
// mục của nó.
const rootEnv = parseEnvFile(path.join(__dirname, '.env'));

/**
 * Thứ tự ưu tiên: biến môi trường của chính lệnh `pm2` > `.env` ở gốc > mặc
 * định. Nhờ vế cuối, máy chủ chỉ chạy một bản CMSNT Panel không phải khai gì
 * thêm và vẫn ra đúng tên tiến trình cùng cổng mặc định.
 */
function setting(key, fallback) {
  const fromProcess = process.env[key] && process.env[key].trim();
  return fromProcess || (rootEnv[key] && rootEnv[key].trim()) || fallback;
}

// Một máy chủ có thể chạy nhiều bản CMSNT Panel cạnh nhau, mỗi tên miền một
// thư mục. Tên tiến trình PM2 phải khác nhau giữa chúng: PM2 định danh app bằng
// TÊN, nên hai thư mục cùng đặt `cmsnt-api` thì lệnh khởi động của bản này lại
// restart tiến trình của bản kia — kèm cả env của mình.
const appPrefix = setting('PM2_APP_PREFIX', 'novai');
if (!/^[A-Za-z0-9_-]+$/.test(appPrefix)) {
  throw new Error(`PM2_APP_PREFIX chỉ được dùng chữ, số, gạch ngang và gạch dưới (đang là "${appPrefix}").`);
}

/** Đọc số cổng, báo lỗi sớm thay vì để Next nghe nhầm cổng NaN. */
function port(key, fallback) {
  const raw = setting(key, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${key} phải là số cổng hợp lệ (đang là "${raw}").`);
  }
  return value;
}

// Cổng của API do chính API đọc từ `apps/api/.env` (PORT, mặc định 4317) nên
// không khai ở đây. Admin là server standalone của Next: nó đọc PORT từ biến
// môi trường, nên PM2 phải truyền vào.
const adminPort = port('ADMIN_PORT', 3317);

// Next standalone KHÔNG tự nạp file `.env` (chỉ `next dev`/`next start` mới
// nạp), nên toàn bộ `apps/admin/.env` được đọc ở đây và truyền vào env của
// tiến trình admin. Biến NEXT_PUBLIC_* đã được nhúng lúc build nên có hay
// không ở runtime không quan trọng; các biến phía server (API_URL…) thì bắt
// buộc phải có ở runtime.
const adminEnv = parseEnvFile(path.join(__dirname, 'apps', 'admin', '.env'));

// Website khách (apps/web): cổng nội bộ + biến môi trường đọc từ `apps/web/.env.local`.
const webPort = port('WEB_PORT', 3318);
const webEnv = parseEnvFile(path.join(__dirname, 'apps', 'web', '.env.local'));

module.exports = {
  apps: [
    {
      name: `${appPrefix}-api`,
      cwd: './apps/api',
      // API tự nạp `apps/api/.env` qua `dotenv/config` (theo cwd) nên chỉ cần NODE_ENV.
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      // Đặt trần heap V8 thấp hơn max_memory_restart để V8 chủ động thu gom rác (GC) trước khi chạm ngưỡng PM2
      node_args: setting('API_NODE_ARGS', appPrefix === 'novai' ? '--max-old-space-size=640 --max-semi-space-size=8' : '--optimize-for-size --max-old-space-size=192 --max-semi-space-size=4'),
      max_memory_restart: setting('API_MAX_MEMORY', appPrefix === 'novai' ? '1024M' : '512M'),
      // Chờ tối đa 35s khi dừng/khởi động lại (khớp SHUTDOWN_WAIT_MS=30s của AiService/JobsService + 5s dự phòng)
      kill_timeout: 35000,
      env: { NODE_ENV: 'production' },
    },
    ...(appPrefix === 'novai'
      ? [
          {
            // Bản dự phòng nóng (hot-standby) ở cổng 4318 cho nov.ai.vn: tắt cron & Telegram polling,
            // tự động gánh 100% lưu lượng qua Nginx `backup` ngay tức thì nếu novai-api (4317) đang restart/deploy -> triệt tiêu hoàn toàn 502.
            name: 'novai-api-standby',
            cwd: './apps/api',
            script: 'dist/main.js',
            instances: 1,
            exec_mode: 'fork',
            node_args: '--optimize-for-size --max-old-space-size=192 --max-semi-space-size=4',
            max_memory_restart: '512M',
            kill_timeout: 15000,
            env: {
              NODE_ENV: 'production',
              PORT: port('STANDBY_API_PORT', 4318),
              DISABLE_SCHEDULER: 'true',
              TELEGRAM_POLLING: 'false',
              DB_POOL_MAX: '2',
            },
          },
        ]
      : []),
    {
      name: `${appPrefix}-admin`,
      cwd: './apps/admin',
      // Vì workspace pnpm, bản standalone lồng thêm tầng `apps/admin`
      // (xem scripts/prepare-standalone.mjs).
      script: '.next/standalone/apps/admin/server.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--optimize-for-size --max-old-space-size=192 --max-semi-space-size=4',
      max_memory_restart: '420M',
      env: { ...adminEnv, NODE_ENV: 'production', PORT: adminPort, HOSTNAME: '127.0.0.1' },
    },
    {
      // Website khách nov.ai.vn (apps/web) — server standalone của Next, chỉ nghe 127.0.0.1, nginx đứng trước.
      name: `${appPrefix}-web`,
      cwd: './apps/web',
      script: '.next/standalone/apps/web/server.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--optimize-for-size --max-old-space-size=224 --max-semi-space-size=4',
      max_memory_restart: '480M',
      // Standalone không tự nạp `.env.local` nên đọc ở đây (biến phía server: API_URL, SERVER_API_SECRET…).
      env: { ...webEnv, NODE_ENV: 'production', PORT: webPort, HOSTNAME: '127.0.0.1' },
    },
  ],
};
