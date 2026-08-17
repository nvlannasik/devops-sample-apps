import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTraceparent, formatTraceparent, currentTraceparent, withRemoteParent, initTracing } from "./tracing.js";
import { createLogger } from "./logger.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const SAMPLED = `00-${TRACE_ID}-${SPAN_ID}-01`;

test("parseTraceparent reads a valid W3C header", () => {
  assert.deepEqual(parseTraceparent(SAMPLED), { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
});

test("parseTraceparent reads the unsampled flag", () => {
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled, false);
});

test("parseTraceparent rejects anything malformed rather than guessing", () => {
  assert.equal(parseTraceparent(null), null);
  assert.equal(parseTraceparent(""), null);
  assert.equal(parseTraceparent("garbage"), null);
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`), null);
  assert.equal(parseTraceparent(`00-tooshort-${SPAN_ID}-01`), null);
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${SPAN_ID}-01`), null, "an all-zero trace id is invalid");
  assert.equal(parseTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`), null, "an all-zero span id is invalid");
});

test("formatTraceparent round-trips through parseTraceparent", () => {
  const header = formatTraceparent(TRACE_ID, SPAN_ID, true);
  assert.equal(header, SAMPLED);
  assert.deepEqual(parseTraceparent(header), { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
});

test("currentTraceparent is null when no span is active", () => {
  assert.equal(currentTraceparent(), null);
});

test("withRemoteParent runs the callback and returns its value", async () => {
  const result = await withRemoteParent(SAMPLED, "settle order", async () => "settled");
  assert.equal(result, "settled");
});

test("withRemoteParent still runs the callback when the stored traceparent is missing or junk", async () => {
  assert.equal(await withRemoteParent(null, "settle order", async () => "ok"), "ok");
  assert.equal(await withRemoteParent("garbage", "settle order", async () => "ok"), "ok");
});

test("withRemoteParent propagates a thrown error to the caller", async () => {
  await assert.rejects(withRemoteParent(SAMPLED, "settle order", async () => { throw new Error("settle failed"); }), /settle failed/);
});

test("initTracing returns null and warns once when no OTLP endpoint is configured", () => {
  const lines: string[] = [];
  const logger = createLogger({ service: "t", version: "v", level: "info", write: (l) => lines.push(l) });
  const tracing = initTracing({ service: "t", version: "v", deploymentEnv: "dev", endpoint: null, logger });
  assert.equal(tracing, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /tracing disabled/);
});