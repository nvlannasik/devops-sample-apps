# Build context is the repository root — packages/ is shared by every service.
FROM node:26-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/orders-api/package.json services/orders-api/

# --ignore-scripts: this stage only runs `tsc`, but npm ci also installs tsx, whose esbuild
# dependency has a postinstall that EXECS the binary it just wrote. Under QEMU emulation —
# any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the write and
# dies with ETXTBSY. No dependency here needs its install scripts.
RUN npm ci --ignore-scripts

COPY packages/ packages/
COPY services/orders-api/ services/orders-api/

RUN npm run build -w @sample-app/contracts \
 && npm run build -w @sample-app/platform \
 && npm run build -w @sample-app/orders-api


FROM node:26-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/orders-api/package.json services/orders-api/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/services/orders-api/dist services/orders-api/dist
# The migration Job runs `node services/orders-api/dist/db/migrate-cli.js` from this image.
COPY db/migrations db/migrations

ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# The preload starts OpenTelemetry before the service's ESM graph loads — instrumenting from
# index.ts is too late (packages/platform/src/tracing-preload.ts). The name is the resource's.
ENV OTEL_SERVICE_NAME=orders-api
CMD ["node", "--import", "./packages/platform/dist/tracing-preload.js", "services/orders-api/dist/index.js"]