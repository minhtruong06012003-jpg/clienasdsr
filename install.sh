#!/usr/bin/env bash
#
# Trình cài đặt / dựng lại CMSNT Panel trên máy chủ VPS (PM2 + nginx, không Docker).
#
# Gói phát hành là mã nguồn thuần (xem scripts/package-release.sh), nên sau khi
# giải nén vẫn phải cài phụ thuộc và biên dịch thì mới có `apps/api/dist`,
# `apps/admin/.next/standalone` và `apps/web/.next/standalone` cho PM2 chạy.
# Dự án gồm ba tiến trình: API headless, Admin Panel và website khách (apps/web).
# Script này gom đúng chuỗi việc đó lại thành một lệnh.
#
# Nó cố ý KHÔNG đụng tới database (ngoài `prisma migrate deploy` — chỉ thêm —
# và seed idempotent), không sửa `.env` đã có, không đụng nginx hay tường lửa.
# Nhờ vậy chạy lại nhiều lần vẫn an toàn — không có bước nào xoá dữ liệu.
#
# Cách dùng:
#   bash install.sh               # cài mới hoặc dựng lại (tự nhận biết)
#   bash install.sh --skip-deps   # bỏ qua pnpm install (chỉ build lại)
#   bash install.sh --skip-seed   # không chạy seed dữ liệu khởi tạo
#   bash install.sh --no-pm2      # dựng xong thì dừng, không đụng PM2
#
# Lần chạy đầu: nếu thiếu `apps/api/.env` (hoặc `apps/admin/.env`)
# script copy từ `.env.example` tương ứng rồi DỪNG để bạn sửa, chạy lại sau.

set -euo pipefail
cd "$(dirname "$0")"

skip_deps=false
skip_seed=false
use_pm2=true

for arg in "$@"; do
  case "$arg" in
    --skip-deps) skip_deps=true ;;
    --skip-seed) skip_seed=true ;;
    --no-pm2) use_pm2=false ;;
    -h | --help)
      awk 'NR>2 && /^#/ {sub(/^# ?/, ""); print; next} NR>2 {exit}' "$0"
      exit 0
      ;;
    *)
      echo "Tham số không hiểu: $arg (dùng --help để xem cách dùng)" >&2
      exit 1
      ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '\033[1;33mCẢNH BÁO: %s\033[0m\n' "$1" >&2; }
# Đặt khi script tự dừng bằng fail(): lúc đó thông báo đã đủ rõ, trap bên dưới
# không cần nói thêm gì nữa.
explained=false

fail() {
  printf '\033[1;31mLỖI: %s\033[0m\n' "$1" >&2
  explained=true
  exit 1
}

# `set -e` thoát lặng lẽ giữa chừng, mà bước hay hỏng nhất (build hết bộ nhớ,
# mất mạng khi tải phụ thuộc) lại chôn lỗi thật trong hàng trăm dòng output.
# Trap này đảm bảo dòng cuối cùng người deploy nhìn thấy luôn nói rõ là script
# đã dừng giữa chừng chứ không phải đã xong.
trap 'code=$?; if [[ $code -ne 0 && $explained == false ]]; then printf "\033[1;31m\nScript dừng giữa chừng (mã lỗi %s). Đọc lại thông báo phía trên để biết bước nào hỏng, xử lý rồi chạy lại — các bước đã xong sẽ qua rất nhanh.\033[0m\n" "$code" >&2; fi' EXIT

# Đọc một giá trị trong một file .env mà không `source` file: .env do người
# deploy sửa tay, một dấu backtick lạc chỗ trong đó không được phép biến thành
# lệnh chạy dưới quyền của script này.
read_env_value() {
  local file=$1 key=$2 line value
  [[ -f $file ]] || return 1
  line=$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" || true)
  [[ -n "$line" ]] || return 1
  value=${line#*=}
  value=${value%$'\r'}
  # Bỏ cặp nháy bao ngoài nếu người deploy có đặt.
  if [[ ${#value} -ge 2 && ${value:0:1} == '"' && ${value: -1} == '"' ]]; then
    value=${value:1:${#value}-2}
  elif [[ ${#value} -ge 2 && ${value:0:1} == "'" && ${value: -1} == "'" ]]; then
    value=${value:1:${#value}-2}
  fi
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

# Biến môi trường > .env ở gốc > mặc định — phải đọc y hệt ecosystem.config.cjs,
# hai bên nhìn ra hai giá trị khác nhau thì script sẽ chờ API ở cổng không ai nghe.
setting() {
  local key=$1 fallback=$2 value
  value=${!key:-}
  [[ -n $value ]] || value=$(read_env_value .env "$key" || true)
  printf '%s' "${value:-$fallback}"
}

# ---------------------------------------------------------------- 1. Môi trường

step "Kiểm tra máy chủ"

[[ -f package.json && -f ecosystem.config.cjs && -d apps/api && -d apps/admin ]] ||
  fail "Chạy script này từ trong thư mục đã giải nén mã nguồn CMSNT Panel."

# Node và pnpm có thể nằm ngoài PATH (aaPanel cài Node qua nvm vào /www/server/nvm).
# Thêm cả thư mục vào PATH chứ không chỉ gọi bằng đường dẫn tuyệt đối: pnpm ở
# đó là shim của corepack và nó đòi đúng bản Node nằm cùng thư mục.
find_tool_dir() {
  local tool=$1 candidate
  for candidate in $(ls -d /www/server/nvm/versions/node/*/bin \
    "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V -r); do
    [[ -x "$candidate/$tool" ]] && echo "$candidate" && return 0
  done
  for candidate in "${PNPM_HOME:-}" "$HOME/.local/share/pnpm" /usr/local/bin /usr/bin /opt/homebrew/bin; do
    [[ -n $candidate && -x "$candidate/$tool" ]] && echo "$candidate" && return 0
  done
  return 1
}
if ! command -v node >/dev/null 2>&1; then
  if node_dir=$(find_tool_dir node); then
    export PATH="$node_dir:$PATH"
    info "Tìm thấy Node ngoài PATH: $node_dir (đã thêm vào PATH của lượt này)"
  else
    fail "Chưa có Node.js. Cài Node 22 LTS (aaPanel: App Store → PM2 Manager; hoặc nvm) rồi chạy lại."
  fi
fi

node_major=$(node -p 'process.versions.node.split(".")[0]')
if ((node_major < 22)); then
  fail "Node $(node -v) không dùng được — dự án cần Node >= 22."
fi
info "Node $(node -v)"

# pnpm bắt buộc: kho là pnpm workspaces, npm hay yarn dựng ra cây node_modules
# khác hẳn và build sẽ hỏng giữa chừng.
if ! command -v pnpm >/dev/null 2>&1; then
  if pnpm_dir=$(find_tool_dir pnpm); then
    export PATH="$pnpm_dir:$PATH"
    info "Tìm thấy pnpm ngoài PATH: $pnpm_dir"
  else
    step "Cài pnpm"
    pnpm_version=$(node -p "require('./package.json').packageManager.split('@')[1]")
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || true
      corepack prepare "pnpm@${pnpm_version}" --activate ||
        fail "Không kích hoạt được pnpm bằng corepack. Thử: npm install -g pnpm@${pnpm_version}"
    else
      npm install -g "pnpm@${pnpm_version}" ||
        fail "Không cài được pnpm. Chạy bằng quyền root: npm install -g pnpm@${pnpm_version}"
    fi
  fi
fi
info "pnpm $(pnpm -v)"

# pg_dump dùng cho sao lưu trước khi migrate (cả Admin › Công cụ › Sao lưu).
if command -v pg_dump >/dev/null 2>&1; then
  info "pg_dump: $(pg_dump --version | head -1)"
else
  warn "Chưa có pg_dump — sao lưu database (Công cụ › Sao lưu) sẽ không chạy được. Cài postgresql-client hoặc đặt BACKUP_CMD trong apps/api/.env."
fi

# Next.js build là bước ngốn RAM nhất; máy 2 GB không swap thường bị OOM kill
# giữa chừng. Cảnh báo trước để người deploy thêm swap thay vì phải đoán.
if command -v free >/dev/null 2>&1; then
  mem_total=$(free -m | awk '/^Mem:/ {print $2}')
  swap_total=$(free -m | awk '/^Swap:/ {print $2}')
  if ((mem_total + swap_total < 3500)); then
    warn "Chỉ có ${mem_total} MB RAM + ${swap_total} MB swap. Bước build có thể bị hệ điều hành giết vì thiếu bộ nhớ; nên thêm swap trước khi chạy tiếp."
  fi
fi

if command -v df >/dev/null 2>&1; then
  disk_free_mb=$(df -Pm . 2>/dev/null | awk 'NR==2 {print $4}')
  if [[ -n ${disk_free_mb:-} ]] && ((disk_free_mb < 5120)); then
    warn "Phân vùng này chỉ còn ${disk_free_mb} MB trống. Cài phụ thuộc và build cần khoảng 3–4 GB."
  fi
fi

if command -v pm2 >/dev/null 2>&1; then
  info "PM2 $(pm2 -v 2>/dev/null | tail -1)"
elif [[ $use_pm2 == true ]]; then
  info "Chưa có PM2 — script sẽ tự cài ở bước khởi động."
fi

# ------------------------------------------------------------- 2. File .env

step "Kiểm tra file cấu hình .env"

# Mỗi app một file .env trong thư mục của nó. Thiếu file nào thì copy từ
# .env.example rồi DỪNG: giá trị mặc định trong example là của máy dev
# (localhost, mật khẩu demo), không được đem lên production.
missing_env=()
# API và Admin dùng `.env`; website khách (apps/web) dùng `.env.local`, kiểm tra riêng ngay sau vòng lặp.
env_apps=(apps/api apps/admin)
for app in "${env_apps[@]}"; do
  if [[ -f $app/.env ]]; then
    info "$app/.env có sẵn"
  elif [[ -f $app/.env.example ]]; then
    cp "$app/.env.example" "$app/.env"
    # Tự sinh secret ngẫu nhiên thay cho giá trị mẫu (API dừng khởi động ở production nếu JWT secret là giá trị mẫu)
    if [[ $app == apps/api ]] && command -v openssl >/dev/null 2>&1; then
      sed -i.bak "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -hex 32)|" "$app/.env" && rm -f "$app/.env.bak"
    fi
    missing_env+=("$app/.env")
  else
    warn "Không có $app/.env lẫn $app/.env.example — app này sẽ chạy với giá trị mặc định."
  fi
done
# Website khách (apps/web) đọc `.env.local` (không phải `.env`): API_URL, NEXT_PUBLIC_SITE_URL, SERVER_API_SECRET…
if [[ -f apps/web/.env.local ]]; then
  info "apps/web/.env.local có sẵn"
else
  cp apps/web/.env.example apps/web/.env.local
  missing_env+=("apps/web/.env.local")
fi

if ((${#missing_env[@]} > 0)); then
  printf '\n'
  info "Vừa tạo các file sau từ .env.example — hãy mở ra sửa rồi chạy lại 'bash install.sh':"
  for f in "${missing_env[@]}"; do info "  - $f"; done
  cat <<GUIDE

   Những giá trị BẮT BUỘC phải đổi:
     apps/api/.env    DATABASE_URL (PostgreSQL thật), JWT_ACCESS_SECRET (chuỗi ngẫu nhiên >= 32 ký tự),
                      API_PUBLIC_URL, ADMIN_URL, CORS_ORIGINS (thêm domain frontend riêng nếu có),
                      SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (tài khoản admin đầu tiên), NODE_ENV=production,
                      TRUST_PROXY=1 (API nằm sau nginx)
                      Tuỳ chọn: WEB_URL + REVALIDATE_SECRET nếu có frontend riêng cần nhận webhook revalidate
     apps/admin/.env  API_URL (http://127.0.0.1:<PORT của API>),
                      NEXT_PUBLIC_ADMIN_BASE_PATH=/admin khi chạy admin dưới đường dẫn /admin cùng domain
                      Tuỳ chọn: NEXT_PUBLIC_WEB_URL (domain frontend riêng, cho nút "Xem trên website")
   Tuỳ chọn, ở .env GỐC dự án (xem .env.example): PM2_APP_PREFIX, ADMIN_PORT
   khi chạy nhiều bản CMSNT Panel trên cùng máy chủ.

GUIDE
  explained=true
  exit 1
fi

# Chuỗi kết nối database phải đọc được thành URL postgresql:// — migrate ở
# bước sau bắt buộc cần nó, và dừng ở đây rõ ràng hơn là chết sau mấy phút build.
database_url=$(read_env_value apps/api/.env DATABASE_URL || true)
[[ -n ${database_url:-} ]] || fail "apps/api/.env chưa có DATABASE_URL."
db_host_port=$(node -e '
  try {
    const url = new URL(process.argv[1]);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") process.exit(1);
    process.stdout.write(`${url.hostname || "127.0.0.1"} ${url.port || 5432}`);
  } catch {
    process.exit(1);
  }
' "$database_url" 2>/dev/null) ||
  fail "DATABASE_URL trong apps/api/.env không phải URL postgresql:// hợp lệ."
db_host=${db_host_port% *}
db_port=${db_host_port#* }
# Thử mở kết nối TCP bằng Node — máy chủ không chắc có sẵn nc hay psql.
if node -e '
  const net = require("net");
  const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
  socket.setTimeout(3000, () => { socket.destroy(); process.exit(1); });
  socket.once("connect", () => { socket.destroy(); process.exit(0); });
  socket.once("error", () => process.exit(1));
' "$db_host" "$db_port" >/dev/null 2>&1; then
  info "PostgreSQL trả lời ở ${db_host}:${db_port}"
else
  fail "Không nối được PostgreSQL ở ${db_host}:${db_port} (theo DATABASE_URL trong apps/api/.env).
    Bật dịch vụ PostgreSQL, kiểm tra host/cổng rồi chạy lại."
fi

# Tên tiến trình PM2 và cổng — cùng cách đọc với ecosystem.config.cjs.
readonly APP_PREFIX=$(setting PM2_APP_PREFIX cmsnt)
readonly API_APP="${APP_PREFIX}-api"
readonly ADMIN_APP="${APP_PREFIX}-admin"
readonly WEB_APP="${APP_PREFIX}-web"
readonly API_PORT=$(read_env_value apps/api/.env PORT || echo 4317)
readonly ADMIN_PORT=$(setting ADMIN_PORT 3317)
readonly WEB_PORT=$(setting WEB_PORT 3318)
readonly ADMIN_BASE_PATH=$(read_env_value apps/admin/.env NEXT_PUBLIC_ADMIN_BASE_PATH || true)

# ------------------------------------------------------- 3. Phụ thuộc và build

if [[ $skip_deps == false ]]; then
  step "Cài phụ thuộc (vài phút)"
  # Ưu tiên lockfile để máy khách dựng đúng bộ phiên bản đã kiểm thử; bản fork
  # đã tuỳ biến (thêm thư viện) thì lockfile lệch — nới ra thay vì dừng.
  if ! pnpm install --frozen-lockfile; then
    warn "Lockfile không khớp package.json, cài lại ở chế độ thường."
    pnpm install
  fi
fi

# Trình quản lý tệp của aaPanel (nút "Set permissions" đệ quy) áp 644 cho tất
# cả file, xoá luôn bit thực thi của binary trong node_modules — esbuild, next,
# engine của Prisma. Build sau đó chết với EACCES mà không nói vì sao. pnpm
# hard-link từ store nên chmod ở đây vá luôn store, có tác dụng vĩnh viễn.
ensure_executables() {
  local probe
  probe=$(ls -d node_modules/.pnpm/@esbuild+*/node_modules/@esbuild/*/bin/esbuild 2>/dev/null | head -1)
  [[ -n ${probe:-} && ! -x $probe ]] || return 0
  warn "Các binary trong node_modules mất quyền thực thi. Đang cấp lại quyền."
  find node_modules -type f ! -perm -u+x -exec sh -c '
    for file do
      head -c4 "$file" | grep -q ELF && chmod +x "$file"
    done
    exit 0
  ' _ {} + || true
  chmod +x node_modules/.bin/* 2>/dev/null || true
  [[ -x $probe ]] ||
    fail "Vẫn không cấp được quyền thực thi cho ${probe}. Kiểm tra phân vùng có mount kèm noexec: findmnt -T . -o OPTIONS"
}
ensure_executables

step "Build packages dùng chung + sinh Prisma Client"
pnpm --filter @cmsnt/shared build
# Prisma CLI chạy với cwd apps/api và tự đọc apps/api/.env (prisma.config.ts).
pnpm --filter api exec prisma generate

step "Cập nhật cấu trúc database (prisma migrate deploy — chỉ thêm, không xoá)"
pnpm --filter api exec prisma migrate deploy

if [[ $skip_seed == false ]]; then
  step "Seed dữ liệu khởi tạo (idempotent: chỉ thêm khi chưa có)"
  # Tạo tài khoản admin từ SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD, ngôn ngữ,
  # vai trò, cài đặt mặc định. Đặt SEED_DEMO=0 trong apps/api/.env để không có
  # dữ liệu demo. Chạy lại không ghi đè dữ liệu đã có.
  pnpm db:seed
fi

step "Biên dịch API, Admin và website (vài phút)"
pnpm --filter api build
pnpm --filter admin build
# Website khách (apps/web): next build tự nạp apps/web/.env.local (API_URL, NEXT_PUBLIC_*) và nhúng vào bản build.
pnpm --filter web build

# ------------------------------------------------------------------- 4. PM2

if [[ $use_pm2 == false ]]; then
  step "Xong phần dựng mã nguồn"
  info "Bỏ qua PM2 theo yêu cầu (--no-pm2). Tự khởi động bằng: pm2 startOrRestart ecosystem.config.cjs"
  exit 0
fi

if ! command -v pm2 >/dev/null 2>&1; then
  step "Cài PM2"
  npm install -g pm2 ||
    fail "Không cài được PM2. Chạy bằng quyền root: npm install -g pm2"
fi

step "Khởi động dịch vụ"

# PM2 định danh app bằng TÊN, không phải bằng thư mục. Nếu trên máy đã có một
# bản CMSNT Panel khác đăng ký cùng tên, `pm2 restart` sẽ khởi động lại
# tiến trình của bản kia với env của file ecosystem ở đây. Đối chiếu đường dẫn
# trước khi đụng vào.
project_dir=$(pwd -P)
pm2_jlist=$(pm2 jlist 2>/dev/null || true)

# In ra đường dẫn script mà PM2 đang chạy cho một app.
# Mã thoát: 0 có app, 1 chưa có app nào tên đó, 2 không đọc nổi danh sách.
pm2_script_path() {
  printf '%s' "$pm2_jlist" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      // `pm2 jlist` in JSON thuần, nhưng vài bản aaPanel chèn banner phía
      // trước; cắt từ dấu ngoặc vuông đầu tiên rồi mới parse.
      const start = raw.indexOf("[");
      if (start < 0) process.exit(2);
      let list;
      try {
        list = JSON.parse(raw.slice(start));
      } catch {
        process.exit(2);
      }
      const app = list.find((entry) => entry.name === process.argv[1]);
      if (!app) process.exit(1);
      process.stdout.write(app.pm2_env?.pm_exec_path ?? "");
    });
  ' "$1"
}

for app in "$API_APP" "$ADMIN_APP" "$WEB_APP"; do
  running_script=$(pm2_script_path "$app") && probe=0 || probe=$?
  case $probe in
    0)
      if [[ -z $running_script || $running_script != "$project_dir"/* ]]; then
        fail "PM2 đã có app tên \"${app}\" nhưng nó chạy từ ${running_script:-một thư mục khác}, không phải ${project_dir}.
    Khởi động lại nó ở đây sẽ giẫm lên bản đang chạy đó, nên script dừng lại.
    - Muốn chạy song song hai bản: thêm PM2_APP_PREFIX, ADMIN_PORT, WEB_PORT vào ${project_dir}/.env
      (và PORT khác trong apps/api/.env), mỗi thứ một giá trị khác bản kia, rồi chạy lại.
    - Muốn chuyển hẳn bản kia sang thư mục này: 'pm2 delete ${API_APP} ${ADMIN_APP} ${WEB_APP}' rồi chạy lại."
      fi
      ;;
    1) ;;
    *)
      fail "Không đọc được danh sách tiến trình PM2 nên không kiểm tra được app \"${app}\" có thuộc thư mục này không.
    Kiểm tra bằng 'pm2 jlist'. Muốn tự lo phần PM2 thì chạy lại với --no-pm2."
      ;;
  esac
done

# Chỉ khởi động đúng ba app của thư mục này (API + Admin + website khách).
only="${API_APP},${ADMIN_APP},${WEB_APP}"
# `startOrRestart` tự phân biệt app đã có (restart, --update-env để đọc lại
# .env) và app mới (start).
pm2 startOrRestart ecosystem.config.cjs --only "$only" --update-env
pm2 save

# Chờ API trả lời thay vì tin vào mã thoát của pm2: PM2 báo "online" ngay khi
# tiến trình sinh ra, còn Nest thì vài giây sau mới nhận request.
step "Chờ API sẵn sàng"
ready=false
for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:${API_PORT}/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ $ready == false ]]; then
  warn "API chưa trả lời sau 60 giây. Xem log: pm2 logs ${API_APP} --lines 50"
else
  info "API đã sẵn sàng ở 127.0.0.1:${API_PORT}"
fi

# Website render trang bằng dữ liệu của API nên chỉ chờ sau khi API đã lên.
# Chấp nhận mọi mã < 500 (trang có thể chuyển hướng).
step "Chờ website sẵn sàng"
web_ready=false
for _ in $(seq 1 30); do
  if node -e "fetch('http://127.0.0.1:${WEB_PORT}/', { redirect: 'manual' }).then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
    web_ready=true
    break
  fi
  sleep 1
done

if [[ $web_ready == false ]]; then
  warn "Website chưa trả lời sau 30 giây. Xem log: pm2 logs ${WEB_APP} --lines 50"
else
  info "Website đã sẵn sàng ở 127.0.0.1:${WEB_PORT}"
fi

# ---------------------------------------------------------------- 5. Tổng kết

step "Đã dựng xong"
info "Tiến trình PM2: ${API_APP} (API :${API_PORT}), ${ADMIN_APP} (Admin :${ADMIN_PORT}), ${WEB_APP} (Website :${WEB_PORT})"
info "Kiểm tra: pm2 list   |   pm2 logs ${API_APP}"
info "Nên bật PM2 tự chạy sau khi VPS khởi động lại: pm2 startup  (cần quyền root)"

admin_location_prefix=${ADMIN_BASE_PATH:-/admin}
cat <<NGINX

Reverse proxy nginx — hai tiến trình chỉ nghe 127.0.0.1, người dùng đi vào qua
HTTPS của nginx. Admin chạy dưới ${admin_location_prefix} (cần
NEXT_PUBLIC_ADMIN_BASE_PATH=${admin_location_prefix} trong apps/admin/.env rồi build lại admin),
API ở /api và /uploads; gốc domain "/" chuyển hướng về ${admin_location_prefix}:

    server {
        listen 443 ssl http2;
        server_name panel.example.com;
        # ssl_certificate / ssl_certificate_key ... (Let's Encrypt)
        client_max_body_size 50m;

        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;

        # ô tải file AI Studio nhận video / âm thanh tới 1GB (vd video 60 phút cần lồng tiếng)
        location = /api/account/ai/uploads { client_max_body_size 1100m; proxy_read_timeout 900s; proxy_pass http://127.0.0.1:${API_PORT}; }
        location /api/     { proxy_pass http://127.0.0.1:${API_PORT}; }
        location /uploads/ { proxy_pass http://127.0.0.1:${API_PORT}; }
        location = ${admin_location_prefix}  { proxy_pass http://127.0.0.1:${ADMIN_PORT}; }
        location ${admin_location_prefix}/   { proxy_pass http://127.0.0.1:${ADMIN_PORT}; }
        location = /        { return 302 ${admin_location_prefix}; }
    }

Frontend riêng của khách (nếu có) triển khai ở domain khác và gọi API public qua
https://panel.example.com/api/... — nhớ thêm domain đó vào CORS_ORIGINS của API.

Sau khi cấu hình: nginx -t && systemctl reload nginx. Đăng nhập admin bằng
SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD trong apps/api/.env và ĐỔI MẬT KHẨU ngay.
NGINX
