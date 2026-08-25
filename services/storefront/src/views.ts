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

/**
 * RollingStats reports p99 as a raw float — 3.548791000000165 ms. Rendered whole, that column
 * changes width on every 2-second refresh and reads as noise. One decimal is the most precision
 * anyone acts on, and it is the same width every time.
 */
export function formatMs(ms: number): string {
  return ms.toFixed(1);
}

/** Seconds to a width that does not change as the value grows: 9s, 41s, 4m 12s, 1h 06m. */
export function formatAge(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, "0")}m`;
}

/** The clock half of an ISO timestamp. The date is the same all session; the time is the news. */
export function clockOf(iso: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match?.[1] ?? iso;
}

/** Inline so it costs no request and cannot 404 — and it is a graphic, not a text glyph. */
const MARK = `<svg class="mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 8.5h3l1.5-3 2 5 1-2h1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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
  <h1>${MARK}sample store</h1>
  <nav><a href="/">Catalog</a><a href="/status">Chain</a></nav>
</header>
${opts.body}
</main>
</body>
</html>`;
}

/**
 * A `meta refresh` reloads the whole document, which throws away keyboard focus and makes a
 * screen reader re-announce the page — every 2 seconds, with no way out. Auto-updating content
 * has to be stoppable, and with no client JavaScript the only lever is a link that asks the
 * server for the same page without the refresh.
 */
export function liveToggle(live: boolean): string {
  return live
    ? `<a class="live" href="?live=off"><span class="dot" aria-hidden="true"></span>Live · pause</a>`
    : `<a class="live paused" href="?live=on">Paused · resume</a>`;
}

export function catalogPage(assetHref: string): string {
  const items = CATALOG.map((product) => `  <article class="item">
    <h3>${esc(product.name)}</h3>
    <span class="sku">${esc(product.sku)}</span>
    <span class="price"><small>USD</small>${formatCents(product.unitCents)}</span>
    <form method="post" action="/checkout">
      <input type="hidden" name="sku" value="${esc(product.sku)}">
      <label class="qty" for="qty-${esc(product.sku)}">Qty<span class="sr-only"> of ${esc(product.name)}</span>
        <input id="qty-${esc(product.sku)}" type="number" name="qty" value="1" min="1" max="99"></label>
      <button type="submit">Buy ${esc(product.name)}</button>
    </form>
  </article>`).join("\n");

  return layout({
    title: "Catalog — Sample Store",
    assetHref,
    body: `<h2>Catalog</h2>
<div class="grid">
${items}
</div>`,
  });
}

/**
 * Both outcomes stay on the page whatever the status is. The order page refreshes every 5
 * seconds while the worker settles the job, and a strip that added a cell on the way would
 * shift the rest of the page under the reader at the exact moment they are watching it.
 */
function stateStrip(order: OrderV1): string {
  const settled = order.status === "settled";
  const failed = order.status === "failed";
  const cell = (label: string, value: string, cls: string): string =>
    `  <div class="${cls}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  return `<dl class="strip">
${cell("Placed", clockOf(order.created_at), "reached")}
${cell("Settled", settled ? clockOf(order.updated_at) : "—", settled ? "reached reached-ok" : "")}
${cell("Failed", failed ? clockOf(order.updated_at) : "—", failed ? "reached reached-fail" : "")}
</dl>`;
}

export function orderPage(order: OrderV1, assetHref: string, live = true): string {
  const lines = order.items.map((item) => `      <tr>
        <td><code>${esc(item.sku)}</code></td>
        <td class="num">${esc(item.qty)}</td>
        <td class="num">${formatCents(item.unitCents)}</td>
        <td class="num">${formatCents(item.qty * item.unitCents)}</td>
      </tr>`).join("\n");

  return layout({
    title: `Order ${order.id} — Sample Store`,
    assetHref,
    ...(live ? { refreshSeconds: 5 } : {}),
    body: `<h2>Order ${liveToggle(live)}</h2>
<div class="card pad">
  <p class="ident">
    <code>${esc(order.id)}</code>
    <span class="pill status-${esc(order.status)}">${esc(order.status)}</span>
  </p>
  ${stateStrip(order)}
  <table>
    <thead><tr><th>SKU</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Line</th></tr></thead>
    <tbody>
${lines}
    </tbody>
    <tfoot><tr><th colspan="3">Total</th><th class="num">${formatCents(order.amount_cents)}</th></tr></tfoot>
  </table>
</div>`,
  });
}

/**
 * A failing hop reports why on its own line rather than in a sixth column. A reason is a
 * sentence, and a sentence in a table cell is what re-flows every other column when it appears.
 */
function hopRows(hop: HopStatus): string {
  const stats = hop.stats;
  const row = `      <tr>
        <td class="hop">${esc(hop.name)}</td>
        <td class="state"><span class="pill hop-${esc(hop.state)}">${esc(hop.state)}</span></td>
        <td class="num">${stats === null || stats.p99Ms === null ? "—" : esc(formatMs(stats.p99Ms))}</td>
        <td class="num">${stats === null ? "—" : esc((stats.errorRate * 100).toFixed(1))}%</td>
        <td class="num">${stats === null ? "—" : esc(stats.requests)}</td>
      </tr>`;
  if (!hop.detail) return row;
  return `${row}
      <tr><td class="reason detail" colspan="5">${esc(hop.detail)}</td></tr>`;
}

export function statusPage(chain: ChainStatus, assetHref: string, live = true): string {
  const queue = chain.queue
    ? `<dl class="queue">
    <div><dt>Queue depth</dt><dd>${esc(chain.queue.depth)}</dd></div>
    <div><dt>Oldest job</dt><dd>${esc(formatAge(chain.queue.oldestAgeSeconds))} <span class="detail">(${esc(chain.queue.oldestAgeSeconds.toFixed(0))}s)</span></dd></div>
  </dl>`
    : `<dl class="queue"><div><dt>Queue</dt><dd class="muted">unknown</dd></div></dl>`;

  return layout({
    title: "Chain status — Sample Store",
    assetHref,
    ...(live ? { refreshSeconds: 2 } : {}),
    body: `<h2>Chain <span class="detail">checked ${esc(clockOf(chain.checkedAt))}</span> ${liveToggle(live)}</h2>
<div class="card">
  <table>
    <thead><tr><th>Hop</th><th class="state">State</th><th class="num">p99 ms</th><th class="num">Errors</th><th class="num">Req/60s</th></tr></thead>
    <tbody>
${chain.hops.map(hopRows).join("\n")}
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
    body: `<h2>Request failed</h2>
<div class="card pad">
  <div class="fault">
    <span class="code">${esc(opts.status)}</span>
    <div>
      <p>${esc(opts.message)}</p>
      ${opts.traceId ? `<p class="detail">Trace id — paste this into the tracing backend<code class="copyable">${esc(opts.traceId)}</code></p>` : ""}
      <p><a href="/">Back to the catalog</a></p>
    </div>
  </div>
</div>`,
  });
}
