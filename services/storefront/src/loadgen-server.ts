/**
 * Entry point for the load generator. It comes up idle and drives traffic only when the control
 * page says so, which is what makes it a Deployment rather than a Job: the load is a runtime
 * knob, not a redeploy.
 *
 * Bootstrap lives in its own file so loadgen.ts and loadgen-control.ts stay importable by tests
 * without starting a server — which is what the old `argv[1]` sniffing existed to work around.
 */
import {
  createApp,
  createLogger,
  createMetrics,
  initTracing,
  installShutdown,
  listen,
  loadCommonConfig,
  loadOrExit,
  redactConfig,
  RollingStats,
} from "@sample-app/platform";
import { createLoadRunner, loadLoadgenConfig, type RunSettings } from "./loadgen.js";
import { createControlRoutes } from "./loadgen-control.js";

const SERVICE = "loadgen";

const config = loadOrExit((env) => ({ ...loadCommonConfig(env), ...loadLoadgenConfig(env) }));
const logger = createLogger({ service: SERVICE, version: config.serviceVersion, level: config.logLevel });
const tracing = initTracing({
  service: SERVICE,
  version: config.serviceVersion,
  deploymentEnv: config.deploymentEnv,
  endpoint: config.otelEndpoint,
  logger,
});
const metrics = createMetrics({ service: SERVICE, version: config.serviceVersion, commit: config.serviceVersion });
logger.info("starting", { config: redactConfig({ ...config }) });

const runner = createLoadRunner(config.targetUrl);
const defaults: RunSettings = {
  rps: config.rps,
  concurrency: config.concurrency,
  checkoutRatio: config.checkoutRatio,
  durationSeconds: config.durationSeconds,
};

const server = createApp({
  service: SERVICE,
  config,
  metrics,
  logger,
  stats: new RollingStats(),
  routes: createControlRoutes({
    runner,
    targetUrl: config.targetUrl,
    defaults,
    password: config.uiPassword,
    cookieSecure: config.uiCookieSecure,
  }),
  // Ready as soon as it is listening. The target being unreachable is the incident under test,
  // not a reason for the generator to drop out of its own Service.
  readiness: async () => ({ ok: true }),
});

installShutdown({
  server,
  timeoutMs: config.gracefulShutdownMs,
  logger,
  tasks: [
    { name: "loadgen", run: () => runner.stop() },
    ...(tracing ? [{ name: "tracing", run: () => tracing.shutdown() }] : []),
  ],
});

if (!config.uiPassword) {
  logger.warn("control page disabled: LOADGEN_UI_PASSWORD is not set, serving 503 until it is");
}

await listen(server, config.port, logger);

if (config.autostart) {
  logger.info("autostart", { ...defaults });
  await runner.start(defaults);
}
