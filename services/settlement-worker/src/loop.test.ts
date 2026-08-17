import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, createMetrics } from "@sample-app/platform";
import type { QueueStats } from "@sample-app/contracts";
import { runBatch, startLoop, type LoopDeps } from "./loop.js";
import type { SettlementJob } from "./db/queue.js";

const job = (over: Partial<SettlementJob> = {}): SettlementJob => ({
  id: "1",
  order_id: "018f0000-0000-4000-8000-000000000001",
  attempts: 1,
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  created_at: "2026-08-16T09:14:22.417Z",
  amount_cents: 2598,
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  ...over,
});

function harness(opts: {
  batches?: SettlementJob[][];
  settle?: (job: SettlementJob) => Promise<void>;
  stats?: QueueStats;
  maxAttempts?: number;
}) {
  const batches = [...(opts.batches ?? [])];
  const calls = { settled: [] as string[], retried: [] as { id: string; backoffMs: number }[], failed: [] as string[], claims: 0 };
  const metrics = createMetrics({ service: "settlement-worker", version: "test", commit: "test" });
  const deps: LoopDeps = {
    queue: {
      claimBatch: async () => { calls.claims++; return batches.shift() ?? []; },
      settle: async (j) => { calls.settled.push(j.id); await opts.settle?.(j); },
      retry: async (j, backoffMs) => { calls.retried.push({ id: j.id, backoffMs }); },
      fail: async (j) => { calls.failed.push(j.id); },
      stats: async () => opts.stats ?? { depth: 0, oldestAgeSeconds: 0 },
      ping: async () => {},
    },
    metrics,
    logger: createLogger({ service: "settlement-worker", version: "test", level: "error", write: () => {} }),
    batchSize: 50,
    pollIntervalMs: 1,
    maxAttempts: opts.maxAttempts ?? 3,
    verbosePayload: false,
  };
  return { deps, calls, metrics };
}

test("a batch settles every claimed job and counts each one", async () => {
  const { deps, calls, metrics } = harness({ batches: [[job({ id: "1" }), job({ id: "2" })]] });
  assert.equal(await runBatch(deps), 2);
  assert.deepEqual(calls.settled, ["1", "2"]);
  const text = await metrics.registry.metrics();
  assert.match(text, /settlement_jobs_total\{result="ok"\} 2/);
  assert.match(text, /settlement_batch_size_count 1/);
});

test("an empty batch settles nothing and observes no batch size", async () => {
  const { deps, metrics } = harness({ batches: [[]] });
  assert.equal(await runBatch(deps), 0);
  assert.doesNotMatch(await metrics.registry.metrics(), /settlement_batch_size_count [1-9]/);
});

test("a failing job below the attempt ceiling is retried with a growing backoff", async () => {
  const { deps, calls, metrics } = harness({
    batches: [[job({ id: "7", attempts: 2 })]],
    settle: async () => { throw new Error("deadlock detected"); },
  });
  await runBatch(deps);
  assert.deepEqual(calls.retried, [{ id: "7", backoffMs: 10_000 }]);
  assert.equal(calls.failed.length, 0);
  assert.match(await metrics.registry.metrics(), /settlement_jobs_total\{result="retried"\} 1/);
});

test("a job that has burned its attempts marks the order failed", async () => {
  const { deps, calls, metrics } = harness({
    batches: [[job({ id: "7", attempts: 3 })]],
    settle: async () => { throw new Error("deadlock detected"); },
    maxAttempts: 3,
  });
  await runBatch(deps);
  assert.deepEqual(calls.failed, ["7"]);
  assert.equal(calls.retried.length, 0);
  assert.match(await metrics.registry.metrics(), /settlement_jobs_total\{result="failed"\} 1/);
});

test("one poisonous job does not abort the rest of the batch", async () => {
  const { deps, calls } = harness({
    batches: [[job({ id: "1" }), job({ id: "2" }), job({ id: "3" })]],
    settle: async (j) => { if (j.id === "2") throw new Error("boom"); },
  });
  assert.equal(await runBatch(deps), 3);
  assert.deepEqual(calls.settled, ["1", "2", "3"]);
  assert.deepEqual(calls.retried.map((r) => r.id), ["2"]);
});

test("queue depth and oldest-job age are published as gauges every batch", async () => {
  const { deps, metrics } = harness({ batches: [[]], stats: { depth: 41, oldestAgeSeconds: 137 } });
  await runBatch(deps);
  const text = await metrics.registry.metrics();
  assert.match(text, /queue_depth\{queue="settlement"\} 41/);
  assert.match(text, /queue_oldest_job_age_seconds\{queue="settlement"\} 137/);
});

test("stop lets the in-flight batch finish and claims no new one", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { deps, calls } = harness({ batches: [[job({ id: "1" })], [job({ id: "2" })]], settle: async () => { await gate; } });
  const loop = startLoop(deps);
  await new Promise((r) => setTimeout(r, 5));
  const stopped = loop.stop();
  release();
  await stopped;
  assert.deepEqual(calls.settled, ["1"], "the claimed job was finished");
  assert.equal(calls.claims, 1, "no further claim after stop");
});

test("a claim failure is logged and the loop survives it", async () => {
  const { deps } = harness({});
  deps.queue.claimBatch = async () => { throw new Error("db down"); };
  assert.equal(await runBatch(deps), 0);
});