import type { ChainStatus, OrderV1, ServiceStats } from "@sample-app/contracts";
import {
  DownstreamError,
  sendHtml,
  sendText,
  statusForDownstream,
  traceContext,
  type HttpClient,
  type Logger,
  type Route,
  type RouteContext,
  type Semaphore,
} from "@sample-app/platform";
import { APP_CSS } from "./assets.js";
import { catalogPage, errorPage, orderPage, statusPage } from "./views.js";

export interface RouteDeps {
  client: HttpClient;
  logger: Logger;
  semaphore: Semaphore;
  selfStats: () => ServiceStats;
  gatewayUrl: string;
  assetVersion: string;
  assetCacheSeconds: number;
}

export function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

export function assetHref(version: string): string {
  return `/assets/${encodeURIComponent(version)}/app.css`;
}

/** Live is the default; `?live=off` is the reader asking the page to hold still. */
export function isLive(url: URL): boolean {
  return url.searchParams.get("live") !== "off";
}

class BadRequestError extends Error {}

function page(deps: RouteDeps, handler: (ctx: RouteContext) => Promise<void>) {
  return async (ctx: RouteContext): Promise<void> => {
    const release = await deps.semaphore.acquire();
    try {
      await handler(ctx);
    } catch (err) {
      const href = assetHref(deps.assetVersion);
      if (err instanceof BadRequestError) {
        sendHtml(ctx.res, 400, errorPage({ status: 400, message: err.message, traceId: null, assetHref: href }));
        return;
      }
      if (err instanceof DownstreamError) {
        const status = err.kind === "status" && err.status !== undefined && err.status < 500 ? err.status : statusForDownstream(err);
        deps.logger.error("gateway call failed", { peer: err.peer, kind: err.kind, upstream_status: err.status, err });
        sendHtml(ctx.res, status, errorPage({ status, message: err.message, traceId: traceContext().trace_id ?? null, assetHref: href }));
        return;
      }
      throw err;
    } finally {
      release();
    }
  };
}

export function createRoutes(deps: RouteDeps): Route[] {
  const href = () => assetHref(deps.assetVersion);

  return [
    {
      method: "GET",
      pattern: "/",
      handler: page(deps, async ({ res }) => sendHtml(res, 200, catalogPage(href()))),
    },
    {
      method: "POST",
      pattern: "/checkout",
      handler: page(deps, async ({ res, readBody }) => {
        const form = parseForm(await readBody());
        const qty = Number(form["qty"]);
        if (!form["sku"] || !Number.isInteger(qty) || qty < 1) {
          throw new BadRequestError(`"${form["qty"] ?? ""}" is not a valid quantity`);
        }
        const created = await deps.client.postJson<OrderV1>("checkout-gateway", `${deps.gatewayUrl}/api/checkout`, {
          customerId: "web-user",
          items: [{ sku: form["sku"], qty }],
        });
        res.writeHead(303, { location: `/orders/${encodeURIComponent(created.id)}` });
        res.end();
      }),
    },
    {
      method: "GET",
      pattern: "/orders/:id",
      handler: page(deps, async ({ res, params, url }) => {
        const order = await deps.client.getJson<OrderV1>(
          "checkout-gateway",
          `${deps.gatewayUrl}/api/orders/${encodeURIComponent(params["id"]!)}`,
        );
        sendHtml(res, 200, orderPage(order, href(), isLive(url)));
      }),
    },
    {
      method: "GET",
      pattern: "/status",
      handler: page(deps, async ({ res, url }) => {
        const self = { name: "storefront", state: "ok" as const, stats: deps.selfStats() };
        let chain: ChainStatus;
        try {
          chain = await deps.client.getJson<ChainStatus>("checkout-gateway", `${deps.gatewayUrl}/api/chain-status`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          chain = {
            hops: ["checkout-gateway", "orders-api", "settlement-worker"].map((name) => ({ name, state: "unreachable" as const, detail, stats: null })),
            queue: null,
            checkedAt: new Date().toISOString(),
          };
        }
        sendHtml(res, 200, statusPage({ ...chain, hops: [self, ...chain.hops] }, href(), isLive(url)));
      }),
    },
    {
      method: "GET",
      pattern: "/assets/:version/app.css",
      handler: async ({ res, params }) => {
        if (params["version"] !== deps.assetVersion) {
          sendText(res, 404, "not found");
          return;
        }
        sendText(res, 200, APP_CSS, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": `public, max-age=${deps.assetCacheSeconds}`,
        });
      },
    },
  ];
}