FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/settlement-worker/package.json services/settlement-worker/

RUN npm ci --ignore-scripts

COPY packages/ packages/
COPY services/settlement-worker/ services/settlement-worker/

RUN npm run build -w @sample-app/contracts \
 && npm run build -w @sample-app/platform \
 && npm run build -w @sample-app/settlement-worker


FROM node:24-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/settlement-worker/package.json services/settlement-worker/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/services/settlement-worker/dist services/settlement-worker/dist

ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "services/settlement-worker/dist/index.js"]