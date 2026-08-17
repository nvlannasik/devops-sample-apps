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