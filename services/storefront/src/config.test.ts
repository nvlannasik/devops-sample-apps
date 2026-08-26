import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = { GATEWAY_URL: "http://checkout-gateway:3000" };

test("the load generator link is off unless LOADGEN_UI_URL is set", () => {
  assert.equal(loadConfig({ GATEWAY_URL: "http://checkout-gateway:3000" }).loadgenUrl, null);
  assert.equal(
    loadConfig({ GATEWAY_URL: "http://checkout-gateway:3000", LOADGEN_UI_URL: "https://loadgen.example.com" }).loadgenUrl,
    "https://loadgen.example.com",
  );
});

test("every documented default is applied", () => {
  const c = loadConfig(base);
  assert.equal(c.gatewayTimeoutMs, 2000);
  assert.equal(c.ssrConcurrency, 32);
  assert.equal(c.assetCacheSeconds, 3600);
});

test("GATEWAY_URL is required", () => {
  assert.throws(() => loadConfig({}), /GATEWAY_URL/);
});

test("ASSET_VERSION follows SERVICE_VERSION unless it is overridden", () => {
  assert.equal(loadConfig({ ...base, SERVICE_VERSION: "abc123" }).assetVersion, "abc123");
  assert.equal(loadConfig({ ...base, SERVICE_VERSION: "abc123", ASSET_VERSION: "stale" }).assetVersion, "stale");
});

test("the fault knobs are readable from the environment", () => {
  const c = loadConfig({ ...base, GATEWAY_TIMEOUT_MS: "50", SSR_CONCURRENCY: "1", ASSET_CACHE_SECONDS: "0" });
  assert.equal(c.gatewayTimeoutMs, 50);
  assert.equal(c.ssrConcurrency, 1);
  assert.equal(c.assetCacheSeconds, 0);
});

test("SSR_CONCURRENCY must be at least 1 — zero would serve nothing at all", () => {
  assert.throws(() => loadConfig({ ...base, SSR_CONCURRENCY: "0" }), /SSR_CONCURRENCY/);
});