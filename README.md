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

Ports: storefront `8080`, checkout-gateway `8081`, orders-api `8082`, settlement-worker `8083`,
loadgen `8090`.

## Development

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm install
npm run build:libs
npm test                              # 261 tests, 20 DB tests skip without Postgres
docker compose up -d postgres
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test  # all 261 pass
```

## Load generator

A traffic source with a control page. It runs as its own Deployment (from the storefront image —
no extra image), comes up **idle**, and starts, re-rates and stops from a button, so driving load
never means editing a workload.

`docker compose up` brings it up alongside the rest; the storefront header then carries a
**Load generator** button pointing at it (password `local-demo`).

```bash
# In-cluster
kubectl -n sample-app port-forward svc/sample-app-loadgen 8090:3000

# Standalone, against a local stack
TARGET_URL=http://localhost:8080 LOADGEN_UI_PASSWORD=secret LOADGEN_UI_COOKIE_SECURE=false npm run loadgen

# ...or skip the page and drive immediately
TARGET_URL=http://localhost:8080 LOADGEN_RPS=20 LOADGEN_AUTOSTART=true npm run loadgen
```

The page is behind a shared password with a signed session cookie and a failed-login throttle —
the same design as the agent's dashboard. With `LOADGEN_UI_PASSWORD` unset it serves 503 rather
than an anonymous Start button. Set `LOADGEN_UI_URL` on the storefront to show the header button;
a browser follows it, so it must be an address a browser can reach.

`LOADGEN_CONCURRENCY` (default `1`) is how many requests are in flight at once, and it is what
decides whether a latency scenario works at all: one worker is one request at a time, so it never
makes a server with `SSR_CONCURRENCY=1` or `DB_POOL_MAX=1` queue — no matter how high the rps.
Raise it to 5+ for those. See [`DEPLOYMENT_CONTRACT.md` §5](docs/DEPLOYMENT_CONTRACT.md#5-load-generator).


## API authentication

`checkout-gateway` gates `/api` behind a bearer token. `GATEWAY_AUTH_TOKEN` is one value set on
both the gateway (which enforces it) and the storefront (which presents it) — the same shape as
`MCP_AUTH_TOKEN` between the agent and the MCP server, and deliberately not the session-and-login
the load generator uses: the storefront cannot fill in a form.

Unset leaves `/api` open with a warning at boot. `docker compose` sets a token anyway, so the
default local run exercises the authenticated path rather than hiding a wiring mistake.

The probes and `/metrics` are **not** gated — they sit above the gate, so a missing token can
never take a pod out of service or blind Prometheus. That also means they answer on the same
port: route only `/api` at the Ingress. See
[`DEPLOYMENT_CONTRACT.md` §3](docs/DEPLOYMENT_CONTRACT.md#api-authentication).

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
  migration Job, the loadgen Deployment, and the Prometheus scrape job. Copy-and-edit material; this repo
  deploys nothing.
