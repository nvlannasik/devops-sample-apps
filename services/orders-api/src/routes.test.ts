import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createApp, createLogger, createMetrics, loadCommonConfig, RollingStats } from "@sample-app/platform";
import type { OrderRow } from "@sample-app/contracts";
import { createRoutes } from "./routes.js";

function stubRepo(rows: OrderRow[] = []) {
  const store = new Map(rows.map((r) => [r.id, r]));
  return {
    store,
    createOrderWithJob: async (input: { id: string; customerId: string; items: { sku: string; qty: number; unitCents: number }[]; amountCents: number; traceparent: string | null }) => {
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
  const config = loadCommonConfig({});
  // createApp, the same factory index.ts boots — a test server with different built-ins
  // proves nothing about what actually ships.
  const server = createApp({
    service: "orders-api",
    config,
    metrics,
    logger,
    stats: new RollingStats(),
    routes: createRoutes({ repo, logger, orderResponseVersion: version }),
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