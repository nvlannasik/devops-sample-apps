import type { ChainStatus, HopStatus, QueueStats, ServiceStats } from "@sample-app/contracts";
import { DownstreamError, type HttpClient } from "@sample-app/platform";

/** Deliberately the same numbers as SampleAppHighErrorRate and SampleAppHighLatency: the
 *  status page and the alert must never disagree about what "degraded" means. */
export const DEGRADED_ERROR_RATE = 0.05;
export const DEGRADED_P99_MS = 1000;

export interface ChainDeps {
  client: HttpClient;
  selfStats: () => ServiceStats;
  ordersApiUrl: string;
  workerUrl: string;
}

export async function probeHop(client: HttpClient, name: string, statsUrl: string): Promise<HopStatus> {
  try {
    const stats = await client.getJson<ServiceStats>(name, statsUrl);
    const degraded = stats.errorRate > DEGRADED_ERROR_RATE || (stats.p99Ms !== null && stats.p99Ms > DEGRADED_P99_MS);
    return {
      name,
      state: degraded ? "degraded" : "ok",
      detail: degraded ? `errorRate=${stats.errorRate.toFixed(3)} p99=${stats.p99Ms ?? "n/a"}ms` : undefined,
      stats,
    };
  } catch (err) {
    return {
      name,
      state: "unreachable",
      detail: err instanceof DownstreamError ? err.message : String(err),
      stats: null,
    };
  }
}

export async function buildChainStatus(deps: ChainDeps): Promise<ChainStatus> {
  // Each hop is fetched independently and concurrently: one dead hop must not decide the
  // fate of the others, and the page must not take the sum of every timeout to render.
  const [ordersHop, workerHop, queue] = await Promise.all([
    probeHop(deps.client, "orders-api", `${deps.ordersApiUrl}/stats`),
    probeHop(deps.client, "settlement-worker", `${deps.workerUrl}/stats`),
    deps.client
      .getJson<QueueStats>("settlement-worker", `${deps.workerUrl}/queue-stats`)
      .catch(() => null),
  ]);

  const self: HopStatus = { name: "checkout-gateway", state: "ok", stats: deps.selfStats() };

  return {
    hops: [self, ordersHop, workerHop],
    queue,
    checkedAt: new Date().toISOString(),
  };
}