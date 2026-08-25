# MEMORY_BANK.md — devops-sample-app

Persistent context for agentic sessions. Update this when a non-obvious decision is made.

## Current state (2026-08-25)

All 22 tasks complete. 228 tests passing (208 without DB, 228 with DB).

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

### Load generator: a Deployment with a control page, not a Job
`loadgen.ts` is the library (config, `runLoad`, `createLoadRunner`), `loadgen-control.ts` the page
and routes, `loadgen-server.ts` the entry point. Splitting the bootstrap out deleted the old
`argv[1].endsWith("/loadgen.ts")` sniffing, which only existed because the entry lived in a file
the tests import.

- **Concurrency is the knob that matters.** One worker is one in-flight request, so a
  single-worker generator can never make `SSR_CONCURRENCY=1` or `DB_POOL_MAX=1` queue, no matter
  how high the rps. `rps` is the total across workers, not per worker, so raising concurrency
  does not silently double the load.
- The page lives on the generator, never on the storefront: a control route there would land in
  the storefront's own `http_server_*` series and logs, and the STOP button would be served by
  the process the load is overwhelming.
- The generator's pod is deliberately not scraped — its `http_client_*` series would be
  aggregated into `job="sample-app"`.

### Storefront pages: nothing moves when the data does
The status page reloads every 2 seconds and the order page every 5, so the layout is built to
make a reload read as digits changing in place: tabular numerals, a fixed-width state column, a
reason on its own row rather than in a sixth column, and an order state strip that keeps both
outcomes present and dims the unreached one. `formatMs` exists because `RollingStats` reports
p99 as a raw float (`3.548791000000165`), which changed that column's width on every refresh.

A `meta refresh` also discards keyboard focus and re-announces the page to a screen reader every
2 seconds, so `?live=off` renders the same page without the refresh, with a link to resume. It is
a link because there is no client JavaScript to make it anything else.

## Known deviations from spec (from plan §Deviations)

1. `/status` stats come from in-process rolling window, not Prometheus
2. `storefront` CSS is versioned at `/assets/:version/app.css`, not inlined
3. `checkout-gateway` requires `WORKER_URL`
4. `SERVICE_VERSION` defaults to `dev`
5. Health/introspection endpoints excluded from `http_server_*` metrics
6. Load generator lives in storefront, not `tools/` — and it is now a Deployment with a control
   page (`loadgen-server.ts` boots, `loadgen-control.ts` serves), not a Job that runs on start
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
