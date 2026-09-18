import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "./semaphore.js";

test("a limit of 1 serialises two callers", async () => {
  const sem = createSemaphore(1);
  const order: string[] = [];

  const releaseA = await sem.acquire();
  order.push("a-start");

  const bDone = (async () => {
    const releaseB = await sem.acquire();
    order.push("b-start");
    releaseB();
  })();

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["a-start"], "b must not start while a holds the permit");
  assert.equal(sem.queued, 1);
  assert.equal(sem.inFlight, 1);

  order.push("a-end");
  releaseA();
  await bDone;
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("callers up to the limit run concurrently", async () => {
  const sem = createSemaphore(3);
  const releases = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
  assert.equal(sem.inFlight, 3);
  assert.equal(sem.queued, 0);
  for (const release of releases) release();
  assert.equal(sem.inFlight, 0);
});

test("releasing twice does not hand out an extra permit", async () => {
  const sem = createSemaphore(1);
  const release = await sem.acquire();
  release();
  release();
  assert.equal(sem.inFlight, 0);
  const second = await sem.acquire();
  assert.equal(sem.inFlight, 1);
  second();
});
test("a limit lowered mid-flight queues the next acquire instead of admitting it", async () => {
  let limit = 3;
  const sem = createSemaphore(() => limit);
  const a = await sem.acquire();
  const b = await sem.acquire();

  limit = 1; // SSR_CONCURRENCY armed while two requests are already in flight
  const queued = sem.acquire();
  assert.equal(sem.queued, 1);

  a(); // one still in flight, which is not below the new limit: the waiter keeps waiting
  assert.equal(sem.queued, 1);
  b();
  await queued;
  assert.equal(sem.inFlight, 1);
});

test("a limit raised back admits every waiter that now fits, not one per release", async () => {
  let limit = 1;
  const sem = createSemaphore(() => limit);
  const held = await sem.acquire();
  const waiters = [sem.acquire(), sem.acquire(), sem.acquire()];
  assert.equal(sem.queued, 3);

  // Disarming must not leave the backlog draining one request per completion — on an idle
  // storefront that would strand them until traffic arrived to release the permits.
  limit = 4;
  held();
  await Promise.all(waiters);
  assert.equal(sem.inFlight, 3);
  assert.equal(sem.queued, 0);
});
