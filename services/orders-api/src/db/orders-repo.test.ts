import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createLogger, createMetrics } from "@sample-app/platform";
import { runMigrations } from "./migrate.js";
import { createOrdersRepo, type OrdersRepo } from "./orders-repo.js";
// Import pool.ts to register pg type parsers (timestamptz → ISO string)
import "./pool.js";

const DB = process.env["TEST_DATABASE_URL"];
const quiet = createLogger({ service: "orders-api", version: "test", level: "error", write: () => {} });

let pool: pg.Pool;
let repo: OrdersRepo;
let metrics = createMetrics({ service: "orders-api", version: "test", commit: "test" });

before(async () => {
  if (!DB) return;
  pool = new pg.Pool({ connectionString: DB });
  await pool.query("DROP TABLE IF EXISTS settlement_jobs, orders, schema_migrations CASCADE");
  await runMigrations(pool, quiet);
  repo = createOrdersRepo(pool, { metrics, service: "orders-api" });
});

after(async () => {
  if (pool) await pool.end();
});

const newOrder = () => ({
  id: randomUUID(),
  customerId: "web-user",
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  amountCents: 2598,
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});

test("createOrderWithJob writes the order and its settlement job in one transaction", { skip: !DB }, async () => {
  const input = newOrder();
  const row = await repo.createOrderWithJob(input);
  assert.equal(row.id, input.id);
  assert.equal(row.status, "placed");
  assert.equal(Number(row.amount_cents), 2598);
  assert.deepEqual(row.items, input.items);

  const jobs = await pool.query("SELECT order_id, attempts, traceparent, locked_at FROM settlement_jobs WHERE order_id = $1", [input.id]);
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].attempts, 0);
  assert.equal(jobs.rows[0].locked_at, null);
  assert.equal(jobs.rows[0].traceparent, input.traceparent);
});

test("a failed insert leaves neither an order nor a job behind", { skip: !DB }, async () => {
  const input = newOrder();
  await repo.createOrderWithJob(input);
  await assert.rejects(repo.createOrderWithJob(input), /duplicate key/);

  const orders = await pool.query("SELECT id FROM orders WHERE id = $1", [input.id]);
  const jobs = await pool.query("SELECT id FROM settlement_jobs WHERE order_id = $1", [input.id]);
  assert.equal(orders.rowCount, 1, "the original order survives");
  assert.equal(jobs.rowCount, 1, "the retry added no second job");
});

test("getOrder returns the row, and null for an id that does not exist", { skip: !DB }, async () => {
  const input = newOrder();
  await repo.createOrderWithJob(input);
  assert.equal((await repo.getOrder(input.id))?.id, input.id);
  assert.equal(await repo.getOrder(randomUUID()), null);
});

test("timestamps are serialised as ISO strings, not Date objects", { skip: !DB }, async () => {
  const row = await repo.createOrderWithJob(newOrder());
  assert.equal(typeof row.created_at, "string");
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("listOrders returns the newest first and honours the limit", { skip: !DB }, async () => {
  for (let i = 0; i < 3; i++) await repo.createOrderWithJob(newOrder());
  const rows = await repo.listOrders(2);
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.created_at >= rows[1]!.created_at);
});

test("every query records db_query_duration_seconds under a logical operation label", { skip: !DB }, async () => {
  await repo.createOrderWithJob(newOrder());
  const text = await metrics.registry.metrics();
  assert.match(text, /db_query_duration_seconds_count\{service="orders-api",operation="create_order"\}/);
});

test("ping resolves against a healthy database", { skip: !DB }, async () => {
  await repo.ping();
});