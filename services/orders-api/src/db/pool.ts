import pg from "pg";
import type { OrdersApiConfig } from "../config.js";

// timestamptz (OID 1184) and timestamp (1114) arrive as ISO strings instead of Date objects,
// so a row can be JSON-serialised straight to the client and compared as text.
pg.types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
pg.types.setTypeParser(1114, (value: string) => new Date(value + "Z").toISOString());

// int8 (OID 20) defaults to a string, because bigint outruns Number. orders.amount_cents is
// bigint but is typed `number` in the contract, and checkout-gateway's assertOrderV1 rejects a
// string outright — a raw int8 turns every checkout into a 502. Cents stay far inside 2^53.
// NOTE: settlement_jobs.id is also int8 and stays a string by design (plan deviation 7); it is
// never selected through this pool, so this parser does not reach it.
pg.types.setTypeParser(20, (value: string) => Number(value));

export function createPool(config: Pick<OrdersApiConfig, "databaseUrl" | "dbPoolMax" | "dbStatementTimeoutMs">): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    // DB_POOL_MAX=1 genuinely serialises database access: real queueing, real p99,
    // and the value is visible in k8s_describe_pod.
    max: config.dbPoolMax,
    statement_timeout: config.dbStatementTimeoutMs,
    application_name: "orders-api",
  });
}