import pg from "pg";
import { createLogger, loadDbConfig, loadOrExit, optLogLevel, optStr, pgSsl } from "@sample-app/platform";
import { runMigrations } from "./migrate.js";

const config = loadOrExit((env) => ({
  db: loadDbConfig(env),
  logLevel: optLogLevel(env, "LOG_LEVEL", "info"),
  serviceVersion: optStr(env, "SERVICE_VERSION", "dev"),
}));

const logger = createLogger({ service: "orders-api-migrate", version: config.serviceVersion, level: config.logLevel });
const { host, port, user, password, database, sslMode } = config.db;
const pool = new pg.Pool({ host, port, user, password, database, ssl: pgSsl(sslMode), max: 2 });

try {
  await runMigrations(pool, logger);
  await pool.end();
  process.exit(0);
} catch (err) {
  logger.error("migration failed", { err });
  await pool.end().catch(() => {});
  process.exit(1);
}
