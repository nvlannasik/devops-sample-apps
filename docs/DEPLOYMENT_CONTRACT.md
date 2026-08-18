# Deployment Contract

This document captures every decision an operator must agree to before this workload can run
and be observed correctly. It is the handover document from the development team to the
platform team.

---

## §1 Images

Four images are produced from this repo. All share the same build context (repo root) and are
pushed with the same tag: the 7-character git SHA.

| Service | Dockerfile |
|---|---|
| `storefront` | `services/storefront/Dockerfile` |
| `checkout-gateway` | `services/checkout-gateway/Dockerfile` |
| `orders-api` | `services/orders-api/Dockerfile` |
| `settlement-worker` | `services/settlement-worker/Dockerfile` |

Build command (replace `<sha>` with `git rev-parse --short HEAD`):

```sh
docker build -f services/<name>/Dockerfile --build-arg SERVICE_VERSION=<sha> -t <name>:<sha> .
```

---

## §2 Schema migrations

Migrations must run **before** any new `orders-api` or `settlement-worker` pod starts.

```yaml
# Kubernetes Job — runs once per release, must complete successfully before the Deployment rolls.
command: ["node", "services/orders-api/dist/db/migrate-cli.js"]
env:
  DATABASE_URL: <secret>
  SERVICE_VERSION: <sha>
```

The advisory lock (`pg_advisory_lock(4927313)`) serialises concurrent migration runners, so
concurrent init containers from a surge deployment are safe.

`MIGRATION_REQUIRED=true` (the default) makes `orders-api` and `settlement-worker` refuse to
boot against an un-migrated schema. Set `MIGRATION_REQUIRED=false` to bypass.

---

## §3 Environment variables and fault knobs

Every variable has a documented default. The variables marked **fault knob** are the ones the
`devops-ai-agent` incident catalog exercises.

### Common to every service

Read by `loadCommonConfig` in `@sample-app/platform`, so all four services accept all of these.

| Variable | Default | Fault knob |
|---|---|---|
| `PORT` | `3000` | — |
| `NODE_ENV` | `production` | — |
| `LOG_LEVEL` | `info` (`debug\|info\|warn\|error`) | — |
| `SERVICE_VERSION` | `dev` | — set to the git SHA; labels every metric and log line |
| `DEPLOYMENT_ENV` | `dev` | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _unset_ (tracing off) | — see §7 |
| `GRACEFUL_SHUTDOWN_MS` | `10000` | ✓ raise above `terminationGracePeriodSeconds` to make the kubelet SIGKILL mid-drain |

`GRACEFUL_SHUTDOWN_MS` is how long a pod keeps serving after SIGTERM. Keep
`terminationGracePeriodSeconds` above it, or the kubelet kills the process while it is still
draining and in-flight requests die as connection resets with no error in any log.

### storefront

| Variable | Default | Fault knob |
|---|---|---|
| `GATEWAY_URL` | _required_ | — |
| `GATEWAY_TIMEOUT_MS` | `2000` | ✓ set below real latency to cause 504 storms |
| `SSR_CONCURRENCY` | `32` | ✓ set to `1` for head-of-line blocking |
| `ASSET_VERSION` | `$SERVICE_VERSION` | ✓ set to stale SHA to cause asset 404s |
| `ASSET_CACHE_SECONDS` | `3600` | — |

### checkout-gateway

| Variable | Default | Fault knob |
|---|---|---|
| `ORDERS_API_URL` | _required_ | — |
| `WORKER_URL` | _required_ | — |
| `DOWNSTREAM_TIMEOUT_MS` | `2000` | ✓ |
| `CACHE_TTL_SECONDS` | `30` | ✓ set to `0` to disable cache |
| `CACHE_MAX_ENTRIES` | `1000` | — |

### orders-api

| Variable | Default | Fault knob |
|---|---|---|
| `DATABASE_URL` | _required_ | — |
| `DB_POOL_MAX` | `10` | ✓ set to `1` to serialise DB access |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | ✓ |
| `ORDER_RESPONSE_VERSION` | `1` | ✓ set to `2` to break checkout-gateway |
| `LIVENESS_CHECKS_DB` | `false` | ✓ set to `true` to cause restart storm |
| `MIGRATION_REQUIRED` | `true` | — |

### settlement-worker

| Variable | Default | Fault knob |
|---|---|---|
| `DATABASE_URL` | _required_ | — |
| `SETTLEMENT_BATCH_SIZE` | `50` | ✓ large values grow heap |
| `SETTLEMENT_POLL_INTERVAL_MS` | `1000` | ✓ raise above arrival rate to cause backlog |
| `SETTLEMENT_MAX_ATTEMPTS` | `3` | — |
| `DB_POOL_MAX` | `5` | — |
| `VERBOSE_PAYLOAD` | `false` | ✓ set to `true` to emit order items in logs |

---

## §4 Ports and health endpoints

Every service exposes the same set of built-in routes on its `PORT` (default `3000`):

| Route | Description |
|---|---|
| `GET /healthz` | Always `{"status":"ok"}` if the process is alive |
| `GET /readyz` | `{"status":"ok"}` when the service is ready to serve traffic |
| `GET /metrics` | Prometheus metrics (text/plain) |

Additionally:

- `settlement-worker` exposes `GET /queue-stats` — used by `checkout-gateway` chain-status
- All services expose `GET /stats` — p99/error-rate/request-count over the last 60 seconds

---

## §5 Load generator

The load generator lives in the `storefront` image:

```sh
# From a laptop
TARGET_URL=http://storefront:3000 LOADGEN_RPS=20 node services/storefront/dist/loadgen.js

# In-cluster Job
command: ["node", "services/storefront/dist/loadgen.js"]
env:
  TARGET_URL: http://storefront.sample-app.svc.cluster.local:3000
  LOADGEN_RPS: "50"
  LOADGEN_DURATION_SECONDS: "0"   # 0 = run until killed
```

| Variable | Default |
|---|---|
| `TARGET_URL` | _required_ |
| `LOADGEN_RPS` | `5` |
| `LOADGEN_DURATION_SECONDS` | `0` (run until killed) |
| `LOADGEN_CHECKOUT_RATIO` | `0.3` — share of requests that check out; the rest browse |

---

## §6 Alert rules

`docs/alerting/sample-app-rules.yaml` is a fragment of `serverFiles.alerting_rules.yml.groups`
for the community `prometheus` Helm chart. Merge it into the chart's `values.yaml`:

```yaml
serverFiles:
  alerting_rules.yml:
    groups:
      # ... existing groups ...
      # paste the contents of docs/alerting/sample-app-rules.yaml here
```

**Assumptions the rules make:**
- Every scrape target has the label `job="sample-app"`.
- The workloads live in a namespace that matches `sample-app.*`.

**kube-state-metrics compatibility note** — `SampleAppNoEndpoints` ships the modern form:

```yaml
expr: sum by (namespace, endpoint) (kube_endpoint_address{namespace=~"sample-app.*",ready="true"}) == 0
```

If your cluster runs kube-state-metrics < 2.0, use the deprecated form instead:

```yaml
expr: kube_endpoint_address_available{namespace=~"sample-app.*"} == 0
```

Verify which form your cluster exports:

```sh
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=kube_endpoint_address' | head
```

---

## §7 Tracing (optional)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on every pod to enable distributed tracing. Without it
the SDK starts but no spans are exported. The `settlement-worker` links its span back to the
checkout request's trace via the `traceparent` column — do not omit this endpoint if incident
response depends on the async trace path.
