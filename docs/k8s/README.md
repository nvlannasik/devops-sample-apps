# Reference manifests

**This repo deploys nothing.** These files are handover material — copy them into your manifest
repo, or apply them to a scratch cluster. Nothing here is reconciled from this repository.

| File | What it is |
|---|---|
| `sample-app.yaml` | Namespace, DB secret, migration Job, 4 Deployments + Services, loadgen Job |
| `prometheus-values.yaml` | Scrape job **and** alert rules, as community-chart Helm values |
| `../alerting/sample-app-rules.yaml` | The rules alone — the authoritative copy, kept beside the metric names it queries |

## Order matters

The two files are not independent, and applying only the first is the most common way to end up
with a cluster that looks healthy and alerts on nothing.

```sh
# 1. Workloads
sed -e 's|ghcr.io/OWNER|<your-registry>|g' -e "s|GIT_SHA|$(git rev-parse --short HEAD)|g" \
  docs/k8s/sample-app.yaml | kubectl apply -f -

# 2. Prometheus — merge prometheus-values.yaml into your prometheus release, then reconcile.
#    Without this every rule below evaluates an empty vector: nothing fires, nothing errors.

# 3. Verify. Both must be non-empty before any scenario means anything.
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=up{job="sample-app"}'
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=count by (service) (up{job="sample-app"})'
```

Edit the `sample-app-db` Secret in `sample-app.yaml` before applying: `DB_PASSWORD` is
`CHANGEME` and `DB_HOST` assumes a Postgres service named `sample-app-postgres`. The database must already exist —
the Bitnami chart creates it only when `auth.database` is set and only on first init of an empty
PVC. App migrations create tables, never the database.

## What each piece is load-bearing for

- **The pod `app` label** is relabelled to `service` by the scrape job. Every rule groups by
  `(namespace, service)`. Rename the label and the rules keep evaluating but stop distinguishing
  services.
- **The namespace name** must match `sample-app.*` — `SampleAppNotReady` and
  `SampleAppNoEndpoints` select on it.
- **`terminationGracePeriodSeconds: 30`** must stay above `GRACEFUL_SHUTDOWN_MS` (default 10s).
  Below it, the kubelet SIGKILLs mid-drain and in-flight requests die as connection resets with
  nothing in any log.
- **`memory: 256Mi` on settlement-worker** is what makes `SETTLEMENT_BATCH_SIZE=200000` reach
  the OOM killer in bounded time instead of swelling forever.
- **The loadgen Job** is a prerequisite, not an extra: error-rate and latency are rate-based and
  do not exist at zero requests per second.

## Deliberately not here

- **kube-state-metrics** — `SampleAppNotReady` and `SampleAppNoEndpoints` read it, and most
  clusters already run it. Confirm before relying on those two:
  `curl -sG <prometheus>/api/v1/query --data-urlencode 'query=kube_deployment_spec_replicas'`
- **Ingress** — cluster-specific. Reach the storefront with
  `kubectl -n sample-app port-forward svc/storefront 8080:3000`.
- **NetworkPolicy, HPA, PDB** — this is a fault-injection target, not a production workload.
- **A tracing backend** — set `OTEL_EXPORTER_OTLP_ENDPOINT` on all four Deployments once one
  exists. Until then the services log one warning at boot and run without tracing.

## Running a fault scenario

See [`../DEPLOYMENT_CONTRACT.md` §10](../DEPLOYMENT_CONTRACT.md#10-running-a-fault-scenario-in-the-cluster):
one working trigger per rule, the timing each needs, and the two traps that void a run silently
(Flux reverting `kubectl set env`, and rate-based rules with no load).
