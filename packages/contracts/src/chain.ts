export type HopState = "ok" | "degraded" | "unreachable";

/** A service's own view of its last 60 seconds, served at GET /stats. */
export interface ServiceStats {
  service: string;
  version: string;
  p99Ms: number | null;
  errorRate: number;
  requests: number;
  windowSeconds: number;
}

export interface HopStatus {
  name: string;
  state: HopState;
  detail?: string;
  stats: ServiceStats | null;
}

export interface QueueStats {
  depth: number;
  oldestAgeSeconds: number;
}

export interface ChainStatus {
  hops: HopStatus[];
  queue: QueueStats | null;
  checkedAt: string;
}
