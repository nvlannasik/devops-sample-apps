export interface CatalogProduct {
  sku: string;
  name: string;
  unitCents: number;
}

/** The product list is static and shared: storefront renders it, orders-api prices from it. */
export const CATALOG: readonly CatalogProduct[] = [
  { sku: "sku-widget", name: "Widget", unitCents: 1299 },
  { sku: "sku-gizmo", name: "Gizmo", unitCents: 4550 },
  { sku: "sku-doodad", name: "Doodad", unitCents: 799 },
  { sku: "sku-thingamajig", name: "Thingamajig", unitCents: 15999 },
];

export class UnknownSkuError extends Error {
  readonly sku: string;
  constructor(sku: string) {
    super(`unknown sku: ${sku}`);
    this.name = "UnknownSkuError";
    this.sku = sku;
  }
}

export function priceOf(sku: string): number | null {
  return CATALOG.find((p) => p.sku === sku)?.unitCents ?? null;
}

export interface CartItem {
  sku: string;
  qty: number;
}

export interface OrderItem {
  sku: string;
  qty: number;
  unitCents: number;
}

/** Prices a cart server-side. The client never sends a price. */
export function computeItems(cart: CartItem[]): OrderItem[] {
  return cart.map((line) => {
    if (!Number.isInteger(line.qty) || line.qty < 1) {
      throw new Error(`invalid qty for ${line.sku}: qty must be a positive integer`);
    }
    const unitCents = priceOf(line.sku);
    if (unitCents === null) throw new UnknownSkuError(line.sku);
    return { sku: line.sku, qty: line.qty, unitCents };
  });
}

export function computeAmountCents(items: OrderItem[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.unitCents, 0);
}
