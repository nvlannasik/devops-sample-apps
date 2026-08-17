import { randomUUID } from "node:crypto";
import { UnknownSkuError, computeAmountCents, computeItems, type CartItem } from "@sample-app/contracts";
import { currentTraceparent, sendJson, type Logger, type Route } from "@sample-app/platform";
import type { OrdersRepo } from "./db/orders-repo.js";
import { serializeOrder } from "./serialize.js";

export interface RouteDeps {
  repo: OrdersRepo;
  logger: Logger;
  orderResponseVersion: 1 | 2;
}

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;

function parseCart(raw: string): { customerId: string; items: CartItem[] } {
  const parsed = JSON.parse(raw) as { customerId?: unknown; items?: unknown };
  if (typeof parsed.customerId !== "string" || parsed.customerId.trim() === "") {
    throw new Error("customerId is required");
  }
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  const items = parsed.items.map((line) => {
    const item = line as { sku?: unknown; qty?: unknown };
    if (typeof item.sku !== "string") throw new Error("each item needs a sku");
    if (typeof item.qty !== "number") throw new Error(`qty must be a number for ${item.sku}`);
    return { sku: item.sku, qty: item.qty };
  });
  return { customerId: parsed.customerId, items };
}

export function createRoutes(deps: RouteDeps): Route[] {
  return [
    {
      method: "POST",
      pattern: "/orders",
      handler: async ({ res, readBody }) => {
        let cart: { customerId: string; items: CartItem[] };
        let items;
        try {
          cart = parseCart(await readBody());
          items = computeItems(cart.items);
        } catch (err) {
          const detail = err instanceof UnknownSkuError ? err.message : err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: "invalid_request", detail });
          return;
        }

        const order = await deps.repo.createOrderWithJob({
          id: randomUUID(),
          customerId: cart.customerId,
          items,
          amountCents: computeAmountCents(items),
          traceparent: currentTraceparent(),
        });
        deps.logger.info("order created", { order_id: order.id, amount_cents: order.amount_cents });
        sendJson(res, 201, serializeOrder(order, deps.orderResponseVersion));
      },
    },
    {
      method: "GET",
      pattern: "/orders/:id",
      handler: async ({ res, params }) => {
        const order = await deps.repo.getOrder(params["id"]!);
        if (!order) {
          sendJson(res, 404, { error: "not_found", id: params["id"] });
          return;
        }
        sendJson(res, 200, serializeOrder(order, deps.orderResponseVersion));
      },
    },
    {
      method: "GET",
      pattern: "/orders",
      handler: async ({ res, url }) => {
        const raw = url.searchParams.get("limit");
        if (raw !== null && !/^\d+$/.test(raw)) {
          sendJson(res, 400, { error: "invalid_request", detail: "limit must be a positive integer" });
          return;
        }
        const limit = raw === null ? DEFAULT_LIST_LIMIT : Math.min(MAX_LIST_LIMIT, Math.max(1, Number(raw)));
        const orders = await deps.repo.listOrders(limit);
        sendJson(res, 200, { orders: orders.map((o) => serializeOrder(o, deps.orderResponseVersion)) });
      },
    },
  ];
}