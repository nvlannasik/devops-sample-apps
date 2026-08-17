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
    const key = new URL(url).pathname + "@" + new URL(url).port;
    const value = responses[key];
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