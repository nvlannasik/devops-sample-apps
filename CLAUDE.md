# CLAUDE.md — devops-sample-app

## Environment

- **Node 24 required.** Every shell running `npm`/`node` must start with:
  ```bash
  export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
  ```
- **TypeScript ESM, `module`/`moduleResolution` = NodeNext.** Every relative import ends in `.js` even though the source is `.ts`.
- **Tests: `node:test` + `tsx`.** No jest, vitest, mocha, chai, or sinon.

## Build & test

```bash
npm run build:libs          # compile @sample-app/contracts and @sample-app/platform
npm test                    # build:libs + run all *.test.ts files (201 tests)
npm run build               # compile everything including services
```

Database-backed tests (20) skip when `TEST_DATABASE_URL` is unset. Set it to run them — each
DB test file creates and drops its own Postgres schema, so they are safe to run in parallel
against a shared database and never touch your dev tables:
```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test
```

## Repository structure

```
packages/
  contracts/   types + catalog pricing — zero runtime deps
  platform/    config, logger, metrics, http-server, http-client, shutdown, tracing, semaphore
services/
  storefront/           SSR HTML, versioned CSS, load generator
  checkout-gateway/     BFF, TTL cache, chain-status
  orders-api/           writes + DB migrations
  settlement-worker/    SKIP LOCKED queue drain
db/migrations/          SQL run by orders-api migrate-cli
docs/
  DEPLOYMENT_CONTRACT.md
  alerting/sample-app-rules.yaml
```

## Key platform APIs

- `createApp(deps)` — the ONLY server factory. /healthz, /readyz, /metrics, /stats, route
  metrics. Probe paths are excluded from `http_server_*`. Tests boot it too: a test-only
  server variant is how `/stats`, probe exclusion and the liveness knob all silently broke.
- `installShutdown(opts)` — SIGTERM handler, returns callable for tests
- `createHttpClient(deps)` — instrumented fetch with peer-labeled metrics
- `loadDbConfig(env)` + `pgSsl(mode)` — the DB connection, read from discrete `DB_*` variables
  (the same names devops-ai-agent uses). There is no `DATABASE_URL`; `TEST_DATABASE_URL` is
  unrelated and stays a URL.
- `createSemaphore(limit)` — bounded concurrency
- `RollingStats` — in-process p99/error-rate over 60s window

## Fault knobs

See `docs/DEPLOYMENT_CONTRACT.md §3` for the full table. Key ones:
- `ORDER_RESPONSE_VERSION=2` — breaks checkout-gateway parse
- `ASSET_VERSION=stale` — asset 404s with all metrics green
- `GATEWAY_TIMEOUT_MS=50` — gateway timeout storm
- `SSR_CONCURRENCY=1` — head-of-line blocking at storefront

## Global constraints

- No new npm dependencies. The closed list is in the plan.
- Never `git push`, never create a branch or PR.
- Docs in English. Chat in Indonesian.
- This repo deploys nothing. It publishes images and docs.
