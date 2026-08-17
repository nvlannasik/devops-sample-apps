import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, priceOf, computeItems, computeAmountCents, UnknownSkuError } from "./catalog.js";

test("catalog is non-empty and every sku is unique", () => {
  assert.ok(CATALOG.length >= 3);
  assert.equal(new Set(CATALOG.map((p) => p.sku)).size, CATALOG.length);
});

test("priceOf returns the unit price for a known sku", () => {
  assert.equal(priceOf(CATALOG[0]!.sku), CATALOG[0]!.unitCents);
});

test("priceOf returns null for an unknown sku", () => {
  assert.equal(priceOf("nope"), null);
});

test("computeItems attaches the catalog price to each cart line", () => {
  const items = computeItems([{ sku: "sku-widget", qty: 2 }]);
  assert.deepEqual(items, [{ sku: "sku-widget", qty: 2, unitCents: priceOf("sku-widget") }]);
});

test("computeItems rejects an unknown sku with UnknownSkuError", () => {
  assert.throws(() => computeItems([{ sku: "ghost", qty: 1 }]), UnknownSkuError);
});

test("computeItems rejects a non-positive quantity", () => {
  assert.throws(() => computeItems([{ sku: "sku-widget", qty: 0 }]), /qty/);
});

test("computeAmountCents multiplies and sums every line", () => {
  const amount = computeAmountCents([
    { sku: "a", qty: 2, unitCents: 150 },
    { sku: "b", qty: 3, unitCents: 1000 },
  ]);
  assert.equal(amount, 3300);
});
