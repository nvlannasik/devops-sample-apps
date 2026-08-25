import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChainStatus, OrderV1 } from "@sample-app/contracts";
import { catalogPage, clockOf, errorPage, esc, formatAge, formatCents, formatMs, orderPage, statusPage } from "./views.js";

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

// A meta refresh throws away keyboard focus and re-announces the whole page to a screen reader,
// every 2 seconds, with no way out. The stop control is a link because there is no JavaScript.
test("auto-refresh can be stopped, and the page says which state it is in", () => {
  const live = statusPage(chain, ASSET, true);
  assert.match(live, /<meta http-equiv="refresh"/);
  assert.match(live, /href="\?live=off"/);

  const paused = statusPage(chain, ASSET, false);
  assert.doesNotMatch(paused, /<meta http-equiv="refresh"/);
  assert.match(paused, /href="\?live=on"/);
  assert.match(paused, /Paused/);
});

test("the order page is stoppable too — it reloads while the worker settles the job", () => {
  assert.match(orderPage(order, ASSET, true), /<meta http-equiv="refresh" content="5">/);
  assert.doesNotMatch(orderPage(order, ASSET, false), /<meta http-equiv="refresh"/);
});

test("the quantity field carries a visible label, not an aria-label alone", () => {
  const html = catalogPage(ASSET);
  assert.match(html, /<label class="qty" for="qty-sku-widget">Qty/);
  assert.match(html, /<input id="qty-sku-widget" type="number" name="qty"/);
  assert.doesNotMatch(html, /aria-label/, "a visible label makes the aria-label redundant");
});

test("a hop with no stats renders its failure detail instead of blank cells", () => {
  const html = statusPage(chain, ASSET);
  assert.ok(html.includes("orders-api timed out after 2000ms"));
});

test("a null queue renders as unknown rather than zero — zero is a claim, unknown is the truth", () => {
  const html = statusPage({ ...chain, queue: null }, ASSET);
  assert.ok(html.includes("unknown"));
});

// RollingStats hands over a raw float. Rendered whole it is 3.548791000000165, and that column
// changes width on every 2-second refresh.
test("p99 is rendered at a fixed precision, not as a raw float", () => {
  assert.equal(formatMs(3.548791000000165), "3.5");
  assert.equal(formatMs(340), "340.0");

  const raw = { ...chain.hops[0]!, stats: { ...chain.hops[0]!.stats!, p99Ms: 3.548791000000165 } };
  const html = statusPage({ ...chain, hops: [raw] }, ASSET);
  assert.match(html, /<td class="num">3\.5<\/td>/);
  assert.doesNotMatch(html, /3\.548/);
});

test("formatAge stays readable as a job ages past the alert threshold", () => {
  assert.equal(formatAge(9), "9s");
  assert.equal(formatAge(59), "59s");
  assert.equal(formatAge(60), "1m 00s");
  assert.equal(formatAge(137), "2m 17s");
  assert.equal(formatAge(3600), "1h 00m");
  assert.equal(formatAge(-5), "0s", "a clock skew must not render a negative age");
});

test("clockOf keeps the time and drops the date, and passes anything else through", () => {
  assert.equal(clockOf("2026-08-16T09:14:22.417Z"), "09:14:22");
  assert.equal(clockOf("not a timestamp"), "not a timestamp");
});

// The page reloads every 5 seconds while the worker settles the job. If the strip grew a cell
// on the way, the table below it would jump under the reader mid-refresh.
test("the order state strip keeps every outcome present, whatever the status is", () => {
  const cells = (html: string): number => (html.match(/<dt>/g) ?? []).length;
  const placed = orderPage(order, ASSET);
  const settled = orderPage({ ...order, status: "settled" }, ASSET);
  const failed = orderPage({ ...order, status: "failed" }, ASSET);

  assert.equal(cells(placed), 3);
  assert.equal(cells(settled), 3);
  assert.equal(cells(failed), 3);
  assert.match(settled, /reached-ok/);
  assert.match(failed, /reached-fail/);
  assert.doesNotMatch(placed, /reached-ok|reached-fail/);
});

test("a hop's reason gets its own row, so a sentence never widens the number columns", () => {
  const html = statusPage(chain, ASSET);
  assert.match(html, /<tr><td class="reason detail" colspan="5">orders-api timed out after 2000ms<\/td><\/tr>/);
  // A healthy hop contributes no reason row at all.
  assert.equal((html.match(/class="reason/g) ?? []).length, 2, "one per hop that reported a detail");
});

test("the error page carries the trace id when there is one", () => {
  assert.ok(errorPage({ status: 504, message: "gateway timed out", traceId: "4bf92f35", assetHref: ASSET }).includes("4bf92f35"));
  assert.doesNotMatch(errorPage({ status: 500, message: "boom", traceId: null, assetHref: ASSET }), /trace/i);
});