import { test } from "node:test";
import assert from "node:assert/strict";
import { RollingStats } from "./rolling-stats.js";

test("an empty window reports no p99 and no requests", () => {
  const s = new RollingStats(60, () => 0);
  assert.deepEqual(s.snapshot(), { p99Ms: null, errorRate: 0, requests: 0, windowSeconds: 60 });
});

test("p99 is the 99th percentile of the samples in the window", () => {
  const s = new RollingStats(60, () => 0);
  for (let i = 1; i <= 100; i++) s.record(i, false);
  const snap = s.snapshot();
  assert.equal(snap.requests, 100);
  assert.equal(snap.p99Ms, 99);
});

test("errorRate is the share of samples flagged as errors", () => {
  const s = new RollingStats(60, () => 0);
  for (let i = 0; i < 8; i++) s.record(10, false);
  for (let i = 0; i < 2; i++) s.record(10, true);
  assert.equal(s.snapshot().errorRate, 0.2);
});

test("samples older than the window are dropped", () => {
  let now = 0;
  const s = new RollingStats(60, () => now);
  s.record(500, true);
  now = 61_000;
  s.record(10, false);
  const snap = s.snapshot();
  assert.equal(snap.requests, 1);
  assert.equal(snap.errorRate, 0);
  assert.equal(snap.p99Ms, 10);
});

test("the sample buffer is bounded so a traffic spike cannot grow it without limit", () => {
  const s = new RollingStats(60, () => 0);
  for (let i = 0; i < 20_000; i++) s.record(1, false);
  assert.ok(s.snapshot().requests <= 10_000);
});