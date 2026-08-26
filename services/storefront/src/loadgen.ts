import { CATALOG } from "@sample-app/contracts";
import { optBool, optInt, optNumber, optStr, requireUrl, type EnvSource } from "@sample-app/platform";

/** Bounds shared by the environment loader and the control form, so both refuse the same values. */
export const RPS_BOUNDS = { min: 1, max: 10_000 } as const;
/** One worker is one in-flight request. 100 concurrent fetches is already more than a 50m pod serves. */
export const CONCURRENCY_BOUNDS = { min: 1, max: 100 } as const;

export interface LoadgenConfig {
  targetUrl: string;
  rps: number;
  concurrency: number;
  durationSeconds: number;
  checkoutRatio: number;
  autostart: boolean;
  uiPassword: string | null;
  uiCookieSecure: boolean;
}

export function loadLoadgenConfig(env: EnvSource): LoadgenConfig {
  return {
    targetUrl: requireUrl(env, "TARGET_URL"),
    rps: optInt(env, "LOADGEN_RPS", 5, RPS_BOUNDS),
    // The knob that makes SSR_CONCURRENCY=1 and DB_POOL_MAX=1 reachable. One worker drives one
    // request at a time, so a single-worker generator never makes a serialised server queue.
    concurrency: optInt(env, "LOADGEN_CONCURRENCY", 1, CONCURRENCY_BOUNDS),
    // 0 means run until stopped — the normal mode for the long-lived Deployment.
    durationSeconds: optInt(env, "LOADGEN_DURATION_SECONDS", 0, { min: 0 }),
    checkoutRatio: optNumber(env, "LOADGEN_CHECKOUT_RATIO", 0.3, { min: 0, max: 1 }),
    // Off by default: the pod comes up idle and waits for the button. Set it to reproduce the
    // old run-on-start CLI behaviour, locally or for a load that must exist before anyone looks.
    autostart: optBool(env, "LOADGEN_AUTOSTART", false),
    // Unset means the control page serves 503 rather than serving the Start button to anyone
    // who finds the URL. See loadgen-control.ts.
    uiPassword: optStr(env, "LOADGEN_UI_PASSWORD", "") || null,
    // Opt-out, not opt-in: a Secure cookie is dropped in silence over plain HTTP, and the
    // symptom — a login form that keeps reappearing — points nowhere near the cause. Browsers
    // exempt localhost, so a port-forward needs no change; only a plain-HTTP hostname does.
    uiCookieSecure: optBool(env, "LOADGEN_UI_COOKIE_SECURE", true),
  };
}

export type LoadAction = "browse" | "checkout";

export function pickAction(random: number, checkoutRatio: number): LoadAction {
  return random < checkoutRatio ? "checkout" : "browse";
}

export interface LoadStats {
  requests: number;
  checkouts: number;
  errors: number;
  statuses: Record<string, number>;
}

export interface RunLoadOptions {
  targetUrl: string;
  rps: number;
  checkoutRatio: number;
  /** Bounded run for tests; omit for an endless one. */
  iterations?: number;
  durationSeconds?: number;
  random?: () => number;
  /** Supply one to watch the running totals from outside — the control page does. */
  stats?: LoadStats;
  /**
   * Aborting ends the loop after the iteration in flight, and skips the pacing sleep so a stop
   * at 1 rps does not wait out a second. In-flight fetches are left alone: cancelling them would
   * book a stop as an error and put a spike in the graph the operator just tried to end.
   */
  signal?: AbortSignal;
}

export function emptyStats(): LoadStats {
  return { requests: 0, checkouts: 0, errors: 0, statuses: {} };
}

export async function runLoad(opts: RunLoadOptions): Promise<LoadStats> {
  const random = opts.random ?? Math.random;
  const stats = opts.stats ?? emptyStats();
  const intervalMs = 1000 / opts.rps;
  const deadline = opts.durationSeconds ? Date.now() + opts.durationSeconds * 1000 : Infinity;

  const record = (status: string): void => {
    stats.requests++;
    stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
    if (status === "error" || Number(status) >= 400) stats.errors++;
  };

  const visit = async (path: string, init?: RequestInit): Promise<Response | null> => {
    try {
      const res = await fetch(`${opts.targetUrl}${path}`, { redirect: "manual", ...init });
      record(String(res.status));
      await res.text();
      return res;
    } catch {
      record("error");
      return null;
    }
  };

  for (let i = 0; opts.iterations === undefined || i < opts.iterations; i++) {
    if (Date.now() >= deadline || opts.signal?.aborted) break;
    const startedAt = Date.now();

    if (pickAction(random(), opts.checkoutRatio) === "checkout") {
      const product = CATALOG[Math.floor(random() * CATALOG.length)] ?? CATALOG[0]!;
      const res = await visit("/checkout", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sku: product.sku, qty: "1" }).toString(),
      });
      stats.checkouts++;
      const location = res?.headers.get("location");
      if (location) await visit(location);
    } else {
      await visit(random() < 0.5 ? "/" : "/status");
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < intervalMs && !opts.signal?.aborted) {
      await new Promise((r) => setTimeout(r, intervalMs - elapsed));
    }
  }

  return stats;
}

export interface RunSettings {
  rps: number;
  concurrency: number;
  checkoutRatio: number;
  durationSeconds: number;
}

export interface RunnerState {
  running: boolean;
  /** The settings of the run in flight, or of the last one to finish. */
  settings: RunSettings | null;
  startedAt: string | null;
  stats: LoadStats;
  /** Wall-clock seconds of the current run, or of the last one. */
  seconds: number;
}

export interface LoadRunner {
  /** Restarts with the new settings if a run is already in flight. */
  start(settings: RunSettings): Promise<void>;
  stop(): Promise<void>;
  state(): RunnerState;
}

/**
 * Owns the workers so the control routes stay a thin translation of a form into settings.
 *
 * `rps` is the total across workers, not per worker: doubling concurrency to make requests
 * queue would otherwise double the load as a side effect, and the operator would be changing
 * two variables while believing they changed one.
 */
export function createLoadRunner(targetUrl: string): LoadRunner {
  let controller: AbortController | null = null;
  let workers: Promise<unknown> = Promise.resolve();
  let settings: RunSettings | null = null;
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;
  let stats = emptyStats();

  const stop = async (): Promise<void> => {
    controller?.abort();
    controller = null;
    await workers;
  };

  return {
    async start(next: RunSettings): Promise<void> {
      await stop();
      const local = new AbortController();
      controller = local;
      settings = next;
      startedAtMs = Date.now();
      endedAtMs = null;
      // A fresh counter per run. Carrying the previous run's errors forward would make the
      // first reading after a fix look exactly like no fix at all.
      stats = emptyStats();

      workers = Promise.all(
        Array.from({ length: next.concurrency }, () =>
          runLoad({
            targetUrl,
            rps: next.rps / next.concurrency,
            checkoutRatio: next.checkoutRatio,
            durationSeconds: next.durationSeconds,
            stats,
            signal: local.signal,
          }),
        ),
      ).then(() => {
        // A bounded run ends by itself. Only clear the flag if this run is still the current
        // one — a restart has already replaced it.
        if (controller === local) {
          controller = null;
          endedAtMs = Date.now();
        }
      });
    },

    stop,

    state(): RunnerState {
      const until = controller ? Date.now() : (endedAtMs ?? startedAtMs ?? 0);
      return {
        running: controller !== null,
        settings,
        startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
        stats,
        seconds: startedAtMs === null ? 0 : Math.max(0, (until - startedAtMs) / 1000),
      };
    },
  };
}