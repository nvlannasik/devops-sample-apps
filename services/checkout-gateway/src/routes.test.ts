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
  // createApp, the same factory index.ts boots.
  const server = createApp({
    service: "checkout-gateway",
    config: loadCommonConfig({}),
    metrics,
    logger,
    stats,
    routes: createRoutes({
      client,
      logger,
      metrics,
      cache: createCache({ ttlSeconds: cacheTtlSeconds, maxEntries: 100 }),
      selfStats: () => ({ service: "checkout-gateway", version: "test", p99Ms: null, errorRate: 0, requests: 0, windowSeconds: 60 }),
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
    server.closeAllConnections();
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