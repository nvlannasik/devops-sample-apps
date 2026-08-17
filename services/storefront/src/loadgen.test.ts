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

test("a browse iteration fetches the catalog or the status page", async () => {
  await withStorefront(async (base, paths) => {
    const stats = await runLoad({ targetUrl: base, iterations: 2, rps: 1000, checkoutRatio: 0, random: () => 0.9 });
    assert.equal(stats.requests, 2);
    assert.equal(stats.errors, 0);
    assert.ok(paths.includes("GET /status") || paths.includes("GET /"));
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