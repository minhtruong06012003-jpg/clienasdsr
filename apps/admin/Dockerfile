# Build: docker build -f apps/admin/Dockerfile --build-arg API_URL=http://api:4317 -t cmsnt-admin .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
ARG API_URL=http://api:4317
ARG NEXT_PUBLIC_WEB_URL=
# basePath của admin, phải có lúc build (Next nhúng vào bản build); để trống nếu admin ở subdomain riêng
ARG NEXT_PUBLIC_ADMIN_BASE_PATH=/admin
ENV API_URL=$API_URL NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL NEXT_PUBLIC_ADMIN_BASE_PATH=$NEXT_PUBLIC_ADMIN_BASE_PATH NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile --filter admin... \
  && pnpm --filter @cmsnt/shared build \
  && pnpm --filter admin build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3317 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/admin/.next/standalone ./
COPY --from=build /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=build /repo/apps/admin/public ./apps/admin/public
EXPOSE 3317
CMD ["node", "apps/admin/server.js"]
