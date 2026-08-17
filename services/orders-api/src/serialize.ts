import type { OrderRow, OrderV1, OrderV2 } from "@sample-app/contracts";

export function serializeOrder(row: OrderRow, version: 1): OrderV1;
export function serializeOrder(row: OrderRow, version: 2): OrderV2;
export function serializeOrder(row: OrderRow, version: 1 | 2): OrderV1 | OrderV2 {
  if (version === 1) {
    return {
      id: row.id,
      customer_id: row.customer_id,
      items: row.items,
      amount_cents: row.amount_cents,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } else {
    return {
      id: row.id,
      customer: { id: row.customer_id },
      items: row.items,
      amountCents: row.amount_cents,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}