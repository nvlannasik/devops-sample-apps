import pg from "pg";
import type { OrdersApiConfig } from "../config.js";

// timestamptz (OID 1184) and timestamp (1114) arrive as ISO strings instead of Date objects,
// so a row can be JSON-serialised straight to the client and compared as text.
pg.types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
pg.types.setTypeParser(1114, (value: string) => new Date(value + "Z").toISOString());

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