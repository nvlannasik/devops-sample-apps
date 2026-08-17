export interface Semaphore {
  acquire(): Promise<() => void>;
  readonly inFlight: number;
  readonly queued: number;
}

/**
 * Backs SSR_CONCURRENCY. With a low limit the excess genuinely queues, so head-of-line
 * blocking at the edge is real: storefront TTFB explodes while every tier below stays healthy.
 */
export function createSemaphore(limit: number): Semaphore {
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    inFlight--;
    const next = waiters.shift();
    if (next) {
      inFlight++;
      next();
    }
  };

  return {
    acquire(): Promise<() => void> {
      let released = false;
      const permit = (): void => {
        if (released) return;
        released = true;
        release();
      };

      if (inFlight < limit) {
        inFlight++;
        return Promise.resolve(permit);
      }
      return new Promise((resolve) => {
        waiters.push(() => resolve(permit));
      });
    },
    get inFlight() {
      return inFlight;
    },
    get queued() {
      return waiters.length;
    },
  };
}