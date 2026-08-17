import * as http from "node:http";
import type { Registry } from "prom-client";
import { matchRoute, readBody as routerReadBody, UNMATCHED_ROUTE, type Route } from "./router.js";
import type { Metrics } from "./metrics.js";
import type { Logger } from "./logger.js";

type HttpRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface RouteEntry {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  template: string;
  handler: HttpRouteHandler;
}

/**
 * Returns the route template for a given path (e.g. "/orders/:id" for "/orders/abc").
 * Used for the Prometheus `route` label — raw paths must never reach label values.
 */
export type RouteMatcher = (method: string, path: string) => string | null;

export interface HttpServerOptions {
  port: number;
  service: string;
  metrics: Metrics;
  logger: Logger;
  /** Extra routes beyond the built-in /healthz, /readyz, /metrics. */
  routes?: RouteEntry[];
  healthz?: () => boolean;
  readyz?: () => Promise<{ ok: boolean; reason?: string }>;
}

function parsePath(pattern: string): { re: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const reStr = pattern.replace(/:([^/]+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { re: new RegExp(`^${reStr}$`), paramNames };
}

export function route(
  method: string,
  pattern: string,
  handler: HttpRouteHandler,
): RouteEntry {
  const { re, paramNames } = parsePath(pattern);
  return {
    method: method.toUpperCase(),
    pattern: re,
    paramNames,
    template: pattern,
    handler,
  };
}

export function buildRouter(entries: RouteEntry[]): {
  match: (
    method: string,
    path: string,
  ) => {
    handler: HttpRouteHandler;
    params: Record<string, string>;
    template: string;
  } | null;
} {
  return {
    match(method, path) {
      for (const entry of entries) {
        if (entry.method !== method.toUpperCase()) continue;
        const m = entry.pattern.exec(path);
        if (!m) continue;
        const params: Record<string, string> = {};
        entry.paramNames.forEach((name, i) => {
          params[name] = m[i + 1] ?? "";
        });
        return { handler: entry.handler, params, template: entry.template };
      }
      return null;
    },
  };
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

/**
 * Creates an HTTP server wired with:
 *  - built-in /healthz, /readyz, /metrics
 *  - per-request duration + counter instrumentation
 *  - error logging
 */
export function createHttpServer(opts: HttpServerOptions): http.Server {
  const { service, metrics, logger } = opts;
  const appRoutes = opts.routes ?? [];

  // Build the route lookup table for app routes only
  const router = buildRouter(appRoutes);

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const start = performance.now();

    const finish = (status: number, routeTemplate: string) => {
      const duration = (performance.now() - start) / 1000;
      metrics.httpServerRequests
        .labels(service, method, routeTemplate, String(status))
        .inc();
      metrics.httpServerDuration
        .labels(service, method, routeTemplate)
        .observe(duration);
    };

    // Built-in routes
    if (path === "/healthz") {
      const ok = opts.healthz ? opts.healthz() : true;
      finish(ok ? 200 : 503, "/healthz");
      return sendJson(res, ok ? 200 : 503, { status: ok ? "ok" : "fail" });
    }

    if (path === "/readyz") {
      const check = opts.readyz ? opts.readyz() : Promise.resolve({ ok: true });

      check
        .then((result) => {
          const { ok } = result;
          const reason = "reason" in result ? result.reason : undefined;
          finish(ok ? 200 : 503, "/readyz");
          sendJson(res, ok ? 200 : 503, {
            status: ok ? "ok" : "fail",
            ...(reason ? { reason } : {}),
          });
        })
        .catch((err: unknown) => {
          finish(503, "/readyz");
          logger.error("readyz check threw", { err });
          sendJson(res, 503, { status: "fail", reason: "check error" });
        });
      return;
    }

    if (path === "/metrics") {
      opts.metrics.registry
        .metrics()
        .then((text) => {
          finish(200, "/metrics");
          res.writeHead(200, {
            "Content-Type": opts.metrics.registry.contentType,
          });
          res.end(text);
        })
        .catch((err: unknown) => {
          finish(500, "/metrics");
          logger.error("metrics serialisation failed", { err });
          res.writeHead(500);
          res.end();
        });
      return;
    }

    // App routes
    const matched = router.match(method, path);
    if (matched) {
      Promise.resolve(matched.handler(req, res, matched.params))
        .then(() => {
          finish(res.statusCode, matched.template);
        })
        .catch((err: unknown) => {
          finish(500, matched.template);
          logger.error("unhandled route error", { err, method, path });
          if (!res.headersSent) {
            sendJson(res, 500, { error: "internal server error" });
          }
        });
      return;
    }

    finish(404, "unknown");
    sendJson(res, 404, { error: "not found" });
  });

  return server;
}

export interface AppServerOptions {
  port: number;
  service: string;
  metrics: Metrics;
  logger: Logger;
  routes?: Route[];
  healthz?: () => boolean;
  readyz?: () => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Creates an HTTP server that uses the router.ts Route type (with RouteContext).
 * Routes defined here use ctx.params, ctx.url, ctx.readBody(), etc.
 */
export function createAppServer(opts: AppServerOptions): http.Server {
  const { service, metrics, logger } = opts;
  const appRoutes = opts.routes ?? [];

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const fullUrl = req.url ?? "/";
    const path = fullUrl.split("?")[0] ?? "/";
    const start = performance.now();

    const finish = (status: number, routeTemplate: string) => {
      const duration = (performance.now() - start) / 1000;
      metrics.httpServerRequests
        .labels(service, method, routeTemplate, String(status))
        .inc();
      metrics.httpServerDuration
        .labels(service, method, routeTemplate)
        .observe(duration);
    };

    // Built-in routes
    if (path === "/healthz") {
      const ok = opts.healthz ? opts.healthz() : true;
      finish(ok ? 200 : 503, "/healthz");
      return sendJson(res, ok ? 200 : 503, { status: ok ? "ok" : "fail" });
    }

    if (path === "/readyz") {
      const check = opts.readyz ? opts.readyz() : Promise.resolve({ ok: true });
      check
        .then((result) => {
          const { ok } = result;
          const reason = "reason" in result ? result.reason : undefined;
          finish(ok ? 200 : 503, "/readyz");
          sendJson(res, ok ? 200 : 503, { status: ok ? "ok" : "fail", ...(reason ? { reason } : {}) });
        })
        .catch((err: unknown) => {
          finish(503, "/readyz");
          logger.error("readyz check threw", { err });
          sendJson(res, 503, { status: "fail", reason: "check error" });
        });
      return;
    }

    if (path === "/metrics") {
      opts.metrics.registry
        .metrics()
        .then((text) => {
          finish(200, "/metrics");
          res.writeHead(200, { "Content-Type": opts.metrics.registry.contentType });
          res.end(text);
        })
        .catch((err: unknown) => {
          finish(500, "/metrics");
          logger.error("metrics serialisation failed", { err });
          res.writeHead(500);
          res.end();
        });
      return;
    }

    // App routes using RouteContext
    const matched = matchRoute(appRoutes, method, path);
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
      Promise.resolve(matched.route.handler(ctx))
        .then(() => {
          finish(res.statusCode, matched.route.pattern);
        })
        .catch((err: unknown) => {
          finish(500, matched.route.pattern);
          logger.error("unhandled route error", { err, method, path });
          if (!res.headersSent) {
            sendJson(res, 500, { error: "internal server error" });
          }
        });
      return;
    }

    finish(404, UNMATCHED_ROUTE);
    sendJson(res, 404, { error: "not found" });
  });

  return server;
}

export function listen(
  server: http.Server,
  port: number,
  logger: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      logger.info("listening", { port });
      resolve();
    });
  });
}
