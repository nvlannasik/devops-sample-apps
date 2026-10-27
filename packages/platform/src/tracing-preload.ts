// `node --import ./packages/platform/dist/tracing-preload.js services/<svc>/dist/index.js`
//
// Starts the OpenTelemetry SDK before the service's own module graph is loaded. That ordering is
// the whole point: the services are ESM, so every `import` in an entry module is evaluated before
// a single line of its body — including the node:http and pg imports the instrumentations have to
// patch first. A tracing call inside index.ts is therefore always too late (see initTracing).
//
// Configuration is read from the environment, because no service config exists yet at this point:
// OTEL_SERVICE_NAME (set per image in each Dockerfile), OTEL_EXPORTER_OTLP_ENDPOINT, SERVICE_VERSION,
// DEPLOYMENT_ENV, LOG_LEVEL. The service reads the handle back with activeTracing() to flush it on
// shutdown. Only tracing.js and logger.js are imported here; neither loads node:http.
import { register } from "node:module";
import { createLogger } from "./logger.js";
import { initTracing } from "./tracing.js";
import type { LogLevel } from "./config.js";

// Running first is necessary but not sufficient. The instrumentations patch through require()
// hooks, and an ESM `import * as http from "node:http"` never calls require() — measured: with the
// SDK started first and no loader hook, the server span still never appeared. OTel's documented ESM
// answer is its import-in-the-middle hook, registered before any app module is resolved. It ships
// with @opentelemetry/instrumentation (already a dependency of every instrumentation here).
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

const service = process.env.OTEL_SERVICE_NAME || "unknown-service";
const version = process.env.SERVICE_VERSION || "dev";
const level = (["debug", "info", "warn", "error"].includes(process.env.LOG_LEVEL ?? "") ? process.env.LOG_LEVEL : "info") as LogLevel;

initTracing({
  service,
  version,
  deploymentEnv: process.env.DEPLOYMENT_ENV || "dev",
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
  logger: createLogger({ service, version, level }),
});
