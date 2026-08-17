import type { Server } from "node:http";
import type { Logger } from "./logger.js";

export interface ShutdownTask {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownOptions {
  logger: Logger;
  timeoutMs: number;
  server?: Server;
  tasks?: ShutdownTask[];
  exit?: (code: number) => void;
  signals?: NodeJS.Signals[];
}

/**
 * On SIGTERM: stop accepting connections, drain in flight up to timeoutMs, run the
 * teardown tasks, exit 0. With the default a rollout produces zero 5xx; with
 * GRACEFUL_SHUTDOWN_MS=0 every deploy produces a 5xx burst.
 */
export function installShutdown(opts: ShutdownOptions): () => Promise<void> {
  let started: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    opts.logger.info("shutdown started", { timeout_ms: opts.timeoutMs });
    if (opts.server) await closeServer(opts.server, opts.timeoutMs, opts.logger);
    for (const task of opts.tasks ?? []) {
      try {
        await task.run();
      } catch (err) {
        opts.logger.error(`shutdown task failed: ${task.name}`, { err });
      }
    }
    opts.logger.info("shutdown complete");
    (opts.exit ?? ((code: number) => process.exit(code)))(0);
  };

  const shutdown = (): Promise<void> => {
    started ??= run();
    return started;
  };

  for (const signal of opts.signals ?? (["SIGTERM", "SIGINT"] as NodeJS.Signals[])) {
    process.on(signal, () => void shutdown());
  }

  return shutdown;
}

function closeServer(server: Server, timeoutMs: number, logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      logger.warn("drain timeout reached, closing open connections", { timeout_ms: timeoutMs });
      server.closeAllConnections();
      finish();
    }, Math.max(0, timeoutMs));

    server.close(() => finish());
    // Keep-alive sockets hold the server open until their idle timeout; without this the
    // drain always runs the full timeout even when nothing is actually in flight.
    server.closeIdleConnections();
  });
}

// Backward compat alias
export { installShutdown as registerShutdown };
