import * as http from "node:http";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { RollingStats } from "./rolling-stats.js";
import { matchRoute, readBody as routerReadBody, UNMATCHED_ROUTE, type Route } from "./router.js";
import { sendJson } from "./http.js";
import type { CommonConfig } from "./config.js";

export interface AppDeps {
  service: string;
  config: CommonConfig;
  logger: Logger;
  metrics: Metrics;
  stats: RollingStats;
  routes: Route[];
  readiness: () => Promise<{ ok: boolean; detail?: string }>;
  liveness?: () => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Creates the full application server: built-in /healthz, /readyz, /metrics, /stats,
 * app routes with metrics instrumentation, and proper error envelopes.
 *
 * Probe and introspection endpoints (/healthz, /readyz, /metrics, /stats) are excluded
 * from http_server_* metrics so kubelet probes don't pollute user-traffic dashboards.
 */
export function createApp(deps: AppDeps): http.Server {
  const { service, metrics, logger, stats } = deps;
  const PROBE_PATHS = new Set(["/healthz", "/readyz", "/metrics", "/stats"]);

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const fullUrl = req.url ?? "/";
    const path = fullUrl.split("?")[0] ?? "/";
    const start = performance.now();

    const finish = (status: number, routeTemplate: string): void => {
      if (PROBE_PATHS.has(path)) return; // excluded from metrics
      const duration = (performance.now() - start) / 1000;
      metrics.httpServerRequests
        .labels(service, method, routeTemplate, String(status))
        .inc();
      metrics.httpServerDuration
        .labels(service, method, routeTemplate)
        .observe(duration);
      stats.record(duration * 1000, status >= 400);
    };

    // /healthz — liveness probe (default: always ok unless liveness fn is supplied)
    if (path === "/healthz") {
      if (!deps.liveness) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      deps.liveness()
        .then((result) => {
          const status = result.ok ? 200 : 503;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: result.ok ? "ok" : "fail", ...(result.detail ? { detail: result.detail } : {}) }));
        })
        .catch(() => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "fail" }));
        });
      return;
    }

    // /readyz — readiness probe
    if (path === "/readyz") {
      deps.readiness()
        .then((result) => {
          const status = result.ok ? 200 : 503;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: result.ok ? "ok" : "fail", ...(result.detail ? { detail: result.detail } : {}) }));
        })
        .catch(() => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "fail" }));
        });
      return;
    }

    // /metrics — prometheus scrape endpoint
    if (path === "/metrics") {
      metrics.registry.metrics()
        .then((text) => {
          res.writeHead(200, { "content-type": metrics.registry.contentType });
          res.end(text);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
      return;
    }

    // /stats — rolling window for chain-status
    if (path === "/stats") {
      const snap = stats.snapshot();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service, version: deps.config.serviceVersion, ...snap }));
      return;
    }

    // App routes
    const matched = matchRoute(deps.routes, method, path);
    if (matched) {
      const baseUrl = `http://${req.headers.host ?? "localhost"}`;
      const url = new URL(fullUrl, baseUrl);
      const ctx = {
        req,
        res,
        params: matched.params,
        url,
        readBody: () => routerReadBody(req),
      };
      const handleError = (err: unknown): void => {
        finish(500, matched.route.pattern);
        logger.error("unhandled route error", { err, method, path });
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal_error" });
        }
      };
      let result: void | Promise<void>;
      try {
        result = matched.route.handler(ctx);
      } catch (err) {
        handleError(err);
        return;
      }
      Promise.resolve(result)
        .then(() => {
          finish(res.statusCode, matched.route.pattern);
        })
        .catch(handleError);
      return;
    }

    finish(404, UNMATCHED_ROUTE);
    sendJson(res, 404, { error: "not_found" });
  });

  return server;
}