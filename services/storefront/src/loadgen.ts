import { CATALOG } from "@sample-app/contracts";
import { loadOrExit, optInt, optNumber, requireUrl, type EnvSource } from "@sample-app/platform";

export interface LoadgenConfig {
  targetUrl: string;
  rps: number;
  durationSeconds: number;
  checkoutRatio: number;
}

export function loadLoadgenConfig(env: EnvSource): LoadgenConfig {
  return {
    targetUrl: requireUrl(env, "TARGET_URL"),
    rps: optInt(env, "LOADGEN_RPS", 5, { min: 1, max: 10_000 }),
    // 0 means run until killed — the normal mode for an in-cluster Job.
    durationSeconds: optInt(env, "LOADGEN_DURATION_SECONDS", 0, { min: 0 }),
    checkoutRatio: optNumber(env, "LOADGEN_CHECKOUT_RATIO", 0.3, { min: 0, max: 1 }),
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
  /** Supply one to watch the running totals from outside — the CLI's ticker does. */
  stats?: LoadStats;
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
    if (Date.now() >= deadline) break;
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
    if (elapsed < intervalMs) await new Promise((r) => setTimeout(r, intervalMs - elapsed));
  }

  return stats;
}

// Executed only when run directly (npm run loadgen), never when imported by the tests.
// Check that argv[1] is exactly this file (not loadgen.test.ts which also contains "loadgen").
const entryFile = process.argv[1] ?? "";
if (entryFile.endsWith("/loadgen.ts") || entryFile.endsWith("/loadgen.js")) {
  const config = loadOrExit(loadLoadgenConfig);
  const started = Date.now();
  const current = emptyStats();
  const report = (): void => {
    const seconds = (Date.now() - started) / 1000;
    process.stdout.write(JSON.stringify({ ...current, seconds: Math.round(seconds), rps: +(current.requests / seconds).toFixed(2) }) + "\n");
  };
  const ticker = setInterval(report, 10_000);
  const finish = (): never => { clearInterval(ticker); report(); process.exit(0); };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);

  await runLoad({
    targetUrl: config.targetUrl,
    rps: config.rps,
    checkoutRatio: config.checkoutRatio,
    durationSeconds: config.durationSeconds,
    stats: current,
  });
  clearInterval(ticker);
  report();
}