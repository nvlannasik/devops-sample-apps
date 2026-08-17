import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "./http-server.js";
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