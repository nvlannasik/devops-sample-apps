import { test } from "node:test";
import assert from "node:assert/strict";
import { createCache } from "./cache.js";

test("a cold cache misses — it is never authoritative on its own", () => {
  const cache = createCache<string>({ ttlSeconds: 30, maxEntries: 10 });
  assert.equal(cache.get("order-1"), undefined);
  assert.equal(cache.size, 0);
});

test("a stored value comes back until its ttl elapses", () => {
  let now = 1_000;
  const cache = createCache<string>({ ttlSeconds: 30, maxEntries: 10, now: () => now });
  cache.set("order-1", "placed");
  now += 29_999;
  assert.equal(cache.get("order-1"), "placed");
  now += 2;
  assert.equal(cache.get("order-1"), undefined, "expired");
});

test("an expired entry is dropped, not merely hidden", () => {
  let now = 0;
  const cache = createCache<string>({ ttlSeconds: 1, maxEntries: 10, now: () => now });
  cache.set("order-1", "placed");
  now += 2_000;
  cache.get("order-1");
  assert.equal(cache.size, 0);
});

test("CACHE_TTL_SECONDS=0 disables storage entirely", () => {
  const cache = createCache<string>({ ttlSeconds: 0, maxEntries: 10 });
  cache.set("order-1", "placed");
  assert.equal(cache.get("order-1"), undefined);
  assert.equal(cache.size, 0);
});

test("the oldest entry is evicted once maxEntries is reached", () => {
  const cache = createCache<string>({ ttlSeconds: 30, maxEntries: 2 });
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  assert.equal(cache.size, 2);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), "3");
});

test("re-setting a key refreshes it without growing the cache", () => {
  let now = 0;
  const cache = createCache<string>({ ttlSeconds: 10, maxEntries: 5, now: () => now });
  cache.set("a", "1");
  now += 9_000;
  cache.set("a", "2");
  now += 9_000;
  assert.equal(cache.get("a"), "2");
  assert.equal(cache.size, 1);
});