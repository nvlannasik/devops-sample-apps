export interface StatsSnapshot {
  p99Ms: number | null;
  errorRate: number;
  requests: number;
  windowSeconds: number;
}

interface Sample {
  at: number;
  ms: number;
  err: boolean;
}

const MAX_SAMPLES = 10_000;

/**
 * A bounded, in-process view of the last N seconds, served at GET /stats and aggregated by
 * checkout-gateway for the storefront status page. Prometheus is the system of record; this
 * exists only so the human-facing page can show a fault propagating without querying it.
 */
export class RollingStats {
  readonly #windowSeconds: number;
  readonly #now: () => number;
  #samples: Sample[] = [];

  constructor(windowSeconds = 60, now: () => number = Date.now) {
    this.#windowSeconds = windowSeconds;
    this.#now = now;
  }

  record(durationMs: number, isError: boolean): void {
    this.#prune();
    if (this.#samples.length >= MAX_SAMPLES) this.#samples.shift();
    this.#samples.push({ at: this.#now(), ms: durationMs, err: isError });
  }

  snapshot(): StatsSnapshot {
    this.#prune();
    const n = this.#samples.length;
    if (n === 0) return { p99Ms: null, errorRate: 0, requests: 0, windowSeconds: this.#windowSeconds };
    const sorted = this.#samples.map((s) => s.ms).sort((a, b) => a - b);
    const index = Math.min(n - 1, Math.max(0, Math.ceil(0.99 * n) - 1));
    const errors = this.#samples.reduce((acc, s) => acc + (s.err ? 1 : 0), 0);
    return {
      p99Ms: sorted[index] ?? null,
      errorRate: errors / n,
      requests: n,
      windowSeconds: this.#windowSeconds,
    };
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowSeconds * 1000;
    let drop = 0;
    while (drop < this.#samples.length && this.#samples[drop]!.at < cutoff) drop++;
    if (drop > 0) this.#samples = this.#samples.slice(drop);
  }
}