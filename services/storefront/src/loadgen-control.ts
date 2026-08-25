/**
 * The control surface of the load generator: one page and two form posts.
 *
 * It lives on the generator rather than on the storefront on purpose. The storefront is the
 * workload under investigation — a control route there would show up in its `http_server_*`
 * series and its logs, and, worse, the button that STOPS the load would be served by the very
 * process the load is overwhelming. `SSR_CONCURRENCY=1` would make it unreachable exactly when
 * it is needed most.
 */
import type http from "node:http";
import { sendHtml, type Route } from "@sample-app/platform";
import {
  CONCURRENCY_BOUNDS,
  RPS_BOUNDS,
  type LoadRunner,
  type RunSettings,
  type RunnerState,
} from "./loadgen.js";
import { isLive, parseForm } from "./routes.js";
import { esc, liveToggle } from "./views.js";

class BadSettingError extends Error {}

function intField(form: Record<string, string>, key: string, bounds: { min: number; max: number }): number {
  const value = Number(form[key]);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new BadSettingError(`${key} must be a whole number between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

export function parseSettings(form: Record<string, string>): RunSettings {
  const checkoutRatio = Number(form["checkoutRatio"]);
  if (!Number.isFinite(checkoutRatio) || checkoutRatio < 0 || checkoutRatio > 1) {
    throw new BadSettingError("checkoutRatio must be a number between 0 and 1");
  }
  return {
    rps: intField(form, "rps", RPS_BOUNDS),
    concurrency: intField(form, "concurrency", CONCURRENCY_BOUNDS),
    checkoutRatio,
    durationSeconds: intField(form, "durationSeconds", { min: 0, max: 86_400 }),
  };
}

/**
 * Self-contained: the stylesheet is inline rather than served from /assets/:version/app.css.
 * `ASSET_VERSION` is a fault knob, and a control page that breaks when the fault under test is
 * injected is a control page you cannot use during the incident.
 */
const CONTROL_CSS = `:root {
  --ink:#131a1f; --panel:#1b2429; --raised:#212c32; --line:#2c3940;
  --text:#e3ecef; --muted:#8ba0a8; --signal:#7fd4e8; --ok:#56c596; --fail:#e8695f;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--ink); color:var(--text); font:15px/1.55 var(--sans); font-variant-numeric:tabular-nums; }
main { max-width:760px; margin:0 auto; padding:28px 20px 72px; }
header { border-bottom:1px solid var(--line); padding-bottom:14px; }
header h1 { margin:0; font:600 15px/1 var(--mono); letter-spacing:0.02em; text-transform:lowercase; }
header h1::before { content:"▚ "; color:var(--signal); }
h2 { display:flex; align-items:center; gap:10px; margin:32px 0 14px; font:500 12px/1 var(--mono); letter-spacing:0.1em; text-transform:uppercase; color:var(--muted); }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
:focus-visible { outline:2px solid var(--signal); outline-offset:2px; }
.pill { display:inline-block; min-width:76px; text-align:center; padding:3px 10px; border-radius:999px; font:600 11px/1.5 var(--mono); letter-spacing:0.06em; text-transform:uppercase; }
.state-running { background:rgba(86,197,150,0.14); color:var(--ok); }
.state-idle { background:rgba(139,160,168,0.14); color:var(--muted); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(116px,1fr)); gap:1px; margin:0; background:var(--line); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
.grid div { background:var(--raised); padding:12px 14px; }
.grid dt { color:var(--muted); font:11px/1.4 var(--mono); letter-spacing:0.1em; text-transform:uppercase; }
.grid dd { margin:3px 0 0; font:600 22px/1.2 var(--mono); letter-spacing:-0.02em; }
form.controls { display:grid; grid-template-columns:repeat(auto-fit,minmax(136px,1fr)); gap:12px; align-items:end; }
label { display:block; color:var(--muted); font:11px/1.4 var(--mono); letter-spacing:0.1em; text-transform:uppercase; margin-bottom:5px; }
input { width:100%; background:var(--ink); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:14px/1 var(--mono); }
button { width:100%; background:var(--text); color:var(--ink); border:0; border-radius:8px; padding:10px 16px; font:600 13px/1 var(--sans); cursor:pointer; }
button:hover { background:var(--signal); }
button.stop { background:transparent; color:var(--fail); border:1px solid var(--fail); }
button.stop:hover:enabled { background:var(--fail); color:var(--ink); }
button:disabled { opacity:0.35; cursor:not-allowed; }
.actions { margin-top:14px; }
.actions form { margin:0; max-width:200px; }
.muted { color:var(--muted); }
.detail { color:var(--muted); font:12px/1.5 var(--mono); }
.error { border-left:3px solid var(--fail); padding-left:14px; margin-bottom:18px; }
code { font-family:var(--mono); font-size:13px; }
table { width:100%; border-collapse:collapse; table-layout:fixed; margin-top:14px; }
th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); font-family:var(--mono); font-size:13px; }
th { color:var(--muted); font:500 11px/1.4 var(--mono); letter-spacing:0.1em; text-transform:uppercase; }
tr:last-child td { border-bottom:0; }
p.note { margin:16px 0 0; }
.sr-only { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.live { display:inline-flex; align-items:center; gap:7px; min-height:32px; margin-left:auto; padding:0 12px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font:500 11px/1 var(--mono); letter-spacing:0.08em; text-transform:uppercase; text-decoration:none; transition:color 160ms ease, border-color 160ms ease; }
.live:hover { color:var(--text); border-color:var(--signal); }
.live .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:none; }
.live.paused { color:#e0a35a; border-color:rgba(224,163,90,0.4); }
@media (max-width:560px) { .actions form { max-width:none; } }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; } }`;

function shell(title: string, body: string, refreshSeconds: number | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">\n` : ""}<title>${esc(title)}</title>
<style>${CONTROL_CSS}</style>
</head>
<body>
<main>
<header><h1>Load generator</h1></header>
${body}
</main>
</body>
</html>`;
}

export interface ControlPageOptions {
  state: RunnerState;
  targetUrl: string;
  defaults: RunSettings;
  error?: string;
  /** False when the reader asked the page to hold still with `?live=off`. */
  live?: boolean;
}

export function controlPage(opts: ControlPageOptions): string {
  const { state } = opts;
  const live = opts.live ?? true;
  const polling = state.running && live;
  const form = state.settings ?? opts.defaults;
  const observedRps = state.seconds > 0 ? (state.stats.requests / state.seconds).toFixed(1) : "0.0";
  const statuses = Object.entries(state.stats.statuses).sort(([a], [b]) => a.localeCompare(b));

  const statusRows = statuses.length
    ? statuses.map(([code, count]) => `      <tr><td><code>${esc(code)}</code></td><td>${esc(count)}</td></tr>`).join("\n")
    : `      <tr><td class="muted" colspan="2">No requests yet.</td></tr>`;

  const field = (name: string, label: string, value: string | number, attrs: string): string =>
    `  <div><label for="${esc(name)}">${esc(label)}</label>
    <input id="${esc(name)}" name="${esc(name)}" value="${esc(value)}" ${attrs}></div>`;

  return shell(
    "Load generator",
    `${opts.error ? `<div class="card error"><p>${esc(opts.error)}</p></div>` : ""}
<h2>Run
  <span class="pill state-${state.running ? "running" : "idle"}">${state.running ? "running" : "idle"}</span>
  <span class="detail">target ${esc(opts.targetUrl)}</span>
  ${state.running ? liveToggle(live) : ""}
</h2>
<div class="card">
  <dl class="grid">
    <div><dt>Requests</dt><dd>${esc(state.stats.requests)}</dd></div>
    <div><dt>Checkouts</dt><dd>${esc(state.stats.checkouts)}</dd></div>
    <div><dt>Errors</dt><dd>${esc(state.stats.errors)}</dd></div>
    <div><dt>Observed rps</dt><dd>${esc(observedRps)}</dd></div>
    <div><dt>Elapsed</dt><dd>${esc(Math.round(state.seconds))}s</dd></div>
  </dl>
  <table>
    <thead><tr><th>Status</th><th>Count</th></tr></thead>
    <tbody>
${statusRows}
    </tbody>
  </table>
</div>

<h2>Settings</h2>
<div class="card">
  <form class="controls" method="post" action="/control/start">
${field("rps", "Requests / sec", form.rps, `type="number" min="${RPS_BOUNDS.min}" max="${RPS_BOUNDS.max}" step="1"`)}
${field("concurrency", "Concurrency", form.concurrency, `type="number" min="${CONCURRENCY_BOUNDS.min}" max="${CONCURRENCY_BOUNDS.max}" step="1"`)}
${field("checkoutRatio", "Checkout ratio", form.checkoutRatio, `type="number" min="0" max="1" step="0.05"`)}
${field("durationSeconds", "Duration (0 = forever)", form.durationSeconds, `type="number" min="0" max="86400" step="1"`)}
    <div><button type="submit">${state.running ? "Apply and restart" : "Start"}</button></div>
  </form>
  <div class="actions">
    <form method="post" action="/control/stop"><button class="stop" type="submit" ${state.running ? "" : "disabled"}>Stop</button></form>
  </div>
  <p class="detail note">Concurrency is how many requests are in flight at once. One worker never
  makes a serialised server queue, so <code>SSR_CONCURRENCY=1</code> and <code>DB_POOL_MAX=1</code>
  need this above 1 before latency moves. <code>rps</code> is the total across workers.</p>
</div>`,
    polling ? 5 : null,
  );
}

export interface ControlRouteDeps {
  runner: LoadRunner;
  targetUrl: string;
  defaults: RunSettings;
}

export function createControlRoutes(deps: ControlRouteDeps): Route[] {
  const render = (res: http.ServerResponse, status: number, live: boolean, error?: string): void => {
    sendHtml(res, status, controlPage({
      state: deps.runner.state(),
      targetUrl: deps.targetUrl,
      defaults: deps.defaults,
      live,
      ...(error ? { error } : {}),
    }));
  };

  return [
    {
      method: "GET",
      pattern: "/",
      handler: async ({ res, url }) => render(res, 200, isLive(url)),
    },
    {
      method: "POST",
      pattern: "/control/start",
      handler: async ({ res, readBody }) => {
        let settings: RunSettings;
        try {
          settings = parseSettings(parseForm(await readBody()));
        } catch (err) {
          if (err instanceof BadSettingError) {
            render(res, 400, true, err.message);
            return;
          }
          throw err;
        }
        await deps.runner.start(settings);
        // POST/redirect/GET, like the storefront's checkout: a refresh must not re-submit.
        res.writeHead(303, { location: "/" });
        res.end();
      },
    },
    {
      method: "POST",
      pattern: "/control/stop",
      handler: async ({ res }) => {
        await deps.runner.stop();
        res.writeHead(303, { location: "/" });
        res.end();
      },
    },
  ];
}
