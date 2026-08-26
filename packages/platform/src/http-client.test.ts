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
test("defaultHeaders ride on every request, and a per-call header still wins", async () => {
  const seen: Array<Record<string, string>> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers as Record<string, string>);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const client = createHttpClient({
      service: "storefront",
      metrics: createMetrics({ service: "storefront", version: "test", commit: "test" }),
      timeoutMs: 1000,
      defaultHeaders: { authorization: "Bearer default" },
    });
    await client.getJson("peer", base);
    await client.postJson("peer", base, {});
    await client.getJson("peer", base, { headers: { authorization: "Bearer override" } });

    assert.equal(seen[0]?.authorization, "Bearer default", "GET dropped the default header");
    assert.equal(seen[1]?.authorization, "Bearer default", "POST dropped the default header");
    assert.equal(seen[2]?.authorization, "Bearer override");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
