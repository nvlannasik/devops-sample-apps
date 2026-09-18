import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps, type FaultState } from "./http-server.js";
import { activeFaults, clearFaults, faultInt, type FaultKnob } from "./faults.js";
import { sendJson } from "./http.js";
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
      { method: "GET", pattern: "/orders/:id", handler: (ctx) => sendJson(ctx.res, 200, { id: ctx.params["id"] }) },
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
    server.closeAllConnections();
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

test("readyz is 503 with the detail when a dependency is down", async () => {
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
    const s = await (await fetch(`${base}/stats`)).json() as { service: string; requests: number; windowSeconds: number };
    assert.equal(s.service, "test-svc");
    assert.equal(s.requests, 1);
    assert.equal(s.windowSeconds, 60);
  });
});
// --- /control/fault -------------------------------------------------------------------------

const KNOBS: FaultKnob[] = [
  { key: "ORDER_RESPONSE_VERSION", label: "Order response v2", armed: "2", note: "breaks the gateway's parse" },
];

function faultHarness(token: string | null) {
  return harness({ faults: { knobs: KNOBS, token, ttlSeconds: 900 } });
}

const arm = (base: string, token: string | null, body: unknown): Promise<Response> =>
  fetch(`${base}/control/fault`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test("no fault control token means no fault route at all, not an open one", async () => {
  const { server } = faultHarness(null);
  await withServer(server, async (base) => {
    // 404 from the app-route fallthrough: nothing is listening on that path, so there is no
    // switch to find. An unset GATEWAY_AUTH_TOKEN leaves /api open; this must not.
    assert.equal((await fetch(`${base}/control/fault`)).status, 404);
    assert.equal((await arm(base, null, { key: "ORDER_RESPONSE_VERSION", on: true })).status, 404);
  });
});

test("the fault route refuses a missing or wrong token", async () => {
  const { server } = faultHarness("s3cret");
  await withServer(server, async (base) => {
    const anon = await fetch(`${base}/control/fault`);
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get("www-authenticate"), "Bearer");
    assert.equal((await arm(base, "wrong", { key: "ORDER_RESPONSE_VERSION", on: true })).status, 401);
    assert.deepEqual(activeFaults(), []);
  });
});

test("arming and disarming a declared knob round-trips through the endpoint", async () => {
  const { server } = faultHarness("s3cret");
  await withServer(server, async (base) => {
    const armed = await arm(base, "s3cret", { key: "ORDER_RESPONSE_VERSION", on: true });
    assert.equal(armed.status, 200);
    const state = (await armed.json()) as FaultState;
    assert.equal(state.knobs[0]?.active, true);
    assert.ok((state.knobs[0]?.expiresAt ?? 0) > Date.now());
    assert.equal(faultInt("ORDER_RESPONSE_VERSION", 1), 2);

    const off = await arm(base, "s3cret", { key: "ORDER_RESPONSE_VERSION", on: false });
    assert.equal(((await off.json()) as FaultState).knobs[0]?.active, false);
    assert.equal(faultInt("ORDER_RESPONSE_VERSION", 1), 1);
  });
  clearFaults();
});

test("the endpoint arms only what the service declared, and only to the declared value", async () => {
  const { server } = faultHarness("s3cret");
  await withServer(server, async (base) => {
    // An undeclared key is not a config the caller may set — it is a knob that does not exist.
    assert.equal((await arm(base, "s3cret", { key: "DB_POOL_MAX", on: true })).status, 404);
    assert.equal((await arm(base, "s3cret", { key: "ORDER_RESPONSE_VERSION", on: "yes" })).status, 400);
    // A value supplied by the caller is ignored: the request picks a knob, it does not set one.
    await arm(base, "s3cret", { key: "ORDER_RESPONSE_VERSION", on: true, armed: "9999" });
    assert.equal(faultInt("ORDER_RESPONSE_VERSION", 1), 2);
  });
  clearFaults();
});

test("the fault route stays out of http_server_* like the probes do", async () => {
  const { server, metrics } = faultHarness("s3cret");
  await withServer(server, async (base) => {
    await fetch(`${base}/control/fault`, { headers: { authorization: "Bearer s3cret" } });
    const text = await metrics.registry.metrics();
    // The button that ends an incident must not add to the error rate being watched to decide
    // whether it worked.
    assert.doesNotMatch(text, /http_server_requests_total\{[^}]*control/);
  });
});

test("fault_active carries the armed knob into the scrape, and drops it on disarm", async () => {
  const { server, metrics } = faultHarness("s3cret");
  await withServer(server, async (base) => {
    await arm(base, "s3cret", { key: "ORDER_RESPONSE_VERSION", on: true });
    assert.match(await metrics.registry.metrics(), /fault_active\{service="test-svc",knob="ORDER_RESPONSE_VERSION"\} 1/);
    await arm(base, "s3cret", { key: "ORDER_RESPONSE_VERSION", on: false });
    assert.doesNotMatch(await metrics.registry.metrics(), /fault_active\{/);
  });
  clearFaults();
});
