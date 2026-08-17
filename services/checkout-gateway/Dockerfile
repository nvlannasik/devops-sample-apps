# Build context is the repository root — packages/ is shared by every service.
FROM node:24-alpine AS builder

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


FROM node:24-alpine AS runtime

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

CMD ["node", "services/checkout-gateway/dist/index.js"]