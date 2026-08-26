import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, createLogger, createMetrics, createSemaphore, loadCommonConfig, RollingStats, DownstreamError, type HttpClient } from "@sample-app/platform";
import { createRoutes, parseForm } from "./routes.js";
import { APP_CSS } from "./assets.js";

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
  // createApp, the same factory index.ts boots.
  const server = createApp({
    service: "storefront",
    config: loadCommonConfig({}),
    metrics,
    logger,
    stats: new RollingStats(),
    routes: createRoutes({
      client,
      logger,
      semaphore: createSemaphore(concurrency),
      selfStats: () => ({ service: "storefront", version: "test", p99Ms: null, errorRate: 0, requests: 0, windowSeconds: 60 }),
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
    server.closeAllConnections();
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
    // An error page, not a stack trace: the status and the reason, rendered as HTML.
    const html = await res.text();
    assert.match(html, /<html/);
    assert.match(html, /is not a valid quantity/);
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
  await withApp(stubClient({ get: () => order }), async (base) => {
    const res = await fetch(`${base}/orders/${order.id}`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("25.98"));
  });

  await withApp(stubClient({ get: () => new DownstreamError("not found", { peer: "checkout-gateway", kind: "status", status: 404 }) }), async (base) => {
    const res = await fetch(`${base}/orders/${order.id}`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /<html/);
    assert.match(html, /not found/);
    assert.doesNotMatch(html, /DownstreamError|at async/, "a stack trace must never reach the browser");
  });
});

test("?live=off is honoured by the server — the reader can stop the page reloading", async () => {
  await withApp(stubClient({ get: () => chain }), async (base) => {
    assert.match(await (await fetch(`${base}/status`)).text(), /<meta http-equiv="refresh"/);
    assert.doesNotMatch(await (await fetch(`${base}/status?live=off`)).text(), /<meta http-equiv="refresh"/);
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

test("GET /status still renders 200 when the gateway is down", async () => {
  const client = stubClient({ get: () => new DownstreamError("checkout-gateway unreachable", { peer: "checkout-gateway", kind: "network" }) });
  await withApp(client, async (base) => {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("hop-unreachable"));
    assert.ok(html.includes("unknown"));
  });
});

test("the stylesheet is served at its versioned path and cached", async () => {
  await withApp(stubClient({}), async (base) => {
    const res = await fetch(`${base}/assets/abc123/app.css`);
    assert.equal(res.status, 200);
    // Exact, not a match: Headers.get joins duplicates, so /text\/css/ passed for as long as
    // the response carried BOTH text/plain and text/css and browsers refused the stylesheet.
    assert.equal(res.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(await res.text(), APP_CSS, "the versioned path must serve the real stylesheet");
  });
});

test("a wrong asset version genuinely 404s", async () => {
  await withApp(stubClient({}), async (base) => {
    assert.equal((await fetch(`${base}/assets/stale/app.css`)).status, 404);
  });
});

test("SSR_CONCURRENCY=1 serialises rendering instead of dropping requests", async () => {
  let inFlight = 0;
  let peak = 0;
  const client = stubClient({
    get: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return order;
    },
  });
  await withApp(client, async (base) => {
    await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/orders/${order.id}`)));
    assert.equal(peak, 1);
  }, 1);
});