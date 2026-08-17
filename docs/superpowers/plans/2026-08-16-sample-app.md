# devops-sample-app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a four-service e-commerce checkout stack that emits real metrics, traces, and logs, and whose faults are driven by plausible production config values — so the `devops-ai-agent` incident path can be exercised against failures that behave like production failures.

**Architecture:** An npm-workspaces monorepo. Two shared packages (`@sample-app/contracts` for types + catalog pricing, `@sample-app/platform` for config, logging, metrics, HTTP server/client, tracing, shutdown) and four independently-imaged services: `storefront` (SSR, zero client JS) → `checkout-gateway` (BFF + TTL cache) → `orders-api` (writes) → Postgres, with `settlement-worker` draining a `settlement_jobs` queue that lives in the same database. Every service exposes `/healthz`, `/readyz`, `/metrics`, `/stats`. The repo publishes images plus alert-rule definitions and a deployment contract; it deploys nothing.

**Tech Stack:** Node 24, TypeScript ESM (NodeNext), `node:test` + `tsx`, `prom-client`, OpenTelemetry (`sdk-node` + `instrumentation-http` + `instrumentation-pg`), `pg`, Postgres 16, Docker.

**Spec:** `docs/superpowers/specs/2026-08-16-sample-app-design.md` — read section references (§N) against it.

## Global Constraints

- **Node 24 required.** The default shell node is v14. Every shell that runs `npm`/`node` must start with: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH`
- **TypeScript ESM, `module`/`moduleResolution` = `NodeNext`.** Every relative import ends in `.js` even though the source is `.ts`.
- **Tests are `node:test` + `tsx`.** No test framework dependency — no jest, vitest, mocha, chai, sinon.
- **`*.test.ts` is excluded from every build** (`exclude` in each `tsconfig.json`).
- **npm workspaces only.** No nx, turbo, lerna, pnpm, or yarn.
- **The dependency list is closed.** Runtime: `prom-client`, `pg`, `@opentelemetry/api`, `@opentelemetry/core`, `@opentelemetry/sdk-node`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-pg`. Dev: `typescript`, `tsx`, `@types/node`, `@types/pg`. Nothing else may be added — everything else is stdlib (`node:http`, built-in `fetch`, `node:crypto`, `node:test`).
- **Docker builder stage uses `npm ci --ignore-scripts`; runtime stage uses `npm ci --omit=dev`.** Dropping `--ignore-scripts` makes cross-arch builds fail intermittently with `ETXTBSY` (esbuild's postinstall execs the binary it just wrote; under QEMU that races the write).
- **Every Docker build context is the repo root**, because `packages/` is shared. Each service's Dockerfile lives at `services/<name>/Dockerfile` and is selected with `-f`.
- **Image tag = git SHA**, matching `sarang-tani-api` in the GitOps repo.
- **Zero client JavaScript in `storefront`.** No `<script>` tag, ever. Auto-refresh uses `<meta http-equiv="refresh">`.
- **The `route` metric label is always the route template (`/orders/:id`), never the raw path.** Raw paths mean unbounded cardinality and a Prometheus incident we caused ourselves.
- **Histogram buckets for every duration metric:** `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` (seconds).
- **Alert rules are symptom-level, never cause-level.** A rule named after the cause hands the agent the answer in its first tool call.
- **Docs are written in English.** (Chat with the user is Indonesian.)
- **This repo deploys nothing.** It publishes images, `docs/alerting/sample-app-rules.yaml`, and `docs/DEPLOYMENT_CONTRACT.md`. It never touches `gitops-devops-ai-manifest` — pushing there is deploying.
- **Never `git push`, and never create a branch or PR.** Per-task local commits are part of the TDD loop; publishing is the user's decision alone.
- **Fail loudly at boot, degrade honestly at runtime.** Invalid config exits non-zero with the reason on stdout. A downstream failure produces an HTTP 502/504 with a JSON body, one log line, and one metric increment. Nothing is swallowed.

## Deviations from the spec (decided while planning — read before Task 1)

Each of these resolves a gap where the spec as written could not be implemented, or would have violated its own §1 design rule. They are deliberate; do not "fix" them back.

1. **`/status` per-hop numbers come from an in-process 60-second rolling window, not from Prometheus.** Spec §4.1 asks for p99, error rate, and ready replicas per hop. Prometheus and the Kubernetes API are both outside the closed dependency list, so each service exposes `GET /stats` (p99, error rate, request count over the last 60s) computed from the same middleware that feeds the metrics, and `chain-status` aggregates those. **Ready replicas is dropped** — it needs the Kubernetes API. Hop reachability (`ok` / `degraded` / `unreachable`) replaces it.
2. **`storefront` CSS is served from `/assets/:version/app.css`, not inlined.** Spec §4.1 says "a single inline `<style>` block", but spec §6 makes a wrong `ASSET_VERSION` a fault whose symptom is "assets genuinely 404". Inline CSS cannot 404, so the inline version would leave that fault with no mechanism — violating §1. The stylesheet is served from the versioned path and linked with `<link rel="stylesheet">`. Still zero client JS.
3. **`checkout-gateway` gains a required `WORKER_URL`.** Spec §4.2 has `chain-status` aggregate `settlement-worker`'s `/queue-stats`, but the §6 config table lists only `ORDERS_API_URL`. The gateway cannot call a service whose address it does not have.
4. **`SERVICE_VERSION` defaults to `dev`** instead of being strictly required, so `npm run dev` and the test suite work without it. The Dockerfile injects the real git SHA via a build ARG.
5. **Health and introspection endpoints are excluded from `http_server_*` metrics and from the rolling stats.** `/healthz`, `/readyz`, `/metrics`, `/stats`. A kubelet probing `/readyz` during a database blip would otherwise emit a steady stream of 503s into `http_server_requests_total`, firing `SampleAppHighErrorRate` with a cause that is not user-facing at all. Excluding them keeps the error-rate rule about real user traffic.
6. **The load generator lives at `services/storefront/src/loadgen.ts`, not `tools/loadgen/`.** Spec §12 wants it runnable "from a laptop, or an in-cluster Job using the storefront image". A `tools/` script is not in any image; as part of the storefront workspace it compiles to `dist/loadgen.js` and the in-cluster Job becomes `command: ["node", "services/storefront/dist/loadgen.js"]` with no fifth image and no extra Dockerfile.
7. **`settlement_jobs.id` is `bigserial`, and node-postgres returns `int8` as a JavaScript string.** Job ids are typed `string` end to end. Do not coerce them to `number`.
8. **`kube_endpoint_address_available` vs `kube_endpoint_address{ready="true"}`** cannot be resolved from inside this repo (spec §9.2 requires checking the running kube-state-metrics). `docs/alerting/sample-app-rules.yaml` ships the modern form and `DEPLOYMENT_CONTRACT.md` carries both variants plus the one-liner that tells the operator which one their cluster exports.

## File structure

```
devops-sample-app/
├── package.json                              # workspaces root; build/test/loadgen scripts
├── package-lock.json
├── tsconfig.base.json                        # shared compilerOptions
├── tsconfig.json                             # root; used by editors + tsx
├── .gitignore  .dockerignore  .env.example
├── docker-compose.yml                        # postgres + migrate + 4 services
├── README.md  CLAUDE.md  MEMORY_BANK.md
├── db/migrations/
│   ├── 001_orders.sql                        # orders table
│   └── 002_settlement_jobs.sql               # queue table + partial index
├── docs/
│   ├── DEPLOYMENT_CONTRACT.md                # operator handover, copy-ready YAML
│   ├── alerting/sample-app-rules.yaml        # serverFiles.alerting_rules.yml fragment
│   ├── superpowers/specs/2026-08-16-sample-app-design.md
│   └── superpowers/plans/2026-08-16-sample-app.md
├── packages/
│   ├── contracts/                            # types shared across services; no runtime deps
│   │   └── src/{index,orders,catalog,chain}.ts
│   └── platform/                             # every cross-cutting concern, one file each
│       └── src/{index,config,logger,metrics,rolling-stats,router,
│                 http-server,http-client,shutdown,semaphore,tracing}.ts
└── services/
    ├── storefront/       src/{index,config,views,catalog-page,routes,loadgen}.ts
    ├── checkout-gateway/ src/{index,config,cache,chain,routes}.ts
    ├── orders-api/       src/{index,config,serialize,routes,db/{pool,migrate,migrate-cli,orders-repo}}.ts
    └── settlement-worker/src/{index,config,db/{pool,queue},worker,admin}.ts
```

One responsibility per file. `platform` is where a second copy would otherwise appear — this workspace already carries the scar of `toOpenAIMessages()` duplicated across two repos with a "change one, change the other" comment; inside one repo there is no excuse.

---

### Task 1: Workspace scaffold and `@sample-app/contracts`

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`, `src/orders.ts`, `src/catalog.ts`, `src/chain.ts`
- Test: `packages/contracts/src/catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: package `@sample-app/contracts` exporting `OrderStatus`, `OrderItem`, `CartItem`, `OrderRow`, `CreateOrderRequest`, `OrderV1`, `OrderV2`, `CATALOG`, `UnknownSkuError`, `priceOf(sku): number | null`, `computeItems(cart): OrderItem[]`, `computeAmountCents(items): number`, `HopState`, `ServiceStats`, `HopStatus`, `QueueStats`, `ChainStatus`. Root scripts `npm run build:libs`, `npm test`.

- [x] **Step 1: Initialise the repo and root files**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
cd /Users/annasik/riset/devops-sample-app
git init
mkdir -p packages/contracts/src packages/platform/src db/migrations docs/alerting
mkdir -p services/storefront/src services/checkout-gateway/src services/orders-api/src services/settlement-worker/src
```

`package.json`:

```json
{
  "name": "devops-sample-app",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Four-service checkout stack used to exercise the devops-ai-agent incident path",
  "workspaces": ["packages/*", "services/*"],
  "scripts": {
    "build:libs": "npm run build -w @sample-app/contracts && npm run build -w @sample-app/platform",
    "build": "npm run build:libs && npm run build -w @sample-app/storefront && npm run build -w @sample-app/checkout-gateway && npm run build -w @sample-app/orders-api && npm run build -w @sample-app/settlement-worker",
    "test": "npm run build:libs && node --import tsx --test \"packages/**/src/**/*.test.ts\" \"services/**/src/**/*.test.ts\"",
    "loadgen": "node --import tsx services/storefront/src/loadgen.ts"
  },
  "devDependencies": {
    "@types/node": "25.9.1",
    "tsx": "4.22.3",
    "typescript": "6.0.3"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`tsconfig.json` (root; editors and `tsx` read this one):

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["packages/*/src/**/*.ts", "services/*/src/**/*.ts"]
}
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.env
```

`.dockerignore`:

```
node_modules
**/node_modules
**/dist
.git
docs
*.md
docker-compose.yml
```

- [x] **Step 2: Create the contracts package**

`packages/contracts/package.json`:

```json
{
  "name": "@sample-app/contracts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json" }
}
```

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [x] **Step 3: Write the failing test**

`packages/contracts/src/catalog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, priceOf, computeItems, computeAmountCents, UnknownSkuError } from "./catalog.js";

test("catalog is non-empty and every sku is unique", () => {
  assert.ok(CATALOG.length >= 3);
  assert.equal(new Set(CATALOG.map((p) => p.sku)).size, CATALOG.length);
});

test("priceOf returns the unit price for a known sku", () => {
  assert.equal(priceOf(CATALOG[0]!.sku), CATALOG[0]!.unitCents);
});

test("priceOf returns null for an unknown sku", () => {
  assert.equal(priceOf("nope"), null);
});

test("computeItems attaches the catalog price to each cart line", () => {
  const items = computeItems([{ sku: "sku-widget", qty: 2 }]);
  assert.deepEqual(items, [{ sku: "sku-widget", qty: 2, unitCents: priceOf("sku-widget") }]);
});

test("computeItems rejects an unknown sku with UnknownSkuError", () => {
  assert.throws(() => computeItems([{ sku: "ghost", qty: 1 }]), UnknownSkuError);
});

test("computeItems rejects a non-positive quantity", () => {
  assert.throws(() => computeItems([{ sku: "sku-widget", qty: 0 }]), /qty/);
});

test("computeAmountCents multiplies and sums every line", () => {
  const amount = computeAmountCents([
    { sku: "a", qty: 2, unitCents: 150 },
    { sku: "b", qty: 3, unitCents: 1000 },
  ]);
  assert.equal(amount, 3300);
});
```

- [x] **Step 4: Run the test to verify it fails**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm install
npm test
```

Expected: FAIL — `Cannot find module './catalog.js'`.

- [x] **Step 5: Write `packages/contracts/src/catalog.ts`**

```ts
export interface CatalogProduct {
  sku: string;
  name: string;
  unitCents: number;
}

/** The product list is static and shared: storefront renders it, orders-api prices from it. */
export const CATALOG: readonly CatalogProduct[] = [
  { sku: "sku-widget", name: "Widget", unitCents: 1299 },
  { sku: "sku-gizmo", name: "Gizmo", unitCents: 4550 },
  { sku: "sku-doodad", name: "Doodad", unitCents: 799 },
  { sku: "sku-thingamajig", name: "Thingamajig", unitCents: 15999 },
];

export class UnknownSkuError extends Error {
  readonly sku: string;
  constructor(sku: string) {
    super(`unknown sku: ${sku}`);
    this.name = "UnknownSkuError";
    this.sku = sku;
  }
}

export function priceOf(sku: string): number | null {
  return CATALOG.find((p) => p.sku === sku)?.unitCents ?? null;
}

export interface CartItem {
  sku: string;
  qty: number;
}

export interface OrderItem {
  sku: string;
  qty: number;
  unitCents: number;
}

/** Prices a cart server-side. The client never sends a price. */
export function computeItems(cart: CartItem[]): OrderItem[] {
  return cart.map((line) => {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      throw new Error(`invalid qty for ${line.sku}: qty must be a positive integer`);
    }
    const unitCents = priceOf(line.sku);
    if (unitCents === null) throw new UnknownSkuError(line.sku);
    return { sku: line.sku, qty: line.qty, unitCents };
  });
}

export function computeAmountCents(items: OrderItem[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.unitCents, 0);
}
```

- [x] **Step 6: Write `packages/contracts/src/orders.ts`**

```ts
import type { CartItem, OrderItem } from "./catalog.js";

export type OrderStatus = "placed" | "settled" | "failed";

/** The database row, as `orders-api` reads it. */
export interface OrderRow {
  id: string;
  customer_id: string;
  items: OrderItem[];
  amount_cents: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateOrderRequest {
  customerId: string;
  items: CartItem[];
}

/** ORDER_RESPONSE_VERSION=1 — the shape every consumer is written against. */
export interface OrderV1 {
  id: string;
  customer_id: string;
  items: OrderItem[];
  amount_cents: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

/**
 * ORDER_RESPONSE_VERSION=2 — a genuine breaking change: `amount_cents` becomes
 * `amountCents` and `customer_id` is nested. `checkout-gateway` really fails to parse it.
 */
export interface OrderV2 {
  id: string;
  customer: { id: string };
  items: OrderItem[];
  amountCents: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}
```

- [x] **Step 7: Write `packages/contracts/src/chain.ts`**

```ts
export type HopState = "ok" | "degraded" | "unreachable";

/** A service's own view of its last 60 seconds, served at GET /stats. */
export interface ServiceStats {
  service: string;
  version: string;
  p99Ms: number | null;
  errorRate: number;
  requests: number;
  windowSeconds: number;
}

export interface HopStatus {
  name: string;
  state: HopState;
  detail?: string;
  stats: ServiceStats | null;
}

export interface QueueStats {
  depth: number;
  oldestAgeSeconds: number;
}

export interface ChainStatus {
  hops: HopStatus[];
  queue: QueueStats | null;
  checkedAt: string;
}
```

- [x] **Step 8: Write `packages/contracts/src/index.ts`**

```ts
export * from "./catalog.js";
export * from "./orders.js";
export * from "./chain.js";
```

- [x] **Step 9: Run the tests and the build**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
npm run build:libs
```

Expected: 7 tests pass, `packages/contracts/dist/index.js` and `index.d.ts` exist.

- [x] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: workspace scaffold and shared contracts package"
```

---

### Task 2: platform — configuration loading and validation

**Files:**
- Create: `packages/platform/package.json`, `packages/platform/tsconfig.json`
- Create: `packages/platform/src/config.ts`
- Test: `packages/platform/src/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ConfigError`, `EnvSource = Record<string, string | undefined>`, `LogLevel = "debug"|"info"|"warn"|"error"`, `requireStr(env,key)`, `optStr(env,key,def)`, `optInt(env,key,def,{min?,max?})`, `optBool(env,key,def)`, `requireUrl(env,key)`, `optLogLevel(env,key,def)`, `CommonConfig`, `loadCommonConfig(env): CommonConfig`, `redactValue(key,value)`, `redactConfig(obj)`, `loadOrExit<T>(load, env?, io?)`.

- [x] **Step 1: Create the platform package files**

`packages/platform/package.json` — dependency versions are the ones verified against the registry on 2026-08-16; keep them exact:

```json
{
  "name": "@sample-app/platform",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@opentelemetry/api": "1.9.1",
    "@opentelemetry/core": "2.10.0",
    "@opentelemetry/exporter-trace-otlp-http": "0.221.0",
    "@opentelemetry/instrumentation-http": "0.221.0",
    "@opentelemetry/instrumentation-pg": "0.73.0",
    "@opentelemetry/resources": "2.10.0",
    "@opentelemetry/sdk-node": "0.221.0",
    "@opentelemetry/semantic-conventions": "1.43.0",
    "prom-client": "15.1.3"
  }
}
```

`packages/platform/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Then install: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm install`

- [x] **Step 2: Write the failing test**

`packages/platform/src/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConfigError, requireStr, optStr, optInt, optBool, requireUrl, optLogLevel,
  loadCommonConfig, redactConfig, loadOrExit,
} from "./config.js";

test("requireStr returns a trimmed value", () => {
  assert.equal(requireStr({ A: "  hi  " }, "A"), "hi");
});

test("requireStr throws ConfigError naming the key when missing or blank", () => {
  assert.throws(() => requireStr({}, "GATEWAY_URL"), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match((err as Error).message, /GATEWAY_URL/);
    return true;
  });
  assert.throws(() => requireStr({ GATEWAY_URL: "   " }, "GATEWAY_URL"), ConfigError);
});

test("optInt returns the default when unset and parses when set", () => {
  assert.equal(optInt({}, "DB_POOL_MAX", 10), 10);
  assert.equal(optInt({ DB_POOL_MAX: "1" }, "DB_POOL_MAX", 10), 1);
});

test("optInt rejects a non-integer and reports the key and the value", () => {
  assert.throws(() => optInt({ DB_POOL_MAX: "ten" }, "DB_POOL_MAX", 10), (err: unknown) => {
    assert.match((err as Error).message, /DB_POOL_MAX/);
    assert.match((err as Error).message, /ten/);
    return true;
  });
  assert.throws(() => optInt({ N: "1.5" }, "N", 1), ConfigError);
});

test("optInt enforces min and max", () => {
  assert.throws(() => optInt({ N: "0" }, "N", 5, { min: 1 }), /must be >= 1/);
  assert.throws(() => optInt({ N: "99999" }, "N", 5, { max: 100 }), /must be <= 100/);
});

test("optBool accepts true/false/1/0 and rejects anything else", () => {
  assert.equal(optBool({ F: "true" }, "F", false), true);
  assert.equal(optBool({ F: "0" }, "F", true), false);
  assert.equal(optBool({}, "F", true), true);
  assert.throws(() => optBool({ F: "yes" }, "F", false), ConfigError);
});

test("requireUrl validates and strips trailing slashes", () => {
  assert.equal(requireUrl({ U: "http://gw:3000/" }, "U"), "http://gw:3000");
  assert.throws(() => requireUrl({ U: "gw:3000" }, "U"), ConfigError);
});

test("optLogLevel rejects an unknown level", () => {
  assert.equal(optLogLevel({}, "LOG_LEVEL", "info"), "info");
  assert.throws(() => optLogLevel({ LOG_LEVEL: "chatty" }, "LOG_LEVEL", "info"), ConfigError);
});

test("loadCommonConfig applies every documented default", () => {
  assert.deepEqual(loadCommonConfig({}), {
    nodeEnv: "production",
    port: 3000,
    logLevel: "info",
    serviceVersion: "dev",
    deploymentEnv: "dev",
    otelEndpoint: null,
    gracefulShutdownMs: 10000,
  });
});

test("loadCommonConfig reads OTEL_EXPORTER_OTLP_ENDPOINT when set", () => {
  const c = loadCommonConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" });
  assert.equal(c.otelEndpoint, "http://otel:4318");
});

test("redactConfig hides a password but keeps the host and database visible", () => {
  const out = redactConfig({
    databaseUrl: "postgres://app:s3cret@db.svc:5432/sample",
    dbPoolMax: 10,
  });
  assert.equal(out.dbPoolMax, 10);
  assert.match(String(out.databaseUrl), /db\.svc:5432\/sample/);
  assert.doesNotMatch(String(out.databaseUrl), /s3cret/);
});

test("redactConfig masks anything named like a secret", () => {
  const out = redactConfig({ apiToken: "abc123", webhookSecret: "xyz" });
  assert.equal(out.apiToken, "***");
  assert.equal(out.webhookSecret, "***");
});

test("loadOrExit writes the reason to stdout and exits 1 on a bad value", () => {
  const written: string[] = [];
  let code: number | null = null;
  loadOrExit(
    (env) => ({ n: optInt(env, "DB_POOL_MAX", 10) }),
    { DB_POOL_MAX: "ten" },
    { write: (s) => written.push(s), exit: ((c: number) => { code = c; return undefined as never; }) },
  );
  assert.equal(code, 1);
  assert.equal(written.length, 1);
  const line = JSON.parse(written[0]!);
  assert.equal(line.level, "error");
  assert.match(line.err.msg, /DB_POOL_MAX/);
});
```

- [x] **Step 3: Run the test to verify it fails**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
```

Expected: FAIL — `Cannot find module './config.js'`.

- [x] **Step 4: Write `packages/platform/src/config.ts`**

```ts
export type EnvSource = Record<string, string | undefined>;
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export class ConfigError extends Error {
  readonly key: string;
  constructor(key: string, reason: string) {
    super(`invalid config: ${key} ${reason}`);
    this.name = "ConfigError";
    this.key = key;
  }
}

export function requireStr(env: EnvSource, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") throw new ConfigError(key, "is required");
  return raw.trim();
}

export function optStr(env: EnvSource, key: string, def: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? def : raw.trim();
}

export function optInt(
  env: EnvSource,
  key: string,
  def: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) throw new ConfigError(key, `must be an integer, got "${raw}"`);
  if (opts.min !== undefined && n < opts.min) throw new ConfigError(key, `must be >= ${opts.min}, got ${n}`);
  if (opts.max !== undefined && n > opts.max) throw new ConfigError(key, `must be <= ${opts.max}, got ${n}`);
  return n;
}

export function optBool(env: EnvSource, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ConfigError(key, `must be true or false, got "${raw}"`);
}

export function requireUrl(env: EnvSource, key: string): string {
  const raw = requireStr(env, key);
  try {
    new URL(raw);
  } catch {
    throw new ConfigError(key, `must be an absolute URL, got "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
}

export function optLogLevel(env: EnvSource, key: string, def: LogLevel): LogLevel {
  const raw = optStr(env, key, def).toLowerCase();
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new ConfigError(key, `must be one of ${LOG_LEVELS.join("|")}, got "${raw}"`);
  }
  return raw as LogLevel;
}

export interface CommonConfig {
  nodeEnv: string;
  port: number;
  logLevel: LogLevel;
  serviceVersion: string;
  deploymentEnv: string;
  otelEndpoint: string | null;
  gracefulShutdownMs: number;
}

export function loadCommonConfig(env: EnvSource): CommonConfig {
  return {
    nodeEnv: optStr(env, "NODE_ENV", "production"),
    port: optInt(env, "PORT", 3000, { min: 1, max: 65535 }),
    logLevel: optLogLevel(env, "LOG_LEVEL", "info"),
    // Injected at build time from the git SHA; "dev" keeps local runs and tests working.
    serviceVersion: optStr(env, "SERVICE_VERSION", "dev"),
    deploymentEnv: optStr(env, "DEPLOYMENT_ENV", "dev"),
    otelEndpoint: optStr(env, "OTEL_EXPORTER_OTLP_ENDPOINT", "") || null,
    gracefulShutdownMs: optInt(env, "GRACEFUL_SHUTDOWN_MS", 10000, { min: 0 }),
  };
}

const SECRET_KEY = /pass|secret|token/i;

/**
 * The resolved config is logged once at boot so a fault knob is findable in Loki as well as
 * in k8s_describe_pod. A blanked-out DATABASE_URL would defeat that, so URLs keep their host
 * and database and lose only the password.
 */
export function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (SECRET_KEY.test(key)) return "***";
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = "***";
      return url.toString();
    }
  } catch {
    // not a URL; fall through
  }
  return value;
}

export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) out[k] = redactValue(k, v);
  return out;
}

export interface LoadOrExitIo {
  write?: (line: string) => void;
  exit?: (code: number) => never;
}

/** Fail loudly at boot: a bad value prints its reason on stdout and exits non-zero. */
export function loadOrExit<T>(
  load: (env: EnvSource) => T,
  env: EnvSource = process.env,
  io: LoadOrExitIo = {},
): T {
  const write = io.write ?? ((line: string) => void process.stdout.write(line));
  const exit = io.exit ?? ((code: number) => process.exit(code));
  try {
    return load(env);
  } catch (err) {
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "config error, refusing to start",
        err: { type: err instanceof Error ? err.name : typeof err, msg: err instanceof Error ? err.message : String(err) },
      }) + "\n",
    );
    return exit(1);
  }
}
```

- [x] **Step 5: Run the tests**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
```

Expected: PASS (13 config tests + 7 catalog tests).

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(platform): config loading, validation, redaction"
```

---

### Task 3: platform — structured JSON logger

**Files:**
- Create: `packages/platform/src/logger.ts`
- Test: `packages/platform/src/logger.test.ts`

**Interfaces:**
- Consumes: `LogLevel` from `./config.js`.
- Produces: `Logger` (`debug|info|warn|error(msg: string, fields?: LogFields): void`), `LogFields = Record<string, unknown>`, `LoggerOptions`, `createLogger(opts): Logger`, `serializeError(err): { type: string; msg: string; stack?: string }`.

- [x] **Step 1: Write the failing test**

`packages/platform/src/logger.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, serializeError } from "./logger.js";

function capture(level: "debug" | "info" | "warn" | "error" = "info", extra = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: "orders-api",
    version: "a1b2c3d",
    level,
    write: (l) => lines.push(l),
    now: () => new Date("2026-08-16T09:14:22.417Z"),
    ...extra,
  });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

test("emits one newline-terminated JSON object with the standard fields", () => {
  const { logger, lines, parsed } = capture();
  logger.info("order created", { order_id: "018f" });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith("\n"));
  assert.deepEqual(parsed()[0], {
    ts: "2026-08-16T09:14:22.417Z",
    level: "info",
    service: "orders-api",
    version: "a1b2c3d",
    msg: "order created",
    order_id: "018f",
  });
});

test("drops messages below the configured level", () => {
  const { logger, lines } = capture("warn");
  logger.debug("noise");
  logger.info("noise");
  logger.warn("kept");
  logger.error("kept");
  assert.equal(lines.length, 2);
});

test("serializes an Error under err with type, msg and stack", () => {
  const { logger, parsed } = capture();
  logger.error("settlement enqueue failed", { err: new TypeError("boom"), order_id: "018f" });
  const line = parsed()[0];
  assert.equal(line.err.type, "TypeError");
  assert.equal(line.err.msg, "boom");
  assert.match(line.err.stack, /boom/);
  assert.equal(line.order_id, "018f");
});

test("merges the trace context so trace_id joins Loki, traces and the Slack thread", () => {
  const { logger, parsed } = capture("info", {
    traceContext: () => ({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7" }),
  });
  logger.info("hello");
  assert.equal(parsed()[0].trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(parsed()[0].span_id, "00f067aa0ba902b7");
});

test("serializeError handles a non-Error throw", () => {
  assert.deepEqual(serializeError("plain string"), { type: "string", msg: "plain string" });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './logger.js'`.

- [x] **Step 3: Write `packages/platform/src/logger.ts`**

```ts
import type { LogLevel } from "./config.js";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function serializeError(err: unknown): { type: string; msg: string; stack?: string } {
  if (err instanceof Error) {
    return { type: err.name, msg: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { type: typeof err, msg: String(err) };
}

export interface LoggerOptions {
  service: string;
  version: string;
  level: LogLevel;
  write?: (line: string) => void;
  /** Supplies trace_id/span_id from the active span, when tracing is enabled. */
  traceContext?: () => { trace_id?: string; span_id?: string };
  now?: () => Date;
}

/** One JSON object per line, to stdout, never to a file (12-factor XI). */
export function createLogger(opts: LoggerOptions): Logger {
  const write = opts.write ?? ((line: string) => void process.stdout.write(line));
  const now = opts.now ?? (() => new Date());
  const traceContext = opts.traceContext ?? (() => ({}));
  const min = RANK[opts.level];

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[level] < min) return;
    const { err, ...rest } = fields ?? {};
    const line: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      service: opts.service,
      version: opts.version,
      msg,
      ...traceContext(),
      ...rest,
    };
    if (err !== undefined) line.err = serializeError(err);
    write(JSON.stringify(line) + "\n");
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
```

- [x] **Step 4: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(platform): JSON stdout logger with trace context"
```

---

### Task 4: platform — metrics registry and rolling stats

**Files:**
- Create: `packages/platform/src/metrics.ts`, `packages/platform/src/rolling-stats.ts`
- Test: `packages/platform/src/metrics.test.ts`, `packages/platform/src/rolling-stats.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DURATION_BUCKETS: number[]`, `BATCH_SIZE_BUCKETS: number[]`, `Metrics` (fields: `registry`, `service`, `httpServerRequests`, `httpServerDuration`, `httpClientRequests`, `httpClientDuration`, `dbPoolConnections`, `dbQueryDuration`, `cacheRequests`, `queueDepth`, `queueOldestJobAge`, `settlementJobs`, `settlementBatchSize`, `buildInfo`), `createMetrics({service,version,commit}): Metrics`, `PoolLike`, `bindPoolMetrics(metrics, pool)`, `StatsSnapshot`, `RollingStats`.

- [x] **Step 1: Write the failing tests**

`packages/platform/src/rolling-stats.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RollingStats } from "./rolling-stats.js";

test("an empty window reports no p99 and no requests", () => {
  const s = new RollingStats(60, () => 0);
  assert.deepEqual(s.snapshot(), { p99Ms: null, errorRate: 0, requests: 0, windowSeconds: 60 });
});

test("p99 is the 99th percentile of the samples in the window", () => {
  const s = new RollingStats(60, () => 0);
  for (let i = 1; i <= 100; i++) s.record(i, false);
  const snap = s.snapshot();
  assert.equal(snap.requests, 100);
  assert.equal(snap.p99Ms, 99);
});

test("errorRate is the share of samples flagged as errors", () => {
  const s = new RollingStats(60, () => 0);
  for (let i = 0; i < 8; i++) s.record(10, false);
  for (let i = 0; i < 2; i++) s.record(10, true);
  assert.equal(s.snapshot().errorRate, 0.2);
});

test("samples older than the window are dropped", () => {
  let now = 0;
  const s = new RollingStats(60, () => now);
  s.record(500, true);
  now = 61_000;
  s.record(10, false);
  const snap = s.snapshot();
  assert.equal(snap.requests, 1);
  assert.equal(snap.errorRate, 0);
  assert.equal(snap.p99Ms, 10);
});

test("the sample buffer is bounded so a traffic spike cannot grow it without limit", () => {
  const s = new RollingStats(60, () => 0);
  for (let i = 0; i < 20_000; i++) s.record(1, false);
  assert.ok(s.snapshot().requests <= 10_000);
});
```

`packages/platform/src/metrics.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMetrics, DURATION_BUCKETS, bindPoolMetrics } from "./metrics.js";

const EXPECTED = [
  "http_server_requests_total",
  "http_server_request_duration_seconds",
  "http_client_requests_total",
  "http_client_request_duration_seconds",
  "db_pool_connections",
  "db_query_duration_seconds",
  "cache_requests_total",
  "queue_depth",
  "queue_oldest_job_age_seconds",
  "settlement_jobs_total",
  "settlement_batch_size",
  "build_info",
];

test("every metric in the observability contract is registered", async () => {
  const m = createMetrics({ service: "orders-api", version: "a1b2c3d", commit: "a1b2c3d" });
  const text = await m.registry.metrics();
  for (const name of EXPECTED) assert.match(text, new RegExp(`^# HELP ${name} `, "m"), name);
});

test("prom-client default process and nodejs collectors are included", async () => {
  const m = createMetrics({ service: "orders-api", version: "v", commit: "c" });
  const text = await m.registry.metrics();
  assert.match(text, /process_cpu_seconds_total/);
  assert.match(text, /nodejs_eventloop_lag_seconds/);
});

test("build_info is always 1 and carries service, version and commit", async () => {
  const m = createMetrics({ service: "orders-api", version: "a1b2c3d", commit: "a1b2c3d" });
  const text = await m.registry.metrics();
  assert.match(text, /build_info\{service="orders-api",version="a1b2c3d",commit="a1b2c3d"\} 1/);
});

test("duration histograms use the exact contract buckets", async () => {
  const m = createMetrics({ service: "s", version: "v", commit: "c" });
  m.httpServerDuration.observe({ service: "s", method: "GET", route: "/orders/:id" }, 0.3);
  const text = await m.registry.metrics();
  const les = [...text.matchAll(/http_server_request_duration_seconds_bucket\{[^}]*le="([^"]+)"\}/g)]
    .map((match) => match[1]);
  assert.deepEqual(les, [...DURATION_BUCKETS.map(String), "+Inf"]);
});

test("http_server metrics use the route template, never the raw path", async () => {
  const m = createMetrics({ service: "s", version: "v", commit: "c" });
  m.httpServerRequests.inc({ service: "s", method: "GET", route: "/orders/:id", status: "200" });
  const text = await m.registry.metrics();
  assert.match(text, /route="\/orders\/:id"/);
});

test("bindPoolMetrics reports idle, busy and waiting from the pool counters", async () => {
  const m = createMetrics({ service: "orders-api", version: "v", commit: "c" });
  bindPoolMetrics(m, { totalCount: 7, idleCount: 2, waitingCount: 3 });
  const text = await m.registry.metrics();
  assert.match(text, /db_pool_connections\{service="orders-api",state="idle"\} 2/);
  assert.match(text, /db_pool_connections\{service="orders-api",state="busy"\} 5/);
  assert.match(text, /db_pool_connections\{service="orders-api",state="waiting"\} 3/);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './rolling-stats.js'` and `'./metrics.js'`.

- [x] **Step 3: Write `packages/platform/src/rolling-stats.ts`**

```ts
export interface StatsSnapshot {
  p99Ms: number | null;
  errorRate: number;
  requests: number;
  windowSeconds: number;
}

interface Sample {
  at: number;
  ms: number;
  err: boolean;
}

const MAX_SAMPLES = 10_000;

/**
 * A bounded, in-process view of the last N seconds, served at GET /stats and aggregated by
 * checkout-gateway for the storefront status page. Prometheus is the system of record; this
 * exists only so the human-facing page can show a fault propagating without querying it.
 */
export class RollingStats {
  readonly #windowSeconds: number;
  readonly #now: () => number;
  #samples: Sample[] = [];

  constructor(windowSeconds = 60, now: () => number = Date.now) {
    this.#windowSeconds = windowSeconds;
    this.#now = now;
  }

  record(durationMs: number, isError: boolean): void {
    this.#prune();
    if (this.#samples.length >= MAX_SAMPLES) this.#samples.shift();
    this.#samples.push({ at: this.#now(), ms: durationMs, err: isError });
  }

  snapshot(): StatsSnapshot {
    this.#prune();
    const n = this.#samples.length;
    if (n === 0) return { p99Ms: null, errorRate: 0, requests: 0, windowSeconds: this.#windowSeconds };
    const sorted = this.#samples.map((s) => s.ms).sort((a, b) => a - b);
    const index = Math.min(n - 1, Math.max(0, Math.ceil(0.99 * n) - 1));
    const errors = this.#samples.reduce((acc, s) => acc + (s.err ? 1 : 0), 0);
    return {
      p99Ms: sorted[index] ?? null,
      errorRate: errors / n,
      requests: n,
      windowSeconds: this.#windowSeconds,
    };
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowSeconds * 1000;
    let drop = 0;
    while (drop < this.#samples.length && this.#samples[drop]!.at < cutoff) drop++;
    if (drop > 0) this.#samples = this.#samples.slice(drop);
  }
}
```

- [x] **Step 4: Write `packages/platform/src/metrics.ts`**

```ts
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** Seconds. Every duration histogram in the contract shares these. */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Rows per settlement claim — not seconds, so it needs its own scale. */
export const BATCH_SIZE_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];

export interface Metrics {
  registry: Registry;
  service: string;
  httpServerRequests: Counter<string>;
  httpServerDuration: Histogram<string>;
  httpClientRequests: Counter<string>;
  httpClientDuration: Histogram<string>;
  dbPoolConnections: Gauge<string>;
  dbQueryDuration: Histogram<string>;
  cacheRequests: Counter<string>;
  queueDepth: Gauge<string>;
  queueOldestJobAge: Gauge<string>;
  settlementJobs: Counter<string>;
  settlementBatchSize: Histogram<string>;
  buildInfo: Gauge<string>;
}

export function createMetrics(opts: { service: string; version: string; commit: string }): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const metrics: Metrics = {
    registry,
    service: opts.service,
    httpServerRequests: new Counter({
      name: "http_server_requests_total",
      help: "HTTP requests served, by templated route and status",
      labelNames: ["service", "method", "route", "status"],
      registers: [registry],
    }),
    httpServerDuration: new Histogram({
      name: "http_server_request_duration_seconds",
      help: "HTTP server request duration in seconds",
      labelNames: ["service", "method", "route"],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    httpClientRequests: new Counter({
      name: "http_client_requests_total",
      help: "Outbound HTTP requests, by logical peer and status",
      labelNames: ["service", "peer", "status"],
      registers: [registry],
    }),
    httpClientDuration: new Histogram({
      name: "http_client_request_duration_seconds",
      help: "Outbound HTTP request duration in seconds",
      labelNames: ["service", "peer"],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    dbPoolConnections: new Gauge({
      name: "db_pool_connections",
      help: "Database pool connections by state",
      labelNames: ["service", "state"],
      registers: [registry],
    }),
    dbQueryDuration: new Histogram({
      name: "db_query_duration_seconds",
      help: "Database query duration in seconds, by logical operation",
      labelNames: ["service", "operation"],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    cacheRequests: new Counter({
      name: "cache_requests_total",
      help: "In-process cache lookups by result",
      labelNames: ["service", "result"],
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: "queue_depth",
      help: "Unclaimed jobs in the queue",
      labelNames: ["queue"],
      registers: [registry],
    }),
    queueOldestJobAge: new Gauge({
      name: "queue_oldest_job_age_seconds",
      help: "Age of the oldest unclaimed job in seconds",
      labelNames: ["queue"],
      registers: [registry],
    }),
    settlementJobs: new Counter({
      name: "settlement_jobs_total",
      help: "Settlement job outcomes",
      labelNames: ["result"],
      registers: [registry],
    }),
    settlementBatchSize: new Histogram({
      name: "settlement_batch_size",
      help: "Rows claimed per settlement batch",
      buckets: BATCH_SIZE_BUCKETS,
      registers: [registry],
    }),
    buildInfo: new Gauge({
      name: "build_info",
      help: "Always 1; carries the running version so error onset can be correlated to a deploy",
      labelNames: ["service", "version", "commit"],
      registers: [registry],
    }),
  };

  metrics.buildInfo.set({ service: opts.service, version: opts.version, commit: opts.commit }, 1);
  return metrics;
}

/** Structurally typed so platform never has to import `pg`. */
export interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/** Reads the pool counters on every scrape rather than on every checkout. */
export function bindPoolMetrics(metrics: Metrics, pool: PoolLike): void {
  metrics.dbPoolConnections.collect = () => {
    metrics.dbPoolConnections.set({ service: metrics.service, state: "idle" }, pool.idleCount);
    metrics.dbPoolConnections.set({ service: metrics.service, state: "busy" }, pool.totalCount - pool.idleCount);
    metrics.dbPoolConnections.set({ service: metrics.service, state: "waiting" }, pool.waitingCount);
  };
}
```

- [x] **Step 5: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS. If the bucket-ordering assertion fails, print the `/metrics` text and check that `DURATION_BUCKETS` was passed to the histogram — do not change the expected bucket list.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(platform): prometheus metrics registry and rolling stats window"
```

---

### Task 5: platform — route matcher with templated labels

**Files:**
- Create: `packages/platform/src/router.ts`
- Test: `packages/platform/src/router.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RouteParams = Record<string, string>`, `RouteContext { req, res, params, url, readBody() }`, `RouteHandler = (ctx) => Promise<void> | void`, `Route { method, pattern, handler }`, `UNMATCHED_ROUTE = "__unmatched__"`, `matchPath(pattern, pathname): RouteParams | null`, `matchRoute(routes, method, pathname): { route, params } | null`, `readBody(req, maxBytes?): Promise<string>`.

- [x] **Step 1: Write the failing test**

`packages/platform/src/router.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPath, matchRoute, UNMATCHED_ROUTE, type Route } from "./router.js";

const noop = () => {};

test("a literal pattern matches only itself", () => {
  assert.deepEqual(matchPath("/orders", "/orders"), {});
  assert.equal(matchPath("/orders", "/order"), null);
});

test("the root pattern matches the root path", () => {
  assert.deepEqual(matchPath("/", "/"), {});
});

test("a parameter segment captures its value", () => {
  assert.deepEqual(matchPath("/orders/:id", "/orders/018f-abc"), { id: "018f-abc" });
});

test("a parameter never spans a slash", () => {
  assert.equal(matchPath("/orders/:id", "/orders/018f/items"), null);
  assert.equal(matchPath("/orders/:id", "/orders"), null);
});

test("a parameter value is url-decoded", () => {
  assert.deepEqual(matchPath("/assets/:version/app.css", "/assets/a%2Fb/app.css"), { version: "a/b" });
});

test("matchRoute honours the method and returns the first matching route", () => {
  const routes: Route[] = [
    { method: "GET", pattern: "/orders", handler: noop },
    { method: "POST", pattern: "/orders", handler: noop },
    { method: "GET", pattern: "/orders/:id", handler: noop },
  ];
  assert.equal(matchRoute(routes, "POST", "/orders")?.route.pattern, "/orders");
  assert.equal(matchRoute(routes, "GET", "/orders/9")?.route.pattern, "/orders/:id");
  assert.deepEqual(matchRoute(routes, "GET", "/orders/9")?.params, { id: "9" });
  assert.equal(matchRoute(routes, "DELETE", "/orders"), null);
});

test("UNMATCHED_ROUTE is a fixed label so a 404 flood cannot explode cardinality", () => {
  assert.equal(UNMATCHED_ROUTE, "__unmatched__");
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './router.js'`.

- [x] **Step 3: Write `packages/platform/src/router.ts`**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteParams = Record<string, string>;

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: RouteParams;
  url: URL;
  readBody: () => Promise<string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface Route {
  method: string;
  /** The metric label. `/orders/:id`, never a raw path. */
  pattern: string;
  handler: RouteHandler;
}

/** Every unrouted request shares one label, so a 404 scan cannot explode cardinality. */
export const UNMATCHED_ROUTE = "__unmatched__";

const segments = (p: string): string[] => p.split("/").filter((s) => s.length > 0);

export function matchPath(pattern: string, pathname: string): RouteParams | null {
  const want = segments(pattern);
  const got = segments(pathname);
  if (want.length !== got.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) {
      params[w.slice(1)] = decodeURIComponent(g);
      continue;
    }
    if (w !== g) return null;
  }
  return params;
}

export function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: RouteParams } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}

const MAX_BODY_BYTES = 1_000_000;

export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
```

- [x] **Step 4: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(platform): route matcher with templated metric labels"
```

---

### Task 6: platform — HTTP server with metrics, health and stats endpoints

**Files:**
- Create: `packages/platform/src/http-server.ts`
- Test: `packages/platform/src/http-server.test.ts`

**Interfaces:**
- Consumes: `CommonConfig` (Task 2), `Logger` (Task 3), `Metrics` + `RollingStats` (Task 4), `Route`/`matchRoute`/`readBody`/`UNMATCHED_ROUTE` (Task 5), `ServiceStats` from `@sample-app/contracts` (Task 1).
- Produces: `ProbeResult { ok: boolean; detail?: string }`, `AppDeps`, `createApp(deps): http.Server`, `sendJson(res, status, body)`, `sendHtml(res, status, html)`, `sendText(res, status, body, headers?)`, `INTROSPECTION_ROUTES: string[]`.

- [x] **Step 1: Write the failing test**

`packages/platform/src/http-server.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sendJson, type AppDeps } from "./http-server.js";
import { createMetrics } from "./metrics.js";
import { RollingStats } from "./rolling-stats.js";
import { createLogger } from "./logger.js";
import { loadCommonConfig } from "./config.js";

function harness(overrides: Partial<AppDeps> = {}) {
  const metrics = createMetrics({ service: "test-svc", version: "v1", commit: "c1" });
  const deps: AppDeps = {
    service: "test-svc",
    config: loadCommonConfig({}),
    logger: createLogger({ service: "test-svc", version: "v1", level: "error", write: () => {} }),
    metrics,
    stats: new RollingStats(),
    routes: [
      { method: "GET", pattern: "/orders/:id", handler: (ctx) => sendJson(ctx.res, 200, { id: ctx.params.id }) },
      { method: "GET", pattern: "/boom", handler: () => { throw new Error("handler exploded"); } },
      { method: "POST", pattern: "/echo", handler: async (ctx) => sendJson(ctx.res, 200, { body: await ctx.readBody() }) },
    ],
    readiness: async () => ({ ok: true }),
    ...overrides,
  };
  const server = createApp(deps);
  return { deps, metrics, server };
}

async function withServer<T>(server: ReturnType<typeof createApp>, fn: (base: string) => Promise<T>): Promise<T> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("a matched route runs and its params are passed through", async () => {
  const { server } = harness();
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/orders/018f`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "018f" });
  });
});

test("http_server metrics record the route template and the status", async () => {
  const { server, metrics } = harness();
  await withServer(server, async (base) => {
    await fetch(`${base}/orders/018f`);
  });
  const text = await metrics.registry.metrics();
  assert.match(text, /http_server_requests_total\{service="test-svc",method="GET",route="\/orders\/:id",status="200"\} 1/);
  assert.match(text, /http_server_request_duration_seconds_count\{service="test-svc",method="GET",route="\/orders\/:id"\} 1/);
});

test("an unmatched path returns 404 under the fixed unmatched label", async () => {
  const { server, metrics } = harness();
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/nope/12345`);
    assert.equal(res.status, 404);
  });
  assert.match(await metrics.registry.metrics(), /route="__unmatched__",status="404"/);
});

test("a throwing handler returns a 500 JSON envelope instead of hanging", async () => {
  const { server } = harness();
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/boom`);
    assert.equal(res.status, 500);
    assert.equal((await res.json() as { error: string }).error, "internal_error");
  });
});

test("readBody delivers the request body to the handler", async () => {
  const { server } = harness();
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/echo`, { method: "POST", body: "sku=widget" });
    assert.deepEqual(await res.json(), { body: "sku=widget" });
  });
});

test("healthz is 200 without touching any dependency", async () => {
  const { server } = harness({ readiness: async () => ({ ok: false, detail: "db down" }) });
  await withServer(server, async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test("readyz is 503 with the reason when a dependency is down", async () => {
  const { server } = harness({ readiness: async () => ({ ok: false, detail: "db unreachable" }) });
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { detail: string }).detail, "db unreachable");
  });
});

test("healthz becomes 503 when a liveness probe is supplied and fails", async () => {
  const { server } = harness({ liveness: async () => ({ ok: false, detail: "db unreachable" }) });
  await withServer(server, async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 503);
  });
});

test("probe and introspection endpoints are excluded from http_server metrics", async () => {
  const { server, metrics } = harness({ readiness: async () => ({ ok: false, detail: "db down" }) });
  await withServer(server, async (base) => {
    await fetch(`${base}/healthz`);
    await fetch(`${base}/readyz`);
    await fetch(`${base}/metrics`);
    await fetch(`${base}/stats`);
  });
  const text = await metrics.registry.metrics();
  assert.doesNotMatch(text, /route="\/healthz"/);
  assert.doesNotMatch(text, /route="\/readyz"/);
  assert.doesNotMatch(text, /route="\/metrics"/);
  assert.doesNotMatch(text, /route="\/stats"/);
});

test("metrics is served in prometheus text format", async () => {
  const { server } = harness();
  await withServer(server, async (base) => {
    const res = await fetch(`${base}/metrics`);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await res.text(), /# HELP build_info/);
  });
});

test("stats reports the rolling window for this service", async () => {
  const { server } = harness();
  await withServer(server, async (base) => {
    await fetch(`${base}/orders/1`);
    const stats = await (await fetch(`${base}/stats`)).json() as { service: string; requests: number; windowSeconds: number };
    assert.equal(stats.service, "test-svc");
    assert.equal(stats.requests, 1);
    assert.equal(stats.windowSeconds, 60);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './http-server.js'`.

- [x] **Step 3: Write `packages/platform/src/http-server.ts`**

```ts
import http from "node:http";
import type { ServerResponse } from "node:http";
import type { ServiceStats } from "@sample-app/contracts";
import type { CommonConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { RollingStats } from "./rolling-stats.js";
import { UNMATCHED_ROUTE, matchRoute, readBody, type Route, type RouteContext } from "./router.js";

export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

export interface AppDeps {
  service: string;
  config: CommonConfig;
  logger: Logger;
  metrics: Metrics;
  stats: RollingStats;
  routes: Route[];
  readiness: () => Promise<ProbeResult>;
  /** Supplied only by orders-api, and only when LIVENESS_CHECKS_DB is on. */
  liveness?: () => Promise<ProbeResult>;
  traceIdOf?: () => string | undefined;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
  res.end(html);
}

export function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

/**
 * Probes and introspection are excluded from http_server_* and from the rolling window.
 * A kubelet hammering /readyz during a database blip would otherwise pour 503s into
 * http_server_requests_total and fire SampleAppHighErrorRate on traffic no user ever sent.
 */
export const INTROSPECTION_ROUTES = ["/healthz", "/readyz", "/metrics", "/stats"];

export function createApp(deps: AppDeps): http.Server {
  const probeRoutes: Route[] = [
    {
      method: "GET",
      pattern: "/healthz",
      handler: async ({ res }) => {
        const result = deps.liveness ? await deps.liveness() : { ok: true };
        sendJson(res, result.ok ? 200 : 503, { status: result.ok ? "ok" : "unhealthy", detail: result.detail ?? null });
      },
    },
    {
      method: "GET",
      pattern: "/readyz",
      handler: async ({ res }) => {
        const result = await deps.readiness();
        sendJson(res, result.ok ? 200 : 503, { status: result.ok ? "ready" : "not_ready", detail: result.detail ?? null });
      },
    },
    {
      method: "GET",
      pattern: "/metrics",
      handler: async ({ res }) => {
        const body = await deps.metrics.registry.metrics();
        sendText(res, 200, body, { "content-type": deps.metrics.registry.contentType });
      },
    },
    {
      method: "GET",
      pattern: "/stats",
      handler: ({ res }) => {
        const snap = deps.stats.snapshot();
        const payload: ServiceStats = {
          service: deps.service,
          version: deps.config.serviceVersion,
          p99Ms: snap.p99Ms,
          errorRate: snap.errorRate,
          requests: snap.requests,
          windowSeconds: snap.windowSeconds,
        };
        sendJson(res, 200, payload);
      },
    },
  ];

  const all = [...probeRoutes, ...deps.routes];

  return http.createServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const matched = matchRoute(all, method, url.pathname);
    const route = matched ? matched.route.pattern : UNMATCHED_ROUTE;

    if (!INTROSPECTION_ROUTES.includes(route)) {
      res.on("finish", () => {
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        deps.metrics.httpServerRequests.inc({ service: deps.service, method, route, status: String(res.statusCode) });
        deps.metrics.httpServerDuration.observe({ service: deps.service, method, route }, seconds);
        deps.stats.record(seconds * 1000, res.statusCode >= 500);
      });
    }

    if (!matched) {
      sendJson(res, 404, { error: "not_found", path: url.pathname });
      return;
    }

    const ctx: RouteContext = {
      req,
      res,
      params: matched.params,
      url,
      readBody: () => readBody(req),
    };

    Promise.resolve(matched.route.handler(ctx)).catch((err: unknown) => {
      deps.logger.error("unhandled request error", { err, route, method });
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "internal_error", trace_id: deps.traceIdOf?.() ?? null });
    });
  });
}
```

- [x] **Step 4: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 11 http-server tests.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(platform): http server with probes, metrics and stats endpoints"
```

---

### Task 7: platform — graceful shutdown

**Files:**
- Create: `packages/platform/src/shutdown.ts`
- Test: `packages/platform/src/shutdown.test.ts`

**Interfaces:**
- Consumes: `Logger` (Task 3).
- Produces: `ShutdownTask { name: string; run: () => Promise<void> }`, `ShutdownOptions`, `installShutdown(opts): () => Promise<void>`.

- [x] **Step 1: Write the failing test**

`packages/platform/src/shutdown.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { installShutdown } from "./shutdown.js";
import { createLogger } from "./logger.js";

const quietLogger = () => createLogger({ service: "t", version: "v", level: "error", write: () => {} });

function slowServer(delayMs: number): http.Server {
  return http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("done");
    }, delayMs);
  });
}

test("an in-flight request completes and the process exits 0", async () => {
  const server = slowServer(150);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  let exitCode: number | null = null;
  const shutdown = installShutdown({
    server,
    timeoutMs: 5000,
    logger: quietLogger(),
    signals: [],
    exit: (code) => { exitCode = code; },
  });

  const inFlight = fetch(`http://127.0.0.1:${port}/`);
  await new Promise((r) => setTimeout(r, 30));
  const shutdownDone = shutdown();

  assert.equal(await (await inFlight).text(), "done");
  await shutdownDone;
  assert.equal(exitCode, 0);
});

test("no new connection is accepted once shutdown has started", async () => {
  const server = slowServer(150);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const shutdown = installShutdown({ server, timeoutMs: 5000, logger: quietLogger(), signals: [], exit: () => {} });

  const inFlight = fetch(`http://127.0.0.1:${port}/`);
  await new Promise((r) => setTimeout(r, 30));
  const shutdownDone = shutdown();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  await inFlight;
  await shutdownDone;
});

test("shutdown tasks run after the server is closed, in order", async () => {
  const server = slowServer(0);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ran: string[] = [];
  const shutdown = installShutdown({
    server,
    timeoutMs: 1000,
    logger: quietLogger(),
    signals: [],
    exit: () => {},
    tasks: [
      { name: "pool", run: async () => { ran.push("pool"); } },
      { name: "tracing", run: async () => { ran.push("tracing"); } },
    ],
  });
  await shutdown();
  assert.deepEqual(ran, ["pool", "tracing"]);
});

test("a failing shutdown task is logged and does not block the rest", async () => {
  const lines: string[] = [];
  const logger = createLogger({ service: "t", version: "v", level: "error", write: (l) => lines.push(l) });
  const ran: string[] = [];
  const shutdown = installShutdown({
    timeoutMs: 100,
    logger,
    signals: [],
    exit: () => {},
    tasks: [
      { name: "pool", run: async () => { throw new Error("pool close failed"); } },
      { name: "tracing", run: async () => { ran.push("tracing"); } },
    ],
  });
  await shutdown();
  assert.deepEqual(ran, ["tracing"]);
  assert.match(lines.join(""), /pool close failed/);
});

test("GRACEFUL_SHUTDOWN_MS=0 cuts in-flight connections instead of draining", async () => {
  const server = slowServer(1000);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const shutdown = installShutdown({ server, timeoutMs: 0, logger: quietLogger(), signals: [], exit: () => {} });

  const inFlight = fetch(`http://127.0.0.1:${port}/`).catch(() => "cut");
  await new Promise((r) => setTimeout(r, 30));
  const startedAt = Date.now();
  await shutdown();
  assert.ok(Date.now() - startedAt < 500, "shutdown must not wait for the 1s handler");
  assert.equal(await inFlight, "cut");
});

test("shutdown is idempotent", async () => {
  let exits = 0;
  const shutdown = installShutdown({ timeoutMs: 10, logger: quietLogger(), signals: [], exit: () => { exits++; } });
  await Promise.all([shutdown(), shutdown()]);
  assert.equal(exits, 1);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './shutdown.js'`.

- [x] **Step 3: Write `packages/platform/src/shutdown.ts`**

```ts
import type { Server } from "node:http";
import type { Logger } from "./logger.js";

export interface ShutdownTask {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownOptions {
  logger: Logger;
  /** GRACEFUL_SHUTDOWN_MS. 0 cuts in-flight connections — the fault knob. */
  timeoutMs: number;
  server?: Server;
  tasks?: ShutdownTask[];
  exit?: (code: number) => void;
  signals?: NodeJS.Signals[];
}

/**
 * On SIGTERM: stop accepting connections, drain in flight up to timeoutMs, run the
 * teardown tasks, exit 0. With the default a rollout produces zero 5xx; with
 * GRACEFUL_SHUTDOWN_MS=0 every deploy produces a 5xx burst.
 */
export function installShutdown(opts: ShutdownOptions): () => Promise<void> {
  let started: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    opts.logger.info("shutdown started", { timeout_ms: opts.timeoutMs });
    if (opts.server) await closeServer(opts.server, opts.timeoutMs, opts.logger);
    for (const task of opts.tasks ?? []) {
      try {
        await task.run();
      } catch (err) {
        opts.logger.error(`shutdown task failed: ${task.name}`, { err });
      }
    }
    opts.logger.info("shutdown complete");
    (opts.exit ?? ((code: number) => process.exit(code)))(0);
  };

  const shutdown = (): Promise<void> => {
    started ??= run();
    return started;
  };

  for (const signal of opts.signals ?? (["SIGTERM", "SIGINT"] as NodeJS.Signals[])) {
    process.on(signal, () => void shutdown());
  }

  return shutdown;
}

function closeServer(server: Server, timeoutMs: number, logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      logger.warn("drain timeout reached, closing open connections", { timeout_ms: timeoutMs });
      server.closeAllConnections();
      finish();
    }, Math.max(0, timeoutMs));

    server.close(() => finish());
    // Keep-alive sockets hold the server open until their idle timeout; without this the
    // drain always runs the full timeout even when nothing is actually in flight.
    server.closeIdleConnections();
  });
}
```

- [x] **Step 4: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 6 shutdown tests.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(platform): graceful shutdown with drain timeout"
```

---

### Task 8: platform — instrumented HTTP client

**Files:**
- Create: `packages/platform/src/http-client.ts`
- Test: `packages/platform/src/http-client.test.ts`

**Interfaces:**
- Consumes: `Metrics` (Task 4).
- Produces: `DownstreamErrorKind = "timeout"|"network"|"status"|"parse"`, `DownstreamError` (fields `peer`, `kind`, `status?`), `statusForDownstream(err): number`, `RequestOptions { timeoutMs?, headers? }`, `HttpClient { getJson<T>(peer,url,opts?), postJson<T>(peer,url,body,opts?) }`, `createHttpClient({service, metrics, timeoutMs}): HttpClient`.

- [x] **Step 1: Write the failing test**

`packages/platform/src/http-client.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpClient, DownstreamError, statusForDownstream } from "./http-client.js";
import { createMetrics } from "./metrics.js";

async function withPeer<T>(
  handler: http.RequestListener,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const clientWithMetrics = (timeoutMs = 2000) => {
  const metrics = createMetrics({ service: "checkout-gateway", version: "v", commit: "c" });
  return { metrics, client: createHttpClient({ service: "checkout-gateway", metrics, timeoutMs }) };
};

test("getJson returns the parsed body and records a client metric", async () => {
  const { client, metrics } = clientWithMetrics();
  const body = await withPeer(
    (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"018f"}'); },
    (base) => client.getJson<{ id: string }>("orders-api", `${base}/orders/018f`),
  );
  assert.deepEqual(body, { id: "018f" });
  const text = await metrics.registry.metrics();
  assert.match(text, /http_client_requests_total\{service="checkout-gateway",peer="orders-api",status="200"\} 1/);
  assert.match(text, /http_client_request_duration_seconds_count\{service="checkout-gateway",peer="orders-api"\} 1/);
});

test("postJson sends a JSON body and returns the parsed response", async () => {
  const { client } = clientWithMetrics();
  const seen: string[] = [];
  const body = await withPeer(
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push(Buffer.concat(chunks).toString());
        res.writeHead(201, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    },
    (base) => client.postJson<{ ok: boolean }>("orders-api", `${base}/orders`, { customerId: "web" }),
  );
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(JSON.parse(seen[0]!), { customerId: "web" });
});

test("a 5xx becomes a DownstreamError of kind status carrying the peer and code", async () => {
  const { client, metrics } = clientWithMetrics();
  await withPeer(
    (_req, res) => { res.writeHead(503); res.end("nope"); },
    async (base) => {
      await assert.rejects(client.getJson("orders-api", `${base}/orders/1`), (err: unknown) => {
        assert.ok(err instanceof DownstreamError);
        assert.equal(err.kind, "status");
        assert.equal(err.status, 503);
        assert.equal(err.peer, "orders-api");
        return true;
      });
    },
  );
  assert.match(await metrics.registry.metrics(), /peer="orders-api",status="503"/);
});

test("a timeout becomes kind timeout and is labelled status=timeout", async () => {
  const { client, metrics } = clientWithMetrics(50);
  await withPeer(
    (_req, res) => { setTimeout(() => res.end("late"), 1000); },
    async (base) => {
      await assert.rejects(client.getJson("orders-api", `${base}/slow`), (err: unknown) => {
        assert.ok(err instanceof DownstreamError);
        assert.equal(err.kind, "timeout");
        return true;
      });
    },
  );
  assert.match(await metrics.registry.metrics(), /peer="orders-api",status="timeout"/);
});

test("an unparseable body becomes kind parse", async () => {
  const { client } = clientWithMetrics();
  await withPeer(
    (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("not json"); },
    async (base) => {
      await assert.rejects(client.getJson("orders-api", `${base}/x`), (err: unknown) => {
        assert.equal((err as DownstreamError).kind, "parse");
        return true;
      });
    },
  );
});

test("a refused connection becomes kind network and is labelled status=error", async () => {
  const { client, metrics } = clientWithMetrics();
  await assert.rejects(client.getJson("orders-api", "http://127.0.0.1:1/x"), (err: unknown) => {
    assert.equal((err as DownstreamError).kind, "network");
    return true;
  });
  assert.match(await metrics.registry.metrics(), /peer="orders-api",status="error"/);
});

test("statusForDownstream maps timeout to 504 and everything else to 502", () => {
  const timeout = new DownstreamError("t", { peer: "p", kind: "timeout" });
  const status = new DownstreamError("s", { peer: "p", kind: "status", status: 500 });
  assert.equal(statusForDownstream(timeout), 504);
  assert.equal(statusForDownstream(status), 502);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './http-client.js'`.

- [x] **Step 3: Write `packages/platform/src/http-client.ts`**

```ts
import type { Metrics } from "./metrics.js";

export type DownstreamErrorKind = "timeout" | "network" | "status" | "parse";

export class DownstreamError extends Error {
  readonly peer: string;
  readonly kind: DownstreamErrorKind;
  readonly status?: number;

  constructor(message: string, opts: { peer: string; kind: DownstreamErrorKind; status?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "DownstreamError";
    this.peer = opts.peer;
    this.kind = opts.kind;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** A caller that gave up first is a gateway timeout; anything else is a bad gateway. */
export function statusForDownstream(err: DownstreamError): number {
  return err.kind === "timeout" ? 504 : 502;
}

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface HttpClient {
  getJson<T>(peer: string, url: string, opts?: RequestOptions): Promise<T>;
  postJson<T>(peer: string, url: string, body: unknown, opts?: RequestOptions): Promise<T>;
}

export interface HttpClientDeps {
  service: string;
  metrics: Metrics;
  /** DOWNSTREAM_TIMEOUT_MS / GATEWAY_TIMEOUT_MS — the fault knob. */
  timeoutMs: number;
}

/**
 * `peer` is the logical service name, never the URL: it is a metric label, and the URL
 * would make http_client_* unbounded.
 */
export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const request = async <T>(peer: string, url: string, init: RequestInit, opts: RequestOptions): Promise<T> => {
    const startedAt = process.hrtime.bigint();
    const observe = (status: string): void => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      deps.metrics.httpClientRequests.inc({ service: deps.service, peer, status });
      deps.metrics.httpClientDuration.observe({ service: deps.service, peer }, seconds);
    };

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? deps.timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      observe(timedOut ? "timeout" : "error");
      throw new DownstreamError(
        timedOut ? `${peer} timed out after ${opts.timeoutMs ?? deps.timeoutMs}ms` : `${peer} unreachable: ${String(err)}`,
        { peer, kind: timedOut ? "timeout" : "network", cause: err },
      );
    }

    observe(String(res.status));
    const text = await res.text();

    if (!res.ok) {
      throw new DownstreamError(`${peer} returned ${res.status}: ${text.slice(0, 200)}`, {
        peer,
        kind: "status",
        status: res.status,
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new DownstreamError(`${peer} returned unparseable JSON: ${text.slice(0, 200)}`, {
        peer,
        kind: "parse",
        status: res.status,
        cause: err,
      });
    }
  };

  return {
    getJson: (peer, url, opts = {}) =>
      request(peer, url, { method: "GET", headers: { accept: "application/json", ...opts.headers } }, opts),
    postJson: (peer, url, body, opts = {}) =>
      request(
        peer,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...opts.headers },
          body: JSON.stringify(body),
        },
        opts,
      ),
  };
}
```

- [x] **Step 4: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 7 http-client tests.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(platform): instrumented http client with peer-labelled metrics"
```

---

### Task 9: platform — bounded concurrency semaphore

**Files:**
- Create: `packages/platform/src/semaphore.ts`
- Test: `packages/platform/src/semaphore.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Semaphore { acquire(): Promise<() => void>; readonly inFlight: number; readonly queued: number }`, `createSemaphore(limit: number): Semaphore`.

- [x] **Step 1: Write the failing test**

`packages/platform/src/semaphore.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "./semaphore.js";

test("a limit of 1 serialises two callers", async () => {
  const sem = createSemaphore(1);
  const order: string[] = [];

  const releaseA = await sem.acquire();
  order.push("a-start");

  const bDone = (async () => {
    const releaseB = await sem.acquire();
    order.push("b-start");
    releaseB();
  })();

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["a-start"], "b must not start while a holds the permit");
  assert.equal(sem.queued, 1);
  assert.equal(sem.inFlight, 1);

  order.push("a-end");
  releaseA();
  await bDone;
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("callers up to the limit run concurrently", async () => {
  const sem = createSemaphore(3);
  const releases = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
  assert.equal(sem.inFlight, 3);
  assert.equal(sem.queued, 0);
  for (const release of releases) release();
  assert.equal(sem.inFlight, 0);
});

test("releasing twice does not hand out an extra permit", async () => {
  const sem = createSemaphore(1);
  const release = await sem.acquire();
  release();
  release();
  assert.equal(sem.inFlight, 0);
  const second = await sem.acquire();
  assert.equal(sem.inFlight, 1);
  second();
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './semaphore.js'`.

- [x] **Step 3: Write `packages/platform/src/semaphore.ts`**

```ts
export interface Semaphore {
  acquire(): Promise<() => void>;
  readonly inFlight: number;
  readonly queued: number;
}

/**
 * Backs SSR_CONCURRENCY. With a low limit the excess genuinely queues, so head-of-line
 * blocking at the edge is real: storefront TTFB explodes while every tier below stays healthy.
 */
export function createSemaphore(limit: number): Semaphore {
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    inFlight--;
    const next = waiters.shift();
    if (next) {
      inFlight++;
      next();
    }
  };

  return {
    acquire(): Promise<() => void> {
      let released = false;
      const permit = (): void => {
        if (released) return;
        released = true;
        release();
      };

      if (inFlight < limit) {
        inFlight++;
        return Promise.resolve(permit);
      }
      return new Promise((resolve) => {
        waiters.push(() => resolve(permit));
      });
    },
    get inFlight() {
      return inFlight;
    },
    get queued() {
      return waiters.length;
    },
  };
}
```

- [x] **Step 4: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 3 semaphore tests.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(platform): bounded concurrency semaphore"
```

---

### Task 10: platform — OpenTelemetry bootstrap, traceparent helpers, package barrel

**Files:**
- Create: `packages/platform/src/tracing.ts`, `packages/platform/src/index.ts`
- Test: `packages/platform/src/tracing.test.ts`

**Interfaces:**
- Consumes: `Logger` (Task 3).
- Produces: `TraceIds { trace_id?: string; span_id?: string }`, `traceContext(): TraceIds`, `currentTraceparent(): string | null`, `parseTraceparent(tp): { traceId, spanId, sampled } | null`, `formatTraceparent(traceId, spanId, sampled): string`, `withRemoteParent<T>(traceparent, spanName, fn): Promise<T>`, `Tracing { shutdown(): Promise<void> }`, `initTracing(opts): Tracing | null`. Plus `packages/platform/src/index.ts` re-exporting every platform module.

- [x] **Step 1: Write the failing test**

`packages/platform/src/tracing.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTraceparent, formatTraceparent, currentTraceparent, withRemoteParent, initTracing } from "./tracing.js";
import { createLogger } from "./logger.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const SAMPLED = `00-${TRACE_ID}-${SPAN_ID}-01`;

test("parseTraceparent reads a valid W3C header", () => {
  assert.deepEqual(parseTraceparent(SAMPLED), { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
});

test("parseTraceparent reads the unsampled flag", () => {
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled, false);
});

test("parseTraceparent rejects anything malformed rather than guessing", () => {
  assert.equal(parseTraceparent(null), null);
  assert.equal(parseTraceparent(""), null);
  assert.equal(parseTraceparent("garbage"), null);
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`), null);
  assert.equal(parseTraceparent(`00-tooshort-${SPAN_ID}-01`), null);
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${SPAN_ID}-01`), null, "an all-zero trace id is invalid");
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`), null, "an all-zero span id is invalid");
});

test("formatTraceparent round-trips through parseTraceparent", () => {
  const header = formatTraceparent(TRACE_ID, SPAN_ID, true);
  assert.equal(header, SAMPLED);
  assert.deepEqual(parseTraceparent(header), { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
});

test("currentTraceparent is null when no span is active", () => {
  assert.equal(currentTraceparent(), null);
});

test("withRemoteParent runs the callback and returns its value", async () => {
  const result = await withRemoteParent(SAMPLED, "settle order", async () => "settled");
  assert.equal(result, "settled");
});

test("withRemoteParent still runs the callback when the stored traceparent is missing or junk", async () => {
  assert.equal(await withRemoteParent(null, "settle order", async () => "ok"), "ok");
  assert.equal(await withRemoteParent("garbage", "settle order", async () => "ok"), "ok");
});

test("withRemoteParent propagates a thrown error to the caller", async () => {
  await assert.rejects(withRemoteParent(SAMPLED, "settle order", async () => { throw new Error("settle failed"); }), /settle failed/);
});

test("initTracing returns null and warns once when no OTLP endpoint is configured", () => {
  const lines: string[] = [];
  const logger = createLogger({ service: "t", version: "v", level: "info", write: (l) => lines.push(l) });
  const tracing = initTracing({ service: "t", version: "v", deploymentEnv: "dev", endpoint: null, logger });
  assert.equal(tracing, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /tracing disabled/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './tracing.js'`.

- [x] **Step 3: Write `packages/platform/src/tracing.ts`**

The OTel package surface moves between majors. The symbols below were checked against the versions pinned in Task 1. If an import throws `SyntaxError: The requested module does not provide an export named X`, open `node_modules/@opentelemetry/<pkg>/build/src/index.d.ts` and use the current name — **do not downgrade the package and do not add a new one.**

```ts
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { Logger } from "./logger.js";

// Registered at import time so traceparent round-trips work even when no SDK is started
// (tracing disabled): the queue still carries the header, and the worker still logs it.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

export interface TraceIds {
  trace_id?: string;
  span_id?: string;
}

/** Feeds the logger, so one grep joins Loki, the tracing backend and the Slack thread. */
export function traceContext(): TraceIds {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export function parseTraceparent(
  traceparent: string | null | undefined,
): { traceId: string; spanId: string; sampled: boolean } | null {
  if (!traceparent) return null;
  const match = TRACEPARENT_RE.exec(traceparent.trim());
  if (!match) return null;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

/** The value written to settlement_jobs.traceparent at enqueue time. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/**
 * Restores the checkout request's trace as the parent of the worker's span. Without this the
 * async side is a blind spot: "settlement for order X failed" would not join its request.
 */
export async function withRemoteParent<T>(
  traceparent: string | null,
  spanName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = traceparent ? propagation.extract(context.active(), { traceparent }) : context.active();
  const tracer = trace.getTracer("sample-app");
  return context.with(parent, () =>
    tracer.startActiveSpan(spanName, async (span) => {
      try {
        const result = await fn();
        span.end();
        return result;
      } catch (err) {
        // tracing_search can only filter for errors if failed spans say so.
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        span.end();
        throw err;
      }
    }),
  );
}

export interface Tracing {
  shutdown(): Promise<void>;
}

export interface TracingOptions {
  service: string;
  version: string;
  deploymentEnv: string;
  endpoint: string | null;
  logger: Logger;
}

/**
 * Auto-instruments http and pg, so every hop and every SQL statement gets a span without
 * manual code. Probe endpoints are excluded — otherwise the trace backend fills with kubelet.
 */
export function initTracing(opts: TracingOptions): Tracing | null {
  if (!opts.endpoint) {
    opts.logger.warn("tracing disabled: OTEL_EXPORTER_OTLP_ENDPOINT is not set");
    return null;
  }

  const { NodeSDK } = require("@opentelemetry/sdk-node") as typeof import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http") as typeof import("@opentelemetry/exporter-trace-otlp-http");
  const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http") as typeof import("@opentelemetry/instrumentation-http");
  const { PgInstrumentation } = require("@opentelemetry/instrumentation-pg") as typeof import("@opentelemetry/instrumentation-pg");
  const { resourceFromAttributes } = require("@opentelemetry/resources") as typeof import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions") as typeof import("@opentelemetry/semantic-conventions");

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.service,
      [ATTR_SERVICE_VERSION]: opts.version,
      "deployment.environment": opts.deploymentEnv,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${opts.endpoint}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const path = (req.url ?? "").split("?")[0] ?? "";
          return ["/healthz", "/readyz", "/metrics", "/stats"].includes(path);
        },
      }),
      new PgInstrumentation(),
    ],
  });

  sdk.start();
  opts.logger.info("tracing enabled", { endpoint: opts.endpoint });
  return { shutdown: () => sdk.shutdown() };
}
```

**Note on the `require` calls:** the SDK must not be imported at module load, because importing it registers global instrumentation and every test that touches `platform` would start it. `createRequire` is the ESM-safe way to defer it. Add at the top of the file:

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
```

- [x] **Step 4: Write `packages/platform/src/index.ts`**

```ts
export * from "./config.js";
export * from "./logger.js";
export * from "./metrics.js";
export * from "./rolling-stats.js";
export * from "./router.js";
export * from "./http-server.js";
export * from "./http-client.js";
export * from "./shutdown.js";
export * from "./semaphore.js";
export * from "./tracing.js";
```

- [x] **Step 5: Run the tests and the library build**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
npm run build:libs
```

Expected: PASS — 9 tracing tests. `packages/platform/dist/index.d.ts` exists.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(platform): otel bootstrap, traceparent helpers, package barrel"
```

---

### Task 11: Database schema, migration runner, and a Postgres for tests

**Files:**
- Create: `db/migrations/001_orders.sql`, `db/migrations/002_settlement_jobs.sql`
- Create: `services/orders-api/package.json`, `services/orders-api/tsconfig.json`
- Create: `services/orders-api/src/db/migrate.ts`, `services/orders-api/src/db/migrate-cli.ts`
- Create: `docker-compose.yml` (Postgres only for now; Task 21 completes it)
- Create: `.env.example`
- Test: `services/orders-api/src/db/migrate.test.ts`

**Interfaces:**
- Consumes: `Logger` (Task 3).
- Produces: `pendingMigrations(files: string[], applied: Set<string>): string[]`, `migrationsDir(): string`, `migrationFiles(): string[]`, `runMigrations(pool, logger): Promise<void>`, `appliedVersions(pool): Promise<Set<string>>`, `assertSchemaCurrent(pool, logger): Promise<void>`, and the `orders` / `settlement_jobs` schema.

- [x] **Step 1: Write the migrations**

`db/migrations/001_orders.sql`:

```sql
CREATE TABLE IF NOT EXISTS orders (
  id            uuid PRIMARY KEY,
  customer_id   text        NOT NULL,
  items         jsonb       NOT NULL,
  amount_cents  bigint      NOT NULL,
  status        text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_created_at ON orders (created_at DESC);
```

`db/migrations/002_settlement_jobs.sql`:

```sql
CREATE TABLE IF NOT EXISTS settlement_jobs (
  id            bigserial   PRIMARY KEY,
  order_id      uuid        NOT NULL REFERENCES orders(id),
  attempts      int         NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  traceparent   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Claimable jobs only: the partial index is what keeps the SKIP LOCKED claim cheap.
CREATE INDEX IF NOT EXISTS settlement_jobs_claimable
  ON settlement_jobs (available_at) WHERE locked_at IS NULL;
```

- [x] **Step 2: Create the orders-api workspace and a Postgres to test against**

`services/orders-api/package.json`:

```json
{
  "name": "@sample-app/orders-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "node --import tsx --watch src/index.ts",
    "migrate": "node dist/db/migrate-cli.js",
    "migrate:dev": "node --import tsx src/db/migrate-cli.ts"
  },
  "dependencies": {
    "@sample-app/contracts": "*",
    "@sample-app/platform": "*",
    "pg": "8.23.0"
  },
  "devDependencies": {
    "@types/pg": "8.21.0"
  }
}
```

`services/orders-api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`docker-compose.yml` (Postgres only at this stage):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sample
      POSTGRES_PASSWORD: sample
      POSTGRES_DB: sample_app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sample -d sample_app"]
      interval: 2s
      timeout: 3s
      retries: 15
```

`.env.example`:

```
# Local development. Copy to .env; docker-compose reads none of it — it is for `npm run dev`.
DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app
# Database-backed tests are skipped unless this is set.
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app
LOG_LEVEL=debug
SERVICE_VERSION=dev
```

Then: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm install && docker compose up -d postgres`

- [x] **Step 3: Write the failing test**

`services/orders-api/src/db/migrate.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createLogger } from "@sample-app/platform";
import { pendingMigrations, migrationFiles, runMigrations, appliedVersions, assertSchemaCurrent } from "./migrate.js";

const DB = process.env.TEST_DATABASE_URL;
const quiet = createLogger({ service: "orders-api", version: "test", level: "error", write: () => {} });

test("pendingMigrations returns unapplied .sql files in lexical order", () => {
  const files = ["002_settlement_jobs.sql", "001_orders.sql", "README.md"];
  assert.deepEqual(pendingMigrations(files, new Set()), ["001_orders.sql", "002_settlement_jobs.sql"]);
});

test("pendingMigrations is empty once everything is applied — running twice is a no-op", () => {
  const files = ["001_orders.sql", "002_settlement_jobs.sql"];
  assert.deepEqual(pendingMigrations(files, new Set(files)), []);
});

test("migrationFiles finds the migrations shipped in db/migrations", () => {
  assert.deepEqual(migrationFiles(), ["001_orders.sql", "002_settlement_jobs.sql"]);
});

test("runMigrations creates the schema and is idempotent", { skip: !DB }, async () => {
  const pool = new pg.Pool({ connectionString: DB });
  try {
    await pool.query("DROP TABLE IF EXISTS settlement_jobs, orders, schema_migrations CASCADE");
    await runMigrations(pool, quiet);
    assert.deepEqual([...(await appliedVersions(pool))].sort(), migrationFiles());

    const before = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    await runMigrations(pool, quiet);
    const after = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(after.rows[0].n, before.rows[0].n);

    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'settlement_jobs'",
    );
    assert.ok(cols.rows.some((r: { column_name: string }) => r.column_name === "traceparent"));
  } finally {
    await pool.end();
  }
});

test("assertSchemaCurrent throws when a migration has not been applied", { skip: !DB }, async () => {
  const pool = new pg.Pool({ connectionString: DB });
  try {
    await runMigrations(pool, quiet);
    await pool.query("DELETE FROM schema_migrations WHERE version = $1", ["002_settlement_jobs.sql"]);
    await assert.rejects(assertSchemaCurrent(pool, quiet), /002_settlement_jobs\.sql/);
    await runMigrations(pool, quiet);
    await assertSchemaCurrent(pool, quiet);
  } finally {
    await pool.end();
  }
});
```

- [x] **Step 4: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test`
Expected: FAIL — `Cannot find module './migrate.js'`.

- [x] **Step 5: Write `services/orders-api/src/db/migrate.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { Logger } from "@sample-app/platform";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixed key: every pod takes the same advisory lock, so concurrent startups serialise
// instead of racing on DDL.
const LOCK_KEY = 4927313;

/**
 * db/migrations lives at the repo root and is copied to /app/db/migrations in the image.
 * Both layouts sit exactly four levels below this file — src/db and dist/db have the same
 * depth — so one relative path covers dev and production.
 */
export function migrationsDir(): string {
  return join(__dirname, "../../../../db/migrations");
}

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir())
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function pendingMigrations(files: string[], applied: Set<string>): string[] {
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !applied.has(f));
}

export async function appliedVersions(pool: Pool): Promise<Set<string>> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => r.version));
}

export async function runMigrations(pool: Pool, logger: Logger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const pending = pendingMigrations(migrationFiles(), new Set(rows.map((r) => r.version)));

    if (pending.length === 0) {
      logger.info("schema up to date");
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(join(migrationsDir(), file), "utf-8");
      logger.info("applying migration", { migration: file });
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger.info("migrations applied", { count: pending.length });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** MIGRATION_REQUIRED=true: refuse to serve against a schema the code was not written for. */
export async function assertSchemaCurrent(pool: Pool, logger: Logger): Promise<void> {
  const missing = pendingMigrations(migrationFiles(), await appliedVersions(pool));
  if (missing.length > 0) {
    logger.error("schema is behind the code", { missing });
    throw new Error(`MIGRATION_REQUIRED=true but these migrations are not applied: ${missing.join(", ")}`);
  }
}
```

- [x] **Step 6: Write `services/orders-api/src/db/migrate-cli.ts`**

This is what the Kubernetes migration Job runs (12-factor XII: admin processes ship in the same image).

```ts
import pg from "pg";
import { createLogger, loadOrExit, optLogLevel, optStr, requireStr } from "@sample-app/platform";
import { runMigrations } from "./migrate.js";

const config = loadOrExit((env) => ({
  databaseUrl: requireStr(env, "DATABASE_URL"),
  logLevel: optLogLevel(env, "LOG_LEVEL", "info"),
  serviceVersion: optStr(env, "SERVICE_VERSION", "dev"),
}));

const logger = createLogger({ service: "orders-api-migrate", version: config.serviceVersion, level: config.logLevel });
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

try {
  await runMigrations(pool, logger);
  await pool.end();
  process.exit(0);
} catch (err) {
  logger.error("migration failed", { err });
  await pool.end().catch(() => {});
  process.exit(1);
}
```

- [x] **Step 7: Run the tests with a database**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
docker compose up -d postgres
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test
```

Expected: PASS — 5 migrate tests, none skipped. Then verify they are skipped, not failed, without a database: `npm test` alone must still pass.

- [x] **Step 8: Run the migration CLI end to end**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm run migrate:dev -w @sample-app/orders-api
```

Expected: exit 0, one `applying migration` line per file on the first run, `schema up to date` on the second.

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(orders-api): database schema and idempotent migration runner"
```

---

### Task 12: orders-api — configuration and versioned response serialisation

**Files:**
- Create: `services/orders-api/src/config.ts`, `services/orders-api/src/serialize.ts`
- Test: `services/orders-api/src/config.test.ts`, `services/orders-api/src/serialize.test.ts`

**Interfaces:**
- Consumes: `CommonConfig`, `loadCommonConfig`, `optInt`, `optBool`, `requireStr`, `ConfigError` (Task 2); `OrderRow`, `OrderV1`, `OrderV2` (Task 1).
- Produces: `OrdersApiConfig` (extends `CommonConfig` with `databaseUrl`, `dbPoolMax`, `dbStatementTimeoutMs`, `migrationRequired`, `orderResponseVersion: 1 | 2`, `livenessChecksDb`), `loadConfig(env): OrdersApiConfig`, `serializeOrder(row: OrderRow, version: 1 | 2): OrderV1 | OrderV2`.

- [x] **Step 1: Write the failing tests**

`services/orders-api/src/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError } from "@sample-app/platform";
import { loadConfig } from "./config.js";

const base = { DATABASE_URL: "postgres://app:pw@db:5432/sample_app" };

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.dbPoolMax, 10);
  assert.equal(c.dbStatementTimeoutMs, 5000);
  assert.equal(c.migrationRequired, true);
  assert.equal(c.orderResponseVersion, 1);
  assert.equal(c.livenessChecksDb, false);
  assert.equal(c.port, 3000);
  assert.equal(c.gracefulShutdownMs, 10000);
});

test("DATABASE_URL is required", () => {
  assert.throws(() => loadConfig({}), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match((err as Error).message, /DATABASE_URL/);
    return true;
  });
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({
    ...base,
    DB_POOL_MAX: "1",
    DB_STATEMENT_TIMEOUT_MS: "250",
    MIGRATION_REQUIRED: "false",
    ORDER_RESPONSE_VERSION: "2",
    LIVENESS_CHECKS_DB: "true",
  });
  assert.equal(c.dbPoolMax, 1);
  assert.equal(c.dbStatementTimeoutMs, 250);
  assert.equal(c.migrationRequired, false);
  assert.equal(c.orderResponseVersion, 2);
  assert.equal(c.livenessChecksDb, true);
});

test("DB_POOL_MAX must be at least 1", () => {
  assert.throws(() => loadConfig({ ...base, DB_POOL_MAX: "0" }), /DB_POOL_MAX/);
});

test("ORDER_RESPONSE_VERSION only accepts 1 or 2", () => {
  assert.throws(() => loadConfig({ ...base, ORDER_RESPONSE_VERSION: "3" }), /ORDER_RESPONSE_VERSION/);
});
```

`services/orders-api/src/serialize.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrderRow } from "@sample-app/contracts";
import { serializeOrder } from "./serialize.js";

const row: OrderRow = {
  id: "018f0000-0000-4000-8000-000000000001",
  customer_id: "web-user",
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  amount_cents: 2598,
  status: "placed",
  created_at: "2026-08-16T09:14:22.417Z",
  updated_at: "2026-08-16T09:14:22.417Z",
};

test("v1 is the shape every consumer is written against", () => {
  assert.deepEqual(serializeOrder(row, 1), {
    id: row.id,
    customer_id: "web-user",
    items: row.items,
    amount_cents: 2598,
    status: "placed",
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

test("v2 renames amount_cents and nests customer — a genuine breaking change", () => {
  assert.deepEqual(serializeOrder(row, 2), {
    id: row.id,
    customer: { id: "web-user" },
    items: row.items,
    amountCents: 2598,
    status: "placed",
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

test("v2 does not keep the v1 field names, so a v1 consumer really fails", () => {
  const v2 = serializeOrder(row, 2) as Record<string, unknown>;
  assert.equal(v2.amount_cents, undefined);
  assert.equal(v2.customer_id, undefined);
});

test("items are untouched by the version switch", () => {
  const v1 = serializeOrder(row, 1) as Record<string, unknown>;
  const v2 = serializeOrder(row, 2) as Record<string, unknown>;
  assert.deepEqual(v1.items, v2.items);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './config.js'` and `'./serialize.js'`.

- [x] **Step 3: Write `services/orders-api/src/config.ts`**

```ts
import {
  ConfigError,
  loadCommonConfig,
  optBool,
  optInt,
  requireStr,
  type CommonConfig,
  type EnvSource,
} from "@sample-app/platform";

export interface OrdersApiConfig extends CommonConfig {
  databaseUrl: string;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  migrationRequired: boolean;
  orderResponseVersion: 1 | 2;
  livenessChecksDb: boolean;
}

export function loadConfig(env: EnvSource): OrdersApiConfig {
  const version = optInt(env, "ORDER_RESPONSE_VERSION", 1, { min: 1, max: 2 });
  if (version !== 1 && version !== 2) throw new ConfigError("ORDER_RESPONSE_VERSION", "must be 1 or 2");

  return {
    ...loadCommonConfig(env),
    databaseUrl: requireStr(env, "DATABASE_URL"),
    dbPoolMax: optInt(env, "DB_POOL_MAX", 10, { min: 1, max: 1000 }),
    dbStatementTimeoutMs: optInt(env, "DB_STATEMENT_TIMEOUT_MS", 5000, { min: 1 }),
    migrationRequired: optBool(env, "MIGRATION_REQUIRED", true),
    orderResponseVersion: version,
    // Conflating liveness with a dependency check turns a brief database stall into a
    // cluster-wide restart storm. That is the point of this knob.
    livenessChecksDb: optBool(env, "LIVENESS_CHECKS_DB", false),
  };
}
```

- [x] **Step 4: Write `services/orders-api/src/serialize.ts`**

```ts
import type { OrderRow, OrderV1, OrderV2 } from "@sample-app/contracts";

/**
 * ORDER_RESPONSE_VERSION. v2 is a real breaking schema change, not a simulated one:
 * checkout-gateway reads `amount_cents` and genuinely fails to parse v2.
 */
export function serializeOrder(row: OrderRow, version: 1 | 2): OrderV1 | OrderV2 {
  if (version === 2) {
    return {
      id: row.id,
      customer: { id: row.customer_id },
      items: row.items,
      amountCents: Number(row.amount_cents),
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
  return {
    id: row.id,
    customer_id: row.customer_id,
    items: row.items,
    amount_cents: Number(row.amount_cents),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
```

- [x] **Step 5: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 5 config tests, 4 serialize tests.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(orders-api): config and versioned order serialisation"
```

---

### Task 13: orders-api — Postgres pool and orders repository

**Files:**
- Create: `services/orders-api/src/db/pool.ts`, `services/orders-api/src/db/orders-repo.ts`
- Test: `services/orders-api/src/db/orders-repo.test.ts`

**Interfaces:**
- Consumes: `Metrics` (Task 4), `currentTraceparent` (Task 10), `OrdersApiConfig` (Task 12), `runMigrations` (Task 11), `OrderRow`, `OrderItem` (Task 1).
- Produces: `createPool(config): pg.Pool`, `OrdersRepo` with `createOrderWithJob(input): Promise<OrderRow>`, `getOrder(id): Promise<OrderRow | null>`, `listOrders(limit): Promise<OrderRow[]>`, `ping(): Promise<void>`; `createOrdersRepo(pool, { metrics, service }): OrdersRepo`.

- [x] **Step 1: Write the failing test**

`services/orders-api/src/db/orders-repo.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createLogger, createMetrics } from "@sample-app/platform";
import { runMigrations } from "./migrate.js";
import { createOrdersRepo, type OrdersRepo } from "./orders-repo.js";

const DB = process.env.TEST_DATABASE_URL;
const quiet = createLogger({ service: "orders-api", version: "test", level: "error", write: () => {} });

let pool: pg.Pool;
let repo: OrdersRepo;
let metrics = createMetrics({ service: "orders-api", version: "test", commit: "test" });

before(async () => {
  if (!DB) return;
  pool = new pg.Pool({ connectionString: DB });
  await runMigrations(pool, quiet);
  repo = createOrdersRepo(pool, { metrics, service: "orders-api" });
});

after(async () => {
  if (pool) await pool.end();
});

const newOrder = () => ({
  id: randomUUID(),
  customerId: "web-user",
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  amountCents: 2598,
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});

test("createOrderWithJob writes the order and its settlement job in one transaction", { skip: !DB }, async () => {
  const input = newOrder();
  const row = await repo.createOrderWithJob(input);
  assert.equal(row.id, input.id);
  assert.equal(row.status, "placed");
  assert.equal(Number(row.amount_cents), 2598);
  assert.deepEqual(row.items, input.items);

  const jobs = await pool.query("SELECT order_id, attempts, traceparent, locked_at FROM settlement_jobs WHERE order_id = $1", [input.id]);
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].attempts, 0);
  assert.equal(jobs.rows[0].locked_at, null);
  assert.equal(jobs.rows[0].traceparent, input.traceparent);
});

test("a failed insert leaves neither an order nor a job behind", { skip: !DB }, async () => {
  const input = newOrder();
  await repo.createOrderWithJob(input);
  await assert.rejects(repo.createOrderWithJob(input), /duplicate key/);

  const orders = await pool.query("SELECT id FROM orders WHERE id = $1", [input.id]);
  const jobs = await pool.query("SELECT id FROM settlement_jobs WHERE order_id = $1", [input.id]);
  assert.equal(orders.rowCount, 1, "the original order survives");
  assert.equal(jobs.rowCount, 1, "the retry added no second job");
});

test("getOrder returns the row, and null for an id that does not exist", { skip: !DB }, async () => {
  const input = newOrder();
  await repo.createOrderWithJob(input);
  assert.equal((await repo.getOrder(input.id))?.id, input.id);
  assert.equal(await repo.getOrder(randomUUID()), null);
});

test("timestamps are serialised as ISO strings, not Date objects", { skip: !DB }, async () => {
  const row = await repo.createOrderWithJob(newOrder());
  assert.equal(typeof row.created_at, "string");
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("listOrders returns the newest first and honours the limit", { skip: !DB }, async () => {
  for (let i = 0; i < 3; i++) await repo.createOrderWithJob(newOrder());
  const rows = await repo.listOrders(2);
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.created_at >= rows[1]!.created_at);
});

test("every query records db_query_duration_seconds under a logical operation label", { skip: !DB }, async () => {
  await repo.createOrderWithJob(newOrder());
  const text = await metrics.registry.metrics();
  assert.match(text, /db_query_duration_seconds_count\{service="orders-api",operation="create_order"\}/);
});

test("ping resolves against a healthy database", { skip: !DB }, async () => {
  await repo.ping();
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test`
Expected: FAIL — `Cannot find module './orders-repo.js'`.

- [x] **Step 3: Write `services/orders-api/src/db/pool.ts`**

```ts
import pg from "pg";
import type { OrdersApiConfig } from "../config.js";

// timestamptz (OID 1184) and timestamp (1114) arrive as ISO strings instead of Date objects,
// so a row can be JSON-serialised straight to the client and compared as text.
pg.types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
pg.types.setTypeParser(1114, (value: string) => new Date(value + "Z").toISOString());

export function createPool(config: Pick<OrdersApiConfig, "databaseUrl" | "dbPoolMax" | "dbStatementTimeoutMs">): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    // DB_POOL_MAX=1 genuinely serialises database access: real queueing, real p99,
    // and the value is visible in k8s_describe_pod.
    max: config.dbPoolMax,
    statement_timeout: config.dbStatementTimeoutMs,
    application_name: "orders-api",
  });
}
```

- [x] **Step 4: Write `services/orders-api/src/db/orders-repo.ts`**

```ts
import type { Pool } from "pg";
import type { OrderItem, OrderRow } from "@sample-app/contracts";
import type { Metrics } from "@sample-app/platform";

export interface CreateOrderInput {
  id: string;
  customerId: string;
  items: OrderItem[];
  amountCents: number;
  /** The checkout request's trace, carried through the queue so the worker's span links back. */
  traceparent: string | null;
}

export interface OrdersRepo {
  createOrderWithJob(input: CreateOrderInput): Promise<OrderRow>;
  getOrder(id: string): Promise<OrderRow | null>;
  listOrders(limit: number): Promise<OrderRow[]>;
  ping(): Promise<void>;
}

export function createOrdersRepo(pool: Pool, deps: { metrics: Metrics; service: string }): OrdersRepo {
  const timed = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    const end = deps.metrics.dbQueryDuration.startTimer({ service: deps.service, operation });
    try {
      return await fn();
    } finally {
      end();
    }
  };

  return {
    async createOrderWithJob(input) {
      return timed("create_order", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const { rows } = await client.query<OrderRow>(
            `INSERT INTO orders (id, customer_id, items, amount_cents, status)
             VALUES ($1, $2, $3::jsonb, $4, 'placed')
             RETURNING id, customer_id, items, amount_cents, status, created_at, updated_at`,
            [input.id, input.customerId, JSON.stringify(input.items), input.amountCents],
          );
          await client.query(
            "INSERT INTO settlement_jobs (order_id, traceparent) VALUES ($1, $2)",
            [input.id, input.traceparent],
          );
          await client.query("COMMIT");
          return rows[0]!;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });
    },

    async getOrder(id) {
      return timed("get_order", async () => {
        const { rows } = await pool.query<OrderRow>(
          `SELECT id, customer_id, items, amount_cents, status, created_at, updated_at
             FROM orders WHERE id = $1`,
          [id],
        );
        return rows[0] ?? null;
      });
    },

    async listOrders(limit) {
      return timed("list_orders", async () => {
        const { rows } = await pool.query<OrderRow>(
          `SELECT id, customer_id, items, amount_cents, status, created_at, updated_at
             FROM orders ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
        return rows;
      });
    },

    async ping() {
      await timed("ping", async () => pool.query("SELECT 1"));
    },
  };
}
```

- [x] **Step 5: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test`
Expected: PASS — 7 repo tests, none skipped.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(orders-api): postgres pool and orders repository"
```

---

### Task 14: orders-api — routes, boot sequence, Dockerfile

**Files:**
- Create: `services/orders-api/src/routes.ts`, `services/orders-api/src/index.ts`, `services/orders-api/Dockerfile`
- Test: `services/orders-api/src/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–13.
- Produces: `RouteDeps`, `createRoutes(deps): Route[]`, a runnable `orders-api` service, and the image built from `services/orders-api/Dockerfile` with the repo root as context.

- [x] **Step 1: Write the failing test**

`services/orders-api/src/routes.test.ts` — the repository is stubbed here on purpose: these tests are about HTTP behaviour, and the real database is exercised in Task 13.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createApp, createLogger, createMetrics, RollingStats, loadCommonConfig } from "@sample-app/platform";
import type { OrderRow } from "@sample-app/contracts";
import { createRoutes } from "./routes.js";

function stubRepo(rows: OrderRow[] = []) {
  const store = new Map(rows.map((r) => [r.id, r]));
  return {
    store,
    createOrderWithJob: async (input: { id: string; customerId: string; items: { sku: string; qty: number; unitCents: number }[]; amountCents: number }) => {
      const row: OrderRow = {
        id: input.id,
        customer_id: input.customerId,
        items: input.items,
        amount_cents: input.amountCents,
        status: "placed",
        created_at: "2026-08-16T09:14:22.417Z",
        updated_at: "2026-08-16T09:14:22.417Z",
      };
      store.set(row.id, row);
      return row;
    },
    getOrder: async (id: string) => store.get(id) ?? null,
    listOrders: async (limit: number) => [...store.values()].slice(0, limit),
    ping: async () => {},
  };
}

async function withApp<T>(
  version: 1 | 2,
  repo: ReturnType<typeof stubRepo>,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const logger = createLogger({ service: "orders-api", version: "test", level: "error", write: () => {} });
  const metrics = createMetrics({ service: "orders-api", version: "test", commit: "test" });
  const server = createApp({
    service: "orders-api",
    config: loadCommonConfig({}),
    logger,
    metrics,
    stats: new RollingStats(),
    routes: createRoutes({ repo, logger, orderResponseVersion: version }),
    readiness: async () => ({ ok: true }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const cart = { customerId: "web-user", items: [{ sku: "sku-widget", qty: 2 }] };

test("POST /orders prices the cart server-side and returns 201", async () => {
  await withApp(1, stubRepo(), async (base) => {
    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cart),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { amount_cents: number; items: { unitCents: number }[]; id: string };
    assert.equal(body.amount_cents, 2598);
    assert.equal(body.items[0]!.unitCents, 1299);
    assert.match(body.id, /^[0-9a-f-]{36}$/);
  });
});

test("POST /orders rejects an unknown sku with 400, not 500", async () => {
  await withApp(1, stubRepo(), async (base) => {
    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "web", items: [{ sku: "ghost", qty: 1 }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; detail: string };
    assert.equal(body.error, "invalid_request");
    assert.match(body.detail, /ghost/);
  });
});

test("POST /orders rejects a malformed body and an empty cart with 400", async () => {
  await withApp(1, stubRepo(), async (base) => {
    const bad = await fetch(`${base}/orders`, { method: "POST", body: "not json" });
    assert.equal(bad.status, 400);
    const empty = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "web", items: [] }),
    });
    assert.equal(empty.status, 400);
  });
});

test("GET /orders/:id returns the order, and 404 when it is absent", async () => {
  const repo = stubRepo();
  await withApp(1, repo, async (base) => {
    const created = await (await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cart),
    })).json() as { id: string };
    assert.equal((await fetch(`${base}/orders/${created.id}`)).status, 200);
    const missing = await fetch(`${base}/orders/${randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: string }).error, "not_found");
  });
});

test("ORDER_RESPONSE_VERSION=2 changes the shape on the wire", async () => {
  await withApp(2, stubRepo(), async (base) => {
    const body = await (await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cart),
    })).json() as Record<string, unknown>;
    assert.equal(body.amount_cents, undefined);
    assert.equal(body.amountCents, 2598);
    assert.deepEqual(body.customer, { id: "web-user" });
  });
});

test("GET /orders caps limit at 100 and rejects a non-numeric limit", async () => {
  const repo = stubRepo();
  await withApp(1, repo, async (base) => {
    let seen = 0;
    repo.listOrders = async (limit: number) => { seen = limit; return []; };
    await fetch(`${base}/orders?limit=5000`);
    assert.equal(seen, 100);
    await fetch(`${base}/orders`);
    assert.equal(seen, 20);
    assert.equal((await fetch(`${base}/orders?limit=abc`)).status, 400);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './routes.js'`.

- [x] **Step 3: Write `services/orders-api/src/routes.ts`**

```ts
import { randomUUID } from "node:crypto";
import { UnknownSkuError, computeAmountCents, computeItems, type CartItem } from "@sample-app/contracts";
import { currentTraceparent, sendJson, type Logger, type Route } from "@sample-app/platform";
import type { OrdersRepo } from "./db/orders-repo.js";
import { serializeOrder } from "./serialize.js";

export interface RouteDeps {
  repo: OrdersRepo;
  logger: Logger;
  orderResponseVersion: 1 | 2;
}

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;

function parseCart(raw: string): { customerId: string; items: CartItem[] } {
  const parsed = JSON.parse(raw) as { customerId?: unknown; items?: unknown };
  if (typeof parsed.customerId !== "string" || parsed.customerId.trim() === "") {
    throw new Error("customerId is required");
  }
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  const items = parsed.items.map((line) => {
    const item = line as { sku?: unknown; qty?: unknown };
    if (typeof item.sku !== "string") throw new Error("each item needs a sku");
    if (typeof item.qty !== "number") throw new Error(`qty must be a number for ${item.sku}`);
    return { sku: item.sku, qty: item.qty };
  });
  return { customerId: parsed.customerId, items };
}

export function createRoutes(deps: RouteDeps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/orders",
      handler: async ({ res, readBody }) => {
        let cart: { customerId: string; items: CartItem[] };
        let items;
        try {
          cart = parseCart(await readBody());
          items = computeItems(cart.items);
        } catch (err) {
          const detail = err instanceof UnknownSkuError ? err.message : err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: "invalid_request", detail });
          return;
        }

        const order = await deps.repo.createOrderWithJob({
          id: randomUUID(),
          customerId: cart.customerId,
          items,
          amountCents: computeAmountCents(items),
          traceparent: currentTraceparent(),
        });
        deps.logger.info("order created", { order_id: order.id, amount_cents: order.amount_cents });
        sendJson(res, 201, serializeOrder(order, deps.orderResponseVersion));
      },
    },
    {
      method: "GET",
      pattern: "/orders/:id",
      handler: async ({ res, params }) => {
        const order = await deps.repo.getOrder(params.id!);
        if (!order) {
          sendJson(res, 404, { error: "not_found", id: params.id });
          return;
        }
        sendJson(res, 200, serializeOrder(order, deps.orderResponseVersion));
      },
    },
    {
      method: "GET",
      pattern: "/orders",
      handler: async ({ res, url }) => {
        const raw = url.searchParams.get("limit");
        if (raw !== null && !/^\d+$/.test(raw)) {
          sendJson(res, 400, { error: "invalid_request", detail: "limit must be a positive integer" });
          return;
        }
        const limit = raw === null ? DEFAULT_LIST_LIMIT : Math.min(MAX_LIST_LIMIT, Math.max(1, Number(raw)));
        const orders = await deps.repo.listOrders(limit);
        sendJson(res, 200, { orders: orders.map((o) => serializeOrder(o, deps.orderResponseVersion)) });
      },
    },
  ];
}
```

- [x] **Step 4: Write `services/orders-api/src/index.ts`**

```ts
import {
  bindPoolMetrics,
  createApp,
  createLogger,
  createMetrics,
  initTracing,
  installShutdown,
  loadOrExit,
  redactConfig,
  RollingStats,
  traceContext,
  type ProbeResult,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createOrdersRepo } from "./db/orders-repo.js";
import { assertSchemaCurrent } from "./db/migrate.js";
import { createRoutes } from "./routes.js";

const SERVICE = "orders-api";

const config = loadOrExit(loadConfig);
const logger = createLogger({
  service: SERVICE,
  version: config.serviceVersion,
  level: config.logLevel,
  traceContext,
});
const tracing = initTracing({
  service: SERVICE,
  version: config.serviceVersion,
  deploymentEnv: config.deploymentEnv,
  endpoint: config.otelEndpoint,
  logger,
});
const metrics = createMetrics({ service: SERVICE, version: config.serviceVersion, commit: config.serviceVersion });

// Logged once at boot so the running fault knob is findable in Loki, not only in the pod spec.
logger.info("starting", { config: redactConfig({ ...config }) });

const pool = createPool(config);
bindPoolMetrics(metrics, pool);
const repo = createOrdersRepo(pool, { metrics, service: SERVICE });

if (config.migrationRequired) {
  try {
    await assertSchemaCurrent(pool, logger);
  } catch (err) {
    logger.error("refusing to start against an out-of-date schema", { err });
    process.exit(1);
  }
}

const readiness = async (): Promise<ProbeResult> => {
  if (pool.waitingCount > 0 && pool.idleCount === 0) {
    return { ok: false, detail: `db pool exhausted: ${pool.waitingCount} waiting` };
  }
  try {
    await repo.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `db unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const server = createApp({
  service: SERVICE,
  config,
  logger,
  metrics,
  stats: new RollingStats(),
  routes: createRoutes({ repo, logger, orderResponseVersion: config.orderResponseVersion }),
  readiness,
  // LIVENESS_CHECKS_DB=true makes the kubelet restart healthy pods when the database
  // stalls — a cluster-wide restart storm whose symptom points nowhere near its cause.
  liveness: config.livenessChecksDb ? readiness : undefined,
  traceIdOf: () => traceContext().trace_id,
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: [
    { name: "db pool", run: () => pool.end() },
    ...(tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : []),
  ],
});

server.listen(config.port, () => logger.info("listening", { port: config.port }));
```

- [x] **Step 5: Write `services/orders-api/Dockerfile`**

Build context is the repo root: `docker build -f services/orders-api/Dockerfile -t orders-api:$(git rev-parse --short HEAD) .`

```dockerfile
# Build context is the repository root — packages/ is shared by every service.
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/orders-api/package.json services/orders-api/

# --ignore-scripts: this stage only runs `tsc`, but npm ci also installs tsx, whose esbuild
# dependency has a postinstall that EXECS the binary it just wrote. Under QEMU emulation —
# any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the write and
# dies with ETXTBSY. No dependency here needs its install scripts.
RUN npm ci --ignore-scripts

COPY packages/ packages/
COPY services/orders-api/ services/orders-api/

RUN npm run build -w @sample-app/contracts \
 && npm run build -w @sample-app/platform \
 && npm run build -w @sample-app/orders-api


FROM node:24-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/orders-api/package.json services/orders-api/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/services/orders-api/dist services/orders-api/dist
# The migration Job runs `node services/orders-api/dist/db/migrate-cli.js` from this image.
COPY db/migrations db/migrations

ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "services/orders-api/dist/index.js"]
```

- [x] **Step 6: Run the tests, then the service end to end**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
npm run build

DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app PORT=3002 \
  node services/orders-api/dist/index.js &
sleep 1
curl -s localhost:3002/readyz
curl -s -X POST localhost:3002/orders -H 'content-type: application/json' \
  -d '{"customerId":"web-user","items":[{"sku":"sku-widget","qty":2}]}'
curl -s localhost:3002/metrics | grep -E '^(build_info|http_server_requests_total|db_query)'
kill %1
```

Expected: `/readyz` returns `{"status":"ready"...}`, the POST returns 201 with `amount_cents: 2598`, and `/metrics` shows `build_info`, `http_server_requests_total{...route="/orders"...}` and `db_query_duration_seconds`.

- [x] **Step 7: Build the image**

```bash
docker build -f services/orders-api/Dockerfile \
  --build-arg SERVICE_VERSION=$(git rev-parse --short HEAD) \
  -t orders-api:$(git rev-parse --short HEAD) .
```

Expected: the build succeeds from the repo root context.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(orders-api): routes, boot sequence and dockerfile"
```

---

### Task 15: checkout-gateway — configuration and the in-process TTL cache

**Files:**
- Create: `services/checkout-gateway/package.json`, `services/checkout-gateway/tsconfig.json`, `services/checkout-gateway/src/config.ts`, `services/checkout-gateway/src/cache.ts`
- Test: `services/checkout-gateway/src/config.test.ts`, `services/checkout-gateway/src/cache.test.ts`

**Interfaces:**
- Consumes: `loadCommonConfig`, `optInt`, `requireUrl`, `CommonConfig`, `EnvSource` (Task 2).
- Produces: `GatewayConfig` (extends `CommonConfig` with `ordersApiUrl`, `workerUrl`, `downstreamTimeoutMs`, `cacheTtlSeconds`, `cacheMaxEntries`), `loadConfig(env)`, `TtlCache<T>` with `get`/`set`/`size`, `createCache<T>({ttlSeconds, maxEntries, now?})`.

- [x] **Step 1: Write `services/checkout-gateway/package.json` and `tsconfig.json`**

`services/checkout-gateway/package.json`:

```json
{
  "name": "@sample-app/checkout-gateway",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --import tsx --watch src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@sample-app/contracts": "*",
    "@sample-app/platform": "*"
  }
}
```

`services/checkout-gateway/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [
    { "path": "../../packages/contracts" },
    { "path": "../../packages/platform" }
  ]
}
```

- [x] **Step 2: Write the failing tests**

`services/checkout-gateway/src/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = {
  ORDERS_API_URL: "http://orders-api:3000",
  WORKER_URL: "http://settlement-worker:3001",
};

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.downstreamTimeoutMs, 2000);
  assert.equal(c.cacheTtlSeconds, 30);
  assert.equal(c.cacheMaxEntries, 1000);
  assert.equal(c.ordersApiUrl, "http://orders-api:3000");
  assert.equal(c.workerUrl, "http://settlement-worker:3001");
});

test("both upstream URLs are required — the gateway cannot invent an address", () => {
  assert.throws(() => loadConfig({ WORKER_URL: base.WORKER_URL }), /ORDERS_API_URL/);
  assert.throws(() => loadConfig({ ORDERS_API_URL: base.ORDERS_API_URL }), /WORKER_URL/);
});

test("a URL that is not a URL fails at boot, not on the first request", () => {
  assert.throws(() => loadConfig({ ...base, ORDERS_API_URL: "orders-api:3000" }), /ORDERS_API_URL/);
});

test("a trailing slash is stripped so joined paths never double up", () => {
  const c = loadConfig({ ...base, ORDERS_API_URL: "http://orders-api:3000/" });
  assert.equal(c.ordersApiUrl, "http://orders-api:3000");
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({ ...base, DOWNSTREAM_TIMEOUT_MS: "50", CACHE_TTL_SECONDS: "0", CACHE_MAX_ENTRIES: "5" });
  assert.equal(c.downstreamTimeoutMs, 50);
  assert.equal(c.cacheTtlSeconds, 0);
  assert.equal(c.cacheMaxEntries, 5);
});
```

`services/checkout-gateway/src/cache.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCache } from "./cache.js";

test("a cold cache misses — it is never authoritative on its own", () => {
  const cache = createCache<string>({ ttlSeconds: 30, maxEntries: 10 });
  assert.equal(cache.get("order-1"), undefined);
  assert.equal(cache.size, 0);
});

test("a stored value comes back until its ttl elapses", () => {
  let now = 1_000;
  const cache = createCache<string>({ ttlSeconds: 30, maxEntries: 10, now: () => now });
  cache.set("order-1", "placed");
  now += 29_999;
  assert.equal(cache.get("order-1"), "placed");
  now += 2;
  assert.equal(cache.get("order-1"), undefined, "expired");
});

test("an expired entry is dropped, not merely hidden", () => {
  let now = 0;
  const cache = createCache<string>({ ttlSeconds: 1, maxEntries: 10, now: () => now });
  cache.set("order-1", "placed");
  now += 2_000;
  cache.get("order-1");
  assert.equal(cache.size, 0);
});

test("CACHE_TTL_SECONDS=0 disables storage entirely", () => {
  const cache = createCache<string>({ ttlSeconds: 0, maxEntries: 10 });
  cache.set("order-1", "placed");
  assert.equal(cache.get("order-1"), undefined);
  assert.equal(cache.size, 0);
});

test("the oldest entry is evicted once maxEntries is reached", () => {
  const cache = createCache<string>({ ttlSeconds: 30, maxEntries: 2 });
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), "3");
});

test("re-setting a key refreshes it without growing the cache", () => {
  let now = 0;
  const cache = createCache<string>({ ttlSeconds: 10, maxEntries: 5, now: () => now });
  cache.set("a", "1");
  now += 9_000;
  cache.set("a", "2");
  now += 9_000;
  assert.equal(cache.get("a"), "2");
  assert.equal(cache.size, 1);
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './config.js'` and `'./cache.js'`.

- [x] **Step 4: Write `services/checkout-gateway/src/config.ts`**

```ts
import { loadCommonConfig, optInt, requireUrl, type CommonConfig, type EnvSource } from "@sample-app/platform";

export interface GatewayConfig extends CommonConfig {
  ordersApiUrl: string;
  workerUrl: string;
  downstreamTimeoutMs: number;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
}

export function loadConfig(env: EnvSource): GatewayConfig {
  return {
    ...loadCommonConfig(env),
    ordersApiUrl: requireUrl(env, "ORDERS_API_URL"),
    // chain-status aggregates the worker's /queue-stats, so the gateway needs its address.
    workerUrl: requireUrl(env, "WORKER_URL"),
    // Set below the upstream's real latency and the gateway gives up on a healthy service:
    // gateway spans fail while orders-api spans stay OK.
    downstreamTimeoutMs: optInt(env, "DOWNSTREAM_TIMEOUT_MS", 2000, { min: 1 }),
    cacheTtlSeconds: optInt(env, "CACHE_TTL_SECONDS", 30, { min: 0 }),
    cacheMaxEntries: optInt(env, "CACHE_MAX_ENTRIES", 1000, { min: 1 }),
  };
}
```

- [x] **Step 5: Write `services/checkout-gateway/src/cache.ts`**

```ts
export interface TtlCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  readonly size: number;
}

export interface CacheOptions {
  ttlSeconds: number;
  maxEntries: number;
  now?: () => number;
}

/**
 * Per-process, bounded, and correct when cold (12-factor VI). Deliberately a Map and not a
 * backing service: a shared cache would hide the CACHE_TTL_SECONDS fault behind another tier.
 */
export function createCache<T>(opts: CacheOptions): TtlCache<T> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlSeconds * 1000;
  const entries = new Map<string, { value: T; expiresAt: number }>();

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },

    set(key, value) {
      if (ttlMs === 0) return;
      // Map iterates in insertion order, so the first key is the oldest.
      entries.delete(key);
      if (entries.size >= opts.maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },

    get size() {
      return entries.size;
    },
  };
}
```

- [x] **Step 6: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 5 config tests, 6 cache tests.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(checkout-gateway): config and bounded ttl cache"
```

---

### Task 16: checkout-gateway — chain-status aggregation, routes, Dockerfile

**Files:**
- Create: `services/checkout-gateway/src/chain.ts`, `services/checkout-gateway/src/routes.ts`, `services/checkout-gateway/src/index.ts`, `services/checkout-gateway/Dockerfile`
- Test: `services/checkout-gateway/src/chain.test.ts`, `services/checkout-gateway/src/routes.test.ts`

**Interfaces:**
- Consumes: `HttpClient`, `DownstreamError`, `statusForDownstream` (Task 8); `createApp`, `sendJson` (Task 6); `TtlCache` (Task 15); `ChainStatus`, `HopStatus`, `ServiceStats`, `QueueStats` (Task 1).
- Produces: `DEGRADED_ERROR_RATE`, `DEGRADED_P99_MS`, `probeHop(client, name, statsUrl)`, `buildChainStatus(deps): Promise<ChainStatus>`, `assertOrderV1(payload): OrderV1`, `createRoutes(deps): Route[]`, and the `checkout-gateway` image.

- [x] **Step 1: Write `services/checkout-gateway/src/chain.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DownstreamError, type HttpClient } from "@sample-app/platform";
import type { ServiceStats } from "@sample-app/contracts";
import { buildChainStatus, DEGRADED_ERROR_RATE } from "./chain.js";

const stats = (over: Partial<ServiceStats> = {}): ServiceStats => ({
  service: "orders-api",
  version: "abc123",
  p99Ms: 42,
  errorRate: 0,
  requests: 120,
  windowSeconds: 60,
  ...over,
});

function clientFor(responses: Record<string, unknown | Error>): HttpClient {
  const respond = async (_peer: string, url: string) => {
    const value = responses[new URL(url).pathname + "@" + new URL(url).port];
    if (value === undefined) throw new Error(`unexpected call: ${url}`);
    if (value instanceof Error) throw value;
    return value;
  };
  return { getJson: respond as HttpClient["getJson"], postJson: respond as HttpClient["postJson"] };
}

const deps = (client: HttpClient) => ({
  client,
  selfStats: () => stats({ service: "checkout-gateway" }),
  ordersApiUrl: "http://orders-api:3000",
  workerUrl: "http://settlement-worker:3001",
});

test("a healthy chain reports three hops plus queue depth", async () => {
  const chain = await buildChainStatus(deps(clientFor({
    "/stats@3000": stats(),
    "/stats@3001": stats({ service: "settlement-worker" }),
    "/queue-stats@3001": { depth: 3, oldestAgeSeconds: 1.5 },
  })));

  assert.deepEqual(chain.hops.map((h) => h.name), ["checkout-gateway", "orders-api", "settlement-worker"]);
  assert.deepEqual(chain.hops.map((h) => h.state), ["ok", "ok", "ok"]);
  assert.deepEqual(chain.queue, { depth: 3, oldestAgeSeconds: 1.5 });
  assert.match(chain.checkedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("one unreachable hop is reported, never fatal — a status page must survive the incident", async () => {
  const chain = await buildChainStatus(deps(clientFor({
    "/stats@3000": new DownstreamError("orders-api timed out after 2000ms", { peer: "orders-api", kind: "timeout" }),
    "/stats@3001": stats({ service: "settlement-worker" }),
    "/queue-stats@3001": { depth: 0, oldestAgeSeconds: 0 },
  })));

  const orders = chain.hops.find((h) => h.name === "orders-api")!;
  assert.equal(orders.state, "unreachable");
  assert.match(orders.detail!, /timed out/);
  assert.equal(orders.stats, null);
  assert.equal(chain.hops.find((h) => h.name === "settlement-worker")!.state, "ok");
});

test("an error rate above the alert threshold reads as degraded, not ok", async () => {
  const chain = await buildChainStatus(deps(clientFor({
    "/stats@3000": stats({ errorRate: DEGRADED_ERROR_RATE + 0.01 }),
    "/stats@3001": stats({ service: "settlement-worker" }),
    "/queue-stats@3001": { depth: 0, oldestAgeSeconds: 0 },
  })));
  assert.equal(chain.hops.find((h) => h.name === "orders-api")!.state, "degraded");
});

test("a p99 above one second reads as degraded — the same threshold the alert uses", async () => {
  const chain = await buildChainStatus(deps(clientFor({
    "/stats@3000": stats({ p99Ms: 1500 }),
    "/stats@3001": stats({ service: "settlement-worker" }),
    "/queue-stats@3001": { depth: 0, oldestAgeSeconds: 0 },
  })));
  assert.equal(chain.hops.find((h) => h.name === "orders-api")!.state, "degraded");
});

test("a reachable worker with an unreadable queue keeps the hop and nulls the queue", async () => {
  const chain = await buildChainStatus(deps(clientFor({
    "/stats@3000": stats(),
    "/stats@3001": stats({ service: "settlement-worker" }),
    "/queue-stats@3001": new DownstreamError("boom", { peer: "settlement-worker", kind: "status", status: 500 }),
  })));
  assert.equal(chain.hops.find((h) => h.name === "settlement-worker")!.state, "ok");
  assert.equal(chain.queue, null);
});

test("the gateway's own hop needs no network call", async () => {
  const chain = await buildChainStatus(deps(clientFor({
    "/stats@3000": new DownstreamError("down", { peer: "orders-api", kind: "network" }),
    "/stats@3001": new DownstreamError("down", { peer: "settlement-worker", kind: "network" }),
    "/queue-stats@3001": new DownstreamError("down", { peer: "settlement-worker", kind: "network" }),
  })));
  assert.equal(chain.hops[0]!.state, "ok");
  assert.equal(chain.hops[0]!.stats!.service, "checkout-gateway");
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './chain.js'`.

- [x] **Step 3: Write `services/checkout-gateway/src/chain.ts`**

```ts
import type { ChainStatus, HopStatus, QueueStats, ServiceStats } from "@sample-app/contracts";
import { DownstreamError, type HttpClient } from "@sample-app/platform";

/** Deliberately the same numbers as SampleAppHighErrorRate and SampleAppHighLatency: the
 *  status page and the alert must never disagree about what "degraded" means. */
export const DEGRADED_ERROR_RATE = 0.05;
export const DEGRADED_P99_MS = 1000;

export interface ChainDeps {
  client: HttpClient;
  selfStats: () => ServiceStats;
  ordersApiUrl: string;
  workerUrl: string;
}

export async function probeHop(client: HttpClient, name: string, statsUrl: string): Promise<HopStatus> {
  try {
    const stats = await client.getJson<ServiceStats>(name, statsUrl);
    const degraded = stats.errorRate > DEGRADED_ERROR_RATE || (stats.p99Ms !== null && stats.p99Ms > DEGRADED_P99_MS);
    return {
      name,
      state: degraded ? "degraded" : "ok",
      detail: degraded ? `errorRate=${stats.errorRate.toFixed(3)} p99=${stats.p99Ms ?? "n/a"}ms` : undefined,
      stats,
    };
  } catch (err) {
    return {
      name,
      state: "unreachable",
      detail: err instanceof DownstreamError ? err.message : String(err),
      stats: null,
    };
  }
}

export async function buildChainStatus(deps: ChainDeps): Promise<ChainStatus> {
  // Each hop is fetched independently and concurrently: one dead hop must not decide the
  // fate of the others, and the page must not take the sum of every timeout to render.
  const [ordersHop, workerHop, queue] = await Promise.all([
    probeHop(deps.client, "orders-api", `${deps.ordersApiUrl}/stats`),
    probeHop(deps.client, "settlement-worker", `${deps.workerUrl}/stats`),
    deps.client
      .getJson<QueueStats>("settlement-worker", `${deps.workerUrl}/queue-stats`)
      .catch(() => null),
  ]);

  const self: HopStatus = { name: "checkout-gateway", state: "ok", stats: deps.selfStats() };

  return {
    hops: [self, ordersHop, workerHop],
    queue,
    checkedAt: new Date().toISOString(),
  };
}
```

- [x] **Step 4: Write `services/checkout-gateway/src/routes.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, createLogger, createMetrics, loadCommonConfig, RollingStats, DownstreamError, type HttpClient } from "@sample-app/platform";
import { createCache } from "./cache.js";
import { assertOrderV1, createRoutes } from "./routes.js";

const orderV1 = {
  id: "018f0000-0000-4000-8000-000000000001",
  customer_id: "web-user",
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  amount_cents: 2598,
  status: "placed",
  created_at: "2026-08-16T09:14:22.417Z",
  updated_at: "2026-08-16T09:14:22.417Z",
};

function stubClient(handlers: { get?: (url: string) => unknown; post?: (url: string, body: unknown) => unknown }): HttpClient {
  return {
    getJson: (async (_peer: string, url: string) => {
      const value = handlers.get?.(url);
      if (value instanceof Error) throw value;
      return value;
    }) as HttpClient["getJson"],
    postJson: (async (_peer: string, url: string, body: unknown) => {
      const value = handlers.post?.(url, body);
      if (value instanceof Error) throw value;
      return value;
    }) as HttpClient["postJson"],
  };
}

async function withApp<T>(
  client: HttpClient,
  fn: (base: string, metrics: ReturnType<typeof createMetrics>) => Promise<T>,
  cacheTtlSeconds = 30,
): Promise<T> {
  const logger = createLogger({ service: "checkout-gateway", version: "test", level: "error", write: () => {} });
  const metrics = createMetrics({ service: "checkout-gateway", version: "test", commit: "test" });
  const stats = new RollingStats();
  const server = createApp({
    service: "checkout-gateway",
    config: loadCommonConfig({}),
    logger,
    metrics,
    stats,
    routes: createRoutes({
      client,
      logger,
      metrics,
      cache: createCache({ ttlSeconds: cacheTtlSeconds, maxEntries: 100 }),
      selfStats: () => ({ service: "checkout-gateway", version: "test", ...stats.snapshot() }),
      ordersApiUrl: "http://orders-api:3000",
      workerUrl: "http://settlement-worker:3001",
    }),
    readiness: async () => ({ ok: true }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, metrics);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("POST /api/checkout forwards the cart and returns 201", async () => {
  let seenUrl = "";
  const client = stubClient({ post: (url) => { seenUrl = url; return orderV1; } });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "web-user", items: [{ sku: "sku-widget", qty: 2 }] }),
    });
    assert.equal(res.status, 201);
    assert.equal(seenUrl, "http://orders-api:3000/orders");
    assert.equal((await res.json() as { amount_cents: number }).amount_cents, 2598);
  });
});

test("an upstream timeout becomes 504 with a trace_id, not a 500", async () => {
  const client = stubClient({ post: () => new DownstreamError("orders-api timed out after 50ms", { peer: "orders-api", kind: "timeout" }) });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "web-user", items: [] }),
    });
    assert.equal(res.status, 504);
    const body = await res.json() as { error: string; peer: string; trace_id: string | null };
    assert.equal(body.error, "upstream_timeout");
    assert.equal(body.peer, "orders-api");
    assert.ok("trace_id" in body);
  });
});

test("an upstream 5xx becomes 502", async () => {
  const client = stubClient({ post: () => new DownstreamError("orders-api returned 500", { peer: "orders-api", kind: "status", status: 500 }) });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "web-user", items: [] }),
    });
    assert.equal(res.status, 502);
  });
});

test("an upstream 4xx is passed through — a bad cart is not a gateway fault", async () => {
  const client = stubClient({ post: () => new DownstreamError("orders-api returned 400", { peer: "orders-api", kind: "status", status: 400 }) });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId: "web-user", items: [{ sku: "ghost", qty: 1 }] }),
    });
    assert.equal(res.status, 400);
  });
});

test("GET /api/orders/:id serves the second read from cache and counts hit and miss", async () => {
  let calls = 0;
  const client = stubClient({ get: () => { calls++; return orderV1; } });
  await withApp(client, async (base, metrics) => {
    await fetch(`${base}/api/orders/${orderV1.id}`);
    await fetch(`${base}/api/orders/${orderV1.id}`);
    assert.equal(calls, 1);
    const text = await metrics.registry.metrics();
    assert.match(text, /cache_requests_total\{service="checkout-gateway",result="miss"\} 1/);
    assert.match(text, /cache_requests_total\{service="checkout-gateway",result="hit"\} 1/);
  });
});

test("CACHE_TTL_SECONDS=0 sends every read upstream", async () => {
  let calls = 0;
  const client = stubClient({ get: () => { calls++; return orderV1; } });
  await withApp(client, async (base) => {
    await fetch(`${base}/api/orders/${orderV1.id}`);
    await fetch(`${base}/api/orders/${orderV1.id}`);
    assert.equal(calls, 2);
  }, 0);
});

test("a 404 from orders-api is forwarded and never cached", async () => {
  let calls = 0;
  const client = stubClient({ get: () => { calls++; return new DownstreamError("orders-api returned 404", { peer: "orders-api", kind: "status", status: 404 }); } });
  await withApp(client, async (base) => {
    assert.equal((await fetch(`${base}/api/orders/${orderV1.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/orders/${orderV1.id}`)).status, 404);
    assert.equal(calls, 2);
  });
});

test("ORDER_RESPONSE_VERSION=2 upstream really breaks the gateway", () => {
  const v2 = { ...orderV1, amount_cents: undefined, customer_id: undefined, amountCents: 2598, customer: { id: "web-user" } };
  assert.throws(() => assertOrderV1(v2), (err: unknown) => {
    assert.ok(err instanceof DownstreamError);
    assert.equal((err as DownstreamError).kind, "parse");
    return true;
  });
  assert.doesNotThrow(() => assertOrderV1(orderV1));
});

test("GET /api/chain-status returns the aggregate and stays 200 with a dead hop", async () => {
  const client = stubClient({
    get: (url) => (url.includes("orders-api")
      ? new DownstreamError("orders-api unreachable", { peer: "orders-api", kind: "network" })
      : url.endsWith("/queue-stats")
        ? { depth: 0, oldestAgeSeconds: 0 }
        : { service: "settlement-worker", version: "test", p99Ms: 1, errorRate: 0, requests: 1, windowSeconds: 60 }),
  });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/api/chain-status`);
    assert.equal(res.status, 200);
    const chain = await res.json() as { hops: { name: string; state: string }[] };
    assert.equal(chain.hops.find((h) => h.name === "orders-api")!.state, "unreachable");
  });
});
```

- [x] **Step 5: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './routes.js'`.

- [x] **Step 6: Write `services/checkout-gateway/src/routes.ts`**

```ts
import type { OrderV1, ServiceStats } from "@sample-app/contracts";
import {
  DownstreamError,
  sendJson,
  statusForDownstream,
  traceContext,
  type HttpClient,
  type Logger,
  type Metrics,
  type Route,
  type RouteContext,
} from "@sample-app/platform";
import { buildChainStatus } from "./chain.js";
import type { TtlCache } from "./cache.js";

export interface RouteDeps {
  client: HttpClient;
  logger: Logger;
  metrics: Metrics;
  cache: TtlCache<OrderV1>;
  selfStats: () => ServiceStats;
  ordersApiUrl: string;
  workerUrl: string;
}

const SERVICE = "checkout-gateway";

/**
 * The gateway is written against v1 and must genuinely fail on v2 — a tolerant reader here
 * would turn the ORDER_RESPONSE_VERSION fault into a silent no-op.
 */
export function assertOrderV1(payload: unknown): OrderV1 {
  const order = payload as Partial<OrderV1>;
  if (typeof order?.id !== "string" || typeof order.customer_id !== "string" || typeof order.amount_cents !== "number") {
    throw new DownstreamError(
      `orders-api returned a response this gateway cannot read: ${JSON.stringify(payload).slice(0, 200)}`,
      { peer: "orders-api", kind: "parse" },
    );
  }
  return order as OrderV1;
}

function guard(deps: RouteDeps, handler: (ctx: RouteContext) => Promise<void>) {
  return async (ctx: RouteContext): Promise<void> => {
    try {
      await handler(ctx);
    } catch (err) {
      if (!(err instanceof DownstreamError)) throw err;
      // A 4xx belongs to the caller, not to the gateway: forwarding it keeps a bad cart out
      // of http_server_requests_total{status=~"5.."} and out of SampleAppHighErrorRate.
      const status = err.kind === "status" && err.status !== undefined && err.status < 500
        ? err.status
        : statusForDownstream(err);
      const error = err.kind === "timeout" ? "upstream_timeout" : err.kind === "parse" ? "upstream_unreadable" : "upstream_error";
      deps.logger.error("downstream call failed", { peer: err.peer, kind: err.kind, upstream_status: err.status, err });
      sendJson(ctx.res, status, { error, peer: err.peer, detail: err.message, trace_id: traceContext().trace_id ?? null });
    }
  };
}

export function createRoutes(deps: RouteDeps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/api/checkout",
      handler: guard(deps, async ({ res, readBody }) => {
        const body = await readBody();
        const created = assertOrderV1(await deps.client.postJson("orders-api", `${deps.ordersApiUrl}/orders`, JSON.parse(body)));
        deps.logger.info("checkout forwarded", { order_id: created.id });
        sendJson(res, 201, created);
      }),
    },
    {
      method: "GET",
      pattern: "/api/orders/:id",
      handler: guard(deps, async ({ res, params }) => {
        const id = params.id!;
        const cached = deps.cache.get(id);
        if (cached) {
          deps.metrics.cacheRequests.inc({ service: SERVICE, result: "hit" });
          sendJson(res, 200, cached);
          return;
        }
        deps.metrics.cacheRequests.inc({ service: SERVICE, result: "miss" });
        const order = assertOrderV1(await deps.client.getJson("orders-api", `${deps.ordersApiUrl}/orders/${encodeURIComponent(id)}`));
        deps.cache.set(id, order);
        sendJson(res, 200, order);
      }),
    },
    {
      method: "GET",
      pattern: "/api/chain-status",
      handler: async ({ res }) => {
        // Never guarded and never 500: a status page that dies during an incident is worthless.
        sendJson(res, 200, await buildChainStatus({
          client: deps.client,
          selfStats: deps.selfStats,
          ordersApiUrl: deps.ordersApiUrl,
          workerUrl: deps.workerUrl,
        }));
      },
    },
  ];
}
```

- [x] **Step 7: Write `services/checkout-gateway/src/index.ts`**

```ts
import {
  createApp,
  createHttpClient,
  createLogger,
  createMetrics,
  initTracing,
  installShutdown,
  loadOrExit,
  redactConfig,
  RollingStats,
  traceContext,
  type ProbeResult,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
import { createCache } from "./cache.js";
import { createRoutes } from "./routes.js";

const SERVICE = "checkout-gateway";

const config = loadOrExit(loadConfig);
const logger = createLogger({ service: SERVICE, version: config.serviceVersion, level: config.logLevel, traceContext });
const tracing = initTracing({
  service: SERVICE,
  version: config.serviceVersion,
  deploymentEnv: config.deploymentEnv,
  endpoint: config.otelEndpoint,
  logger,
});
const metrics = createMetrics({ service: SERVICE, version: config.serviceVersion, commit: config.serviceVersion });
logger.info("starting", { config: redactConfig({ ...config }) });

const client = createHttpClient({ service: SERVICE, metrics, timeoutMs: config.downstreamTimeoutMs });
const stats = new RollingStats();
const cache = createCache<import("@sample-app/contracts").OrderV1>({
  ttlSeconds: config.cacheTtlSeconds,
  maxEntries: config.cacheMaxEntries,
});

// Readiness checks the downstream (spec §8): a gateway that cannot reach orders-api serves
// nothing useful. It probes /healthz — orders-api's own readiness must not chain into ours.
const readiness = async (): Promise<ProbeResult> => {
  try {
    await client.getJson("orders-api", `${config.ordersApiUrl}/healthz`, { timeoutMs: 1000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `orders-api unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const server = createApp({
  service: SERVICE,
  config,
  logger,
  metrics,
  stats,
  routes: createRoutes({
    client,
    logger,
    metrics,
    cache,
    selfStats: () => ({ service: SERVICE, version: config.serviceVersion, ...stats.snapshot() }),
    ordersApiUrl: config.ordersApiUrl,
    workerUrl: config.workerUrl,
  }),
  readiness,
  traceIdOf: () => traceContext().trace_id,
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : [],
});

server.listen(config.port, () => logger.info("listening", { port: config.port }));
```

- [x] **Step 8: Write `services/checkout-gateway/Dockerfile`**

```dockerfile
# Build context is the repository root — packages/ is shared by every service.
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/checkout-gateway/package.json services/checkout-gateway/

# --ignore-scripts: this stage only runs `tsc`, but npm ci also installs tsx, whose esbuild
# dependency has a postinstall that EXECS the binary it just wrote. Under QEMU emulation —
# any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the write and
# dies with ETXTBSY. No dependency here needs its install scripts.
RUN npm ci --ignore-scripts

COPY packages/ packages/
COPY services/checkout-gateway/ services/checkout-gateway/

RUN npm run build -w @sample-app/contracts \
 && npm run build -w @sample-app/platform \
 && npm run build -w @sample-app/checkout-gateway


FROM node:24-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/checkout-gateway/package.json services/checkout-gateway/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/services/checkout-gateway/dist services/checkout-gateway/dist

ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "services/checkout-gateway/dist/index.js"]
```

- [x] **Step 9: Run the tests and build the image**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
npm run build
docker build -f services/checkout-gateway/Dockerfile \
  --build-arg SERVICE_VERSION=$(git rev-parse --short HEAD) \
  -t checkout-gateway:$(git rev-parse --short HEAD) .
```

Expected: PASS — 6 chain tests, 9 route tests; the image builds.

- [x] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(checkout-gateway): chain-status aggregation, routes and dockerfile"
```

---

### Task 17: settlement-worker — configuration and the SKIP LOCKED queue

**Files:**
- Create: `services/settlement-worker/package.json`, `services/settlement-worker/tsconfig.json`, `services/settlement-worker/src/config.ts`, `services/settlement-worker/src/db.ts`, `services/settlement-worker/src/queue.ts`
- Test: `services/settlement-worker/src/config.test.ts`, `services/settlement-worker/src/queue.test.ts`

**Interfaces:**
- Consumes: `loadCommonConfig`, `optInt`, `optBool`, `requireStr` (Task 2); `Metrics` (Task 4); `QueueStats` (Task 1); the schema from Task 11.
- Produces: `WorkerConfig` (extends `CommonConfig` with `databaseUrl`, `dbPoolMax`, `batchSize`, `pollIntervalMs`, `maxAttempts`, `verbosePayload`), `loadConfig(env)`, `createPool(config)`, `SettlementJob`, `QueueRepo` (`claimBatch`, `settle`, `retry`, `fail`, `stats`, `ping`), `createQueueRepo(pool, {metrics, service})`, `RETRY_BACKOFF_BASE_MS`.

- [x] **Step 1: Write `services/settlement-worker/package.json` and `tsconfig.json`**

`services/settlement-worker/package.json`:

```json
{
  "name": "@sample-app/settlement-worker",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --import tsx --watch src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@sample-app/contracts": "*",
    "@sample-app/platform": "*",
    "pg": "8.16.3"
  },
  "devDependencies": {
    "@types/pg": "8.15.6"
  }
}
```

`services/settlement-worker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [
    { "path": "../../packages/contracts" },
    { "path": "../../packages/platform" }
  ]
}
```

- [x] **Step 2: Write the failing tests**

`services/settlement-worker/src/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = { DATABASE_URL: "postgres://app:pw@db:5432/sample_app" };

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.dbPoolMax, 5);
  assert.equal(c.batchSize, 50);
  assert.equal(c.pollIntervalMs, 1000);
  assert.equal(c.maxAttempts, 3);
  assert.equal(c.verbosePayload, false);
});

test("DATABASE_URL is required", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({
    ...base,
    SETTLEMENT_BATCH_SIZE: "200000",
    SETTLEMENT_POLL_INTERVAL_MS: "60000",
    SETTLEMENT_MAX_ATTEMPTS: "1",
    VERBOSE_PAYLOAD: "true",
    DB_POOL_MAX: "1",
  });
  assert.equal(c.batchSize, 200000);
  assert.equal(c.pollIntervalMs, 60000);
  assert.equal(c.maxAttempts, 1);
  assert.equal(c.verbosePayload, true);
  assert.equal(c.dbPoolMax, 1);
});

test("a batch size of zero is rejected — a worker that claims nothing is a silent outage", () => {
  assert.throws(() => loadConfig({ ...base, SETTLEMENT_BATCH_SIZE: "0" }), /SETTLEMENT_BATCH_SIZE/);
});
```

`services/settlement-worker/src/queue.test.ts`:

```ts
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMetrics } from "@sample-app/platform";
import { createQueueRepo, type QueueRepo } from "./queue.js";

const DB = process.env.TEST_DATABASE_URL;
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let pool: pg.Pool;
let repo: QueueRepo;
const metrics = createMetrics({ service: "settlement-worker", version: "test", commit: "test" });

before(async () => {
  if (!DB) return;
  pool = new pg.Pool({ connectionString: DB });
  repo = createQueueRepo(pool, { metrics, service: "settlement-worker" });
});

after(async () => {
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (!DB) return;
  // Each test owns the whole queue: claiming is inherently global.
  await pool.query("DELETE FROM settlement_jobs");
  await pool.query("DELETE FROM orders");
});

async function seed(opts: { availableAt?: string; traceparent?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO orders (id, customer_id, items, amount_cents, status)
     VALUES ($1, 'web-user', '[{"sku":"sku-widget","qty":2,"unitCents":1299}]'::jsonb, 2598, 'placed')`,
    [id],
  );
  await pool.query(
    `INSERT INTO settlement_jobs (order_id, traceparent, available_at)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()))`,
    [id, opts.traceparent === undefined ? TRACEPARENT : opts.traceparent, opts.availableAt ?? null],
  );
  return id;
}

test("claimBatch locks up to the batch size and increments attempts", { skip: !DB }, async () => {
  await seed();
  await seed();
  await seed();
  const claimed = await repo.claimBatch(2);
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((j) => j.attempts), [1, 1]);

  const locked = await pool.query("SELECT count(*)::int AS n FROM settlement_jobs WHERE locked_at IS NOT NULL");
  assert.equal(locked.rows[0].n, 2);
});

test("a claimed job is invisible to the next claim — SKIP LOCKED, no double settlement", { skip: !DB }, async () => {
  await seed();
  await seed();
  const first = await repo.claimBatch(10);
  const second = await repo.claimBatch(10);
  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
});

test("a job scheduled in the future is not claimed yet", { skip: !DB }, async () => {
  await seed({ availableAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await repo.claimBatch(10)).length, 0);
});

test("the checkout traceparent survives the queue — the async side is not a blind spot", { skip: !DB }, async () => {
  await seed();
  const [job] = await repo.claimBatch(1);
  assert.equal(job!.traceparent, TRACEPARENT);
});

test("a job enqueued without a traceparent claims fine and reports null", { skip: !DB }, async () => {
  await seed({ traceparent: null });
  const [job] = await repo.claimBatch(1);
  assert.equal(job!.traceparent, null);
});

test("the claimed job carries its order payload, so a large batch really enters the heap", { skip: !DB }, async () => {
  const orderId = await seed();
  const [job] = await repo.claimBatch(1);
  assert.equal(job!.order_id, orderId);
  assert.equal(job!.amount_cents, 2598);
  assert.deepEqual(job!.items, [{ sku: "sku-widget", qty: 2, unitCents: 1299 }]);
});

test("settle marks the order settled and removes the job in one transaction", { skip: !DB }, async () => {
  const orderId = await seed();
  const [job] = await repo.claimBatch(1);
  await repo.settle(job!);

  const order = await pool.query("SELECT status, updated_at, created_at FROM orders WHERE id = $1", [orderId]);
  assert.equal(order.rows[0].status, "settled");
  assert.ok(order.rows[0].updated_at >= order.rows[0].created_at, "updated_at moved");
  assert.equal((await pool.query("SELECT id FROM settlement_jobs")).rowCount, 0);
});

test("retry unlocks the job and pushes it into the future", { skip: !DB }, async () => {
  await seed();
  const [job] = await repo.claimBatch(1);
  await repo.retry(job!, 5_000);

  const row = await pool.query("SELECT locked_at, available_at > now() AS deferred FROM settlement_jobs");
  assert.equal(row.rows[0].locked_at, null);
  assert.equal(row.rows[0].deferred, true);
  assert.equal((await repo.claimBatch(10)).length, 0, "not claimable during backoff");
});

test("fail marks the order failed and drops the job for good", { skip: !DB }, async () => {
  const orderId = await seed();
  const [job] = await repo.claimBatch(1);
  await repo.fail(job!, "settle failed 3 times");

  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status, "failed");
  assert.equal((await pool.query("SELECT id FROM settlement_jobs")).rowCount, 0);
});

test("stats reports depth and the oldest job's age", { skip: !DB }, async () => {
  assert.deepEqual(await repo.stats(), { depth: 0, oldestAgeSeconds: 0 });
  await seed();
  await seed();
  const stats = await repo.stats();
  assert.equal(stats.depth, 2);
  assert.ok(stats.oldestAgeSeconds >= 0);
});

test("queue queries are recorded under db_query_duration_seconds", { skip: !DB }, async () => {
  await repo.stats();
  assert.match(
    await metrics.registry.metrics(),
    /db_query_duration_seconds_count\{service="settlement-worker",operation="queue_stats"\}/,
  );
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test`
Expected: FAIL — `Cannot find module './config.js'` and `'./queue.js'`.

- [x] **Step 4: Write `services/settlement-worker/src/config.ts`**

```ts
import { loadCommonConfig, optBool, optInt, requireStr, type CommonConfig, type EnvSource } from "@sample-app/platform";

export interface WorkerConfig extends CommonConfig {
  databaseUrl: string;
  dbPoolMax: number;
  batchSize: number;
  pollIntervalMs: number;
  maxAttempts: number;
  verbosePayload: boolean;
}

export function loadConfig(env: EnvSource): WorkerConfig {
  return {
    ...loadCommonConfig(env),
    databaseUrl: requireStr(env, "DATABASE_URL"),
    dbPoolMax: optInt(env, "DB_POOL_MAX", 5, { min: 1, max: 1000 }),
    // Every claimed row, order payload included, is held in memory for the batch's lifetime.
    // A large value genuinely grows the working set until the OOM killer intervenes.
    batchSize: optInt(env, "SETTLEMENT_BATCH_SIZE", 50, { min: 1 }),
    // Raise it past the arrival rate and the worker falls behind for real.
    pollIntervalMs: optInt(env, "SETTLEMENT_POLL_INTERVAL_MS", 1000, { min: 0 }),
    maxAttempts: optInt(env, "SETTLEMENT_MAX_ATTEMPTS", 3, { min: 1 }),
    verbosePayload: optBool(env, "VERBOSE_PAYLOAD", false),
  };
}
```

- [x] **Step 5: Write `services/settlement-worker/src/db.ts`**

```ts
import pg from "pg";
import type { WorkerConfig } from "./config.js";

// Same parsers as orders-api: timestamps arrive as ISO strings, never Date objects.
// Deliberately duplicated rather than shared — these are separately deployable services,
// and platform stays free of a pg dependency.
pg.types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
pg.types.setTypeParser(1114, (value: string) => new Date(value + "Z").toISOString());

export function createPool(config: Pick<WorkerConfig, "databaseUrl" | "dbPoolMax">): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    application_name: "settlement-worker",
  });
}
```

- [x] **Step 6: Write `services/settlement-worker/src/queue.ts`**

```ts
import type { Pool } from "pg";
import type { OrderItem, QueueStats } from "@sample-app/contracts";
import type { Metrics } from "@sample-app/platform";

/** A claimed job joined with the order it settles. */
export interface SettlementJob {
  id: string;
  order_id: string;
  attempts: number;
  traceparent: string | null;
  created_at: string;
  amount_cents: number;
  items: OrderItem[];
}

export interface QueueRepo {
  claimBatch(limit: number): Promise<SettlementJob[]>;
  settle(job: SettlementJob): Promise<void>;
  retry(job: SettlementJob, backoffMs: number): Promise<void>;
  fail(job: SettlementJob, reason: string): Promise<void>;
  stats(): Promise<QueueStats>;
  ping(): Promise<void>;
}

export const RETRY_BACKOFF_BASE_MS = 5_000;

interface ClaimedRow {
  id: string;
  order_id: string;
  attempts: number;
  traceparent: string | null;
  created_at: string;
}

export function createQueueRepo(pool: Pool, deps: { metrics: Metrics; service: string }): QueueRepo {
  const timed = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    const end = deps.metrics.dbQueryDuration.startTimer({ service: deps.service, operation });
    try {
      return await fn();
    } finally {
      end();
    }
  };

  return {
    async claimBatch(limit) {
      return timed("claim_batch", async () => {
        // The standard skip-locked claim: two workers never see the same row, so scaling
        // the deployment up is safe and settling twice is impossible.
        const claimed = await pool.query<ClaimedRow>(
          `UPDATE settlement_jobs
              SET locked_at = now(), attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM settlement_jobs
               WHERE locked_at IS NULL AND available_at <= now()
               ORDER BY available_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )
          RETURNING id, order_id, attempts, traceparent, created_at`,
          [limit],
        );
        if (claimed.rowCount === 0) return [];

        const orders = await pool.query<{ id: string; amount_cents: string; items: OrderItem[] }>(
          "SELECT id, amount_cents, items FROM orders WHERE id = ANY($1::uuid[])",
          [claimed.rows.map((row) => row.order_id)],
        );
        const byId = new Map(orders.rows.map((row) => [row.id, row]));

        return claimed.rows.map((row) => ({
          ...row,
          amount_cents: Number(byId.get(row.order_id)?.amount_cents ?? 0),
          items: byId.get(row.order_id)?.items ?? [],
        }));
      });
    },

    async settle(job) {
      await timed("settle_order", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("UPDATE orders SET status = 'settled', updated_at = now() WHERE id = $1", [job.order_id]);
          await client.query("DELETE FROM settlement_jobs WHERE id = $1", [job.id]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });
    },

    async retry(job, backoffMs) {
      await timed("retry_job", async () => {
        await pool.query(
          `UPDATE settlement_jobs
              SET locked_at = NULL, available_at = now() + ($2::int * interval '1 millisecond')
            WHERE id = $1`,
          [job.id, Math.max(0, Math.round(backoffMs))],
        );
      });
    },

    async fail(job, reason) {
      await timed("fail_order", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1", [job.order_id]);
          await client.query("DELETE FROM settlement_jobs WHERE id = $1", [job.id]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        void reason;
      });
    },

    async stats() {
      return timed("queue_stats", async () => {
        const { rows } = await pool.query<{ depth: string; oldest: string }>(
          `SELECT count(*)::text AS depth,
                  COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)::text AS oldest
             FROM settlement_jobs`,
        );
        return { depth: Number(rows[0]!.depth), oldestAgeSeconds: Number(rows[0]!.oldest) };
      });
    },

    async ping() {
      await timed("ping", async () => pool.query("SELECT 1"));
    },
  };
}
```

`reason` is accepted for the caller's log line and deliberately not persisted — the schema has no failure column, and adding one is out of scope.

- [x] **Step 7: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test`
Expected: PASS — 4 config tests, 11 queue tests, none skipped.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(settlement-worker): config and skip-locked queue repository"
```

---

### Task 18: settlement-worker — the settle loop, admin port, Dockerfile

**Files:**
- Create: `services/settlement-worker/src/loop.ts`, `services/settlement-worker/src/index.ts`, `services/settlement-worker/Dockerfile`
- Test: `services/settlement-worker/src/loop.test.ts`

**Interfaces:**
- Consumes: `QueueRepo`, `SettlementJob`, `RETRY_BACKOFF_BASE_MS` (Task 17); `withRemoteParent` (Task 10); `Metrics`, `Logger` (Tasks 3–4); `createApp` (Task 6).
- Produces: `LoopDeps`, `runBatch(deps): Promise<number>`, `startLoop(deps): { stop(): Promise<void> }`, and the `settlement-worker` image serving `/healthz`, `/readyz`, `/metrics`, `/stats`, `/queue-stats`.

- [x] **Step 1: Write the failing test**

`services/settlement-worker/src/loop.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, createMetrics } from "@sample-app/platform";
import type { QueueStats } from "@sample-app/contracts";
import { runBatch, startLoop, type LoopDeps } from "./loop.js";
import type { SettlementJob } from "./queue.js";

const job = (over: Partial<SettlementJob> = {}): SettlementJob => ({
  id: "1",
  order_id: "018f0000-0000-4000-8000-000000000001",
  attempts: 1,
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  created_at: "2026-08-16T09:14:22.417Z",
  amount_cents: 2598,
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  ...over,
});

function harness(opts: {
  batches?: SettlementJob[][];
  settle?: (job: SettlementJob) => Promise<void>;
  stats?: QueueStats;
  maxAttempts?: number;
}) {
  const batches = [...(opts.batches ?? [])];
  const calls = { settled: [] as string[], retried: [] as { id: string; backoffMs: number }[], failed: [] as string[], claims: 0 };
  const metrics = createMetrics({ service: "settlement-worker", version: "test", commit: "test" });
  const deps: LoopDeps = {
    queue: {
      claimBatch: async () => { calls.claims++; return batches.shift() ?? []; },
      settle: async (j) => { calls.settled.push(j.id); await opts.settle?.(j); },
      retry: async (j, backoffMs) => { calls.retried.push({ id: j.id, backoffMs }); },
      fail: async (j) => { calls.failed.push(j.id); },
      stats: async () => opts.stats ?? { depth: 0, oldestAgeSeconds: 0 },
      ping: async () => {},
    },
    metrics,
    logger: createLogger({ service: "settlement-worker", version: "test", level: "error", write: () => {} }),
    batchSize: 50,
    pollIntervalMs: 1,
    maxAttempts: opts.maxAttempts ?? 3,
    verbosePayload: false,
  };
  return { deps, calls, metrics };
}

test("a batch settles every claimed job and counts each one", async () => {
  const { deps, calls, metrics } = harness({ batches: [[job({ id: "1" }), job({ id: "2" })]] });
  assert.equal(await runBatch(deps), 2);
  assert.deepEqual(calls.settled, ["1", "2"]);
  const text = await metrics.registry.metrics();
  assert.match(text, /settlement_jobs_total\{result="ok"\} 2/);
  assert.match(text, /settlement_batch_size_count 1/);
});

test("an empty batch settles nothing and observes no batch size", async () => {
  const { deps, metrics } = harness({ batches: [[]] });
  assert.equal(await runBatch(deps), 0);
  assert.doesNotMatch(await metrics.registry.metrics(), /settlement_batch_size_count [1-9]/);
});

test("a failing job below the attempt ceiling is retried with a growing backoff", async () => {
  const { deps, calls, metrics } = harness({
    batches: [[job({ id: "7", attempts: 2 })]],
    settle: async () => { throw new Error("deadlock detected"); },
  });
  await runBatch(deps);
  assert.deepEqual(calls.retried, [{ id: "7", backoffMs: 10_000 }]);
  assert.equal(calls.failed.length, 0);
  assert.match(await metrics.registry.metrics(), /settlement_jobs_total\{result="retried"\} 1/);
});

test("a job that has burned its attempts marks the order failed", async () => {
  const { deps, calls, metrics } = harness({
    batches: [[job({ id: "7", attempts: 3 })]],
    settle: async () => { throw new Error("deadlock detected"); },
    maxAttempts: 3,
  });
  await runBatch(deps);
  assert.deepEqual(calls.failed, ["7"]);
  assert.equal(calls.retried.length, 0);
  assert.match(await metrics.registry.metrics(), /settlement_jobs_total\{result="failed"\} 1/);
});

test("one poisonous job does not abort the rest of the batch", async () => {
  const { deps, calls } = harness({
    batches: [[job({ id: "1" }), job({ id: "2" }), job({ id: "3" })]],
    settle: async (j) => { if (j.id === "2") throw new Error("boom"); },
  });
  assert.equal(await runBatch(deps), 3);
  assert.deepEqual(calls.settled, ["1", "2", "3"]);
  assert.deepEqual(calls.retried.map((r) => r.id), ["2"]);
});

test("queue depth and oldest-job age are published as gauges every batch", async () => {
  const { deps, metrics } = harness({ batches: [[]], stats: { depth: 41, oldestAgeSeconds: 137 } });
  await runBatch(deps);
  const text = await metrics.registry.metrics();
  assert.match(text, /queue_depth\{queue="settlement"\} 41/);
  assert.match(text, /queue_oldest_job_age_seconds\{queue="settlement"\} 137/);
});

test("stop lets the in-flight batch finish and claims no new one", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { deps, calls } = harness({ batches: [[job({ id: "1" })], [job({ id: "2" })]], settle: async () => { await gate; } });

  const loop = startLoop(deps);
  await new Promise((r) => setTimeout(r, 5));
  const stopped = loop.stop();
  release();
  await stopped;

  assert.deepEqual(calls.settled, ["1"], "the claimed job was finished");
  assert.equal(calls.claims, 1, "no further claim after stop");
});

test("a claim failure is logged and the loop survives it", async () => {
  const { deps } = harness({});
  deps.queue.claimBatch = async () => { throw new Error("db down"); };
  assert.equal(await runBatch(deps), 0);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './loop.js'`.

- [x] **Step 3: Write `services/settlement-worker/src/loop.ts`**

```ts
import { withRemoteParent, type Logger, type Metrics } from "@sample-app/platform";
import { RETRY_BACKOFF_BASE_MS, type QueueRepo, type SettlementJob } from "./queue.js";

export interface LoopDeps {
  queue: QueueRepo;
  metrics: Metrics;
  logger: Logger;
  batchSize: number;
  pollIntervalMs: number;
  maxAttempts: number;
  verbosePayload: boolean;
}

const QUEUE = "settlement";

async function publishStats(deps: LoopDeps): Promise<void> {
  try {
    const stats = await deps.queue.stats();
    deps.metrics.queueDepth.set({ queue: QUEUE }, stats.depth);
    deps.metrics.queueOldestJobAge.set({ queue: QUEUE }, stats.oldestAgeSeconds);
  } catch (err) {
    deps.logger.error("failed to publish queue stats", { err });
  }
}

/** One poll: claim, settle each job, publish the gauges. Returns the number of jobs claimed. */
export async function runBatch(deps: LoopDeps): Promise<number> {
  let jobs: SettlementJob[];
  try {
    jobs = await deps.queue.claimBatch(deps.batchSize);
  } catch (err) {
    // A claim failure is the database's problem, not a reason to exit: the gauges stop
    // advancing and SampleAppSettlementBacklog fires on the symptom.
    deps.logger.error("failed to claim a batch", { err });
    return 0;
  }

  if (jobs.length > 0) deps.metrics.settlementBatchSize.observe(jobs.length);

  for (const job of jobs) {
    // The span links back to the checkout request that created the job, so the async side
    // of the incident is not a blind spot.
    await withRemoteParent(job.traceparent, "settle order", async () => {
      try {
        await deps.queue.settle(job);
        deps.metrics.settlementJobs.inc({ result: "ok" });
        deps.logger.info("order settled", {
          order_id: job.order_id,
          attempts: job.attempts,
          ...(deps.verbosePayload ? { amount_cents: job.amount_cents, items: job.items } : {}),
        });
      } catch (err) {
        if (job.attempts >= deps.maxAttempts) {
          await deps.queue.fail(job, err instanceof Error ? err.message : String(err));
          deps.metrics.settlementJobs.inc({ result: "failed" });
          deps.logger.error("order settlement gave up", { order_id: job.order_id, attempts: job.attempts, err });
          return;
        }
        const backoffMs = RETRY_BACKOFF_BASE_MS * job.attempts;
        await deps.queue.retry(job, backoffMs);
        deps.metrics.settlementJobs.inc({ result: "retried" });
        deps.logger.warn("order settlement failed, will retry", { order_id: job.order_id, attempts: job.attempts, backoff_ms: backoffMs, err });
      }
    });
  }

  await publishStats(deps);
  return jobs.length;
}

export function startLoop(deps: LoopDeps): { stop(): Promise<void> } {
  let running = true;
  let timer: NodeJS.Timeout | null = null;

  const finished = (async () => {
    while (running) {
      await runBatch(deps);
      if (!running) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deps.pollIntervalMs);
      });
    }
  })();

  return {
    // SIGTERM: finish the current batch, claim no new one. Anything else would leave rows
    // locked and force every consumer to wait out a lock timeout.
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await finished;
    },
  };
}
```

- [x] **Step 4: Write `services/settlement-worker/src/index.ts`**

```ts
import {
  bindPoolMetrics,
  createApp,
  createLogger,
  createMetrics,
  initTracing,
  installShutdown,
  loadOrExit,
  redactConfig,
  RollingStats,
  sendJson,
  traceContext,
  type ProbeResult,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createQueueRepo } from "./queue.js";
import { startLoop } from "./loop.js";

const SERVICE = "settlement-worker";

const config = loadOrExit(loadConfig);
const logger = createLogger({ service: SERVICE, version: config.serviceVersion, level: config.logLevel, traceContext });
const tracing = initTracing({
  service: SERVICE,
  version: config.serviceVersion,
  deploymentEnv: config.deploymentEnv,
  endpoint: config.otelEndpoint,
  logger,
});
const metrics = createMetrics({ service: SERVICE, version: config.serviceVersion, commit: config.serviceVersion });
logger.info("starting", { config: redactConfig({ ...config }) });

const pool = createPool(config);
bindPoolMetrics(metrics, pool);
const queue = createQueueRepo(pool, { metrics, service: SERVICE });

const loop = startLoop({
  queue,
  metrics,
  logger,
  batchSize: config.batchSize,
  pollIntervalMs: config.pollIntervalMs,
  maxAttempts: config.maxAttempts,
  verbosePayload: config.verbosePayload,
});

const readiness = async (): Promise<ProbeResult> => {
  try {
    await queue.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `db unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

// The worker serves no traffic; this is the admin port. /queue-stats is what chain-status
// aggregates — the worker owns the queue, so it is the only service that reports on it.
const server = createApp({
  service: SERVICE,
  config,
  logger,
  metrics,
  stats: new RollingStats(),
  routes: [
    {
      method: "GET",
      pattern: "/queue-stats",
      handler: async ({ res }) => sendJson(res, 200, await queue.stats()),
    },
  ],
  readiness,
  traceIdOf: () => traceContext().trace_id,
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: [
    { name: "settle loop", run: () => loop.stop() },
    { name: "db pool", run: () => pool.end() },
    ...(tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : []),
  ],
});

server.listen(config.port, () => logger.info("listening", { port: config.port }));
```

- [x] **Step 5: Write `services/settlement-worker/Dockerfile`**

```dockerfile
# Build context is the repository root — packages/ is shared by every service.
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/settlement-worker/package.json services/settlement-worker/

# --ignore-scripts: this stage only runs `tsc`, but npm ci also installs tsx, whose esbuild
# dependency has a postinstall that EXECS the binary it just wrote. Under QEMU emulation —
# any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the write and
# dies with ETXTBSY. No dependency here needs its install scripts.
RUN npm ci --ignore-scripts

COPY packages/ packages/
COPY services/settlement-worker/ services/settlement-worker/

RUN npm run build -w @sample-app/contracts \
 && npm run build -w @sample-app/platform \
 && npm run build -w @sample-app/settlement-worker


FROM node:24-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/settlement-worker/package.json services/settlement-worker/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/services/settlement-worker/dist services/settlement-worker/dist

ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "services/settlement-worker/dist/index.js"]
```

- [x] **Step 6: Run the tests, then the worker against a real database**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
npm run build

DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app PORT=3003 \
  node services/settlement-worker/dist/index.js &
sleep 2
curl -s localhost:3003/queue-stats
curl -s localhost:3003/metrics | grep -E '^(queue_depth|queue_oldest|settlement_)'
kill %1
```

Expected: an order created in Task 14 moves to `settled` within a poll interval, `/queue-stats` returns `{"depth":0,"oldestAgeSeconds":0}`, and `settlement_jobs_total{result="ok"}` is non-zero.

- [x] **Step 7: Build the image**

```bash
docker build -f services/settlement-worker/Dockerfile \
  --build-arg SERVICE_VERSION=$(git rev-parse --short HEAD) \
  -t settlement-worker:$(git rev-parse --short HEAD) .
```

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(settlement-worker): settle loop, admin port and dockerfile"
```

---

### Task 19: storefront — server-rendered views and the stylesheet

**Files:**
- Create: `services/storefront/package.json`, `services/storefront/tsconfig.json`, `services/storefront/src/assets.ts`, `services/storefront/src/views.ts`
- Test: `services/storefront/src/views.test.ts`

**Interfaces:**
- Consumes: `CATALOG`, `OrderV1`, `ChainStatus`, `HopStatus` (Task 1).
- Produces: `APP_CSS`, `esc(value)`, `formatCents(cents)`, `layout({title, assetHref, body})`, `catalogPage(assetHref)`, `orderPage(order, assetHref)`, `statusPage(chain, assetHref)`, `errorPage({status, message, traceId, assetHref})`.

- [x] **Step 1: Write `services/storefront/package.json` and `tsconfig.json`**

`services/storefront/package.json`:

```json
{
  "name": "@sample-app/storefront",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "node --import tsx --watch src/index.ts",
    "start": "node dist/index.js",
    "loadgen": "node --import tsx src/loadgen.ts"
  },
  "dependencies": {
    "@sample-app/contracts": "*",
    "@sample-app/platform": "*"
  }
}
```

`services/storefront/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [
    { "path": "../../packages/contracts" },
    { "path": "../../packages/platform" }
  ]
}
```

- [x] **Step 2: Write the failing test**

`services/storefront/src/views.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChainStatus, OrderV1 } from "@sample-app/contracts";
import { catalogPage, errorPage, esc, formatCents, orderPage, statusPage } from "./views.js";

const ASSET = "/assets/abc123/app.css";

const order: OrderV1 = {
  id: "018f0000-0000-4000-8000-000000000001",
  customer_id: "web-user",
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  amount_cents: 2598,
  status: "placed",
  created_at: "2026-08-16T09:14:22.417Z",
  updated_at: "2026-08-16T09:14:22.417Z",
};

const chain: ChainStatus = {
  hops: [
    { name: "storefront", state: "ok", stats: { service: "storefront", version: "abc123", p99Ms: 12, errorRate: 0, requests: 90, windowSeconds: 60 } },
    { name: "checkout-gateway", state: "degraded", detail: "errorRate=0.120 p99=340ms", stats: { service: "checkout-gateway", version: "abc123", p99Ms: 340, errorRate: 0.12, requests: 90, windowSeconds: 60 } },
    { name: "orders-api", state: "unreachable", detail: "orders-api timed out after 2000ms", stats: null },
  ],
  queue: { depth: 41, oldestAgeSeconds: 137 },
  checkedAt: "2026-08-16T09:14:22.417Z",
};

test("esc neutralises every character that could break out of markup", () => {
  assert.equal(esc(`<script>alert("x")&'`), "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
});

test("formatCents renders whole and fractional amounts", () => {
  assert.equal(formatCents(2598), "25.98");
  assert.equal(formatCents(700), "7.00");
  assert.equal(formatCents(0), "0.00");
});

test("the catalog lists every product with a checkout form", () => {
  const html = catalogPage(ASSET);
  for (const sku of ["sku-widget", "sku-gizmo", "sku-doodad", "sku-thingamajig"]) {
    assert.ok(html.includes(`value="${sku}"`), `missing ${sku}`);
  }
  assert.match(html, /<form method="post" action="\/checkout">/);
  assert.ok(html.includes("15,999") === false, "prices are rendered in currency form");
  assert.ok(html.includes("159.99"));
});

test("every page links the versioned stylesheet — a wrong ASSET_VERSION really 404s", () => {
  for (const html of [catalogPage(ASSET), orderPage(order, ASSET), statusPage(chain, ASSET)]) {
    assert.ok(html.includes(`<link rel="stylesheet" href="${ASSET}">`));
  }
});

test("no page carries client JavaScript", () => {
  for (const html of [catalogPage(ASSET), orderPage(order, ASSET), statusPage(chain, ASSET), errorPage({ status: 502, message: "upstream", traceId: null, assetHref: ASSET })]) {
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  }
});

test("the order page shows status, total, and each line", () => {
  const html = orderPage(order, ASSET);
  assert.ok(html.includes("placed"));
  assert.ok(html.includes("25.98"));
  assert.ok(html.includes("sku-widget"));
  assert.ok(html.includes(order.id));
});

test("untrusted order fields are escaped, never interpolated raw", () => {
  const evil: OrderV1 = { ...order, id: `"><script>alert(1)</script>`, status: "placed" };
  const html = orderPage(evil, ASSET);
  assert.doesNotMatch(html, /<script/i);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("the status page renders every hop, its state, and the queue", () => {
  const html = statusPage(chain, ASSET);
  assert.ok(html.includes("storefront"));
  assert.ok(html.includes("checkout-gateway"));
  assert.ok(html.includes("orders-api"));
  assert.ok(html.includes("hop-unreachable"));
  assert.ok(html.includes("hop-degraded"));
  assert.ok(html.includes("41"), "queue depth");
  assert.ok(html.includes("137"), "oldest job age");
});

test("the status page refreshes itself without JavaScript", () => {
  assert.match(statusPage(chain, ASSET), /<meta http-equiv="refresh" content="2">/);
});

test("a hop with no stats renders its failure detail instead of blank cells", () => {
  const html = statusPage(chain, ASSET);
  assert.ok(html.includes("orders-api timed out after 2000ms"));
});

test("a null queue renders as unknown rather than zero — zero is a claim, unknown is the truth", () => {
  const html = statusPage({ ...chain, queue: null }, ASSET);
  assert.ok(html.includes("unknown"));
});

test("the error page carries the trace id when there is one", () => {
  assert.ok(errorPage({ status: 504, message: "gateway timed out", traceId: "4bf92f35", assetHref: ASSET }).includes("4bf92f35"));
  assert.doesNotMatch(errorPage({ status: 500, message: "boom", traceId: null, assetHref: ASSET }), /trace/i);
});
```

- [x] **Step 3: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './views.js'`.

- [x] **Step 4: Write `services/storefront/src/assets.ts`**

```ts
/**
 * Served from /assets/<ASSET_VERSION>/app.css, never inlined: an inline <style> cannot 404,
 * and the ASSET_VERSION fault needs a genuine mechanism (every metric green, product broken).
 */
export const APP_CSS = `:root {
  --bg: #10131a;
  --panel: #181d27;
  --line: #2a3140;
  --text: #e7ecf3;
  --muted: #97a3b6;
  --ok: #3fb950;
  --degraded: #d29922;
  --down: #f85149;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
header { display: flex; align-items: baseline; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
header h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
header nav a { color: var(--muted); text-decoration: none; margin-right: 12px; }
header nav a:hover { color: var(--text); }
h2 { font-size: 16px; margin: 28px 0 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 4px 16px 16px; }
form { display: flex; gap: 8px; align-items: center; }
input[type="number"] { width: 64px; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
button { background: var(--text); color: var(--bg); border: 0; border-radius: 6px; padding: 7px 14px; font-weight: 600; cursor: pointer; }
button:hover { opacity: 0.88; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.hop-ok, .status-settled { background: rgba(63,185,80,0.16); color: var(--ok); }
.hop-degraded, .status-placed { background: rgba(210,153,34,0.16); color: var(--degraded); }
.hop-unreachable, .status-failed { background: rgba(248,81,73,0.16); color: var(--down); }
.muted { color: var(--muted); }
.detail { color: var(--muted); font-size: 13px; }
.error { border-left: 3px solid var(--down); padding-left: 14px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
`;
```

- [x] **Step 5: Write `services/storefront/src/views.ts`**

```ts
import { CATALOG, type ChainStatus, type HopStatus, type OrderV1 } from "@sample-app/contracts";

/** Every text node passes through esc() BEFORE it touches markup. No exceptions. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export interface LayoutOptions {
  title: string;
  assetHref: string;
  body: string;
  refreshSeconds?: number;
}

export function layout(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">\n` : ""}<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="${esc(opts.assetHref)}">
</head>
<body>
<main>
<header>
  <h1>Sample Store</h1>
  <nav><a href="/">Catalog</a><a href="/status">Chain status</a></nav>
</header>
${opts.body}
</main>
</body>
</html>`;
}

export function catalogPage(assetHref: string): string {
  const rows = CATALOG.map((product) => `      <tr>
        <td>${esc(product.name)}</td>
        <td><code>${esc(product.sku)}</code></td>
        <td>${formatCents(product.unitCents)}</td>
        <td>
          <form method="post" action="/checkout">
            <input type="hidden" name="sku" value="${esc(product.sku)}">
            <input type="number" name="qty" value="1" min="1" max="99" aria-label="Quantity of ${esc(product.name)}">
            <button type="submit">Buy</button>
          </form>
        </td>
      </tr>`).join("\n");

  return layout({
    title: "Catalog — Sample Store",
    assetHref,
    body: `<h2>Catalog</h2>
<div class="card">
  <table>
    <thead><tr><th>Product</th><th>SKU</th><th>Price</th><th></th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`,
  });
}

export function orderPage(order: OrderV1, assetHref: string): string {
  const lines = order.items.map((item) => `      <tr>
        <td><code>${esc(item.sku)}</code></td>
        <td>${esc(item.qty)}</td>
        <td>${formatCents(item.unitCents)}</td>
        <td>${formatCents(item.qty * item.unitCents)}</td>
      </tr>`).join("\n");

  return layout({
    title: `Order ${order.id} — Sample Store`,
    assetHref,
    // The order page refreshes so a settlement backlog is visible as an order that stays
    // "placed" long after checkout.
    refreshSeconds: 5,
    body: `<h2>Order <code>${esc(order.id)}</code></h2>
<div class="card">
  <p>Status <span class="pill status-${esc(order.status)}">${esc(order.status)}</span>
     <span class="detail">placed ${esc(order.created_at)}</span></p>
  <table>
    <thead><tr><th>SKU</th><th>Qty</th><th>Unit</th><th>Line</th></tr></thead>
    <tbody>
${lines}
    </tbody>
    <tfoot><tr><th colspan="3">Total</th><th>${formatCents(order.amount_cents)}</th></tr></tfoot>
  </table>
</div>`,
  });
}

function hopRow(hop: HopStatus): string {
  const stats = hop.stats;
  return `      <tr>
        <td>${esc(hop.name)}</td>
        <td><span class="pill hop-${esc(hop.state)}">${esc(hop.state)}</span></td>
        <td>${stats?.p99Ms === null || stats === null ? "—" : esc(stats.p99Ms)}</td>
        <td>${stats === null ? "—" : esc((stats.errorRate * 100).toFixed(1))}%</td>
        <td>${stats === null ? "—" : esc(stats.requests)}</td>
        <td class="detail">${esc(hop.detail ?? "")}</td>
      </tr>`;
}

export function statusPage(chain: ChainStatus, assetHref: string): string {
  const queue = chain.queue
    ? `<p>Queue depth <strong>${esc(chain.queue.depth)}</strong>, oldest job <strong>${esc(chain.queue.oldestAgeSeconds.toFixed(0))}</strong>s</p>`
    : `<p class="muted">Queue depth unknown — the worker did not answer.</p>`;

  return layout({
    title: "Chain status — Sample Store",
    assetHref,
    refreshSeconds: 2,
    body: `<h2>Chain status <span class="detail">checked ${esc(chain.checkedAt)}</span></h2>
<div class="card">
  <table>
    <thead><tr><th>Hop</th><th>State</th><th>p99 (ms)</th><th>Errors</th><th>Requests/60s</th><th></th></tr></thead>
    <tbody>
${chain.hops.map(hopRow).join("\n")}
    </tbody>
  </table>
  ${queue}
</div>`,
  });
}

export interface ErrorPageOptions {
  status: number;
  message: string;
  traceId: string | null;
  assetHref: string;
}

export function errorPage(opts: ErrorPageOptions): string {
  return layout({
    title: `Error ${opts.status} — Sample Store`,
    assetHref: opts.assetHref,
    body: `<h2>Something went wrong</h2>
<div class="card error">
  <p><strong>${esc(opts.status)}</strong> ${esc(opts.message)}</p>
  ${opts.traceId ? `<p class="detail">trace id <code>${esc(opts.traceId)}</code></p>` : ""}
  <p><a href="/">Back to the catalog</a></p>
</div>`,
  });
}
```

- [x] **Step 6: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 12 view tests.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(storefront): server-rendered views and versioned stylesheet"
```

---

### Task 20: storefront — configuration, routes, bounded render concurrency, Dockerfile

**Files:**
- Create: `services/storefront/src/config.ts`, `services/storefront/src/routes.ts`, `services/storefront/src/index.ts`, `services/storefront/Dockerfile`
- Test: `services/storefront/src/config.test.ts`, `services/storefront/src/routes.test.ts`

**Interfaces:**
- Consumes: `createSemaphore` (Task 9); `createHttpClient`, `DownstreamError`, `statusForDownstream` (Task 8); `createApp`, `sendHtml`, `sendText` (Task 6); the views from Task 19.
- Produces: `StorefrontConfig` (extends `CommonConfig` with `gatewayUrl`, `gatewayTimeoutMs`, `ssrConcurrency`, `assetCacheSeconds`, `assetVersion`), `loadConfig(env)`, `parseForm(body)`, `assetHref(version)`, `createRoutes(deps): Route[]`, and the `storefront` image.

- [x] **Step 1: Write `services/storefront/src/config.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = { GATEWAY_URL: "http://checkout-gateway:3000" };

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.gatewayTimeoutMs, 2000);
  assert.equal(c.ssrConcurrency, 32);
  assert.equal(c.assetCacheSeconds, 3600);
});

test("GATEWAY_URL is required", () => {
  assert.throws(() => loadConfig({}), /GATEWAY_URL/);
});

test("ASSET_VERSION follows SERVICE_VERSION unless it is overridden", () => {
  assert.equal(loadConfig({ ...base, SERVICE_VERSION: "abc123" }).assetVersion, "abc123");
  assert.equal(loadConfig({ ...base, SERVICE_VERSION: "abc123", ASSET_VERSION: "stale" }).assetVersion, "stale");
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({ ...base, GATEWAY_TIMEOUT_MS: "50", SSR_CONCURRENCY: "1", ASSET_CACHE_SECONDS: "0" });
  assert.equal(c.gatewayTimeoutMs, 50);
  assert.equal(c.ssrConcurrency, 1);
  assert.equal(c.assetCacheSeconds, 0);
});

test("SSR_CONCURRENCY must be at least 1 — zero would serve nothing at all", () => {
  assert.throws(() => loadConfig({ ...base, SSR_CONCURRENCY: "0" }), /SSR_CONCURRENCY/);
});
```

- [x] **Step 2: Write `services/storefront/src/routes.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, createLogger, createMetrics, createSemaphore, loadCommonConfig, RollingStats, DownstreamError, type HttpClient } from "@sample-app/platform";
import { createRoutes, parseForm } from "./routes.js";

const order = {
  id: "018f0000-0000-4000-8000-000000000001",
  customer_id: "web-user",
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  amount_cents: 2598,
  status: "placed",
  created_at: "2026-08-16T09:14:22.417Z",
  updated_at: "2026-08-16T09:14:22.417Z",
};

const chain = {
  hops: [
    { name: "checkout-gateway", state: "ok", stats: { service: "checkout-gateway", version: "test", p99Ms: 4, errorRate: 0, requests: 3, windowSeconds: 60 } },
    { name: "orders-api", state: "ok", stats: { service: "orders-api", version: "test", p99Ms: 9, errorRate: 0, requests: 3, windowSeconds: 60 } },
    { name: "settlement-worker", state: "ok", stats: { service: "settlement-worker", version: "test", p99Ms: null, errorRate: 0, requests: 0, windowSeconds: 60 } },
  ],
  queue: { depth: 2, oldestAgeSeconds: 4 },
  checkedAt: "2026-08-16T09:14:22.417Z",
};

function stubClient(handlers: { get?: (url: string) => unknown; post?: (url: string, body: unknown) => unknown }): HttpClient {
  return {
    getJson: (async (_peer: string, url: string) => {
      const value = handlers.get?.(url);
      if (value instanceof Error) throw value;
      return value;
    }) as HttpClient["getJson"],
    postJson: (async (_peer: string, url: string, body: unknown) => {
      const value = handlers.post?.(url, body);
      if (value instanceof Error) throw value;
      return value;
    }) as HttpClient["postJson"],
  };
}

async function withApp<T>(client: HttpClient, fn: (base: string) => Promise<T>, concurrency = 32): Promise<T> {
  const logger = createLogger({ service: "storefront", version: "test", level: "error", write: () => {} });
  const metrics = createMetrics({ service: "storefront", version: "test", commit: "test" });
  const stats = new RollingStats();
  const server = createApp({
    service: "storefront",
    config: loadCommonConfig({}),
    logger,
    metrics,
    stats,
    routes: createRoutes({
      client,
      logger,
      semaphore: createSemaphore(concurrency),
      selfStats: () => ({ service: "storefront", version: "test", ...stats.snapshot() }),
      gatewayUrl: "http://checkout-gateway:3000",
      assetVersion: "abc123",
      assetCacheSeconds: 3600,
    }),
    readiness: async () => ({ ok: true }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("parseForm reads a urlencoded body, including encoded characters", () => {
  assert.deepEqual(parseForm("sku=sku-widget&qty=2"), { sku: "sku-widget", qty: "2" });
  assert.deepEqual(parseForm("sku=a%20b&qty=1"), { sku: "a b", qty: "1" });
  assert.deepEqual(parseForm(""), {});
});

test("GET / renders the catalog as HTML", async () => {
  await withApp(stubClient({}), async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /text\/html/);
    assert.ok((await res.text()).includes("sku-widget"));
  });
});

test("POST /checkout posts the cart and redirects to the order page", async () => {
  let posted: unknown;
  const client = stubClient({ post: (_url, body) => { posted = body; return order; } });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "sku=sku-widget&qty=2",
      redirect: "manual",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/orders/${order.id}`);
    assert.deepEqual(posted, { customerId: "web-user", items: [{ sku: "sku-widget", qty: 2 }] });
  });
});

test("a checkout with a bad quantity renders an error page, not a redirect", async () => {
  await withApp(stubClient({}), async (base) => {
    const res = await fetch(`${base}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "sku=sku-widget&qty=zero",
      redirect: "manual",
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Something went wrong/);
  });
});

test("a gateway timeout renders a 504 HTML page carrying the reason", async () => {
  const client = stubClient({ post: () => new DownstreamError("checkout-gateway timed out after 2000ms", { peer: "checkout-gateway", kind: "timeout" }) });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "sku=sku-widget&qty=1",
      redirect: "manual",
    });
    assert.equal(res.status, 504);
    assert.match(res.headers.get("content-type")!, /text\/html/);
    assert.match(await res.text(), /timed out/);
  });
});

test("GET /orders/:id renders the order, and 404 renders a page not a stack trace", async () => {
  const found = stubClient({ get: () => order });
  await withApp(found, async (base) => {
    const res = await fetch(`${base}/orders/${order.id}`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("25.98"));
  });

  const missing = stubClient({ get: () => new DownstreamError("not found", { peer: "checkout-gateway", kind: "status", status: 404 }) });
  await withApp(missing, async (base) => {
    const res = await fetch(`${base}/orders/${order.id}`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Something went wrong/);
  });
});

test("GET /status prepends the storefront's own hop to the gateway's chain", async () => {
  await withApp(stubClient({ get: () => chain }), async (base) => {
    const html = await (await fetch(`${base}/status`)).text();
    const hopOrder = ["storefront", "checkout-gateway", "orders-api", "settlement-worker"].map((n) => html.indexOf(n));
    assert.ok(hopOrder.every((i) => i >= 0), "every hop is rendered");
    assert.deepEqual([...hopOrder].sort((a, b) => a - b), hopOrder, "hops are in chain order");
  });
});

test("GET /status still renders 200 when the gateway is down — with the chain marked unreachable", async () => {
  const client = stubClient({ get: () => new DownstreamError("checkout-gateway unreachable", { peer: "checkout-gateway", kind: "network" }) });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("hop-unreachable"));
    assert.ok(html.includes("unknown"), "queue depth is unknown, not zero");
  });
});

test("the stylesheet is served at its versioned path and cached", async () => {
  await withApp(stubClient({}), async (base) => {
    const res = await fetch(`${base}/assets/abc123/app.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /text\/css/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.ok((await res.text()).includes("--bg"));
  });
});

test("a wrong asset version genuinely 404s — the whole point of the ASSET_VERSION fault", async () => {
  await withApp(stubClient({}), async (base) => {
    assert.equal((await fetch(`${base}/assets/stale/app.css`)).status, 404);
  });
});

test("SSR_CONCURRENCY=1 serialises rendering instead of dropping requests", async () => {
  let inFlight = 0;
  let peak = 0;
  const client = stubClient({
    get: () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      inFlight--;
      return order;
    },
  });
  await withApp(client, async (base) => {
    await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/orders/${order.id}`)));
    assert.equal(peak, 1);
  }, 1);
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './config.js'` and `'./routes.js'`.

- [x] **Step 4: Write `services/storefront/src/config.ts`**

```ts
import { loadCommonConfig, optInt, optStr, requireUrl, type CommonConfig, type EnvSource } from "@sample-app/platform";

export interface StorefrontConfig extends CommonConfig {
  gatewayUrl: string;
  gatewayTimeoutMs: number;
  ssrConcurrency: number;
  assetCacheSeconds: number;
  assetVersion: string;
}

export function loadConfig(env: EnvSource): StorefrontConfig {
  const common = loadCommonConfig(env);
  return {
    ...common,
    gatewayUrl: requireUrl(env, "GATEWAY_URL"),
    gatewayTimeoutMs: optInt(env, "GATEWAY_TIMEOUT_MS", 2000, { min: 1 }),
    // Bounded render concurrency: excess requests queue rather than pile onto the event loop.
    // At 1 this produces genuine head-of-line blocking with every tier below it healthy.
    ssrConcurrency: optInt(env, "SSR_CONCURRENCY", 32, { min: 1 }),
    assetCacheSeconds: optInt(env, "ASSET_CACHE_SECONDS", 3600, { min: 0 }),
    // Normally the deployed version. Point it at anything else and every asset 404s while
    // every server-side metric stays green.
    assetVersion: optStr(env, "ASSET_VERSION", common.serviceVersion),
  };
}
```

- [x] **Step 5: Write `services/storefront/src/routes.ts`**

```ts
import type { ChainStatus, OrderV1, ServiceStats } from "@sample-app/contracts";
import {
  DownstreamError,
  sendHtml,
  sendText,
  statusForDownstream,
  traceContext,
  type HttpClient,
  type Logger,
  type Route,
  type RouteContext,
  type Semaphore,
} from "@sample-app/platform";
import { APP_CSS } from "./assets.js";
import { catalogPage, errorPage, orderPage, statusPage } from "./views.js";

export interface RouteDeps {
  client: HttpClient;
  logger: Logger;
  semaphore: Semaphore;
  selfStats: () => ServiceStats;
  gatewayUrl: string;
  assetVersion: string;
  assetCacheSeconds: number;
}

export function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

export function assetHref(version: string): string {
  return `/assets/${encodeURIComponent(version)}/app.css`;
}

class BadRequestError extends Error {}

/** Every HTML route renders an error page instead of a stack trace, and holds a semaphore
 *  permit while it renders — SSR_CONCURRENCY is the queue in front of that. */
function page(deps: RouteDeps, handler: (ctx: RouteContext) => Promise<void>) {
  return async (ctx: RouteContext): Promise<void> => {
    const release = await deps.semaphore.acquire();
    try {
      await handler(ctx);
    } catch (err) {
      const href = assetHref(deps.assetVersion);
      if (err instanceof BadRequestError) {
        sendHtml(ctx.res, 400, errorPage({ status: 400, message: err.message, traceId: null, assetHref: href }));
        return;
      }
      if (err instanceof DownstreamError) {
        const status = err.kind === "status" && err.status !== undefined && err.status < 500 ? err.status : statusForDownstream(err);
        deps.logger.error("gateway call failed", { peer: err.peer, kind: err.kind, upstream_status: err.status, err });
        sendHtml(ctx.res, status, errorPage({ status, message: err.message, traceId: traceContext().trace_id ?? null, assetHref: href }));
        return;
      }
      throw err;
    } finally {
      release();
    }
  };
}

export function createRoutes(deps: RouteDeps): Route[] {
  const href = () => assetHref(deps.assetVersion);

  return [
    {
      method: "GET",
      pattern: "/",
      handler: page(deps, async ({ res }) => sendHtml(res, 200, catalogPage(href()))),
    },
    {
      method: "POST",
      pattern: "/checkout",
      handler: page(deps, async ({ res, readBody }) => {
        const form = parseForm(await readBody());
        const qty = Number(form.qty);
        if (!form.sku || !Number.isInteger(qty) || qty < 1) {
          throw new BadRequestError(`"${form.qty ?? ""}" is not a valid quantity`);
        }
        const created = await deps.client.postJson<OrderV1>("checkout-gateway", `${deps.gatewayUrl}/api/checkout`, {
          customerId: "web-user",
          items: [{ sku: form.sku, qty }],
        });
        // 303 so a refresh of the order page never re-posts the form.
        res.writeHead(303, { location: `/orders/${encodeURIComponent(created.id)}` });
        res.end();
      }),
    },
    {
      method: "GET",
      pattern: "/orders/:id",
      handler: page(deps, async ({ res, params }) => {
        const order = await deps.client.getJson<OrderV1>(
          "checkout-gateway",
          `${deps.gatewayUrl}/api/orders/${encodeURIComponent(params.id!)}`,
        );
        sendHtml(res, 200, orderPage(order, href()));
      }),
    },
    {
      method: "GET",
      pattern: "/status",
      handler: page(deps, async ({ res }) => {
        const self = { name: "storefront", state: "ok" as const, stats: deps.selfStats() };
        let chain: ChainStatus;
        try {
          chain = await deps.client.getJson<ChainStatus>("checkout-gateway", `${deps.gatewayUrl}/api/chain-status`);
        } catch (err) {
          // The status page never fails: it reports the failure instead. A dashboard that
          // dies during an incident is worthless.
          const detail = err instanceof Error ? err.message : String(err);
          chain = {
            hops: ["checkout-gateway", "orders-api", "settlement-worker"].map((name) => ({ name, state: "unreachable" as const, detail, stats: null })),
            queue: null,
            checkedAt: new Date().toISOString(),
          };
        }
        sendHtml(res, 200, statusPage({ ...chain, hops: [self, ...chain.hops] }, href()));
      }),
    },
    {
      method: "GET",
      pattern: "/assets/:version/app.css",
      handler: async ({ res, params }) => {
        if (params.version !== deps.assetVersion) {
          sendText(res, 404, "not found");
          return;
        }
        sendText(res, 200, APP_CSS, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": `public, max-age=${deps.assetCacheSeconds}`,
        });
      },
    },
  ];
}
```

- [x] **Step 6: Write `services/storefront/src/index.ts`**

```ts
import {
  createApp,
  createHttpClient,
  createLogger,
  createMetrics,
  createSemaphore,
  initTracing,
  installShutdown,
  loadOrExit,
  redactConfig,
  RollingStats,
  traceContext,
  type ProbeResult,
} from "@sample-app/platform";
import { loadConfig } from "./config.js";
import { createRoutes } from "./routes.js";

const SERVICE = "storefront";

const config = loadOrExit(loadConfig);
const logger = createLogger({ service: SERVICE, version: config.serviceVersion, level: config.logLevel, traceContext });
const tracing = initTracing({
  service: SERVICE,
  version: config.serviceVersion,
  deploymentEnv: config.deploymentEnv,
  endpoint: config.otelEndpoint,
  logger,
});
const metrics = createMetrics({ service: SERVICE, version: config.serviceVersion, commit: config.serviceVersion });
logger.info("starting", { config: redactConfig({ ...config }) });

const client = createHttpClient({ service: SERVICE, metrics, timeoutMs: config.gatewayTimeoutMs });
const stats = new RollingStats();
const semaphore = createSemaphore(config.ssrConcurrency);

const readiness = async (): Promise<ProbeResult> => {
  try {
    await client.getJson("checkout-gateway", `${config.gatewayUrl}/healthz`, { timeoutMs: 1000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `checkout-gateway unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const server = createApp({
  service: SERVICE,
  config,
  logger,
  metrics,
  stats,
  routes: createRoutes({
    client,
    logger,
    semaphore,
    selfStats: () => ({ service: SERVICE, version: config.serviceVersion, ...stats.snapshot() }),
    gatewayUrl: config.gatewayUrl,
    assetVersion: config.assetVersion,
    assetCacheSeconds: config.assetCacheSeconds,
  }),
  readiness,
  traceIdOf: () => traceContext().trace_id,
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : [],
});

server.listen(config.port, () => logger.info("listening", { port: config.port }));
```

- [x] **Step 7: Write `services/storefront/Dockerfile`**

```dockerfile
# Build context is the repository root — packages/ is shared by every service.
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/storefront/package.json services/storefront/

# --ignore-scripts: this stage only runs `tsc`, but npm ci also installs tsx, whose esbuild
# dependency has a postinstall that EXECS the binary it just wrote. Under QEMU emulation —
# any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the write and
# dies with ETXTBSY. No dependency here needs its install scripts.
RUN npm ci --ignore-scripts

COPY packages/ packages/
COPY services/storefront/ services/storefront/

RUN npm run build -w @sample-app/contracts \
 && npm run build -w @sample-app/platform \
 && npm run build -w @sample-app/storefront


FROM node:24-alpine AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY services/storefront/package.json services/storefront/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/platform/dist packages/platform/dist
COPY --from=builder /app/services/storefront/dist services/storefront/dist

ARG SERVICE_VERSION=dev
ENV SERVICE_VERSION=$SERVICE_VERSION
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "services/storefront/dist/index.js"]
```

- [x] **Step 8: Run the tests and build the image**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm test
npm run build
docker build -f services/storefront/Dockerfile \
  --build-arg SERVICE_VERSION=$(git rev-parse --short HEAD) \
  -t storefront:$(git rev-parse --short HEAD) .
```

Expected: PASS — 5 config tests, 11 route tests; the image builds.

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(storefront): routes, bounded ssr concurrency and dockerfile"
```

---

### Task 21: load generator and the full local stack

**Files:**
- Create: `services/storefront/src/loadgen.ts`
- Modify: `docker-compose.yml` (Postgres only from Task 11 → the whole stack)
- Test: `services/storefront/src/loadgen.test.ts`

**Interfaces:**
- Consumes: `optInt`, `optNumber`, `requireUrl`, `loadOrExit` (Task 2); the storefront routes (Task 20).
- Produces: `LoadgenConfig`, `loadLoadgenConfig(env)`, `pickAction(random, checkoutRatio)`, `LoadStats`, `runLoad(opts): Promise<LoadStats>`.

The generator drives **storefront**, not the gateway, so simulated traffic traverses the whole
chain the way a browser does. Rate-based symptoms do not exist at zero requests per second, so
this is a prerequisite for most of the fault catalog, not an extra.

- [x] **Step 1: Write the failing test**

`services/storefront/src/loadgen.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadLoadgenConfig, pickAction, runLoad } from "./loadgen.js";

test("the defaults are modest enough to run on a laptop", () => {
  const c = loadLoadgenConfig({ TARGET_URL: "http://localhost:3000" });
  assert.equal(c.rps, 5);
  assert.equal(c.durationSeconds, 0);
  assert.equal(c.checkoutRatio, 0.3);
});

test("TARGET_URL is required and must be a URL", () => {
  assert.throws(() => loadLoadgenConfig({}), /TARGET_URL/);
  assert.throws(() => loadLoadgenConfig({ TARGET_URL: "localhost:3000" }), /TARGET_URL/);
});

test("pickAction splits traffic between browsing and checking out", () => {
  assert.equal(pickAction(0.0, 0.3), "checkout");
  assert.equal(pickAction(0.29, 0.3), "checkout");
  assert.equal(pickAction(0.31, 0.3), "browse");
  assert.equal(pickAction(0.99, 0.3), "browse");
  assert.equal(pickAction(0.5, 0), "browse", "ratio 0 never checks out");
  assert.equal(pickAction(0.99, 1), "checkout", "ratio 1 always checks out");
});

async function withStorefront<T>(fn: (base: string, paths: string[]) => Promise<T>): Promise<T> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === "/checkout") {
      res.writeHead(303, { location: "/orders/018f0000-0000-4000-8000-000000000001" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, paths);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("a browse iteration fetches the catalog and the status page", async () => {
  await withStorefront(async (base, paths) => {
    const stats = await runLoad({ targetUrl: base, iterations: 2, rps: 1000, checkoutRatio: 0, random: () => 0.9 });
    assert.equal(stats.requests, 2);
    assert.equal(stats.errors, 0);
    assert.ok(paths.includes("GET /"));
  });
});

test("a checkout iteration posts the form and follows the redirect to the order page", async () => {
  await withStorefront(async (base, paths) => {
    const stats = await runLoad({ targetUrl: base, iterations: 1, rps: 1000, checkoutRatio: 1, random: () => 0.1 });
    assert.equal(stats.checkouts, 1);
    assert.ok(paths.includes("POST /checkout"));
    assert.ok(paths.some((p) => p.startsWith("GET /orders/")));
  });
});

test("a failing target is counted, not fatal — the generator keeps driving through an incident", async () => {
  const stats = await runLoad({ targetUrl: "http://127.0.0.1:1", iterations: 3, rps: 1000, checkoutRatio: 0, random: () => 0.9 });
  assert.equal(stats.requests, 3);
  assert.equal(stats.errors, 3);
});

test("a 5xx from the storefront counts as an error without throwing", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(503); res.end("nope"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const stats = await runLoad({ targetUrl: `http://127.0.0.1:${port}`, iterations: 2, rps: 1000, checkoutRatio: 0, random: () => 0.9 });
    assert.equal(stats.errors, 2);
    assert.equal(stats.statuses["503"], 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `Cannot find module './loadgen.js'`.

- [x] **Step 3: Write `services/storefront/src/loadgen.ts`**

```ts
import { CATALOG } from "@sample-app/contracts";
import { loadOrExit, optInt, optNumber, requireUrl, type EnvSource } from "@sample-app/platform";

export interface LoadgenConfig {
  targetUrl: string;
  rps: number;
  durationSeconds: number;
  checkoutRatio: number;
}

export function loadLoadgenConfig(env: EnvSource): LoadgenConfig {
  return {
    targetUrl: requireUrl(env, "TARGET_URL"),
    rps: optInt(env, "LOADGEN_RPS", 5, { min: 1, max: 10_000 }),
    // 0 means run until killed — the normal mode for an in-cluster Job.
    durationSeconds: optInt(env, "LOADGEN_DURATION_SECONDS", 0, { min: 0 }),
    checkoutRatio: optNumber(env, "LOADGEN_CHECKOUT_RATIO", 0.3, { min: 0, max: 1 }),
  };
}

export type LoadAction = "browse" | "checkout";

export function pickAction(random: number, checkoutRatio: number): LoadAction {
  return random < checkoutRatio ? "checkout" : "browse";
}

export interface LoadStats {
  requests: number;
  checkouts: number;
  errors: number;
  statuses: Record<string, number>;
}

export interface RunLoadOptions {
  targetUrl: string;
  rps: number;
  checkoutRatio: number;
  /** Bounded run for tests; omit for an endless one. */
  iterations?: number;
  durationSeconds?: number;
  random?: () => number;
  /** Supply one to watch the running totals from outside — the CLI's ticker does. */
  stats?: LoadStats;
}

export function emptyStats(): LoadStats {
  return { requests: 0, checkouts: 0, errors: 0, statuses: {} };
}

export async function runLoad(opts: RunLoadOptions): Promise<LoadStats> {
  const random = opts.random ?? Math.random;
  const stats = opts.stats ?? emptyStats();
  const intervalMs = 1000 / opts.rps;
  const deadline = opts.durationSeconds ? Date.now() + opts.durationSeconds * 1000 : Infinity;

  const record = (status: string): void => {
    stats.requests++;
    stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
    if (status === "error" || Number(status) >= 400) stats.errors++;
  };

  const visit = async (path: string, init?: RequestInit): Promise<Response | null> => {
    try {
      const res = await fetch(`${opts.targetUrl}${path}`, { redirect: "manual", ...init });
      record(String(res.status));
      await res.text();
      return res;
    } catch {
      // A dead target is the normal state during an incident: count it and keep going.
      record("error");
      return null;
    }
  };

  for (let i = 0; opts.iterations === undefined || i < opts.iterations; i++) {
    if (Date.now() >= deadline) break;
    const startedAt = Date.now();

    if (pickAction(random(), opts.checkoutRatio) === "checkout") {
      const product = CATALOG[Math.floor(random() * CATALOG.length)] ?? CATALOG[0]!;
      const res = await visit("/checkout", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sku: product.sku, qty: "1" }).toString(),
      });
      stats.checkouts++;
      const location = res?.headers.get("location");
      // Following the redirect is the point: it exercises gateway cache, orders-api read,
      // and eventually the settled status the worker wrote.
      if (location) await visit(location);
    } else {
      await visit(random() < 0.5 ? "/" : "/status");
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < intervalMs) await new Promise((r) => setTimeout(r, intervalMs - elapsed));
  }

  return stats;
}

// Executed only when run directly (npm run loadgen), never when imported by the tests.
if (process.argv[1]?.includes("loadgen")) {
  const config = loadOrExit(loadLoadgenConfig);
  const started = Date.now();
  // runLoad mutates this object, so the ticker prints running totals, not a stale copy.
  const current = emptyStats();
  const report = (): void => {
    const seconds = (Date.now() - started) / 1000;
    process.stdout.write(JSON.stringify({ ...current, seconds: Math.round(seconds), rps: +(current.requests / seconds).toFixed(2) }) + "\n");
  };
  const ticker = setInterval(report, 10_000);
  const finish = (): never => { clearInterval(ticker); report(); process.exit(0); };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);

  await runLoad({
    targetUrl: config.targetUrl,
    rps: config.rps,
    checkoutRatio: config.checkoutRatio,
    durationSeconds: config.durationSeconds,
    stats: current,
  });
  clearInterval(ticker);
  report();
}
```

- [x] **Step 4: Add `optNumber` to `packages/platform/src/config.ts`**

`optInt` (Task 2) rejects a fractional value, and `LOADGEN_CHECKOUT_RATIO` is one. Add
beside it, and export it from the platform barrel:

```ts
export function optNumber(env: EnvSource, key: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(key, `must be a number, got ${JSON.stringify(raw)}`);
  if (bounds.min !== undefined && value < bounds.min) throw new ConfigError(key, `must be >= ${bounds.min}, got ${value}`);
  if (bounds.max !== undefined && value > bounds.max) throw new ConfigError(key, `must be <= ${bounds.max}, got ${value}`);
  return value;
}
```

Add its test to `packages/platform/src/config.test.ts`:

```ts
test("optNumber accepts fractions and enforces its bounds", () => {
  assert.equal(optNumber({}, "RATIO", 0.3), 0.3);
  assert.equal(optNumber({ RATIO: "0.75" }, "RATIO", 0.3), 0.75);
  assert.throws(() => optNumber({ RATIO: "2" }, "RATIO", 0.3, { max: 1 }), /RATIO/);
  assert.throws(() => optNumber({ RATIO: "abc" }, "RATIO", 0.3), /RATIO/);
});
```

- [x] **Step 5: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm run build:libs && npm test`
Expected: PASS — 7 loadgen tests plus the new `optNumber` test.

- [x] **Step 6: Replace `docker-compose.yml` with the full stack**

```yaml
# Local stack. Mirrors the deployment contract: one migration pass, then four services.
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sample
      POSTGRES_PASSWORD: sample
      POSTGRES_DB: sample_app
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sample -d sample_app"]
      interval: 2s
      timeout: 3s
      retries: 15

  migrate:
    build:
      context: .
      dockerfile: services/orders-api/Dockerfile
    command: ["node", "services/orders-api/dist/db/migrate-cli.js"]
    environment:
      DATABASE_URL: postgres://sample:sample@postgres:5432/sample_app
      SERVICE_VERSION: local
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  orders-api:
    build:
      context: .
      dockerfile: services/orders-api/Dockerfile
    environment:
      DATABASE_URL: postgres://sample:sample@postgres:5432/sample_app
      SERVICE_VERSION: local
      LOG_LEVEL: debug
      PORT: "3000"
    ports:
      - "8082:3000"
    depends_on:
      migrate:
        condition: service_completed_successfully

  settlement-worker:
    build:
      context: .
      dockerfile: services/settlement-worker/Dockerfile
    environment:
      DATABASE_URL: postgres://sample:sample@postgres:5432/sample_app
      SERVICE_VERSION: local
      LOG_LEVEL: debug
      PORT: "3001"
    ports:
      - "8083:3001"
    depends_on:
      migrate:
        condition: service_completed_successfully

  checkout-gateway:
    build:
      context: .
      dockerfile: services/checkout-gateway/Dockerfile
    environment:
      ORDERS_API_URL: http://orders-api:3000
      WORKER_URL: http://settlement-worker:3001
      SERVICE_VERSION: local
      LOG_LEVEL: debug
      PORT: "3000"
    ports:
      - "8081:3000"
    depends_on:
      - orders-api
      - settlement-worker

  storefront:
    build:
      context: .
      dockerfile: services/storefront/Dockerfile
    environment:
      GATEWAY_URL: http://checkout-gateway:3000
      SERVICE_VERSION: local
      LOG_LEVEL: debug
      PORT: "3000"
    ports:
      - "8080:3000"
    depends_on:
      - checkout-gateway
```

- [x] **Step 7: Drive the whole chain end to end**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
docker compose up -d --build
sleep 15
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/
TARGET_URL=http://localhost:8080 LOADGEN_RPS=10 LOADGEN_DURATION_SECONDS=20 npm run loadgen
curl -s localhost:8083/queue-stats
curl -s localhost:8080/status | grep -o 'hop-[a-z]*'
```

Expected: the catalog returns 200; the loadgen summary reports `errors: 0`; `/queue-stats`
drains back to `depth: 0`; `/status` shows four `hop-ok` rows.

Then confirm a fault is genuinely visible before trusting the stack:

```bash
docker compose stop settlement-worker
TARGET_URL=http://localhost:8080 LOADGEN_RPS=10 LOADGEN_DURATION_SECONDS=15 npm run loadgen
curl -s localhost:8082/metrics | grep -c 'db_query_duration_seconds_count'
curl -s localhost:8080/status | grep -o 'hop-unreachable'
docker compose start settlement-worker
```

Expected: `/status` marks the worker unreachable while checkout keeps succeeding, and the
queue drains once the worker is back — the settlement-backlog symptom, reproduced locally.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: load generator and full local docker compose stack"
```

---

### Task 22: alert rule definitions, deployment contract, repo documentation

**Files:**
- Create: `docs/alerting/sample-app-rules.yaml`, `docs/DEPLOYMENT_CONTRACT.md`, `README.md`, `CLAUDE.md`, `MEMORY_BANK.md`
- Modify: `package.json` (root `test` script — add the `docs/**` glob)
- Test: `docs/alerting/rules.test.ts` (rule expressions must reference metric names that exist)

**Interfaces:**
- Consumes: the metric names produced in Task 4.
- Produces: the rule fragment the operator merges into `serverFiles.alerting_rules.yml.groups`, and the repo's own documentation.

This repo owns the rule definitions because the rules query the metric names in Task 4 —
renaming a metric must break its rule in the same commit. Wiring them into the cluster is the
operator's job; this repo deploys nothing.

- [x] **Step 1: Write the failing test**

`docs/alerting/rules.test.ts` — cheap insurance against a rename that silently kills a rule.
It parses only what it needs, so no YAML dependency is added.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMetrics } from "@sample-app/platform";

const rules = readFileSync(fileURLToPath(new URL("./sample-app-rules.yaml", import.meta.url)), "utf8");

test("every alert the spec names is defined", () => {
  for (const name of [
    "SampleAppHighErrorRate",
    "SampleAppHighLatency",
    "SampleAppSettlementBacklog",
    "SampleAppTargetDown",
    "SampleAppNotReady",
    "SampleAppNoEndpoints",
  ]) {
    assert.match(rules, new RegExp(`alert: ${name}\\b`), `missing rule ${name}`);
  }
});

test("every app metric a rule queries is actually exported", async () => {
  const metrics = await createMetrics({ service: "orders-api", version: "test", commit: "test" }).registry.metrics();
  for (const metric of [
    "http_server_requests_total",
    "http_server_request_duration_seconds",
    "queue_oldest_job_age_seconds",
  ]) {
    assert.ok(rules.includes(metric), `no rule references ${metric}`);
    assert.ok(metrics.includes(metric), `${metric} is referenced by a rule but not exported`);
  }
});

test("no rule names a cause — a cause-level alert hands the agent the answer", () => {
  for (const forbidden of ["PoolExhausted", "CacheDisabled", "BadConfig", "WrongVersion", "Timeout"]) {
    assert.doesNotMatch(rules, new RegExp(`alert: \\w*${forbidden}`), `${forbidden} states a cause`);
  }
});

test("every rule carries a severity and both annotations", () => {
  const blocks = rules.split(/^\s*- alert: /m).slice(1);
  assert.equal(blocks.length, 6);
  for (const block of blocks) {
    assert.match(block, /severity: (critical|warning)/);
    assert.match(block, /summary:/);
    assert.match(block, /description:/);
  }
});

test("the scrape job and namespace selectors match the deployment contract", () => {
  assert.ok(rules.includes(`job="sample-app"`));
  assert.ok(rules.includes(`namespace=~"sample-app.*"`));
});
```

Append a third glob to the root `test` script in `package.json` so this file runs — the first
two globs are unchanged from Task 1:

```json
"test": "npm run build:libs && node --import tsx --test \"packages/**/src/**/*.test.ts\" \"services/**/src/**/*.test.ts\" \"docs/**/*.test.ts\""
```

- [x] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: FAIL — `ENOENT: no such file or directory ... sample-app-rules.yaml`.

- [x] **Step 3: Write `docs/alerting/sample-app-rules.yaml`**

```yaml
# Alert rule definitions for the sample app.
#
# Format: a fragment of serverFiles.alerting_rules.yml.groups for the community `prometheus`
# chart. The cluster does NOT run the Prometheus Operator, so PrometheusRule CRDs do not apply.
# Merge this into apps/base/systems/prometheus/release.yaml — see DEPLOYMENT_CONTRACT.md §6.
#
# Every rule is symptom-level. A rule named SampleAppDbPoolExhausted would state the answer in
# the alert: alertmanager_get_alerts is the agent's unfiltered Blast Radius call, so a
# cause-level rule hands it the diagnosis in tool call #1. Cause signals stay as metrics the
# agent has to go and find.
#
# `for: 1m` on the app rules is a deliberate divergence from production parity (2-5m), made to
# keep the evaluation cycle short. It is not an oversight.
#
# Assumptions, both stated in DEPLOYMENT_CONTRACT.md so scrape config and expressions agree:
#   - the scrape job is labelled job="sample-app"
#   - the workloads live in a namespace matching sample-app.*
groups:
  - name: sample-app
    rules:
      - alert: SampleAppHighErrorRate
        expr: |
          sum by (namespace, service) (rate(http_server_requests_total{job="sample-app",status=~"5.."}[5m]))
            /
          sum by (namespace, service) (rate(http_server_requests_total{job="sample-app"}[5m]))
            > 0.05
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.service }} is failing more than 5% of requests"
          description: >-
            {{ $labels.service }} in {{ $labels.namespace }} has returned 5xx for
            {{ $value | humanizePercentage }} of requests over the last 5 minutes.

      - alert: SampleAppHighLatency
        expr: |
          histogram_quantile(
            0.99,
            sum by (namespace, service, le) (rate(http_server_request_duration_seconds_bucket{job="sample-app"}[5m]))
          ) > 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.service }} p99 latency is above 1s"
          description: >-
            The 99th percentile request duration for {{ $labels.service }} in
            {{ $labels.namespace }} is {{ $value | humanizeDuration }}.

      - alert: SampleAppSettlementBacklog
        expr: max by (namespace, queue) (queue_oldest_job_age_seconds{job="sample-app"}) > 300
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "The {{ $labels.queue }} queue is not draining"
          description: >-
            The oldest unprocessed job in {{ $labels.queue }} ({{ $labels.namespace }}) is
            {{ $value | humanizeDuration }} old. Orders are being accepted but not settled.

      - alert: SampleAppTargetDown
        expr: up{job="sample-app"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "A sample-app target has stopped responding to scrapes"
          description: >-
            Prometheus cannot scrape {{ $labels.instance }} ({{ $labels.namespace }}).
            The process is gone or unreachable without necessarily CrashLooping.

      - alert: SampleAppNotReady
        expr: |
          kube_deployment_spec_replicas{namespace=~"sample-app.*"}
            - on (namespace, deployment) kube_deployment_status_replicas_ready{namespace=~"sample-app.*"}
            > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.deployment }} has replicas that never became ready"
          description: >-
            {{ $value }} replica(s) of {{ $labels.deployment }} in {{ $labels.namespace }} are
            not ready. Pod phase stays Running in this state, so no phase-based rule sees it.

      # kube_endpoint_address_available was deprecated in kube-state-metrics v2.x in favour of
      # kube_endpoint_address{ready="true"}. Before wiring this in, check which one the running
      # kube-state-metrics actually exports and keep that expression:
      #   curl -sG <prometheus>/api/v1/query --data-urlencode 'query=kube_endpoint_address' | head
      # Deprecated form, for a pre-2.x kube-state-metrics:
      #   expr: kube_endpoint_address_available{namespace=~"sample-app.*"} == 0
      - alert: SampleAppNoEndpoints
        expr: |
          sum by (namespace, endpoint) (kube_endpoint_address{namespace=~"sample-app.*",ready="true"}) == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Service {{ $labels.endpoint }} has no ready endpoints"
          description: >-
            {{ $labels.endpoint }} in {{ $labels.namespace }} is serving no traffic. Every pod
            may be healthy — a Service selector that matches nothing looks exactly like this.
```

- [x] **Step 4: Run the rule test**

Run: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH && npm test`
Expected: PASS — 5 rule tests.

- [x] **Step 5: Write `docs/DEPLOYMENT_CONTRACT.md`**

````markdown
# Deployment contract

This repository builds images and publishes rule definitions. **It deploys nothing.**

`main` of `gitops-devops-ai-manifest` is Flux-reconciled on a one-minute poll with no PR gate,
so pushing there *is* deploying. Everything below is handed over, not applied.

Two values are assumed by the alert rules and must match whatever you configure:

| assumption | used by |
|---|---|
| namespace matches `sample-app.*` | `SampleAppNotReady`, `SampleAppNoEndpoints` |
| scrape job is labelled `job="sample-app"` | every app rule |

## 1. Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: sample-app
```

## 2. Postgres and the DATABASE_URL secret

The Bitnami postgresql chart creates a database only when `auth.database` is set, **and only on
first init of an empty PVC**. An already-initialised volume needs a one-time manual
`CREATE DATABASE sample_app;`. App migrations create tables, never the database.

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

## 3. Migration Job (12-factor XII)

Same image as `orders-api`, run to completion **before** the app rollout.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: sample-app-migrate
  namespace: sample-app
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/OWNER/sample-app-orders-api:GIT_SHA
          command: ["node", "services/orders-api/dist/db/migrate-cli.js"]
          envFrom:
            - secretRef:
                name: sample-app-db
```

The runner takes a Postgres advisory lock, so running it twice — or two Jobs racing — is safe.
`orders-api` refuses to start against an out-of-date schema unless `MIGRATION_REQUIRED=false`.

## 4. Four Deployments and Services

Common to every Deployment:

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

Per-service differences:

| service | port | extra env | Service exposes |
|---|---|---|---|
| `storefront` | 3000 | `GATEWAY_URL=http://checkout-gateway:3000` | http 3000, the only one users reach |
| `checkout-gateway` | 3000 | `ORDERS_API_URL=http://orders-api:3000`, `WORKER_URL=http://settlement-worker:3001` | http 3000 |
| `orders-api` | 3000 | `envFrom` the `sample-app-db` secret | http 3000 |
| `settlement-worker` | 3001 | `envFrom` the `sample-app-db` secret, `PORT=3001` | **admin port only** — it serves no traffic |

`memory: 256Mi` is deliberate: it is what makes `SETTLEMENT_BATCH_SIZE=200000` reach the OOM
killer in a bounded time instead of swelling forever.

## 5. Prometheus scrape job

**Required, and easy to miss.** The dev overlay sets
`kubernetes-service-endpoints: enabled: false`, so pod and service annotations alone scrape
nothing. Without this job every app-metric rule is silently dead.

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

Annotate every pod template with `prometheus.io/scrape: "true"`, `prometheus.io/path: /metrics`
and `prometheus.io/port: "3000"` (`"3001"` for the worker).

Verify after rollout — an empty result here means every rule is dead:

```
curl -sG <prometheus>/api/v1/query --data-urlencode 'query=up{job="sample-app"}'
```

## 6. Alert rules

Merge `docs/alerting/sample-app-rules.yaml` into
`serverFiles.alerting_rules.yml.groups` in `apps/base/systems/prometheus/release.yaml`.
Check the kube-state-metrics note in that file before wiring `SampleAppNoEndpoints`.

Alertmanager's route already groups by `["alertname", "namespace"]`, so a fault that breaches
one threshold across three services arrives as one group holding three alerts.

## 7. Tracing backend

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on all four Deployments once a backend exists. **It currently
does not:** `apps/base/systems/jaeger/` is an empty directory and is absent from the dev
kustomization, while `devops-mcp-server` points `TRACING_URL` at a Jaeger query service that
resolves to nothing.

Until then the services log one warning at boot and run without tracing. That is why
`http_client_*` metrics carry so much of the diagnostic load — with no traces, they are the only
signal that distinguishes "my caller gave up" from "my callee failed".

## 8. Flux ownership

Manage these workloads with Flux like any other app. The consequence is worth stating: a fault
injected with `kubectl` on a Flux-managed workload is reverted at the next reconcile. That is
itself the GitOps-drift scenario, and its correct remediation is `flux_reconcile`, not a PR.
````

- [x] **Step 6: Write `README.md`**

````markdown
# devops-sample-app

A deliberately ordinary e-commerce chain, built to be broken on purpose. It exists to exercise
the `devops-ai-agent` stack end to end: an injected fault produces a real symptom, the symptom
fires an alert, and the agent investigates it through the MCP tools with no privileged shortcut.

```
browser → storefront (SSR) → checkout-gateway (BFF) → orders-api → postgres
                                                          ↓ settlement_jobs
                                                   settlement-worker
```

**The design rule:** every fault has a genuine mechanism, and its cause is a plausible
production config value visible in cluster state. No chaos switch, no `if (BREAK_ME)`.
`DB_POOL_MAX=1` really serialises database access; `ARTIFICIAL_LATENCY_MS` would leave no trace
anywhere and does not exist.

## Layout

| path | what |
|---|---|
| `services/storefront` | Server-rendered UI. Zero client JavaScript — a browser-side failure would be invisible to every MCP tool. |
| `services/checkout-gateway` | BFF. In-process TTL cache, chain-status aggregation. |
| `services/orders-api` | Orders and the settlement queue writer. Owns the schema. |
| `services/settlement-worker` | Claims jobs with `FOR UPDATE SKIP LOCKED`, settles orders. |
| `packages/platform` | Config, logging, metrics, HTTP server and client, tracing, shutdown. |
| `packages/contracts` | Catalog, order shapes, chain-status types. Shared by every service. |
| `docs/alerting/` | The alert rule definitions. |
| `docs/DEPLOYMENT_CONTRACT.md` | What an operator must provide. This repo deploys nothing. |

## Running it

Node 24 is required.

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
npm install
docker compose up -d --build
open http://localhost:8080          # catalog
open http://localhost:8080/status   # live chain view
```

Rate-based symptoms do not exist at zero requests per second, so drive traffic:

```bash
TARGET_URL=http://localhost:8080 LOADGEN_RPS=10 npm run loadgen
```

Tests (database-backed ones are skipped unless `TEST_DATABASE_URL` is set):

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test
```

## Injecting a fault

Every fault is an environment variable. Change it the way you would change any config value:

```bash
kubectl -n sample-app set env deploy/orders-api DB_POOL_MAX=1
kubectl -n sample-app set env deploy/checkout-gateway DOWNSTREAM_TIMEOUT_MS=50
kubectl -n sample-app set env deploy/settlement-worker SETTLEMENT_POLL_INTERVAL_MS=60000
kubectl -n sample-app set env deploy/storefront ASSET_VERSION=stale
```

On a Flux-managed workload these are reverted at the next reconcile — which is the GitOps-drift
scenario, and a valid test in its own right.

The full catalog, with each fault's mechanism, observable signature, and triggering alert rule,
is in `docs/superpowers/specs/2026-08-16-sample-app-design.md` §10.

**A fault with no alert rule is never investigated.** The agent's entry point is the
Alertmanager webhook, so faults that page (`DB_POOL_MAX`, `DOWNSTREAM_TIMEOUT_MS`,
`SETTLEMENT_POLL_INTERVAL_MS`, …) drive an investigation, while silent ones (`ASSET_VERSION`)
are only reachable by mentioning them in Slack.
````

- [x] **Step 7: Write `CLAUDE.md`**

````markdown
# devops-sample-app

Test-and-evaluation workload for the `devops-ai-agent` stack: four services that can be broken
in production-plausible ways so an agent investigation has something real to find.

**Read `MEMORY_BANK.md` before adding a service, a metric, or a fault knob.**

## Commands
- Build: `npm run build` (all workspaces) / `npm run build:libs` (contracts + platform only)
- Test: `npm test` (`node:test` + tsx, zero extra test deps)
- Load: `TARGET_URL=http://localhost:8080 npm run loadgen`
- **Node 24 required.** Default shell node is v14 — put `~/.nvm/versions/node/v24.16.0/bin` on the PATH.

## Conventions
- npm workspaces. TypeScript ESM (NodeNext), so relative imports end in `.js`.
- `*.test.ts` is excluded from builds; tests run from source via tsx after `build:libs`.
- The dependency list is closed: `prom-client`, `pg`, and the OpenTelemetry packages. Nothing else.
- Docker builder stages use `npm ci --ignore-scripts`; runtime stages use `npm ci --omit=dev`.
- Every Docker build context is the **repo root**: `docker build -f services/X/Dockerfile .`

## Gotchas
- **This repo deploys nothing.** It builds images and publishes rule definitions. Deployment is
  the operator's, per `docs/DEPLOYMENT_CONTRACT.md`.
- **Alert rules are symptom-level, never cause-level.** `alertmanager_get_alerts` is the agent's
  unfiltered Blast Radius call — a rule named `SampleAppDbPoolExhausted` would hand it the
  answer in tool call #1 and leave nothing to diagnose.
- **A fault with no rule is never investigated.** The trigger is the Alertmanager webhook.
- **No client JavaScript in storefront, ever.** A browser-side failure leaves no trace in Loki,
  Prometheus, or the tracing backend, so it would be undiagnosable by construction.
- **Route labels are templated** (`/orders/:id`, never `/orders/018f…`). A raw path in a metric
  label is unbounded cardinality.
- **Probe endpoints are excluded from `http_server_*`** (`INTROSPECTION_ROUTES`). A kubelet
  hammering `/readyz` during a database blip would otherwise fire the error-rate alert on
  traffic no user ever sent.
- **Fault knobs must have a genuine mechanism.** If a knob only makes the code lie about itself,
  it does not belong here.
- **The resolved config is logged once at boot, redacted.** That log line is how a fault knob is
  findable in Loki as well as in `k8s_describe_pod`.
- **`ORDER_RESPONSE_VERSION=2` really breaks `checkout-gateway`** — `assertOrderV1` is strict on
  purpose. Making it tolerant would turn the fault into a no-op.

## Working style
- Chat in Indonesian; keep technical/English terms untranslated. **Docs are written in English.**
- Don't commit or push unless asked.
````

- [x] **Step 8: Write `MEMORY_BANK.md`**

````markdown
# MEMORY_BANK — devops-sample-app

Design decisions and the reasoning behind them. `CLAUDE.md` has the short rules; this file says
why they exist.

## Purpose

The `devops-ai-agent` stack could only ever be evaluated against real incidents in the repos it
monitors — rare, unrepeatable, and never available on demand. This repo is a workload whose
faults are injectable, repeatable, and production-plausible.

"Production-plausible" is the whole design. **Every fault has a genuine mechanism, and its cause
is a plausible production config value visible in cluster state.** `ARTIFICIAL_LATENCY_MS=800`
would be a lie the code tells about itself: nothing in the cluster would show it, and an
investigation would have to guess. `DB_POOL_MAX=1` genuinely serialises database access,
genuinely raises p99, and is right there in `k8s_describe_pod`.

## Topology

Four services, not one: `storefront` (SSR UI) → `checkout-gateway` (BFF) → `orders-api` →
Postgres, with `settlement-worker` consuming a `settlement_jobs` queue in the same database.

- **Separate images per service**, built from one monorepo. A single image with `APP_ROLE`
  would make "the 14:32 deploy of orders-api broke checkout" impossible to stage, because every
  service would always be on the same version.
- **Postgres is the only backing service and the queue lives inside it, on purpose.** That
  creates one shared failure domain: when the database degrades, `orders-api` and
  `settlement-worker` degrade together while `storefront` and `checkout-gateway` are pure
  victims. A real cascade is what makes naming the true root cause hard.
- **SSR, zero client JavaScript.** A React error in a browser is invisible to every MCP tool the
  agent has. An SPA would build a whole class of faults that are undiagnosable by construction.

## Alerting is the trigger, so alerting is part of the contract

The agent's entry point is the Alertmanager webhook. A fault that fires no alert is never
investigated — it can only be raised by mentioning it in Slack. So this repo owns the rule
definitions even though it deploys nothing: renaming a metric must break its rule in the same
commit.

Rules are **symptom-level, never cause-level**. `alertmanager_get_alerts` is the agent's
unfiltered Blast Radius call at the start of an investigation; a rule named
`SampleAppDbPoolExhausted` would state the answer there and make the evaluation measure nothing.
Cause signals stay as metrics the agent must go and find.

`for: 1m` on the app rules is a deliberate divergence from production parity (2-5m), traded for
a short evaluation cycle.

## Observability choices

- **`http_client_*` carries much of the diagnostic load.** With no tracing backend deployed yet,
  these metrics are the only signal that separates "my caller gave up" (`status="timeout"` on
  the caller, healthy callee) from "my callee failed" (`status="502"`).
- **`build_info{service,version,commit}`** is what correlates an error onset to a running
  version — the alternative is guessing from pod age.
- **The route label is templated.** `/orders/:id`, never the id.
- **Probe and introspection endpoints are excluded from `http_server_*` and from the rolling
  window.** Otherwise a kubelet probing `/readyz` through a database blip pours 503s into
  `http_server_requests_total` and fires `SampleAppHighErrorRate` on traffic no user sent.
- **`traceparent` is stored on the job row** and restored when the worker claims it, so the
  worker's span links back to the checkout that created the job. Most teams skip this, and the
  async side becomes the blind spot.
- **`/stats` (a 60-second in-process rolling window) exists because the status page must not
  depend on Prometheus.** It is also, deliberately, human-facing only: the agent has MCP tools
  and no browser, so the page can never become a shortcut that makes diagnosis falsely easy.

## Deliberate deviations from the spec

- **`/status` shows hop reachability, not ready replicas.** Ready replicas need the Kubernetes
  API, which is outside this repo's closed dependency list.
- **The stylesheet is served from `/assets/<ASSET_VERSION>/app.css`, not inlined.** An inline
  `<style>` cannot 404, and the `ASSET_VERSION` fault needs a genuine mechanism — every server
  metric green, every span OK, product visibly broken.
- **`checkout-gateway` requires `WORKER_URL`.** `chain-status` aggregates the worker's
  `/queue-stats`, and the gateway cannot call a service whose address it does not have.

## Health and shutdown

`/healthz` checks that the process is alive and nothing else. `/readyz` checks dependencies.
Conflating them is the classic bug that turns a brief database stall into a cluster-wide restart
storm — `LIVENESS_CHECKS_DB=true` reproduces exactly that, and it is one of the more valuable
faults precisely because the symptom (everything restarting at once) points nowhere near the
cause.

`GRACEFUL_SHUTDOWN_MS` defaults to 10s and produces zero 5xx on a rollout. At `0`, every deploy
produces a 5xx burst — a fault whose cause is a deploy that "looked fine".

## Known limits

- Faults are injected by hand, one at a time; there is no scheduler, and the benchmark harness
  is deliberately out of scope.
- Tracing degrades to metrics-and-logs until a backend and `OTEL_EXPORTER_OTLP_ENDPOINT` exist.
- Load is generated by a single-process client. It drives `storefront`, not the gateway, so
  traffic traverses the whole chain the way a browser would.
````

- [x] **Step 9: Full verification**

```bash
export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH
docker compose up -d postgres
TEST_DATABASE_URL=postgres://sample:sample@127.0.0.1:5432/sample_app npm test
npm run build
docker compose up -d --build
TARGET_URL=http://localhost:8080 LOADGEN_RPS=10 LOADGEN_DURATION_SECONDS=30 npm run loadgen
```

Expected: every test passes with none skipped, `tsc` is clean across all workspaces, the stack
comes up, and the loadgen summary reports zero errors.

- [x] **Step 10: Commit**

```bash
git add -A
git commit -m "docs: alert rule definitions, deployment contract and repo documentation"
```

---

## Done

The repo now builds four images, publishes one rule fragment, and deploys nothing. Handover is
`docs/DEPLOYMENT_CONTRACT.md`; the fault catalog is spec §10.
