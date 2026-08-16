# devops-sample-app — Design

A four-service e-commerce checkout stack, built to be broken on purpose, so the
`devops-ai-agent` incident path can be exercised against failures that look and behave like
production failures.

**Status:** approved design, not yet implemented.
**Repo:** `devops-sample-app` (new; sibling of `devops-ai-agent`, `devops-mcp-server`, `llm-worker`).

---

## 1. Purpose and non-goals

### Purpose

The agent's entry point is an Alertmanager webhook. To evaluate it end to end we need a
workload that can produce **real** faults with **real** evidence in all four places the agent
can look: Kubernetes state, Prometheus metrics, Loki logs, and distributed traces — and that
can make an alerting rule fire so an investigation actually starts.

### Non-goals

- Not a chaos-engineering framework. There is no `/chaos/*` endpoint and no fault daemon.
- Not the benchmark harness. `devops-ai-agent/docs/BENCHMARK_agent_stack.md` is **on hold**;
  this repo does not implement case files, scoring, or a judge. It is the workload those
  would eventually drive.
- Not a load-testing tool. The included generator exists only to make rate-based symptoms
  observable.
- Not production commerce. No payments, no auth, no PII.

### The design rule that everything else follows

**Every fault has a genuine mechanism, and its cause is a plausible production config value
visible in cluster state.**

A knob named `ARTIFICIAL_LATENCY_MS` would make the root cause invisible: it exists only in
process memory, appears in no tool result, and the agent could never legitimately find it.
The best possible answer would be "the pod is slow", which measures nothing. Instead
`DB_POOL_MAX=1` genuinely serialises database access — real queueing, real p99, real span
widening — and the value itself is right there in `k8s_describe_pod`.

---

## 2. Topology

```
browser ─▶ storefront ─▶ checkout-gateway ─▶ orders-api ─▶ postgres
  (SSR)                    (BFF, cache)      (writes)        │
                                                             │ settlement_jobs
                                                             ▼
                                                     settlement-worker
```

Four hops end to end. That depth is the point: the alert fires at the top, and the fault is
often three hops down. Blaming the service whose alert fired is the most common wrong answer
in real incident response, and a shallow topology cannot test for it.

### Why four separate images, not one image with a role switch

A single image driven by `APP_ROLE` would give all four services **one shared tag**. Rolling
out "a new version of orders-api" would move storefront and worker too, so the classic
incident *"the 14:32 deploy of A broke B"* could not be staged honestly — and correlating
error onset to a deploy timestamp is precisely the reasoning under test. Independent images
mean independent release cycles.

The cost is accepted and must be documented in the repo: four Dockerfiles, and **every build
context is the repo root** because `packages/` is shared.

---

## 3. Repository layout

```
devops-sample-app/
├── package.json                     # npm workspaces root (npm built-in; no nx/turbo/lerna)
├── tsconfig.base.json
├── packages/
│   ├── platform/                    # config loader, logger, metrics registry, OTel bootstrap,
│   │                                #   graceful shutdown, HTTP server helpers
│   └── contracts/                   # request/response shapes, settlement job payload
├── services/
│   ├── storefront/                  # Dockerfile, package.json, src/, *.test.ts
│   ├── checkout-gateway/
│   ├── orders-api/
│   └── settlement-worker/
├── db/
│   └── migrations/                  # plain .sql, applied by the migrate entrypoint
├── tools/
│   └── loadgen/                     # single-file traffic generator
├── docs/
│   ├── DEPLOYMENT_CONTRACT.md       # what the cluster must provide (operator-facing)
│   └── alerting/sample-app-rules.yaml
├── docker-compose.yml               # local dev/prod parity
├── README.md
├── CLAUDE.md
└── MEMORY_BANK.md
```

`packages/platform` is a deliberate shared module. Three copies of the OTel bootstrap would
drift, and this workspace already carries that scar: `toOpenAIMessages()` exists in two repos
with a comment warning "change one, change the other". Inside one repo there is no reason to
repeat it. It does not weaken the four-image story — each image builds only its own service
plus the packages it imports.

### Conventions (inherited from the workspace)

- Node 24, TypeScript ESM (NodeNext). `*.test.ts` excluded from builds.
- Tests: `node:test` + `tsx`. No test framework dependency.
- Docker builder stage uses `npm ci --ignore-scripts`; runtime stage `npm ci --omit=dev`.
  Dropping `--ignore-scripts` makes cross-arch builds fail intermittently with `ETXTBSY`
  (esbuild's postinstall execs the binary it just wrote, under QEMU that races the write).
- Image tag = git SHA, matching the pattern already used by `sarang-tani-api` in the GitOps repo.
- Docs in English; chat in Indonesian.

### Dependencies

Only two dependency families, plus `pg` where a database is actually used:

| package | why not stdlib |
|---|---|
| `prom-client` | A hand-rolled histogram with slightly wrong buckets, `_sum`/`_count`, or a missing `le="+Inf"` makes p99 queries lie. The agent would then be diagnosing our bug instead of the injected fault. |
| `@opentelemetry/sdk-node` + auto-instrumentation for `http` and `pg` | Auto-instrumentation is the reason to take the dependency: every HTTP hop and every SQL statement gets a span with no manual code, so "the slow span is two services down" emerges from reality rather than from us writing it that way. |
| `pg` | `orders-api` and `settlement-worker` only. |

Everything else is stdlib: `node:http`, the built-in `fetch`, `node:test`.

Dependency sets differ by service on purpose — `storefront` and `checkout-gateway` carry no
database driver at all, so each tier's failure modes have a distinct character.

---

## 4. Services

### 4.1 `storefront` — SSR web UI

Server-rendered HTML from template literals, a single inline `<style>` block, **zero client
JavaScript**. Auto-refresh on `/status` via `<meta http-equiv="refresh" content="2">`.

This mirrors `devops-ai-agent/src/dashboard/`, and it is a deliberate choice rather than
laziness: **a client-side failure leaves no trace in Loki, Prometheus, or the tracing backend.**
A React error in the browser is invisible to every MCP tool the agent has, so an SPA would
build a large class of faults that are undiagnosable by construction. SSR gives every symptom
a human sees a matching span, metric, and log line on the server.

| route | behaviour |
|---|---|
| `GET /` | Catalog page. Static product list rendered server-side. |
| `POST /checkout` | Form post → `POST {GATEWAY_URL}/api/checkout` → 303 redirect to `/orders/:id`. |
| `GET /orders/:id` | Order status page → `GET {GATEWAY_URL}/api/orders/:id`. |
| `GET /status` | Live 4-hop chain view (below). |
| `GET /healthz` `GET /readyz` `GET /metrics` | See §8, §6. |

**`/status` is the visualisation.** It renders the chain with, per hop: p99 latency, error
rate, ready replicas, plus queue depth and oldest-job age for the worker. Refreshing every two
seconds, a fault can be watched propagating upward from the worker to the front page.

It is for human eyes only. The agent never opens a browser — it has MCP tools and nothing
else — so this page cannot become a shortcut that makes diagnosis falsely easy.

`/status` fetches `GET {GATEWAY_URL}/api/chain-status`. If that call fails, the page renders
with the failed hops marked unreachable; it never 500s, because a status page that dies during
an incident is worthless.

### 4.2 `checkout-gateway` — BFF

| route | behaviour |
|---|---|
| `POST /api/checkout` | → `POST {ORDERS_API_URL}/orders`. No cache. |
| `GET /api/orders/:id` | → `GET {ORDERS_API_URL}/orders/:id`, through an in-process TTL cache. |
| `GET /api/chain-status` | Aggregates its own health + `orders-api` `/readyz` + `settlement-worker` `/queue-stats`. Each hop is fetched independently; one failing hop is reported as unreachable, never fatal. |
| `GET /healthz` `GET /readyz` `GET /metrics` | |

The cache is explicitly per-process and must be correct when cold (12-factor VI). It is a
plain `Map` with TTL and a max-entry bound — not a backing service.

### 4.3 `orders-api` — business logic

| route | behaviour |
|---|---|
| `POST /orders` | Insert order **and** enqueue its settlement job in one transaction. Returns the created order. |
| `GET /orders/:id` | Read one order. 404 when absent. |
| `GET /orders?limit=N` | List recent orders (`limit` capped at 100). |
| `GET /healthz` `GET /readyz` `GET /metrics` | |

Response shape is versioned by `ORDER_RESPONSE_VERSION` (§5) — v2 renames `amount_cents` to
`amountCents` and nests `customer`. This is a genuine breaking schema change, not a simulated
one: `checkout-gateway` really fails to parse it.

### 4.4 `settlement-worker` — async

No traffic HTTP server. An admin port serves `/healthz`, `/readyz`, `/metrics`, and
`/queue-stats` (`{ depth, oldestAgeSeconds }`, consumed by `chain-status`). The worker owns the
queue, so it is the only service that reads `settlement_jobs` for reporting — `orders-api`
writes jobs but never reports on them.

Loop: claim a batch → settle each order (update `orders.status`) → delete the job rows →
sleep `SETTLEMENT_POLL_INTERVAL_MS`. On failure, increment `attempts` and set `available_at`
to a backoff; past `SETTLEMENT_MAX_ATTEMPTS` the order goes to `status='failed'`.

---

## 5. Data model

```sql
CREATE TABLE orders (
  id            uuid PRIMARY KEY,
  customer_id   text        NOT NULL,
  items         jsonb       NOT NULL,
  amount_cents  bigint      NOT NULL,
  status        text        NOT NULL,   -- placed | settled | failed
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settlement_jobs (
  id            bigserial   PRIMARY KEY,
  order_id      uuid        NOT NULL REFERENCES orders(id),
  attempts      int         NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  traceparent   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX settlement_jobs_claimable
  ON settlement_jobs (available_at) WHERE locked_at IS NULL;
```

Claim, using the standard skip-locked pattern:

```sql
UPDATE settlement_jobs
   SET locked_at = now(), attempts = attempts + 1
 WHERE id IN (
   SELECT id FROM settlement_jobs
    WHERE locked_at IS NULL AND available_at <= now()
    ORDER BY available_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
 )
RETURNING *;
```

**Postgres is the only backing service, and the queue lives in it on purpose.** It creates one
shared failure domain: when the database degrades, `orders-api` and `settlement-worker` degrade
together while `storefront` and `checkout-gateway` are pure victims. That is a real cascade,
not a staged one — and it is the shape of incident where naming the true root cause is hardest.

`traceparent` is stored on the job row so the worker's span links back to the checkout request
that created it. Most teams skip this and the async side becomes a blind spot; here it is the
difference between "settlement for order X failed" being traceable to its request or not.

---

## 6. Configuration

All behaviour comes from environment variables. No per-environment config files (12-factor III).

Config is parsed and validated at boot; an invalid value exits non-zero with the reason on
stdout. The resolved config is then logged **once**, redacted, so the fault knob is findable in
Loki as well as in `k8s_describe_pod`.

### Common to all four services

| var | default | notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | Service binds it itself (12-factor VII). |
| `LOG_LEVEL` | `info` | |
| `SERVICE_VERSION` | — | Git SHA, injected at build. Re-exposed via `build_info`. |
| `DEPLOYMENT_ENV` | `dev` | Becomes `deployment.environment` on spans. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Unset disables tracing cleanly, with one warning log. |
| `GRACEFUL_SHUTDOWN_MS` | `10000` | **Fault knob.** |

### `storefront`

| var | default | notes |
|---|---|---|
| `GATEWAY_URL` | — | required |
| `GATEWAY_TIMEOUT_MS` | `2000` | **Fault knob.** |
| `SSR_CONCURRENCY` | `32` | **Fault knob.** Bounded render concurrency; excess requests queue. |
| `ASSET_CACHE_SECONDS` | `3600` | **Fault knob.** `Cache-Control` max-age on static assets. |
| `ASSET_VERSION` | = `SERVICE_VERSION` | **Fault knob.** Asset URLs are `/assets/<ASSET_VERSION>/…`; a wrong value 404s every asset. |

### `checkout-gateway`

| var | default | notes |
|---|---|---|
| `ORDERS_API_URL` | — | required |
| `DOWNSTREAM_TIMEOUT_MS` | `2000` | **Fault knob.** |
| `CACHE_TTL_SECONDS` | `30` | **Fault knob.** `0` disables caching. |
| `CACHE_MAX_ENTRIES` | `1000` | |

### `orders-api`

| var | default | notes |
|---|---|---|
| `DATABASE_URL` | — | required |
| `DB_POOL_MAX` | `10` | **Fault knob.** |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | **Fault knob.** |
| `MIGRATION_REQUIRED` | `true` | **Fault knob.** Verifies schema version at boot; mismatch exits 1. |
| `ORDER_RESPONSE_VERSION` | `1` | **Fault knob.** `2` is a breaking schema change. |
| `LIVENESS_CHECKS_DB` | `false` | **Fault knob.** See §8. |

### `settlement-worker`

| var | default | notes |
|---|---|---|
| `DATABASE_URL` | — | required |
| `DB_POOL_MAX` | `5` | **Fault knob.** |
| `SETTLEMENT_BATCH_SIZE` | `50` | **Fault knob.** Rows loaded into memory per claim. |
| `SETTLEMENT_POLL_INTERVAL_MS` | `1000` | **Fault knob.** |
| `SETTLEMENT_MAX_ATTEMPTS` | `3` | |
| `VERBOSE_PAYLOAD` | `false` | **Fault knob.** Logs the full order payload per job. |

---

## 7. Observability contract

### 7.1 Metrics

Exposed at `GET /metrics` on every service, Prometheus text format.

```
http_server_requests_total{service,method,route,status}                counter
http_server_request_duration_seconds{service,method,route}             histogram
http_client_requests_total{service,peer,status}                        counter
http_client_request_duration_seconds{service,peer}                     histogram
db_pool_connections{service,state="idle"|"busy"|"waiting"}             gauge
db_query_duration_seconds{service,operation}                           histogram
cache_requests_total{service,result="hit"|"miss"}                      counter
queue_depth{queue="settlement"}                                        gauge
queue_oldest_job_age_seconds{queue="settlement"}                       gauge
settlement_jobs_total{result="ok"|"failed"|"retried"}                  counter
settlement_batch_size                                                  histogram
build_info{service,version,commit}                                     gauge (always 1)
```

Plus `prom-client` default `process_*` / `nodejs_*` collectors.

Histogram buckets: `0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5 10` seconds.

Two of these carry disproportionate weight:

- **`http_client_*`** makes "the gateway is slow because orders-api is slow" answerable from
  metrics alone, without any trace. Traces then confirm rather than being the only path — which
  matters because the cluster has **no tracing backend deployed today** (§11).
- **`build_info`** is how error onset gets correlated to the running version. Without it that
  correlation is only reachable via `k8s_list_replicasets`.

**The `route` label must be the template (`/orders/:id`), never the raw path.** Raw paths mean
unbounded cardinality, a slow Prometheus, and an incident we caused ourselves.

`queue_depth` and `queue_oldest_job_age_seconds` are exported by `settlement-worker`; when the
worker is down nobody exports them, which is itself the signal (`SampleAppTargetDown` covers it).

### 7.2 Traces

OpenTelemetry semantic conventions: `service.name`, `service.version`,
`deployment.environment`. Application attributes: `app.order_id`, `app.batch_size`,
`app.cache_result`.

Failed spans **must** set status `ERROR` and record an `exception` event — otherwise
`tracing_search` cannot filter for errors and the tracing tools become decorative.

W3C `traceparent` propagates across every HTTP hop, and through the queue via the
`settlement_jobs.traceparent` column (§5).

### 7.3 Logs

One JSON object per line to stdout. Never to a file (12-factor XI).

```json
{"ts":"2026-08-16T09:14:22.417Z","level":"error","service":"orders-api",
 "version":"a1b2c3d","msg":"settlement enqueue failed",
 "trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7",
 "order_id":"018f...","err":{"type":"DatabaseError","msg":"...","stack":"..."}}
```

`trace_id` is the join key across Loki, the tracing backend, and the agent's Slack thread —
the same discipline as `traceId` in the agent ↔ llm-worker contract, where one `grep` joins
three places.

The cluster's Fluent Bit runs `Merge_Log On`, so these fields are parsed and filterable from
LogQL without extra configuration.

---

## 8. Health, readiness, and error handling

**Fail loudly at boot, degrade honestly at runtime.**

Invalid config exits non-zero with the reason on stdout. A CrashLoop whose cause is readable
is a feature.

At runtime, a downstream failure produces: an HTTP 502/503 with a JSON body carrying
`trace_id`, one log line, and one metric increment. Nothing is swallowed.

`/healthz` and `/readyz` are deliberately different:

| endpoint | checks | on failure |
|---|---|---|
| `/healthz` (liveness) | process is alive. **No dependency checks.** | kubelet restarts the pod |
| `/readyz` (readiness) | DB reachable, pool not exhausted, downstream reachable | pod removed from endpoints |

Conflating them is the classic bug that turns a brief database stall into a cluster-wide
restart storm. `LIVENESS_CHECKS_DB=true` reproduces exactly that, and it is one of the more
valuable faults in the catalog because the symptom (everything restarting at once) points
nowhere near the cause.

**Graceful shutdown (12-factor IX):** on SIGTERM, HTTP services stop accepting new
connections, drain in-flight requests up to `GRACEFUL_SHUTDOWN_MS`, close the pool, exit 0.
The worker finishes its current batch and claims no new one. With the default, a rollout
produces **zero** 5xx; with `GRACEFUL_SHUTDOWN_MS=0` every deploy produces a 5xx burst.

---

## 9. Alerting contract

**This repo owns the alert rule definitions**, published as
`docs/alerting/sample-app-rules.yaml`. Not because the repo deploys anything — it does not —
but because the rules query the metric names in §7.1. Renaming a metric must break its rule in
the same commit. Wiring the fragment into the cluster is the operator's task (§11).

Format is a `serverFiles.alerting_rules.yml.groups` fragment. The cluster runs the community
`prometheus` chart, not the Prometheus Operator, so `PrometheusRule` CRDs do not apply.

### 9.1 Rules are symptom-level, never cause-level

A rule named `SampleAppDbPoolExhausted` would state the answer in the alert. There would be
nothing left to diagnose, and the evaluation would measure nothing.

This matters more than it used to: `alertmanager_get_alerts` is now the agent's Blast Radius
call, made unfiltered at the start of an investigation. A cause-level rule would hand the
agent the answer in its first tool call.

So only user-visible impact pages. Cause signals stay as **metrics the agent must go and find**.

### 9.2 The rules

All app rules use `for: 1m`. Production equivalents use 2–5m; this is a **deliberate
divergence from parity**, made to keep the test cycle short, and it is recorded here so it is
not mistaken for an oversight.

| alertname | expression (abridged) | severity | closes the gap for |
|---|---|---|---|
| `SampleAppHighErrorRate` | `sum by (namespace,service) (rate(http_server_requests_total{job="sample-app",status=~"5.."}[5m])) / sum by (namespace,service) (rate(http_server_requests_total{job="sample-app"}[5m])) > 0.05` | critical | `DOWNSTREAM_TIMEOUT_MS`, `ORDER_RESPONSE_VERSION`, `GRACEFUL_SHUTDOWN_MS` |
| `SampleAppHighLatency` | `histogram_quantile(0.99, sum by (namespace,service,le) (rate(http_server_request_duration_seconds_bucket{job="sample-app"}[5m]))) > 1` | critical | `DB_POOL_MAX`, `CACHE_TTL_SECONDS`, `SSR_CONCURRENCY` |
| `SampleAppSettlementBacklog` | `max by (namespace,queue) (queue_oldest_job_age_seconds{job="sample-app"}) > 300` | warning | the async path — the only symptom of a stalled worker |
| `SampleAppTargetDown` | `up{job="sample-app"} == 0` (`for: 2m`) | critical | a process gone without CrashLooping |
| `SampleAppNotReady` | `kube_deployment_spec_replicas{namespace=~"sample-app.*"} - on(namespace,deployment) kube_deployment_status_replicas_ready{namespace=~"sample-app.*"} > 0` (`for: 5m`) | warning | **wrong probe path** — pod phase is `Running`, so no existing rule sees it |
| `SampleAppNoEndpoints` | `kube_endpoint_address_available{namespace=~"sample-app.*"} == 0` (`for: 2m`) | critical | **Service selector mismatch** — every pod is healthy |

The last two read kube-state-metrics rather than app metrics, necessarily: their symptom is
that the app is serving nothing at all.

**Version check required at implementation time:** `kube_endpoint_address_available` was
deprecated in kube-state-metrics v2.x in favour of `kube_endpoint_address{ready="true"}`.
Query the running kube-state-metrics for whichever exists and use that; do not assume.

Rules assume the scrape job is labelled `job="sample-app"` and the workloads live in a
namespace matching `sample-app.*`. Both are stated in `DEPLOYMENT_CONTRACT.md` so the
operator's scrape configuration and these expressions agree.

### 9.3 Grouping is free coverage

The cluster's Alertmanager route uses `group_by: ["alertname", "namespace"]`. When storefront,
gateway, and orders-api all breach the error-rate threshold together, the three alerts collapse
into **one group containing three alerts** — exercising the agent's group-correlation path with
no extra work.

---

## 10. Fault catalog

Two classes. Class 2 requires no application code at all.

### Class 1 — driven by application configuration

| knob | genuine mechanism | evidence trail | trigger rule |
|---|---|---|---|
| `DB_POOL_MAX=1` | DB access truly serialises | p99 rises, `pg` spans widen, `db_pool_connections{state="waiting"}` climbs | `SampleAppHighLatency` |
| `CACHE_TTL_SECONDS=0` | every read becomes a DB hit | `cache_requests_total{result="hit"}` flat, DB QPS jumps | `SampleAppHighLatency` |
| `SETTLEMENT_BATCH_SIZE=200000` | the batch really enters the heap | OOMKilled, exit 137, working set climbs linearly | `KubernetesContainerOomKiller` (existing) |
| `DOWNSTREAM_TIMEOUT_MS=50` | upstream healthy, caller gives up first | gateway 5xx, gateway span ERROR, **orders-api span OK** | `SampleAppHighErrorRate` |
| `ORDER_RESPONSE_VERSION=2` | field genuinely renamed | gateway parse errors begin at the orders-api rollout timestamp | `SampleAppHighErrorRate` |
| `MIGRATION_REQUIRED=true` without migration | boot genuinely fails | CrashLoop, exit 1, reason logged | `KubernetesPodCrashLooping` (existing) |
| `LIVENESS_CHECKS_DB=true` + slow DB | kubelet kills healthy pods | cluster-wide restart storm | `KubernetesPodCrashLooping` (existing) |
| `SSR_CONCURRENCY=1` | real head-of-line blocking at the edge | storefront TTFB explodes, **every tier below is healthy** | `SampleAppHighLatency` |
| `GRACEFUL_SHUTDOWN_MS=0` | connections cut mid-request | 5xx burst on every deploy, nothing between deploys | `SampleAppHighErrorRate` |
| `SETTLEMENT_POLL_INTERVAL_MS=60000` | worker genuinely falls behind arrivals | `queue_depth` and oldest-age climb monotonically | `SampleAppSettlementBacklog` |
| `VERBOSE_PAYLOAD=true` | logs really flood | a single `k8s_get_pod_logs` returns hundreds of KB | *(mention-path only)* |
| `ASSET_VERSION` wrong | assets genuinely 404 | **all server metrics green, all spans OK, product visibly broken** | *(mention-path only)* |

### Class 2 — manifest only, zero application code

| fault | trigger rule |
|---|---|
| image tag does not exist | `KubernetesPodNotHealthy` (existing) |
| private image without pull secret | `KubernetesPodNotHealthy` (existing) |
| memory limit below working set | `KubernetesContainerOomKiller` (existing) |
| missing ConfigMap key | `KubernetesPodNotHealthy` (existing) |
| `cpu: 64` request | `KubernetesPodNotHealthy` (existing) |
| non-existent `storageClassName` | `KubernetesPodNotHealthy` (existing) |
| readiness probe path wrong | `SampleAppNotReady` (**new**) |
| Service selector mismatch | `SampleAppNoEndpoints` (**new**) |
| ServiceAccount missing `list` on pods | *(mention-path only)* |

### Mention-path-only faults

Three faults have no rule and are not oversights. Each produces no metric a symptom-level rule
could honestly fire on, and inventing one would mean writing a cause-level alert. They are
reachable through the agent's Slack-mention path, which is a **different code path**: a bounded
tool budget (`MENTION_TOOL_ROUNDS`), an active namespace scope lock, and conversational output
instead of the RCA template.

`ASSET_VERSION` deserves emphasis. Every metric is green, every span succeeds, and the product
is visibly broken. The correct agent answer is to state that no server-side fault is visible
and lower its confidence — not to invent a cause. Nothing else in the catalog tests that
honesty against a symptom a human can actually see.

---

## 11. Deployment contract (operator-facing)

The repo builds and publishes images and rule definitions. It deploys nothing. `main` of
`gitops-devops-ai-manifest` is Flux-reconciled on a one-minute poll with no PR gate — pushing
there **is** deploying — so everything below is handed over, not applied.

`docs/DEPLOYMENT_CONTRACT.md` states each item with copy-ready YAML:

1. **Namespace** matching `sample-app.*`.
2. **Postgres database** and a `DATABASE_URL` secret. The Bitnami chart creates a database only
   when `auth.database` is set, and only on first init of an empty PVC — an already-initialised
   volume needs a one-time manual `CREATE DATABASE`.
3. **Migration Job** — same image, `npm run migrate`, run before the app rollout (12-factor XII).
4. **Four Deployments + Services.** The worker's Service exposes only the admin port.
5. **A Prometheus scrape job labelled `job="sample-app"`.** Required, and easy to miss: the dev
   overlay sets `kubernetes-service-endpoints: enabled: false`, so pod/service annotations alone
   scrape nothing. Without this job every app-metric rule is silently dead.
6. **The alert rule fragment**, merged into `serverFiles.alerting_rules.yml.groups` in
   `apps/base/systems/prometheus/release.yaml`.
7. **A tracing backend and `OTEL_EXPORTER_OTLP_ENDPOINT`.** Currently absent:
   `apps/base/systems/jaeger/` is an empty directory and is not in the dev kustomization, while
   `devops-mcp-server` is configured with `TRACING_URL=http://jaeger-query.observability…`,
   which resolves to nothing. Until this exists, tracing faults degrade to metrics-and-logs —
   which is why `http_client_*` metrics carry so much of the diagnostic load (§7.1).
8. **Flux ownership.** These workloads should be Flux-managed like any other app. Note the
   consequence: a fault injected with `kubectl` on a Flux-managed workload will be reverted at
   the next reconcile — which is itself the GitOps-drift scenario, and the correct remediation
   for it is `flux_reconcile`, not a PR.

---

## 12. Testing

`node:test` + `tsx`, per workspace convention.

In scope:

- config parsing and validation — a bad value must fail boot with a readable reason
- metrics registry shape — routes are templated, no raw path ever reaches a label
- `traceparent` round-trip through the queue — written on enqueue, restored on claim
- graceful shutdown — in-flight requests complete, no new ones accepted, exit code 0
- migration runner idempotency — running twice is a no-op
- cache correctness when cold, and TTL expiry
- `ORDER_RESPONSE_VERSION` v1/v2 serialisation, both shapes pinned

Explicitly out of scope: asserting that a fault knob produces a fault. That is what the cluster
is for, and a unit test of it would only assert our own mock.

The load generator (`tools/loadgen`) runs from anywhere — a laptop, or an in-cluster Job using
the storefront image. It drives `storefront`, not the gateway, so simulated traffic traverses
the whole chain the way a browser would. Rate-based symptoms (error rate, p99) do not exist at
zero requests per second, so it is a prerequisite for most of Class 1, not an extra.

---

## 13. Known limits

- **Tracing is aspirational until a backend is deployed.** Spans are produced and exported, but
  with no collector reachable they go nowhere. Every fault in the catalog is diagnosable from
  metrics and logs alone; traces sharpen the answer rather than enabling it.
- **`for: 1m` on app rules is not production parity.** Deliberate, for cycle time (§9.2).
- **Rate-based faults need load.** Without the generator, error-rate and latency rules never
  fire regardless of configuration.
- **Four images is real overhead.** Four Dockerfiles, four build pipelines, and a shared root
  build context that is easy to get wrong. Accepted in exchange for independent release cycles
  (§2).
- **Prometheus retention is 12 days and `persistentVolume` is disabled** in the dev overlay, so
  a Prometheus restart discards history. Investigations that depend on a range query across a
  deploy boundary can be invalidated by an unrelated restart.
