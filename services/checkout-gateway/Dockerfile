# Build context is the repository root — packages/ is shared by every service.
FROM node:26-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/checkout-gateway/package.json services/checkout-gateway/

RUN npm ci --ignore-scripts

COPY packages/ packages/
COPY services/checkout-gateway/ services/checkout-gateway/

RUN npm run build -w @sample-app/contracts \
 && npm run build -w @sample-app/platform \
 && npm run build -w @sample-app/checkout-gateway


FROM node:26-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/checkout-gateway/package.json services/checkout-gateway/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/services/checkout-gateway/dist services/checkout-gateway/dist

ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# The preload starts OpenTelemetry before the service's ESM graph loads — instrumenting from
# index.ts is too late (packages/platform/src/tracing-preload.ts). The name is the resource's.
ENV OTEL_SERVICE_NAME=checkout-gateway
CMD ["node", "--import", "./packages/platform/dist/tracing-preload.js", "services/checkout-gateway/dist/index.js"]