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
import {
  FAULT_CONTROL_PATH,
  sendHtml,
  type FaultKnobState,
  type FaultState,
  type Route,
  type RouteHandler,
} from "@sample-app/platform";
import {
  LoginThrottle,
  SESSION_COOKIE,
  checkPassword,
  clearedCookie,
  cookieValue,
  mintSession,
  safeNext,
  sessionCookie,
  verifySession,
} from "./auth.js";
import {
  CONCURRENCY_BOUNDS,
  RPS_BOUNDS,
  type FaultTarget,
  type LoadRunner,
  type RunSettings,
  type RunnerState,
} from "./loadgen.js";
import { isLive, parseForm } from "./routes.js";
import { esc, liveToggle } from "./views.js";

class BadSettingError extends Error {}

/** What one target answered, or why it could not be reached. Never both. */
export interface TargetFaultState {
  target: FaultTarget;
  state: FaultState | null;
  error?: string;
}

/**
 * Short by design. This runs while the page is being rendered, and a service that has stopped
 * answering is itself worth showing — waiting 30 seconds for it to confirm that would take the
 * Disarm button away at exactly the moment someone needs it.
 */
const FAULT_CALL_TIMEOUT_MS = 2000;

function authHeaders(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchFaults(target: FaultTarget, token: string | null): Promise<TargetFaultState> {
  try {
    const res = await fetch(`${target.url}${FAULT_CONTROL_PATH}`, {
      headers: { accept: "application/json", ...authHeaders(token) },
      signal: AbortSignal.timeout(FAULT_CALL_TIMEOUT_MS),
    });
    if (res.status === 401) return { target, state: null, error: "rejected the token — FAULT_CONTROL_TOKEN differs there" };
    if (res.status === 404) return { target, state: null, error: "has no fault control: FAULT_CONTROL_TOKEN is unset on that service" };
    if (!res.ok) return { target, state: null, error: `answered ${res.status}` };
    return { target, state: (await res.json()) as FaultState };
  } catch (err) {
    return { target, state: null, error: `unreachable: ${reason(err)}` };
  }
}

/** Null on success, the operator-facing reason on failure. */
export async function postFault(
  target: FaultTarget,
  token: string | null,
  key: string,
  on: boolean,
): Promise<string | null> {
  try {
    const res = await fetch(`${target.url}${FAULT_CONTROL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ key, on }),
      signal: AbortSignal.timeout(FAULT_CALL_TIMEOUT_MS),
    });
    if (res.ok) return null;
    return `${target.name} refused the change: ${res.status} ${(await res.text()).slice(0, 120)}`;
  } catch (err) {
    return `${target.name} is unreachable: ${reason(err)}`;
  }
}

/** "14m" / "45s". Minutes are enough resolution to decide whether to re-arm before it lapses. */
export function formatRemaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
}

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
.actions { display:flex; gap:10px; margin-top:14px; }
.actions form { margin:0; max-width:200px; flex:1; }
button.quiet { background:transparent; color:var(--muted); border:1px solid var(--line); }
button.quiet:hover { background:transparent; color:var(--text); border-color:var(--signal); }
.muted { color:var(--muted); }
.state-armed { background:rgba(232,105,95,0.16); color:var(--fail); }
.target { margin-top:12px; }
.target h3 { display:flex; align-items:baseline; gap:10px; margin:0 0 4px; font:600 13px/1.4 var(--mono); letter-spacing:0.04em; }
.knob { display:flex; align-items:center; gap:16px; padding:14px 0; border-bottom:1px solid var(--line); }
.knob:last-child { padding-bottom:0; border-bottom:0; }
.knob-main { flex:1; min-width:0; }
.knob-name { display:flex; align-items:center; gap:10px; font:600 15px/1.3 var(--mono); }
.knob-note { margin:5px 0 0; color:var(--muted); font-size:13px; }
.lapse { display:inline-block; margin-left:4px; padding:1px 8px; border:1px solid var(--line); border-radius:999px; font:11px/1.6 var(--mono); white-space:nowrap; }
.knob form { margin:0; flex:none; width:140px; }
/* Taller than the run controls: this is the button someone hits from across a room, mid-demo. */
.knob button { min-height:42px; }
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
  /** One entry per FAULT_TARGETS service. Empty renders the card's "not configured" note. */
  faults?: TargetFaultState[];
  /** Injectable so a test can assert a countdown instead of racing one. */
  now?: number;
}

function knobRow(targetName: string, knob: FaultKnobState, now: number): string {
  const remaining = knob.active && knob.expiresAt ? formatRemaining(knob.expiresAt, now) : null;
  // Red for Arm, plain for Disarm: the colour says what the click does, not what the state is,
  // so the destructive one is the one that looks destructive from the back of the room.
  const action = knob.active
    ? { on: "false", label: "Disarm", cls: "" }
    : { on: "true", label: "Arm", cls: "stop" };
  return `  <div class="knob">
    <div class="knob-main">
      <div class="knob-name">${esc(knob.label)}${knob.active ? `<span class="pill state-armed">armed</span>` : ""}</div>
      <p class="knob-note">${esc(knob.note)}${
        // Separated, not appended: the notes do not end in a full stop, and "serves 502 Reverts
        // in 15m" read as one sentence the first time this was rendered.
        remaining ? ` <span class="lapse">reverts in ${esc(remaining)}</span>` : ""
      }</p>
    </div>
    <form method="post" action="/control/arm">
      <input type="hidden" name="target" value="${esc(targetName)}">
      <input type="hidden" name="key" value="${esc(knob.key)}">
      <input type="hidden" name="on" value="${action.on}">
      <button class="${action.cls}" type="submit">${action.label}<span class="sr-only"> ${esc(knob.label)} on ${esc(targetName)}</span></button>
    </form>
  </div>`;
}

export function faultsCard(faults: TargetFaultState[], now: number): string {
  if (faults.length === 0) {
    return `<h2>Faults</h2>
<div class="card">
  <p class="detail"><code>FAULT_TARGETS</code> is not set, so there is nothing to arm from here. Set it to
  the services that expose <code>${esc(FAULT_CONTROL_PATH)}</code>, for example
  <code>storefront=http://storefront:3000,orders-api=http://orders-api:3000</code>.</p>
</div>`;
  }

  const armed = faults.reduce((n, f) => n + (f.state?.knobs.filter((k) => k.active).length ?? 0), 0);
  const ttl = faults.find((f) => f.state)?.state?.ttlSeconds;
  const bodies = faults.map((entry) => {
    const inner = entry.state
      ? entry.state.knobs.map((knob) => knobRow(entry.target.name, knob, now)).join("\n")
      : `  <p class="knob-note">${esc(entry.target.name)} ${esc(entry.error ?? "did not answer")}.</p>`;
    return `<div class="card target">
  <h3>${esc(entry.target.name)} <span class="detail">${esc(entry.target.url)}</span></h3>
${inner}
</div>`;
  });

  return `<h2>Faults
  <span class="pill state-${armed > 0 ? "armed" : "idle"}">${armed > 0 ? `${armed} armed` : "none"}</span>
</h2>
<!-- One atomic status for the whole card: a live region per knob would make every refresh a
     competing announcement, and the number alone would say nothing. -->
<p class="sr-only" role="status" aria-atomic="true">${
    armed === 0 ? "No faults armed" : `${armed} fault${armed === 1 ? "" : "s"} armed`
  }</p>
${bodies.join("\n")}
<p class="detail note">Each fault is the environment variable from
<code>docs/DEPLOYMENT_CONTRACT.md §3</code>, flipped in the running process — the same code path a
redeploy would take, minus the redeploy.${
    ttl ? ` Anything armed reverts on its own after ${Math.round(ttl / 60)} minutes.` : ""
  } Faults need traffic to show up: start the run above first.</p>`;
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
    <form method="post" action="/logout"><button class="quiet" type="submit">Sign out</button></form>
  </div>
  <p class="detail note">Concurrency is how many requests are in flight at once. One worker never
  makes a serialised server queue, so <code>SSR_CONCURRENCY=1</code> and <code>DB_POOL_MAX=1</code>
  need this above 1 before latency moves. <code>rps</code> is the total across workers.</p>
</div>

${faultsCard(opts.faults ?? [], opts.now ?? Date.now())}`,
    polling ? 5 : null,
  );
}

export function loginPage(opts: { next?: string; error?: string } = {}): string {
  return shell(
    "Sign in — load generator",
    `${opts.error ? `<div class="card error"><p>${esc(opts.error)}</p></div>` : ""}
<h2>Sign in</h2>
<div class="card">
  <form class="controls" method="post" action="/login">
    <!-- safeNext again, not only at the route: this value is attacker-supplied and the function
         must not depend on every caller having remembered to sanitise it. -->
    <input type="hidden" name="next" value="${esc(safeNext(opts.next))}">
    <div><label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required></div>
    <div><button type="submit">Sign in</button></div>
  </form>
  <p class="detail note">This page starts real traffic against the cluster. It is not a viewer.</p>
</div>`,
    null,
  );
}

export function unavailablePage(): string {
  return shell(
    "Unavailable — load generator",
    `<h2>Unavailable</h2>
<div class="card error">
  <p><code>LOADGEN_UI_PASSWORD</code> is not set, so this page cannot verify who is asking. It
  will not serve an unauthenticated button that puts load on the cluster. Set the variable to
  enable sign-in.</p>
</div>`,
    null,
  );
}

export interface ControlRouteDeps {
  runner: LoadRunner;
  targetUrl: string;
  defaults: RunSettings;
  /** Null disables the page entirely: it serves 503 rather than serving Start to anyone. */
  password: string | null;
  cookieSecure: boolean;
  /** Empty renders the Faults card as an explanation rather than buttons. */
  faultTargets: FaultTarget[];
  /** Presented to every target. The same FAULT_CONTROL_TOKEN those services check. */
  faultToken: string | null;
}

export function createControlRoutes(deps: ControlRouteDeps): Route[] {
  const throttle = new LoginThrottle();

  const render = async (res: http.ServerResponse, status: number, live: boolean, error?: string): Promise<void> => {
    // In parallel: two targets that each take a second must not cost two seconds, and one that
    // has stopped answering must not hold the page past its own timeout.
    const faults = await Promise.all(deps.faultTargets.map((t) => fetchFaults(t, deps.faultToken)));
    sendHtml(res, status, controlPage({
      state: deps.runner.state(),
      targetUrl: deps.targetUrl,
      defaults: deps.defaults,
      live,
      faults,
      ...(error ? { error } : {}),
    }));
  };

  const authed = (req: http.IncomingMessage): boolean =>
    verifySession(cookieValue(req.headers.cookie, SESSION_COOKIE), deps.password ?? undefined);

  /**
   * Wraps every route that can read or change the run. `/healthz`, `/readyz`, `/metrics` and
   * `/stats` are served by createApp and never reach this list, so a missing password can
   * never take the pod out of service — it only closes the page.
   */
  const guard = (handler: RouteHandler): RouteHandler => async (ctx) => {
    if (!deps.password) {
      sendHtml(ctx.res, 503, unavailablePage());
      return;
    }
    if (!authed(ctx.req)) {
      const next = ctx.url.pathname + ctx.url.search;
      ctx.res.writeHead(303, { location: `/login?next=${encodeURIComponent(safeNext(next))}` });
      ctx.res.end();
      return;
    }
    await handler(ctx);
  };

  return [
    {
      method: "GET",
      pattern: "/",
      handler: guard(async ({ res, url }) => { await render(res, 200, isLive(url)); }),
    },
    {
      method: "GET",
      pattern: "/login",
      handler: async ({ res, req, url }) => {
        if (!deps.password) {
          sendHtml(res, 503, unavailablePage());
          return;
        }
        const next = safeNext(url.searchParams.get("next"));
        // Already signed in: the form would re-ask for a password the browser is holding.
        if (authed(req)) {
          res.writeHead(303, { location: next });
          res.end();
          return;
        }
        sendHtml(res, 200, loginPage({ next }));
      },
    },
    {
      method: "POST",
      pattern: "/login",
      handler: async ({ res, req, readBody }) => {
        if (!deps.password) {
          sendHtml(res, 503, unavailablePage());
          return;
        }
        // The socket address, not X-Forwarded-For: that header is written by whoever is
        // calling, which would make the throttle decorative. Behind a proxy every client
        // shares one bucket, which still throttles the guessing this exists to stop.
        const key = req.socket.remoteAddress ?? "unknown";
        const waitMs = throttle.retryAfterMs(key);
        if (waitMs > 0) {
          sendHtml(res, 429, loginPage({ error: `Too many sign-in attempts. Try again in ${Math.ceil(waitMs / 1000)}s.` }));
          return;
        }
        const form = parseForm(await readBody());
        const next = safeNext(form["next"]);
        if (!checkPassword(form["password"] ?? "", deps.password)) {
          throttle.fail(key);
          sendHtml(res, 401, loginPage({ error: "That password is not right. Check it and try again.", next }));
          return;
        }
        throttle.succeed(key);
        res.writeHead(303, {
          location: next,
          "set-cookie": sessionCookie(mintSession(deps.password), deps.cookieSecure),
        });
        res.end();
      },
    },
    {
      method: "POST",
      pattern: "/logout",
      handler: async ({ res }) => {
        // Unconditional: signing out an already-signed-out browser is the same outcome, and
        // refusing would only confuse someone whose session had just expired.
        res.writeHead(303, { location: "/login", "set-cookie": clearedCookie(deps.cookieSecure) });
        res.end();
      },
    },
    {
      method: "POST",
      pattern: "/control/start",
      handler: guard(async ({ res, readBody }) => {
        let settings: RunSettings;
        try {
          settings = parseSettings(parseForm(await readBody()));
        } catch (err) {
          if (err instanceof BadSettingError) {
            await render(res, 400, true, err.message);
            return;
          }
          throw err;
        }
        await deps.runner.start(settings);
        // POST/redirect/GET, like the storefront's checkout: a refresh must not re-submit.
        res.writeHead(303, { location: "/" });
        res.end();
      }),
    },
    {
      method: "POST",
      pattern: "/control/stop",
      handler: guard(async ({ res }) => {
        await deps.runner.stop();
        res.writeHead(303, { location: "/" });
        res.end();
      }),
    },
    {
      // `/control/arm`, not `/control/fault`: that path is the services' own API, and naming the
      // page's form after it would collide the day this generator declares a knob of its own.
      method: "POST",
      pattern: "/control/arm",
      handler: guard(async ({ res, readBody }) => {
        const form = parseForm(await readBody());
        const target = deps.faultTargets.find((t) => t.name === form["target"]);
        if (!target) {
          await render(res, 400, true, `No fault target named "${form["target"] ?? ""}".`);
          return;
        }
        // No confirmation dialog. Arming is reversible by the button beside it and by the TTL,
        // and a demo that needs two clicks to show one thing is a demo nobody runs twice.
        const failure = await postFault(target, deps.faultToken, form["key"] ?? "", form["on"] === "true");
        if (failure) {
          await render(res, 502, true, failure);
          return;
        }
        res.writeHead(303, { location: "/" });
        res.end();
      }),
    },
  ];
}
