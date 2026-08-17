# MEMORY_BANK.md — devops-sample-app

Persistent context for agentic sessions. Update this when a non-obvious decision is made.

## Current state (2026-08-17)

All 22 tasks complete. 195 tests passing (175 without DB, 195 with DB).

## Architectural decisions

### Platform file naming vs plan
The plan listed `http-server.ts`, `http-client.ts`, `tracing.ts`. Implemented as:
- `http.ts` — legacy HTTP server helpers (`createHttpServer`, `buildRouter`, `route`, `sendJson`, `sendHtml`, `sendText`, `createAppServer`)
- `http-server.ts` — `createApp` with full built-in routes, rolling stats, probe exclusion
- Both are exported from `index.ts`; services use `createApp` from `http-server.ts`
- `otel.ts` and `tracing.ts` both exist — `otel.ts` is the old SDK init (unused), `tracing.ts` is the new one

### Route types
Two RouteHandler types coexist intentionally:
- `RouteHandler` (router.ts) — `(ctx: RouteContext) => void|Promise<void>` — used by `createApp`, `createAppServer`, all services
- `HttpRouteHandler` (http.ts) — `(req, res, params)` — internal to `createHttpServer` (legacy)

### Settlement worker db path
Plan specified `services/settlement-worker/src/db.ts`. Implemented as:
- `services/settlement-worker/src/db/pool.ts`
- `services/settlement-worker/src/db/queue.ts`

### Shutdown API
Plan specified `installShutdown` returning `() => Promise<void>`.
`registerShutdown` is kept as a backward-compat alias.
Services were updated to use `installShutdown` with `tasks: [...]` instead of `hooks: [...]`.

## Known deviations from spec (from plan §Deviations)

1. `/status` stats come from in-process rolling window, not Prometheus
2. `storefront` CSS is versioned at `/assets/:version/app.css`, not inlined
3. `checkout-gateway` requires `WORKER_URL`
4. `SERVICE_VERSION` defaults to `dev`
5. Health/introspection endpoints excluded from `http_server_*` metrics
6. Load generator lives in storefront, not `tools/`
7. `settlement_jobs.id` is bigserial, typed as string
8. `kube_endpoint_address` modern form in alert rules

## Test commands

```bash
# All tests (no DB)
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test

# All tests (with DB)
docker compose up -d postgres
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test

# Migration end-to-end
DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm run migrate:dev -w @sample-app/orders-api
```
