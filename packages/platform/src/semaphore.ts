export interface Semaphore {
  acquire(): Promise<() => void>;
  readonly inFlight: number;
  readonly queued: number;
}

/**
 * Backs SSR_CONCURRENCY. With a low limit the excess genuinely queues, so head-of-line
 * blocking at the edge is real: storefront TTFB explodes while every tier below stays healthy.
 *
 * The limit may be a function so the fault knob can move it at runtime (see faults.ts). It is
 * read on every acquire and release rather than captured, which is what lets a limit that has
 * just been raised back admit the whole backlog instead of one waiter per completed request.
 */
export function createSemaphore(limit: number | (() => number)): Semaphore {
  const limitOf = typeof limit === "function" ? limit : () => limit;
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    inFlight--;
    // A loop rather than one shift: after the limit is raised several waiters may now fit. The
    // guard is re-read each turn, so a limit that just dropped drains instead of admitting.
    while (waiters.length > 0 && inFlight < limitOf()) {
      const next = waiters.shift();
      if (!next) break;
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

      if (inFlight < limitOf()) {
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