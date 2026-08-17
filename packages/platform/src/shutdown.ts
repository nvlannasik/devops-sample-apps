import * as http from "node:http";
import type { Logger } from "./logger.js";

export type ShutdownHook = () => Promise<void>;

/**
 * Registers SIGTERM / SIGINT handlers.
 *
 * On signal:
 *  1. Stop accepting new connections (server.close).
 *  2. Wait up to `gracefulShutdownMs` for in-flight requests to drain.
 *  3. Run all registered shutdown hooks (close DB pool, stop OTel, etc.).
 *  4. exit(0).
 *
 * With GRACEFUL_SHUTDOWN_MS=0 step 2 is skipped — connections are cut
 * immediately, producing 5xx on every rolling deploy (the intended fault).
 */
export function registerShutdown(opts: {
  server: http.Server;
  gracefulShutdownMs: number;
  hooks?: ShutdownHook[];
  logger: Logger;
}): void {
  const { server, gracefulShutdownMs, hooks = [], logger } = opts;

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown signal received", { signal, gracefulShutdownMs });

    // Stop accepting new connections
    server.close();

    if (gracefulShutdownMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, gracefulShutdownMs),
      );
    }

    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        logger.error("shutdown hook failed", { err });
      }
    }

    logger.info("shutdown complete");
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
