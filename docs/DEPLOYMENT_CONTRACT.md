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
- Every scrape target has the label `job="sample-app"`. **§9 is what produces that label — without
  it every app rule below is silently dead, evaluating an empty vector forever.**
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

---

## §8 Namespace, Postgres, and the workload shape

### Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: sample-app
```

The name must match `sample-app.*` — `SampleAppNotReady` and `SampleAppNoEndpoints` select on it.

### Postgres and the DATABASE_URL secret

The Bitnami postgresql chart creates a database only when `auth.database` is set, **and only on
first init of an empty PVC.** An already-initialised volume needs a one-time manual
`CREATE DATABASE sample_app;`. App migrations create tables, never the database (§2).

```yaml
# HelmRelease values
auth:
  username: sample
  database: sample_app
  existingSecret: sample-app-postgres
```

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: sample-app-db
  namespace: sample-app
stringData:
  DATABASE_URL: postgres://sample:CHANGEME@sample-app-postgres:5432/sample_app
```

### Common to every Deployment

```yaml
      containers:
        - name: app
          image: ghcr.io/OWNER/sample-app-SERVICE:GIT_SHA
          ports:
            - name: http
              containerPort: 3000
          env:
            - name: SERVICE_VERSION
              value: GIT_SHA
            - name: DEPLOYMENT_ENV
              value: dev
          readinessProbe:
            httpGet: { path: /readyz, port: http }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
          resources:
            requests: { cpu: 50m, memory: 96Mi }
            limits: { memory: 256Mi }
```

Annotate every pod template so §9 can find it:

```yaml
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/path: /metrics
    prometheus.io/port: "3000"      # "3001" for settlement-worker
```

`terminationGracePeriodSeconds` must stay above `GRACEFUL_SHUTDOWN_MS` (§3) — the default 30s
clears the default 10s drain.

`memory: 256Mi` is deliberate: it is what makes `SETTLEMENT_BATCH_SIZE=200000` reach the OOM
killer in bounded time instead of swelling forever.

| service | port | extra env | Service exposes |
|---|---|---|---|
| `storefront` | 3000 | `GATEWAY_URL=http://checkout-gateway:3000` | http 3000 — the only one users reach |
| `checkout-gateway` | 3000 | `ORDERS_API_URL=http://orders-api:3000`, `WORKER_URL=http://settlement-worker:3001` | http 3000 |
| `orders-api` | 3000 | `envFrom` the `sample-app-db` secret | http 3000 |
| `settlement-worker` | 3001 | `envFrom` the `sample-app-db` secret, `PORT=3001` | **admin port only** — serves no user traffic |

---

## §9 Prometheus scrape job

**Required, and easy to miss.** If the cluster's Prometheus has
`kubernetes-service-endpoints: enabled: false`, pod annotations alone scrape nothing and every
app-metric rule in §6 is dead — the alerts never fire and never error either.

```yaml
# serverFiles.prometheus.yml scrape_configs
- job_name: sample-app
  kubernetes_sd_configs:
    - role: pod
      namespaces:
        names: [sample-app]
  relabel_configs:
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
      action: keep
      regex: "true"
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
      target_label: __address__
      regex: (.+)
      replacement: $1
      action: replace
    - source_labels: [__meta_kubernetes_namespace]
      target_label: namespace
    - source_labels: [__meta_kubernetes_pod_label_app]
      target_label: service
```

`job_name: sample-app` is what produces the `job="sample-app"` label every rule selects on, and
the last two relabels produce `namespace` and `service` — the labels every rule groups by.

Verify after rollout. An empty result means every app rule is dead:

```sh
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=up{job="sample-app"}'
```

---

## §10 Running a fault scenario in the cluster

The fault catalog is spec §10. Nothing in the test suite asserts that a knob produces its fault
— that needs load, a scrape interval, and a rule evaluation, so it belongs here, not in CI.

**Prerequisite: traffic.** Error-rate and latency are rate-based; they do not exist at zero
requests per second. Run the §5 generator as a Job before expecting any Class 1 alert.

**Baseline before injecting anything** — a green baseline is what makes the fault attributable:

```sh
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=up{job="sample-app"}'                      # expect 4 (5 with a worker admin target)
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=ALERTS{alertstate="firing",alertname=~"SampleApp.*"}'   # expect empty
kubectl -n sample-app exec deploy/storefront -- wget -qO- localhost:3000/status                       # every hop ok
```

**Inject, observe, revert:**

```sh
kubectl -n sample-app set env deploy/orders-api DB_POOL_MAX=1     # or edit the manifest — see the Flux note
# wait: rule window (5m rate) + `for:` (1m) + scrape interval. First firing lands 6-7 minutes in.
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=ALERTS{alertstate="firing",alertname=~"SampleApp.*"}'
kubectl -n sample-app set env deploy/orders-api DB_POOL_MAX-      # revert
```

Expected alert per knob is the `trigger rule` column of spec §10. Three Class 1 knobs
(`SETTLEMENT_BATCH_SIZE`, `MIGRATION_REQUIRED`, `LIVENESS_CHECKS_DB`) trip the cluster's
existing `Kubernetes*` rules rather than a `SampleApp*` one, and two (`VERBOSE_PAYLOAD`,
`ASSET_VERSION`) trip nothing at all by design.

### One trigger per rule

Six rules ship in `docs/alerting/sample-app-rules.yaml`. Each needs a different action — four
are reachable by changing app config, two are not reachable that way at all.

| rule | threshold | what to do | time to fire |
|---|---|---|---|
| `SampleAppHighErrorRate` | 5xx rate > 5% | `kubectl -n sample-app set env deploy/orders-api ORDER_RESPONSE_VERSION=2` | ~6 min |
| `SampleAppHighLatency` | p99 > 1s | `kubectl -n sample-app set env deploy/storefront SSR_CONCURRENCY=1` **and raise `LOADGEN_RPS` to ≥20** | ~6 min |
| `SampleAppSettlementBacklog` | oldest job > 300s | `kubectl -n sample-app set env deploy/settlement-worker SETTLEMENT_POLL_INTERVAL_MS=600000` | **~6 min minimum** |
| `SampleAppTargetDown` | `up == 0` for 2m | `kubectl -n sample-app scale deploy/settlement-worker --replicas=0` | ~2-3 min |
| `SampleAppNotReady` | ready < spec for 5m | patch the readiness probe to a path that does not exist, e.g. `/ready` | ~5-6 min |
| `SampleAppNoEndpoints` | no ready endpoint for 2m | patch the Service selector to `app: sample-app-typo` | ~2-3 min |

Notes that decide whether a run works:

- **`SampleAppHighErrorRate`** — `ORDER_RESPONSE_VERSION=2` fires it on `checkout-gateway`, not
  on `orders-api`: orders-api happily returns 200 in the new shape and the gateway 502s on
  parse. That asymmetry is the scenario. Needs checkout traffic, so keep
  `LOADGEN_CHECKOUT_RATIO` above 0. `DOWNSTREAM_TIMEOUT_MS=50` is the alternative trigger, and
  gives a 504 instead of a 502.
  A 4xx never counts — the gateway forwards upstream 4xx unchanged precisely so a bad cart
  stays out of this rule.
- **`SampleAppHighLatency`** — the threshold is p99 > **1s**, and the histogram's top buckets
  are 1, 2.5, 5, 10. `SSR_CONCURRENCY=1` only crosses 1s if requests actually queue, which
  needs real concurrent load; at 5 rps the storefront keeps up and nothing fires.
  `DB_POOL_MAX=1` on orders-api works the same way and also needs the load.
- **`SampleAppSettlementBacklog`** — the threshold is *oldest job age > 300s*, so nothing can
  fire in under 5 minutes no matter how slow the worker is; the rule's `for: 1m` sits on top of
  that. Raising the poll interval starves the queue but does not backdate the jobs. Scaling the
  worker to 0 is the faster and more honest trigger — but note `queue_depth` and
  `queue_oldest_job_age_seconds` are published *by the worker*, so at 0 replicas the gauges go
  stale rather than climbing, and `SampleAppTargetDown` fires first. To exercise the backlog
  rule specifically, keep one replica alive with a long poll interval and let it age past 300s.
- **`SampleAppNotReady` and `SampleAppNoEndpoints` are not app-config faults.** No env var
  reaches them — they read kube-state-metrics, and their whole point is that the app is fine
  while the cluster serves nothing. Both need a manifest change (probe path, Service selector).
  Confirm kube-state-metrics is deployed and scraped first, or both are dead rules:
  `curl -sG <prometheus>/api/v1/query --data-urlencode 'query=kube_deployment_spec_replicas'`

**`ASSET_VERSION` is the one worth running deliberately.** Set it to a stale SHA: every metric
stays green, every span succeeds, and the storefront is visibly broken in a browser. No alert
fires, so it is reachable only through the agent's Slack-mention path. The correct answer is
that no server-side fault is visible — an agent that invents a cause fails this scenario, and
nothing else in the catalog tests that.

**Flux ownership.** `kubectl set env` on a Flux-managed workload is reverted at the next
reconcile (one-minute poll), which will silently end a scenario mid-run. Either pause the
Kustomization for the duration, or inject through the manifest repo. That revert is itself the
GitOps-drift scenario, whose correct remediation is `flux_reconcile`, not a PR.
