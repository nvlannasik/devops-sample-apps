import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMetrics } from "@sample-app/platform";
import { createQueueRepo, type QueueRepo } from "./db/queue.js";
import "./db/pool.js"; // register pg type parsers

const DB = process.env["TEST_DATABASE_URL"];
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let pool: pg.Pool;
let repo: QueueRepo;
const metrics = createMetrics({ service: "settlement-worker", version: "test", commit: "test" });

before(async () => {
  if (!DB) return;
  pool = new pg.Pool({ connectionString: DB });
  repo = createQueueRepo(pool, { metrics, service: "settlement-worker" });
});

after(async () => {
  if (pool) await pool.end();
});

beforeEach(async () => {
  if (!DB) return;
  await pool.query("DELETE FROM settlement_jobs");
  await pool.query("DELETE FROM orders");
});

async function seed(opts: { availableAt?: string; traceparent?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO orders (id, customer_id, items, amount_cents, status)
     VALUES ($1, 'web-user', '[{"sku":"sku-widget","qty":2,"unitCents":1299}]'::jsonb, 2598, 'placed')`,
    [id],
  );
  await pool.query(
    `INSERT INTO settlement_jobs (order_id, traceparent, available_at)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()))`,
    [id, opts.traceparent === undefined ? TRACEPARENT : opts.traceparent, opts.availableAt ?? null],
  );
  return id;
}

test("claimBatch locks up to the batch size and increments attempts", { skip: !DB }, async () => {
  await seed(); await seed(); await seed();
  const claimed = await repo.claimBatch(2);
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((j) => j.attempts), [1, 1]);
  const locked = await pool.query("SELECT count(*)::int AS n FROM settlement_jobs WHERE locked_at IS NOT NULL");
  assert.equal(locked.rows[0].n, 2);
});

test("a claimed job is invisible to the next claim — SKIP LOCKED, no double settlement", { skip: !DB }, async () => {
  await seed(); await seed();
  const first = await repo.claimBatch(10);
  const second = await repo.claimBatch(10);
  assert.equal(first.length, 2);
  assert.equal(second.length, 0);
});

test("a job scheduled in the future is not claimed yet", { skip: !DB }, async () => {
  await seed({ availableAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await repo.claimBatch(10)).length, 0);
});

test("the checkout traceparent survives the queue — the async side is not a blind spot", { skip: !DB }, async () => {
  await seed();
  const [job] = await repo.claimBatch(1);
  assert.equal(job!.traceparent, TRACEPARENT);
});

test("a job enqueued without a traceparent claims fine and reports null", { skip: !DB }, async () => {
  await seed({ traceparent: null });
  const [job] = await repo.claimBatch(1);
  assert.equal(job!.traceparent, null);
});

test("the claimed job carries its order payload", { skip: !DB }, async () => {
  const orderId = await seed();
  const [job] = await repo.claimBatch(1);
  assert.equal(job!.order_id, orderId);
  assert.equal(job!.amount_cents, 2598);
  assert.deepEqual(job!.items, [{ sku: "sku-widget", qty: 2, unitCents: 1299 }]);
});

test("settle marks the order settled and removes the job in one transaction", { skip: !DB }, async () => {
  const orderId = await seed();
  const [job] = await repo.claimBatch(1);
  await repo.settle(job!);
  const order = await pool.query("SELECT status, updated_at, created_at FROM orders WHERE id = $1", [orderId]);
  assert.equal(order.rows[0].status, "settled");
  assert.ok(order.rows[0].updated_at >= order.rows[0].created_at, "updated_at moved");
  assert.equal((await pool.query("SELECT id FROM settlement_jobs")).rowCount, 0);
});

test("retry unlocks the job and pushes it into the future", { skip: !DB }, async () => {
  await seed();
  const [job] = await repo.claimBatch(1);
  await repo.retry(job!, 5_000);
  const row = await pool.query("SELECT locked_at, available_at > now() AS deferred FROM settlement_jobs");
  assert.equal(row.rows[0].locked_at, null);
  assert.equal(row.rows[0].deferred, true);
  assert.equal((await repo.claimBatch(10)).length, 0, "not claimable during backoff");
});

test("fail marks the order failed and drops the job for good", { skip: !DB }, async () => {
  const orderId = await seed();
  const [job] = await repo.claimBatch(1);
  await repo.fail(job!, "settle failed 3 times");
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0].status, "failed");
  assert.equal((await pool.query("SELECT id FROM settlement_jobs")).rowCount, 0);
});

test("stats reports depth and the oldest job's age", { skip: !DB }, async () => {
  assert.deepEqual(await repo.stats(), { depth: 0, oldestAgeSeconds: 0 });
  await seed(); await seed();
  const stats = await repo.stats();
  assert.equal(stats.depth, 2);
  assert.ok(stats.oldestAgeSeconds >= 0);
});

test("queue queries are recorded under db_query_duration_seconds", { skip: !DB }, async () => {
  await repo.stats();
  assert.match(
    await metrics.registry.metrics(),
    /db_query_duration_seconds_count\{service="settlement-worker",operation="queue_stats"\}/,
  );
});