import type { CartItem, OrderItem } from "./catalog.js";

export type OrderStatus = "placed" | "settled" | "failed";

/** The database row, as `orders-api` reads it. */
export interface OrderRow {
  id: string;
  customer_id: string;
  items: OrderItem[];
  amount_cents: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateOrderRequest {
  customerId: string;
  items: CartItem[];
}

/** ORDER_RESPONSE_VERSION=1 — the shape every consumer is written against. */
export interface OrderV1 {
  id: string;
  customer_id: string;
  items: OrderItem[];
  amount_cents: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

/**
 * ORDER_RESPONSE_VERSION=2 — a genuine breaking change: `amount_cents` becomes
 * `amountCents` and `customer_id` is nested. `checkout-gateway` really fails to parse it.
 */
export interface OrderV2 {
  id: string;
  customer: { id: string };
  items: OrderItem[];
  amountCents: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}
