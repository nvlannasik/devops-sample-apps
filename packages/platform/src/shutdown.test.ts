import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { installShutdown } from "./shutdown.js";
import { createLogger } from "./logger.js";

const quietLogger = () => createLogger({ service: "t", version: "v", level: "error", write: () => {} });

type SlowServer = http.Server & { firstRequest: Promise<void> };

/**
 * `firstRequest` resolves when a request has actually reached the handler. Every test here needs
 * one in flight before it starts the shutdown, and it used to wait 30ms and hope — which held
 * until the suite grew enough to squeeze that window, and then failed as "in-flight request did
 * not complete" with nothing wrong in the code under test.
 */
function slowServer(delayMs: number): SlowServer {
  let arrived!: () => void;
  const firstRequest = new Promise<void>((resolve) => (arrived = resolve));
  const server = http.createServer((_req, res) => {
    arrived();
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("done");
    }, delayMs);
  });
  return Object.assign(server, { firstRequest });
}

test("an in-flight request completes and the process exits 0", async () => {
  const server = slowServer(150);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  let exitCode: number | null = null;
  const shutdown = installShutdown({
    server,
    timeoutMs: 5000,
    logger: quietLogger(),
    signals: [],
    exit: (code) => { exitCode = code; },
  });

  const inFlight = fetch(`http://127.0.0.1:${port}/`);
  await server.firstRequest;
  const shutdownDone = shutdown();

  assert.equal(await (await inFlight).text(), "done");
  await shutdownDone;
  assert.equal(exitCode, 0);
});

test("no new connection is accepted once shutdown has started", async () => {
  const server = slowServer(150);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const shutdown = installShutdown({ server, timeoutMs: 5000, logger: quietLogger(), signals: [], exit: () => {} });

  const inFlight = fetch(`http://127.0.0.1:${port}/`);
  await server.firstRequest;
  const shutdownDone = shutdown();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  await inFlight;
  await shutdownDone;
});

test("shutdown tasks run after the server is closed, in order", async () => {
  const server = slowServer(0);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ran: string[] = [];
  const shutdown = installShutdown({
    server,
    timeoutMs: 1000,
    logger: quietLogger(),
    signals: [],
    exit: () => {},
    tasks: [
      { name: "pool", run: async () => { ran.push("pool"); } },
      { name: "tracing", run: async () => { ran.push("tracing"); } },
    ],
  });
  await shutdown();
  assert.deepEqual(ran, ["pool", "tracing"]);
});

test("a failing shutdown task is logged and does not block the rest", async () => {
  const lines: string[] = [];
  const logger = createLogger({ service: "t", version: "v", level: "error", write: (l) => lines.push(l) });
  const ran: string[] = [];
  const shutdown = installShutdown({
    timeoutMs: 100,
    logger,
    signals: [],
    exit: () => {},
    tasks: [
      { name: "pool", run: async () => { throw new Error("pool close failed"); } },
      { name: "tracing", run: async () => { ran.push("tracing"); } },
    ],
  });
  await shutdown();
  assert.deepEqual(ran, ["tracing"]);
  assert.match(lines.join(""), /pool close failed/);
});

test("GRACEFUL_SHUTDOWN_MS=0 cuts in-flight connections instead of draining", async () => {
  const server = slowServer(1000);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const shutdown = installShutdown({ server, timeoutMs: 0, logger: quietLogger(), signals: [], exit: () => {} });

  const inFlight = fetch(`http://127.0.0.1:${port}/`).catch(() => "cut");
  await server.firstRequest;
  const startedAt = Date.now();
  await shutdown();
  assert.ok(Date.now() - startedAt < 500, "shutdown must not wait for the 1s handler");
  assert.equal(await inFlight, "cut");
});

test("shutdown is idempotent", async () => {
  let exits = 0;
  const shutdown = installShutdown({ timeoutMs: 10, logger: quietLogger(), signals: [], exit: () => { exits++; } });
  await Promise.all([shutdown(), shutdown()]);
  assert.equal(exits, 1);
});