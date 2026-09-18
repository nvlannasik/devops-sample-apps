import * as http from "node:http";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { RollingStats } from "./rolling-stats.js";
import { matchRoute, readBody as routerReadBody, UNMATCHED_ROUTE, type Route } from "./router.js";
import { sendJson } from "./http.js";
import type { CommonConfig } from "./config.js";
import { authorized } from "./bearer.js";
import { activeFaults, armFault, disarmFault, type FaultKnob } from "./faults.js";

/** One path on every service, so the control page needs no per-service map of routes. */
export const FAULT_CONTROL_PATH = "/control/fault";

export interface FaultControl {
  /** What this service knows how to break. Empty leaves the route unregistered. */
  knobs: FaultKnob[];
  /** `CommonConfig.faultControlToken`. Null leaves the route unregistered. */
  token: string | null;
  ttlSeconds: number;
}

export interface FaultKnobState extends FaultKnob {
  active: boolean;
  /** Epoch ms, or null when the knob is not armed. */
  expiresAt: number | null;
}

export interface FaultState {
  service: string;
  ttlSeconds: number;
  knobs: FaultKnobState[];
}

function faultState(service: string, faults: FaultControl): FaultState {
  const active = new Map(activeFaults().map((f) => [f.key, f]));
  return {
    service,
    ttlSeconds: faults.ttlSeconds,
    knobs: faults.knobs.map((knob) => ({
      ...knob,
      active: active.has(knob.key),
      expiresAt: active.get(knob.key)?.expiresAt ?? null,
    })),
  };
}

export interface AppDeps {
  service: string;
  config: CommonConfig;
  logger: Logger;
  metrics: Metrics;
  stats: RollingStats;
  routes: Route[];
  readiness: () => Promise<{ ok: boolean; detail?: string }>;
  liveness?: () => Promise<{ ok: boolean; detail?: string }>;
  /** Omit, or leave the token unset, and no service ever serves an arming switch. */
  faults?: FaultControl;
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
  // Registered only when both halves are present. A knob list with no token is a switch anyone
  // who finds the port can flip, so it is treated as "not configured" rather than "open".
  const faults = deps.faults?.token && deps.faults.knobs.length > 0 ? deps.faults : null;
  const PROBE_PATHS = new Set([
    "/healthz",
    "/readyz",
    "/metrics",
    "/stats",
    // Excluded for the same reason as the probes: the button that ENDS an incident must not
    // add to the error rate the operator is watching to decide whether it worked.
    ...(faults ? [FAULT_CONTROL_PATH] : []),
  ]);

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

    // /control/fault — arm or disarm a documented fault knob without a redeploy
    if (faults && path === FAULT_CONTROL_PATH) {
      if (!authorized(req.headers.authorization, faults.token)) {
        // Nothing about the expected value, not even its length — same as the gateway's /api.
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (method === "GET") {
        sendJson(res, 200, faultState(service, faults));
        return;
      }
      if (method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      routerReadBody(req)
        .then((body) => {
          let parsed: { key?: unknown; on?: unknown };
          try {
            parsed = JSON.parse(body || "{}") as { key?: unknown; on?: unknown };
          } catch {
            sendJson(res, 400, { error: "invalid_json" });
            return;
          }
          // Matched against the declared list, never applied as given: the request picks a knob,
          // it does not supply a value. That is what keeps this a switch and not a config API.
          const knob = faults.knobs.find((k) => k.key === parsed.key);
          if (!knob) {
            sendJson(res, 404, { error: "unknown_knob" });
            return;
          }
          if (parsed.on === true) {
            const fault = armFault(knob.key, knob.armed, faults.ttlSeconds);
            // WARN, not INFO: this is the only line that explains an incident with no deploy
            // behind it, and it is what an investigator greps when the ReplicaSet is unchanged.
            logger.warn("fault armed", {
              knob: knob.key,
              value: knob.armed,
              expires_at: new Date(fault.expiresAt).toISOString(),
            });
          } else if (parsed.on === false) {
            if (disarmFault(knob.key)) logger.warn("fault disarmed", { knob: knob.key });
          } else {
            sendJson(res, 400, { error: "on_must_be_boolean" });
            return;
          }
          sendJson(res, 200, faultState(service, faults));
        })
        .catch((err: unknown) => {
          logger.error("fault control failed", { err });
          if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
        });
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