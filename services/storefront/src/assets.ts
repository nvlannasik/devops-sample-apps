/**
 * Served from /assets/<ASSET_VERSION>/app.css, never inlined: an inline <style> cannot 404,
 * and the ASSET_VERSION fault needs a genuine mechanism (every metric green, product broken).
 *
 * The design rule these pages are built to: NOTHING MOVES WHEN THE DATA DOES. The status page
 * reloads every 2 seconds and the order page every 5, so a reload has to read as digits
 * changing in place, not as a page redrawing. That is why every number is tabular, every state
 * cell has a reserved width, and no column is sized by its content.
 */
export const APP_CSS = `:root {
  /* Bench instrument under glass: cool slate, not the near-black every dashboard ships with. */
  --ink: #131a1f;
  --panel: #1b2429;
  --raised: #212c32;
  --line: #2c3940;
  --text: #e3ecef;
  --muted: #8ba0a8;
  --signal: #7fd4e8;
  --ok: #56c596;
  --warn: #e0a35a;
  --fail: #e8695f;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--ink);
  color: var(--text);
  font: 15px/1.55 var(--sans);
  /* Every figure on every page is read while it is changing. */
  font-variant-numeric: tabular-nums;
}
main { max-width: 960px; margin: 0 auto; padding: 28px 20px 72px; }

/* ---- chrome ------------------------------------------------------------ */
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 20px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 14px;
}
header h1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font: 600 15px/1 var(--mono);
  letter-spacing: 0.02em;
  text-transform: lowercase;
}
header h1 .mark { color: var(--signal); flex: none; }
header nav { display: flex; gap: 4px; font: 12px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; }
/* 44px tall: a nav link is the smallest thing anyone taps on this site. */
header nav a {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 10px;
  color: var(--muted);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: color 160ms ease, border-color 160ms ease;
}
header nav a:hover { color: var(--text); border-bottom-color: var(--signal); }
/* The one link that leaves this app. It reads as an action because it is one — behind it is a
   button that puts real load on the cluster. */
header nav a.nav-cta {
  margin-left: 6px;
  padding: 0 12px;
  color: var(--signal);
  border: 1px solid var(--line);
  border-bottom-color: var(--line);
  border-radius: 8px;
}
header nav a.nav-cta:hover { color: var(--ink); background: var(--signal); border-color: var(--signal); }

h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 32px 0 14px;
  font: 500 12px/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}

a { color: var(--signal); }
:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; border-radius: 4px; }

/* Visible to a screen reader, absent from the layout. */
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* The stop control for the page's own auto-refresh. */
.live {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  margin-left: auto;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font: 500 11px/1 var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-decoration: none;
  transition: color 160ms ease, border-color 160ms ease;
}
.live:hover { color: var(--text); border-color: var(--signal); }
.live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.live.paused { color: var(--warn); border-color: rgba(224,163,90,0.4); }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.pad { padding: 18px 20px; }
.muted { color: var(--muted); }
.detail { color: var(--muted); font: 12px/1.5 var(--mono); }
code { font-family: var(--mono); font-size: 13px; }

/* ---- catalog ----------------------------------------------------------- */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(216px, 1fr)); gap: 14px; }
.item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 18px 18px 16px;
}
.item h3 { margin: 0; font: 500 17px/1.3 var(--sans); letter-spacing: -0.01em; }
.item .sku { font: 12px/1.6 var(--mono); color: var(--muted); }
.item .price { margin: 12px 0 16px; font: 600 26px/1 var(--mono); letter-spacing: -0.02em; }
.item .price small { font: 500 12px/1 var(--mono); color: var(--muted); letter-spacing: 0.06em; margin-right: 4px; vertical-align: 3px; }
.item form { display: flex; gap: 10px; align-items: flex-end; margin-top: auto; }

/* Visible label, not a placeholder and not an aria-label alone: the field is a bare number box
   and "1" tells the reader nothing about what it counts. */
label.qty {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: none;
  color: var(--muted);
  font: 500 10px/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
input[type="number"] {
  width: 68px;
  min-height: 44px;
  background: var(--ink);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font: 15px/1 var(--mono);
  transition: border-color 160ms ease;
}
input[type="number"]:hover { border-color: var(--muted); }
button {
  flex: 1;
  min-height: 44px;
  background: var(--text);
  color: var(--ink);
  border: 0;
  border-radius: 8px;
  padding: 0 14px;
  font: 600 13px/1.2 var(--sans);
  cursor: pointer;
  transition: background-color 160ms ease;
}
button:hover { background: var(--signal); }

/* ---- order ------------------------------------------------------------- */
.ident { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
.ident code { font-size: 15px; letter-spacing: -0.01em; }

/* The strip keeps BOTH outcomes on the page at all times: the unreached one is dimmed, never
   removed, so a refresh that flips placed to settled moves no pixels. */
.strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin-bottom: 20px; }
.strip div { background: var(--raised); padding: 12px 14px; }
.strip dt { font: 11px/1.4 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.strip dd { margin: 3px 0 0; font: 13px/1.4 var(--mono); color: var(--muted); }
.strip .reached dd { color: var(--text); }
.strip .reached-ok dd { color: var(--ok); }
.strip .reached-fail dd { color: var(--fail); }

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font: 500 11px/1.4 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; }
td { font-size: 14px; }
td.num, th.num { text-align: right; font-family: var(--mono); }
tfoot th { color: var(--text); font-size: 13px; }
tr:last-child td { border-bottom: 0; }

/* ---- status ------------------------------------------------------------ */
.hop { font-family: var(--mono); font-size: 13px; }
/* Reserved, so a state going from ok to unreachable does not re-lay-out the row. */
.state { width: 124px; }
.pill {
  display: inline-block;
  min-width: 96px;
  text-align: center;
  padding: 3px 10px;
  border-radius: 999px;
  font: 600 11px/1.5 var(--mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.hop-ok, .status-settled { background: rgba(86,197,150,0.14); color: var(--ok); }
.hop-degraded, .status-placed { background: rgba(224,163,90,0.14); color: var(--warn); }
.hop-unreachable, .status-failed { background: rgba(232,105,95,0.14); color: var(--fail); }
.reason { padding: 0 12px 10px; border-bottom: 1px solid var(--line); }
.queue { display: flex; gap: 28px; margin: 0; padding: 16px 20px; border-top: 1px solid var(--line); }
.queue div { display: flex; flex-direction: column; gap: 2px; }
.queue dt { font: 11px/1.4 var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.queue dd { margin: 0; font: 600 20px/1.2 var(--mono); letter-spacing: -0.02em; }

/* ---- error ------------------------------------------------------------- */
.fault { display: flex; gap: 20px; align-items: flex-start; }
.fault .code { font: 600 44px/1 var(--mono); letter-spacing: -0.03em; color: var(--fail); }
.fault p { margin: 0 0 10px; }
.copyable { display: block; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; margin-top: 4px; font-size: 13px; overflow-x: auto; }

@media (max-width: 560px) {
  .strip { grid-template-columns: 1fr; }
  .fault { flex-direction: column; gap: 10px; }
  .queue { flex-direction: column; gap: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;
