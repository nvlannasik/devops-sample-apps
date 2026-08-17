import { withRemoteParent, type Logger, type Metrics } from "@sample-app/platform";
import { RETRY_BACKOFF_BASE_MS, type QueueRepo, type SettlementJob } from "./db/queue.js";

export interface LoopDeps {
  queue: QueueRepo;
  metrics: Metrics;
  logger: Logger;
  batchSize: number;
  pollIntervalMs: number;
  maxAttempts: number;
  verbosePayload: boolean;
}

const QUEUE = "settlement";

async function publishStats(deps: LoopDeps): Promise<void> {
  try {
    const stats = await deps.queue.stats();
    deps.metrics.queueDepth.set({ queue: QUEUE }, stats.depth);
    deps.metrics.queueOldestJobAge.set({ queue: QUEUE }, stats.oldestAgeSeconds);
  } catch (err) {
    deps.logger.error("failed to publish queue stats", { err });
  }
}

/** One poll: claim, settle each job, publish the gauges. Returns the number of jobs claimed. */
export async function runBatch(deps: LoopDeps): Promise<number> {
  let jobs: SettlementJob[];
  try {
    jobs = await deps.queue.claimBatch(deps.batchSize);
  } catch (err) {
    deps.logger.error("failed to claim a batch", { err });
    return 0;
  }

  if (jobs.length > 0) deps.metrics.settlementBatchSize.observe(jobs.length);

  for (const job of jobs) {
    await withRemoteParent(job.traceparent, "settle order", async () => {
      try {
        await deps.queue.settle(job);
        deps.metrics.settlementJobs.inc({ result: "ok" });
        deps.logger.info("order settled", {
          order_id: job.order_id,
          attempts: job.attempts,
          ...(deps.verbosePayload ? { amount_cents: job.amount_cents, items: job.items } : {}),
        });
      } catch (err) {
        if (job.attempts >= deps.maxAttempts) {
          await deps.queue.fail(job, err instanceof Error ? err.message : String(err));
          deps.metrics.settlementJobs.inc({ result: "failed" });
          deps.logger.error("order settlement gave up", { order_id: job.order_id, attempts: job.attempts, err });
          return;
        }
        const backoffMs = RETRY_BACKOFF_BASE_MS * job.attempts;
        await deps.queue.retry(job, backoffMs);
        deps.metrics.settlementJobs.inc({ result: "retried" });
        deps.logger.warn("order settlement failed, will retry", { order_id: job.order_id, attempts: job.attempts, backoff_ms: backoffMs, err });
      }
    });
  }

  await publishStats(deps);
  return jobs.length;
}

export function startLoop(deps: LoopDeps): { stop(): Promise<void> } {
  let running = true;
  let timer: NodeJS.Timeout | null = null;

  const finished = (async () => {
    while (running) {
      await runBatch(deps);
      if (!running) break;
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deps.pollIntervalMs);
      });
    }
  })();

  return {
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await finished;
    },
  };
}