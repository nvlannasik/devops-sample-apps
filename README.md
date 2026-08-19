# devops-sample-app

A four-service e-commerce checkout stack that exercises the `devops-ai-agent` incident response
path. Every fault in the catalog is backed by a real config knob that produces a plausible
production failure mode.

## Architecture

```
Browser / loadgen
       │
       ▼
  storefront          SSR, zero client JS, versioned CSS
       │
       ▼
checkout-gateway      BFF, TTL cache, chain-status aggregation
       │
       ▼
  orders-api          Writes orders + enqueues settlement jobs
       │
       ▼
   Postgres           orders + settlement_jobs tables
       ▲
       │
settlement-worker     SKIP LOCKED drain loop
```

## Quick start

```bash
# Requires Docker and Node 24
cp .env.example .env
docker compose up -d --build
# Wait ~15s for images to build and migrations to run
curl http://localhost:8080/          # storefront catalog
curl http://localhost:8080/status    # chain status page
```

Ports: storefront `8080`, checkout-gateway `8081`, orders-api `8082`, settlement-worker `8083`.

## Development

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm install
npm run build:libs
npm test                              # 195 tests, 20 DB tests skip without Postgres
docker compose up -d postgres
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test  # all 195 pass
```

## Load generator

```bash
# Laptop
TARGET_URL=http://localhost:8080 LOADGEN_RPS=20 npm run loadgen

# In-cluster Job (uses the storefront image, no extra image needed)
# command: ["node", "services/storefront/dist/loadgen.js"]
# env: TARGET_URL, LOADGEN_RPS, LOADGEN_DURATION_SECONDS
```

## Fault catalog

The seven below are the quick-start subset. The authoritative catalog is
[spec §10](docs/superpowers/specs/2026-08-16-sample-app-design.md#10-fault-catalog): twelve
config-driven faults plus nine that need only a manifest change, each with the alert rule it is
expected to trip. Every knob's default lives in
[`DEPLOYMENT_CONTRACT.md` §3](docs/DEPLOYMENT_CONTRACT.md#3-environment-variables-and-fault-knobs).

Note what is deliberately absent: no test asserts that a knob produces its fault. That needs a
cluster, load, and a scrape interval — a unit test of it would assert our own mock (spec §12).
Running one for real is
[`DEPLOYMENT_CONTRACT.md` §10](docs/DEPLOYMENT_CONTRACT.md#10-running-a-fault-scenario-in-the-cluster):
baseline, inject, wait out the rule window, revert.

| Fault | Env var | Value | Symptom |
|---|---|---|---|
| Gateway timeout | `GATEWAY_TIMEOUT_MS` | `50` | Storefront 504 storm, orders-api healthy |
| SSR queue backup | `SSR_CONCURRENCY` | `1` | Storefront TTFB explodes, downstream fine |
| Stale assets | `ASSET_VERSION` | `old-sha` | Product page broken, all metrics green |
| Response schema break | `ORDER_RESPONSE_VERSION` | `2` | Gateway parse errors, orders-api healthy |
| Settlement backlog | `SETTLEMENT_POLL_INTERVAL_MS` | `60000` | Queue depth climbs, no 5xx |
| Pool exhaustion | `DB_POOL_MAX` | `1` | orders-api p99 climbs under load |
| Liveness restart storm | `LIVENESS_CHECKS_DB` | `true` | Pods restart on DB blip |

## Packages

- **`@sample-app/contracts`** — shared types and catalog pricing (zero runtime deps)
- **`@sample-app/platform`** — config, logger, metrics, tracing, HTTP server/client, shutdown, semaphore, rolling stats

## Docs

- [`docs/DEPLOYMENT_CONTRACT.md`](docs/DEPLOYMENT_CONTRACT.md) — operator handover, and
  [§3](docs/DEPLOYMENT_CONTRACT.md#3-environment-variables-and-fault-knobs) is the single env
  var reference: common vars first, then one table per service. Services carry no README of
  their own — two copies of an env table drift.
- [`docs/alerting/sample-app-rules.yaml`](docs/alerting/sample-app-rules.yaml) — Prometheus alert rules
- [`docs/k8s/`](docs/k8s/) — reference manifests: the four Deployments and Services, the
  migration and loadgen Jobs, and the Prometheus scrape job. Copy-and-edit material; this repo
  deploys nothing.
