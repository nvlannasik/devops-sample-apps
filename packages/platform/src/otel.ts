import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions";
import { context, trace, type Span } from "@opentelemetry/api";

export interface OtelOptions {
  serviceName: string;
  serviceVersion: string;
  deploymentEnv: string;
  otlpEndpoint: string | null;
  /** Called once with a warning when the endpoint is absent. */
  onNoEndpoint?: (msg: string) => void;
}

let _sdk: NodeSDK | null = null;

/**
 * Initialises the OTel SDK. Must be called before any other imports that
 * create spans (i.e. at the very top of the entrypoint, before service logic).
 *
 * When `otlpEndpoint` is null the SDK is still started (so instrumentation
 * patches apply) but no exporter is registered — spans are silently dropped.
 */
export function startOtel(opts: OtelOptions): void {
  if (_sdk) return; // idempotent — safe to call in tests

  if (!opts.otlpEndpoint) {
    opts.onNoEndpoint?.(
      "OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing disabled, spans will be dropped",
    );
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: opts.deploymentEnv,
  });

  _sdk = new NodeSDK({
    resource,
    ...(opts.otlpEndpoint
      ? {
          traceExporter: new OTLPTraceExporter({
            url: `${opts.otlpEndpoint}/v1/traces`,
          }),
        }
      : {}),
    instrumentations: [
      new HttpInstrumentation({
        // Suppress internal health-check noise from the span tree
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? "";
          return url === "/healthz" || url === "/readyz" || url === "/metrics";
        },
      }),
      new PgInstrumentation(),
    ],
  });

  _sdk.start();
}

export async function stopOtel(): Promise<void> {
  if (_sdk) {
    await _sdk.shutdown();
    _sdk = null;
  }
}

/** Returns trace_id / span_id from the active span, suitable for log fields. */
export function activeTraceContext(): { trace_id?: string; span_id?: string } {
  const span: Span | undefined = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!ctx.traceId || ctx.traceId === "00000000000000000000000000000000")
    return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}
