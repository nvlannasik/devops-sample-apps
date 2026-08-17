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