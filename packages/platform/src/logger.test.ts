import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, serializeError } from "./logger.js";

function capture(level: "debug" | "info" | "warn" | "error" = "info", extra = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: "orders-api",
    version: "a1b2c3d",
    level,
    write: (l) => lines.push(l),
    now: () => new Date("2026-08-16T09:14:22.417Z"),
    ...extra,
  });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

test("emits one newline-terminated JSON object with the standard fields", () => {
  const { logger, lines, parsed } = capture();
  logger.info("order created", { order_id: "018f" });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith("\n"));
  assert.deepEqual(parsed()[0], {
    ts: "2026-08-16T09:14:22.417Z",
    level: "info",
    service: "orders-api",
    version: "a1b2c3d",
    msg: "order created",
    order_id: "018f",
  });
});

test("drops messages below the configured level", () => {
  const { logger, lines } = capture("warn");
  logger.debug("noise");
  logger.info("noise");
  logger.warn("kept");
  logger.error("kept");
  assert.equal(lines.length, 2);
});

test("serializes an Error under err with type, msg and stack", () => {
  const { logger, parsed } = capture();
  logger.error("settlement enqueue failed", { err: new TypeError("boom"), order_id: "018f" });
  const line = parsed()[0];
  assert.equal(line.err.type, "TypeError");
  assert.equal(line.err.msg, "boom");
  assert.match(line.err.stack, /boom/);
  assert.equal(line.order_id, "018f");
});

test("merges the trace context so trace_id joins Loki, traces and the Slack thread", () => {
  const { logger, parsed } = capture("info", {
    traceContext: () => ({ trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7" }),
  });
  logger.info("hello");
  assert.equal(parsed()[0].trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(parsed()[0].span_id, "00f067aa0ba902b7");
});

test("serializeError handles a non-Error throw", () => {
  assert.deepEqual(serializeError("plain string"), { type: "string", msg: "plain string" });
});
