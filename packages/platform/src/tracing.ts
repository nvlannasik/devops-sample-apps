import { createRequire } from "node:module";
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { Logger } from "./logger.js";

const require = createRequire(import.meta.url);

// Registered at import time so traceparent round-trips work even when no SDK is started
// (tracing disabled): the queue still carries the header, and the worker still logs it.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

export interface TraceIds {
  trace_id?: string;
  span_id?: string;
}

/** Feeds the logger, so one grep joins Loki, the tracing backend and the Slack thread. */
export function traceContext(): TraceIds {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export function parseTraceparent(
  traceparent: string | null | undefined,
): { traceId: string; spanId: string; sampled: boolean } | null {
  if (!traceparent) return null;
  const match = TRACEPARENT_RE.exec(traceparent.trim());
  if (!match) return null;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

/** The value written to settlement_jobs.traceparent at enqueue time. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/**
 * Restores the checkout request's trace as the parent of the worker's span. Without this the
 * async side is a blind spot: "settlement for order X failed" would not join its request.
 */
export async function withRemoteParent<T>(
  traceparent: string | null,
  spanName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = traceparent ? propagation.extract(context.active(), { traceparent }) : context.active();
  const tracer = trace.getTracer("sample-app");
  return context.with(parent, () =>
    tracer.startActiveSpan(spanName, async (span) => {
      try {
        const result = await fn();
        span.end();
        return result;
      } catch (err) {
        // tracing_search can only filter for errors if failed spans say so.
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        span.end();
        throw err;
      }
    }),
  );
}

export interface Tracing {
  shutdown(): Promise<void>;
}

export interface TracingOptions {
  service: string;
  version: string;
  deploymentEnv: string;
  endpoint: string | null;
  logger: Logger;
}

/**
 * Auto-instruments http and pg, so every hop and every SQL statement gets a span without
 * manual code. Probe endpoints are excluded — otherwise the trace backend fills with kubelet.
 */
export function initTracing(opts: TracingOptions): Tracing | null {
  if (!opts.endpoint) {
    opts.logger.warn("tracing disabled: OTEL_EXPORTER_OTLP_ENDPOINT is not set");
    return null;
  }

  const { NodeSDK } = require("@opentelemetry/sdk-node") as typeof import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http") as typeof import("@opentelemetry/exporter-trace-otlp-http");
  const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http") as typeof import("@opentelemetry/instrumentation-http");
  const { PgInstrumentation } = require("@opentelemetry/instrumentation-pg") as typeof import("@opentelemetry/instrumentation-pg");
  const { resourceFromAttributes } = require("@opentelemetry/resources") as typeof import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions") as typeof import("@opentelemetry/semantic-conventions");

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.service,
      [ATTR_SERVICE_VERSION]: opts.version,
      "deployment.environment": opts.deploymentEnv,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${opts.endpoint}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const path = (req.url ?? "").split("?")[0] ?? "";
          return ["/healthz", "/readyz", "/metrics", "/stats"].includes(path);
        },
      }),
      new PgInstrumentation(),
    ],
  });

  sdk.start();
  opts.logger.info("tracing enabled", { endpoint: opts.endpoint });
  return { shutdown: () => sdk.shutdown() };
}