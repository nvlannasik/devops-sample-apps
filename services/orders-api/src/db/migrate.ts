import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { Logger } from "@sample-app/platform";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixed key: every pod takes the same advisory lock, so concurrent startups serialise
// instead of racing on DDL.
const LOCK_KEY = 4927313;

/**
 * db/migrations lives at the repo root and is copied to /app/db/migrations in the image.
 * Both layouts sit exactly four levels below this file — src/db and dist/db have the same
 * depth — so one relative path covers dev and production.
 */
export function migrationsDir(): string {
  return join(__dirname, "../../../../db/migrations");
}

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir())
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function pendingMigrations(files: string[], applied: Set<string>): string[] {
  return files
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !applied.has(f));
}

export async function appliedVersions(pool: Pool): Promise<Set<string>> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => r.version));
}

export async function runMigrations(pool: Pool, logger: Logger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const pending = pendingMigrations(migrationFiles(), new Set(rows.map((r) => r.version)));

    if (pending.length === 0) {
      logger.info("schema up to date");
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(join(migrationsDir(), file), "utf-8");
      logger.info("applying migration", { migration: file });
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger.info("migrations applied", { count: pending.length });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/** MIGRATION_REQUIRED=true: refuse to serve against a schema the code was not written for. */
export async function assertSchemaCurrent(pool: Pool, logger: Logger): Promise<void> {
  const missing = pendingMigrations(migrationFiles(), await appliedVersions(pool));
  if (missing.length > 0) {
    logger.error("schema is behind the code", { missing });
    throw new Error(`MIGRATION_REQUIRED=true but these migrations are not applied: ${missing.join(", ")}`);
  }
}
