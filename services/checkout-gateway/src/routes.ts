import type { OrderV1, ServiceStats } from "@sample-app/contracts";
import {
  DownstreamError,
  authorized,
  sendJson,
  statusForDownstream,
  traceContext,
  type HttpClient,
  type Logger,
  type Metrics,
  type Route,
  type RouteContext,
} from "@sample-app/platform";
import { buildChainStatus } from "./chain.js";
import type { TtlCache } from "./cache.js";

export interface RouteDeps {
  client: HttpClient;
  logger: Logger;
  metrics: Metrics;
  cache: TtlCache<OrderV1>;
  selfStats: () => ServiceStats;
  ordersApiUrl: string;
  workerUrl: string;
  /** Null leaves /api open, which is what a local stack with no token configured wants. */
  authToken: string | null;
}

const SERVICE = "checkout-gateway";

/**
 * The gateway is written against v1 and must genuinely fail on v2 — a tolerant reader here
 * would turn the ORDER_RESPONSE_VERSION fault into a silent no-op.
 */
export function assertOrderV1(payload: unknown): OrderV1 {
  const order = payload as Partial<OrderV1>;
  if (typeof order?.id !== "string" || typeof order.customer_id !== "string" || typeof order.amount_cents !== "number") {
    throw new DownstreamError(
      `orders-api returned a response this gateway cannot read: ${JSON.stringify(payload).slice(0, 200)}`,
      { peer: "orders-api", kind: "parse" },
    );
  }
  return order as OrderV1;
}

/**
 * Bearer-token gate for `/api`. Applied to every route in this file, including chain-status:
 * that response names each hop and its error rate, which is exactly the reconnaissance an
 * exposed endpoint should not hand out for free.
 *
 * The probes and `/metrics` are served by createApp and never reach this list, so the gate
 * cannot take the pod out of service or blind Prometheus. The consequence is that they are open
 * on this port — put only `/api` behind the Ingress.
 */
function authorize(deps: RouteDeps, handler: (ctx: RouteContext) => Promise<void>) {
  return async (ctx: RouteContext): Promise<void> => {
    if (!authorized(ctx.req.headers.authorization, deps.authToken)) {
      // No detail: which half of the credential was wrong is not the caller's business.
      ctx.res.setHeader("www-authenticate", "Bearer");
      sendJson(ctx.res, 401, { error: "unauthorized" });
      return;
    }
    await handler(ctx);
  };
}

function guard(deps: RouteDeps, handler: (ctx: RouteContext) => Promise<void>) {
  return async (ctx: RouteContext): Promise<void> => {
    try {
      await handler(ctx);
    } catch (err) {
      if (!(err instanceof DownstreamError)) throw err;
      // A 4xx belongs to the caller, not to the gateway: forwarding it keeps a bad cart out
      // of http_server_requests_total{status=~"5.."} and out of SampleAppHighErrorRate.
      const status = err.kind === "status" && err.status !== undefined && err.status < 500
        ? err.status
        : statusForDownstream(err);
      const error = err.kind === "timeout" ? "upstream_timeout" : err.kind === "parse" ? "upstream_unreadable" : "upstream_error";
      deps.logger.error("downstream call failed", { peer: err.peer, kind: err.kind, upstream_status: err.status, err });
      sendJson(ctx.res, status, { error, peer: err.peer, detail: err.message, trace_id: traceContext().trace_id ?? null });
    }
  };
}

export function createRoutes(deps: RouteDeps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/api/checkout",
      handler: authorize(deps, guard(deps, async ({ res, readBody }) => {
        const body = await readBody();
        const created = assertOrderV1(await deps.client.postJson("orders-api", `${deps.ordersApiUrl}/orders`, JSON.parse(body)));
        deps.logger.info("checkout forwarded", { order_id: created.id });
        sendJson(res, 201, created);
      })),
    },
    {
      method: "GET",
      pattern: "/api/orders/:id",
      handler: authorize(deps, guard(deps, async ({ res, params }) => {
        const id = params["id"]!;
        const cached = deps.cache.get(id);
        if (cached) {
          deps.metrics.cacheRequests.inc({ service: SERVICE, result: "hit" });
          sendJson(res, 200, cached);
          return;
        }
        deps.metrics.cacheRequests.inc({ service: SERVICE, result: "miss" });
        const order = assertOrderV1(await deps.client.getJson("orders-api", `${deps.ordersApiUrl}/orders/${encodeURIComponent(id)}`));
        deps.cache.set(id, order);
        sendJson(res, 200, order);
      })),
    },
    {
      method: "GET",
      pattern: "/api/chain-status",
      // Authorized like the rest — it names every hop and its error rate — but never wrapped in
      // guard(): a status page that 500s during an incident is worthless, which is the whole
      // reason this route swallows its own downstream failures instead.
      handler: authorize(deps, async ({ res }) => {
        sendJson(res, 200, await buildChainStatus({
          client: deps.client,
          selfStats: deps.selfStats,
          ordersApiUrl: deps.ordersApiUrl,
          workerUrl: deps.workerUrl,
        }));
      }),
    },
  ];
}