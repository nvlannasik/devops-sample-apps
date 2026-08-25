# MEMORY_BANK.md — devops-sample-app

Persistent context for agentic sessions. Update this when a non-obvious decision is made.

## Current state (2026-08-25)

All 22 tasks complete. 201 tests passing (181 without DB, 201 with DB).

## Architectural decisions

### DB connection: discrete DB_* variables, no DATABASE_URL
`loadDbConfig` / `pgSsl` in `@sample-app/platform` read `DB_HOST`, `DB_PORT`, `DB_USERNAME`,
`DB_PASSWORD`, `DB_NAME`, `DB_SSL_MODE` — deliberately the same names `devops-ai-agent` reads,
so one Postgres Secret fits either workload. This supersedes `DATABASE_URL` in spec §11 and
the §3 tables; `TEST_DATABASE_URL` is unaffected — it is a test-harness connection string
handed straight to `pg`, not app config.

Two consequences worth remembering:
- `redactConfig` now recurses into nested groups. It previously only inspected top-level
  strings, so `config.db.password` would have been logged in clear at boot.
- `DB_SSL_MODE` is validated against the four libpq modes. The agent's version is not; a typo
  there silently means `disable`, i.e. an unencrypted connection believed to be encrypted.

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
DB_HOST=127.0.0.1 DB_USERNAME=sample DB_PASSWORD=sample npm run migrate:dev -w @sample-app/orders-api
```
