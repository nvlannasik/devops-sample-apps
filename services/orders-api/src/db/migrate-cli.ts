import pg from "pg";
import { createLogger, loadOrExit, optLogLevel, optStr, requireStr } from "@sample-app/platform";
import { runMigrations } from "./migrate.js";

const config = loadOrExit((env) => ({
  databaseUrl: requireStr(env, "DATABASE_URL"),
  logLevel: optLogLevel(env, "LOG_LEVEL", "info"),
  serviceVersion: optStr(env, "SERVICE_VERSION", "dev"),
}));

const logger = createLogger({ service: "orders-api-migrate", version: config.serviceVersion, level: config.logLevel });
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

try {
  await runMigrations(pool, logger);
  await pool.end();
  process.exit(0);
} catch (err) {
  logger.error("migration failed", { err });
  await pool.end().catch(() => {});
  process.exit(1);
}
