import pg from "pg";
import type { WorkerConfig } from "../config.js";

// Same parsers as orders-api: timestamps arrive as ISO strings, never Date objects.
pg.types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
pg.types.setTypeParser(1114, (value: string) => new Date(value + "Z").toISOString());

export function createPool(config: Pick<WorkerConfig, "databaseUrl" | "dbPoolMax">): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    application_name: "settlement-worker",
  });
}