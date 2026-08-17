import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrderRow } from "@sample-app/contracts";
import { serializeOrder } from "./serialize.js";

const row: OrderRow = {
  id: "018f0000-0000-4000-8000-000000000001",
  customer_id: "web-user",
  items: [{ sku: "sku-widget", qty: 2, unitCents: 1299 }],
  amount_cents: 2598,
  status: "placed",
  created_at: "2026-08-16T09:14:22.417Z",
  updated_at: "2026-08-16T09:14:22.417Z",
};

test("v1 is the shape every consumer is written against", () => {
  assert.deepEqual(serializeOrder(row, 1), {
    id: row.id,
    customer_id: "web-user",
    items: row.items,
    amount_cents: 2598,
    status: "placed",
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

test("v2 renames amount_cents and nests customer — a genuine breaking change", () => {
  assert.deepEqual(serializeOrder(row, 2), {
    id: row.id,
    customer: { id: "web-user" },
    items: row.items,
    amountCents: 2598,
    status: "placed",
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

test("v2 does not keep the v1 field names, so a v1 consumer really fails", () => {
  const v2 = serializeOrder(row, 2) as Record<string, unknown>;
  assert.equal(v2.amount_cents, undefined);
  assert.equal(v2.customer_id, undefined);
});

test("items are untouched by the version switch", () => {
  const v1 = serializeOrder(row, 1) as Record<string, unknown>;
  const v2 = serializeOrder(row, 2) as Record<string, unknown>;
  assert.deepEqual(v1.items, v2.items);
});