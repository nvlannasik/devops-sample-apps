import type { Pool } from "pg";
import type { OrderItem, OrderRow } from "@sample-app/contracts";
import type { Metrics } from "@sample-app/platform";

export interface CreateOrderInput {
  id: string;
  customerId: string;
  items: OrderItem[];
  amountCents: number;
  /** The checkout request's trace, carried through the queue so the worker's span links back. */
  traceparent: string | null;
}

export interface OrdersRepo {
  createOrderWithJob(input: CreateOrderInput): Promise<OrderRow>;
  getOrder(id: string): Promise<OrderRow | null>;
  listOrders(limit: number): Promise<OrderRow[]>;
  ping(): Promise<void>;
}

export function createOrdersRepo(pool: Pool, deps: { metrics: Metrics; service: string }): OrdersRepo {
  const timed = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    const end = deps.metrics.dbQueryDuration.startTimer({ service: deps.service, operation });
    try {
      return await fn();
    } finally {
      end();
    }
  };

  return {
    async createOrderWithJob(input) {
      return timed("create_order", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const { rows } = await client.query<OrderRow>(
            `INSERT INTO orders (id, customer_id, items, amount_cents, status)
             VALUES ($1, $2, $3::jsonb, $4, 'placed')
             RETURNING id, customer_id, items, amount_cents, status, created_at, updated_at`,
            [input.id, input.customerId, JSON.stringify(input.items), input.amountCents],
          );
          await client.query(
            "INSERT INTO settlement_jobs (order_id, traceparent) VALUES ($1, $2)",
            [input.id, input.traceparent],
          );
          await client.query("COMMIT");
          return rows[0]!;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });
    },

    async getOrder(id) {
      return timed("get_order", async () => {
        const { rows } = await pool.query<OrderRow>(
          `SELECT id, customer_id, items, amount_cents, status, created_at, updated_at
             FROM orders WHERE id = $1`,
          [id],
        );
        return rows[0] ?? null;
      });
    },

    async listOrders(limit) {
      return timed("list_orders", async () => {
        const { rows } = await pool.query<OrderRow>(
          `SELECT id, customer_id, items, amount_cents, status, created_at, updated_at
             FROM orders ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
        return rows;
      });
    },

    async ping() {
      await timed("ping", async () => pool.query("SELECT 1"));
    },
  };
}