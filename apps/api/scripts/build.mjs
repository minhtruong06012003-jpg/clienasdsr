/**
 * Gọi `nest build`, cho phép đổi thư mục đầu ra sang chỗ khác khi build lại trên máy đang chạy.
 *
 * `nest-cli.json` bật `deleteOutDir`, nên một lần build bình thường sẽ xoá sạch
 * `dist` — đúng thư mục mà tiến trình API đang chạy trên đó. Suốt vài phút
 * build, bất kỳ lần restart nào của PM2 (ví dụ chạm trần `max_memory_restart`
 * lúc build ăn RAM) đều dựng dậy một thư mục rỗng và API rơi vào vòng crash.
 *
 * Vì vậy khi build lại trên máy đang chạy, đặt `CMSNT_API_DIST_DIR=dist-staging`
 * để build vào một thư mục tạm, rồi mới đổi tên vào đúng chỗ ngay trước khi
 * khởi động lại. Bỏ trống thì mọi thứ chạy y như cũ (dev, Docker, build tay).
 *
 * `nest build` lấy `outDir` từ tsconfig chứ không nhận tham số dòng lệnh, nên
 * cách duy nhất để đổi chỗ là sinh một tsconfig tạm kế thừa tsconfig.build.json
 * và trỏ `nest build --path` vào đó.
 */
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.CMSNT_API_DIST_DIR?.trim() || 'dist';

// Tên thư mục đi thẳng vào tsconfig và vào lệnh xoá của Nest, nên chỉ nhận một
// tên thư mục đơn giản ngay cạnh `dist` — không cho đường dẫn lồng nhau hay
// `..` để một biến môi trường đặt sai không xoá nhầm chỗ khác.
if (!/^[A-Za-z0-9._-]+$/.test(outDir) || outDir === '.' || outDir === '..') {
  console.error(`CMSNT_API_DIST_DIR không hợp lệ: ${outDir}`);
  process.exit(1);
}

// Nest đọc `tsconfig.build.json` mặc định; chỉ khi đổi chỗ mới phải sinh file.
// `incremental: true` trong tsconfig.json ghi `.tsbuildinfo` theo outDir, nên
// tắt hẳn ở bản tạm để không dùng nhầm cache của lượt build vào `dist`.
const generated = join(apiRoot, 'tsconfig.build.generated.json');
const args = ['build'];
if (outDir !== 'dist') {
  writeFileSync(
    generated,
    `${JSON.stringify(
      {
        extends: './tsconfig.build.json',
        compilerOptions: { outDir: `./${outDir}`, incremental: false },
      },
      null,
      2,
    )}\n`,
  );
  args.push('--path', 'tsconfig.build.generated.json');
}

// `nest` nằm trong node_modules/.bin của workspace; gọi qua pnpm để không phải
// tự dò đường dẫn binary ở cả máy dev lẫn máy khách.
const result = spawnSync('pnpm', ['exec', 'nest', ...args], {
  cwd: apiRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (outDir !== 'dist') rmSync(generated, { force: true });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
