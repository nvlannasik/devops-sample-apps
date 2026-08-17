import type { Pool } from "pg";
import type { OrderItem, QueueStats } from "@sample-app/contracts";
import type { Metrics } from "@sample-app/platform";

/** A claimed job joined with the order it settles. */
export interface SettlementJob {
  id: string;
  order_id: string;
  attempts: number;
  traceparent: string | null;
  created_at: string;
  amount_cents: number;
  items: OrderItem[];
}

export interface QueueRepo {
  claimBatch(limit: number): Promise<SettlementJob[]>;
  settle(job: SettlementJob): Promise<void>;
  retry(job: SettlementJob, backoffMs: number): Promise<void>;
  fail(job: SettlementJob, reason: string): Promise<void>;
  stats(): Promise<QueueStats>;
  ping(): Promise<void>;
}

export const RETRY_BACKOFF_BASE_MS = 5_000;

interface ClaimedRow {
  id: string;
  order_id: string;
  attempts: number;
  traceparent: string | null;
  created_at: string;
}

export function createQueueRepo(pool: Pool, deps: { metrics: Metrics; service: string }): QueueRepo {
  const timed = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    const end = deps.metrics.dbQueryDuration.startTimer({ service: deps.service, operation });
    try {
      return await fn();
    } finally {
      end();
    }
  };

  return {
    async claimBatch(limit) {
      return timed("claim_batch", async () => {
        const claimed = await pool.query<ClaimedRow>(
          `UPDATE settlement_jobs
              SET locked_at = now(), attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM settlement_jobs
               WHERE locked_at IS NULL AND available_at <= now()
               ORDER BY available_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )
          RETURNING id, order_id, attempts, traceparent, created_at`,
          [limit],
        );
        if (claimed.rowCount === 0) return [];

        const orders = await pool.query<{ id: string; amount_cents: string; items: OrderItem[] }>(
          "SELECT id, amount_cents, items FROM orders WHERE id = ANY($1::uuid[])",
          [claimed.rows.map((row) => row.order_id)],
        );
        const byId = new Map(orders.rows.map((row) => [row.id, row]));

        return claimed.rows.map((row) => ({
          ...row,
          amount_cents: Number(byId.get(row.order_id)?.amount_cents ?? 0),
          items: byId.get(row.order_id)?.items ?? [],
        }));
      });
    },

    async settle(job) {
      await timed("settle_order", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("UPDATE orders SET status = 'settled', updated_at = now() WHERE id = $1", [job.order_id]);
          await client.query("DELETE FROM settlement_jobs WHERE id = $1", [job.id]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      });
    },

    async retry(job, backoffMs) {
      await timed("retry_job", async () => {
        await pool.query(
          `UPDATE settlement_jobs
              SET locked_at = NULL, available_at = now() + ($2::int * interval '1 millisecond')
            WHERE id = $1`,
          [job.id, Math.max(0, Math.round(backoffMs))],
        );
      });
    },

    async fail(job, reason) {
      await timed("fail_order", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1", [job.order_id]);
          await client.query("DELETE FROM settlement_jobs WHERE id = $1", [job.id]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        void reason;
      });
    },

    async stats() {
      return timed("queue_stats", async () => {
        const { rows } = await pool.query<{ depth: string; oldest: string }>(
          `SELECT count(*)::text AS depth,
                  COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)::text AS oldest
             FROM settlement_jobs`,
        );
        return { depth: Number(rows[0]!.depth), oldestAgeSeconds: Number(rows[0]!.oldest) };
      });
    },

    async ping() {
      await timed("ping", async () => pool.query("SELECT 1"));
    },
  };
}