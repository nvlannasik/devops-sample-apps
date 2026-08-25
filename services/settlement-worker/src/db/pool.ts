import pg from "pg";
import { pgSsl } from "@sample-app/platform";
import type { WorkerConfig } from "../config.js";

// Same parsers as orders-api: timestamps arrive as ISO strings, never Date objects.
pg.types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
pg.types.setTypeParser(1114, (value: string) => new Date(value + "Z").toISOString());

export function createPool(config: Pick<WorkerConfig, "db" | "dbPoolMax">): pg.Pool {
  const { host, port, user, password, database, sslMode } = config.db;
  return new pg.Pool({
    host,
    port,
    user,
    password,
    database,
    ssl: pgSsl(sslMode),
    max: config.dbPoolMax,
    application_name: "settlement-worker",
  });
}