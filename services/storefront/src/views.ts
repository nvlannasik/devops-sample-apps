import { CATALOG, type ChainStatus, type HopStatus, type OrderV1 } from "@sample-app/contracts";

/** Every text node passes through esc() BEFORE it touches markup. No exceptions. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export interface LayoutOptions {
  title: string;
  assetHref: string;
  body: string;
  refreshSeconds?: number;
}

export function layout(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">\n` : ""}<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="${esc(opts.assetHref)}">
</head>
<body>
<main>
<header>
  <h1>Sample Store</h1>
  <nav><a href="/">Catalog</a><a href="/status">Chain status</a></nav>
</header>
${opts.body}
</main>
</body>
</html>`;
}

export function catalogPage(assetHref: string): string {
  const rows = CATALOG.map((product) => `      <tr>
        <td>${esc(product.name)}</td>
        <td><code>${esc(product.sku)}</code></td>
        <td>${formatCents(product.unitCents)}</td>
        <td>
          <form method="post" action="/checkout">
            <input type="hidden" name="sku" value="${esc(product.sku)}">
            <input type="number" name="qty" value="1" min="1" max="99" aria-label="Quantity of ${esc(product.name)}">
            <button type="submit">Buy</button>
          </form>
        </td>
      </tr>`).join("\n");

  return layout({
    title: "Catalog — Sample Store",
    assetHref,
    body: `<h2>Catalog</h2>
<div class="card">
  <table>
    <thead><tr><th>Product</th><th>SKU</th><th>Price</th><th></th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`,
  });
}

export function orderPage(order: OrderV1, assetHref: string): string {
  const lines = order.items.map((item) => `      <tr>
        <td><code>${esc(item.sku)}</code></td>
        <td>${esc(item.qty)}</td>
        <td>${formatCents(item.unitCents)}</td>
        <td>${formatCents(item.qty * item.unitCents)}</td>
      </tr>`).join("\n");

  return layout({
    title: `Order ${order.id} — Sample Store`,
    assetHref,
    refreshSeconds: 5,
    body: `<h2>Order <code>${esc(order.id)}</code></h2>
<div class="card">
  <p>Status <span class="pill status-${esc(order.status)}">${esc(order.status)}</span>
     <span class="detail">placed ${esc(order.created_at)}</span></p>
  <table>
    <thead><tr><th>SKU</th><th>Qty</th><th>Unit</th><th>Line</th></tr></thead>
    <tbody>
${lines}
    </tbody>
    <tfoot><tr><th colspan="3">Total</th><th>${formatCents(order.amount_cents)}</th></tr></tfoot>
  </table>
</div>`,
  });
}

function hopRow(hop: HopStatus): string {
  const stats = hop.stats;
  return `      <tr>
        <td>${esc(hop.name)}</td>
        <td><span class="pill hop-${esc(hop.state)}">${esc(hop.state)}</span></td>
        <td>${stats?.p99Ms === null || stats === null ? "—" : esc(stats.p99Ms)}</td>
        <td>${stats === null ? "—" : esc((stats.errorRate * 100).toFixed(1))}%</td>
        <td>${stats === null ? "—" : esc(stats.requests)}</td>
        <td class="detail">${esc(hop.detail ?? "")}</td>
      </tr>`;
}

export function statusPage(chain: ChainStatus, assetHref: string): string {
  const queue = chain.queue
    ? `<p>Queue depth <strong>${esc(chain.queue.depth)}</strong>, oldest job <strong>${esc(chain.queue.oldestAgeSeconds.toFixed(0))}</strong>s</p>`
    : `<p class="muted">Queue depth unknown — the worker did not answer.</p>`;

  return layout({
    title: "Chain status — Sample Store",
    assetHref,
    refreshSeconds: 2,
    body: `<h2>Chain status <span class="detail">checked ${esc(chain.checkedAt)}</span></h2>
<div class="card">
  <table>
    <thead><tr><th>Hop</th><th>State</th><th>p99 (ms)</th><th>Errors</th><th>Requests/60s</th><th></th></tr></thead>
    <tbody>
${chain.hops.map(hopRow).join("\n")}
    </tbody>
  </table>
  ${queue}
</div>`,
  });
}

export interface ErrorPageOptions {
  status: number;
  message: string;
  traceId: string | null;
  assetHref: string;
}

export function errorPage(opts: ErrorPageOptions): string {
  return layout({
    title: `Error ${opts.status} — Sample Store`,
    assetHref: opts.assetHref,
    body: `<h2>Something went wrong</h2>
<div class="card error">
  <p><strong>${esc(opts.status)}</strong> ${esc(opts.message)}</p>
  ${opts.traceId ? `<p class="detail">trace id <code>${esc(opts.traceId)}</code></p>` : ""}
  <p><a href="/">Back to the catalog</a></p>
</div>`,
  });
}