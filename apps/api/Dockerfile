# Build: docker build -f apps/api/Dockerfile -t cmsnt-api .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter api... \
  && pnpm --filter @cmsnt/shared build \
  && pnpm --filter api exec prisma generate \
  && pnpm --filter api build \
  && pnpm --filter api deploy --prod --legacy /out \
  && cp -r apps/api/dist apps/api/prisma apps/api/prisma.config.ts apps/api/src/generated /out/ 2>/dev/null || true

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# pg_dump/psql cho tính năng sao lưu/khôi phục trong admin (phiên bản client phải >= phiên bản PostgreSQL server)
RUN apk add --no-cache postgresql18-client || apk add --no-cache postgresql-client
COPY --from=build /out ./
# package.json gốc monorepo: nguồn số phiên bản lõi (config/app-version.ts đọc root-package.json khi không có cây monorepo)
COPY --from=build /repo/package.json ./root-package.json
RUN mkdir -p uploads backups
EXPOSE 4317
# Áp migration (an toàn, chỉ thêm) rồi chạy server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
