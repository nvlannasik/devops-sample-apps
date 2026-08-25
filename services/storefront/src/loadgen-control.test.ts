import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, createLogger, createMetrics, loadCommonConfig, RollingStats } from "@sample-app/platform";
import { createLoadRunner, type LoadRunner, type RunSettings } from "./loadgen.js";
import { controlPage, createControlRoutes, parseSettings } from "./loadgen-control.js";

const DEFAULTS: RunSettings = { rps: 5, concurrency: 1, checkoutRatio: 0.3, durationSeconds: 0 };

const form = (over: Partial<Record<keyof RunSettings, string>> = {}): Record<string, string> => ({
  rps: "10",
  concurrency: "4",
  checkoutRatio: "0.5",
  durationSeconds: "0",
  ...over,
});

test("parseSettings accepts a well-formed control form", () => {
  assert.deepEqual(parseSettings(form()), { rps: 10, concurrency: 4, checkoutRatio: 0.5, durationSeconds: 0 });
});

test("parseSettings rejects values outside the bounds the env loader uses", () => {
  assert.throws(() => parseSettings(form({ rps: "0" })), /rps/);
  assert.throws(() => parseSettings(form({ rps: "10001" })), /rps/);
  assert.throws(() => parseSettings(form({ concurrency: "0" })), /concurrency/);
  assert.throws(() => parseSettings(form({ concurrency: "101" })), /concurrency/);
  assert.throws(() => parseSettings(form({ checkoutRatio: "1.5" })), /checkoutRatio/);
  assert.throws(() => parseSettings(form({ durationSeconds: "-1" })), /durationSeconds/);
});

test("parseSettings rejects a fractional rps rather than silently truncating it", () => {
  assert.throws(() => parseSettings(form({ rps: "2.5" })), /rps/);
  assert.throws(() => parseSettings(form({ rps: "" })), /rps/);
});

/** Counts requests and the high-water mark of concurrent ones. */
async function withTarget<T>(
  fn: (base: string, seen: { requests: number; maxInFlight: number }) => Promise<T>,
  delayMs = 0,
): Promise<T> {
  const seen = { requests: 0, maxInFlight: 0 };
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    seen.requests++;
    inFlight++;
    seen.maxInFlight = Math.max(seen.maxInFlight, inFlight);
    const finish = (): void => {
      inFlight--;
      if (req.method === "POST") {
        res.writeHead(303, { location: "/orders/018f0000-0000-4000-8000-000000000001" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>ok</body></html>");
    };
    if (delayMs) setTimeout(finish, delayMs);
    else finish();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a runner starts idle and reports no run", () => {
  const runner = createLoadRunner("http://127.0.0.1:1");
  const state = runner.state();
  assert.equal(state.running, false);
  assert.equal(state.startedAt, null);
  assert.equal(state.stats.requests, 0);
});

test("start drives the target and stop ends it — no request lands after stop returns", async () => {
  await withTarget(async (base, seen) => {
    const runner = createLoadRunner(base);
    await runner.start({ rps: 200, concurrency: 2, checkoutRatio: 0, durationSeconds: 0 });
    assert.equal(runner.state().running, true);
    await settle(150);
    await runner.stop();

    assert.equal(runner.state().running, false);
    const afterStop = seen.requests;
    await settle(120);
    assert.equal(seen.requests, afterStop, "the loop kept driving after stop resolved");
    assert.ok(afterStop > 0, "no traffic was generated at all");
  });
});

// The whole reason concurrency is a knob: one worker is one in-flight request, so a single
// worker can never make a server with SSR_CONCURRENCY=1 or DB_POOL_MAX=1 queue.
test("concurrency N really puts N requests in flight at once", async () => {
  await withTarget(async (base, seen) => {
    const runner = createLoadRunner(base);
    await runner.start({ rps: 100, concurrency: 5, checkoutRatio: 0, durationSeconds: 0 });
    await settle(200);
    await runner.stop();
    assert.ok(seen.maxInFlight >= 3, `expected concurrent requests, saw at most ${seen.maxInFlight}`);
  }, 60);
});

test("one worker never exceeds one request in flight", async () => {
  await withTarget(async (base, seen) => {
    const runner = createLoadRunner(base);
    await runner.start({ rps: 100, concurrency: 1, checkoutRatio: 0, durationSeconds: 0 });
    await settle(200);
    await runner.stop();
    assert.equal(seen.maxInFlight, 1);
  }, 60);
});

test("restarting applies the new settings and resets the counters", async () => {
  await withTarget(async (base) => {
    const runner = createLoadRunner(base);
    await runner.start({ rps: 200, concurrency: 1, checkoutRatio: 0, durationSeconds: 0 });
    await settle(120);
    assert.ok(runner.state().stats.requests > 0);

    await runner.start({ rps: 50, concurrency: 3, checkoutRatio: 1, durationSeconds: 0 });
    const state = runner.state();
    assert.deepEqual(state.settings, { rps: 50, concurrency: 3, checkoutRatio: 1, durationSeconds: 0 });
    // A carried-over error count would make the first reading after a fix look like no fix.
    assert.equal(state.stats.requests, 0);
    await runner.stop();
  });
});

test("a bounded run clears the running flag on its own", async () => {
  await withTarget(async (base) => {
    const runner = createLoadRunner(base);
    await runner.start({ rps: 100, concurrency: 1, checkoutRatio: 0, durationSeconds: 0 });
    await runner.stop();
    assert.equal(runner.state().running, false);
    assert.ok(runner.state().seconds >= 0);
  });
});

test("stop is safe on an idle runner", async () => {
  const runner = createLoadRunner("http://127.0.0.1:1");
  await runner.stop();
  await runner.stop();
  assert.equal(runner.state().running, false);
});

async function withControl<T>(runner: LoadRunner, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createApp({
    service: "loadgen",
    config: loadCommonConfig({}),
    metrics: createMetrics({ service: "loadgen", version: "test", commit: "test" }),
    logger: createLogger({ service: "loadgen", version: "test", level: "error", write: () => {} }),
    stats: new RollingStats(),
    routes: createControlRoutes({ runner, targetUrl: "http://storefront:3000", defaults: DEFAULTS }),
    readiness: async () => ({ ok: true }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (base: string, path: string, body: Record<string, string>): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

test("GET / renders the control page with the env defaults while idle", async () => {
  await withControl(createLoadRunner("http://127.0.0.1:1"), async (base) => {
    const res = await fetch(base);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /value="5"/, "the rps field is seeded from the defaults");
    assert.match(html, /state-idle/);
    assert.match(html, /http:\/\/storefront:3000/);
  });
});

test("POST /control/start starts the run and redirects — a refresh must not re-submit", async () => {
  await withTarget(async (target) => {
    const runner = createLoadRunner(target);
    await withControl(runner, async (base) => {
      const res = await post(base, "/control/start", form({ concurrency: "2" }));
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/");
      assert.equal(runner.state().running, true);
      assert.deepEqual(runner.state().settings, { rps: 10, concurrency: 2, checkoutRatio: 0.5, durationSeconds: 0 });

      const page = await (await fetch(base)).text();
      assert.match(page, /state-running/);
      assert.match(page, /http-equiv="refresh"/, "a running page refreshes itself");
    });
    await runner.stop();
  });
});

test("POST /control/stop returns the runner to idle", async () => {
  await withTarget(async (target) => {
    const runner = createLoadRunner(target);
    await withControl(runner, async (base) => {
      await post(base, "/control/start", form());
      const res = await post(base, "/control/stop", {});
      assert.equal(res.status, 303);
      assert.equal(runner.state().running, false);
      assert.doesNotMatch(await (await fetch(base)).text(), /http-equiv="refresh"/, "an idle page has nothing to poll for");
    });
  });
});

test("a bad setting renders 400 with the reason and never starts a run", async () => {
  const runner = createLoadRunner("http://127.0.0.1:1");
  await withControl(runner, async (base) => {
    const res = await post(base, "/control/start", form({ concurrency: "500" }));
    const html = await res.text();
    assert.equal(res.status, 400);
    assert.match(html, /concurrency must be a whole number between 1 and 100/);
    assert.equal(runner.state().running, false);
  });
});

test("the control page carries no client JavaScript — the same rule the storefront keeps", () => {
  const html = controlPage({
    state: createLoadRunner("http://127.0.0.1:1").state(),
    targetUrl: "http://storefront:3000",
    defaults: DEFAULTS,
  });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test("an operator-supplied target url is escaped, never interpolated raw", () => {
  const html = controlPage({
    state: createLoadRunner("http://127.0.0.1:1").state(),
    targetUrl: `http://x/"><script>alert(1)</script>`,
    defaults: DEFAULTS,
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("the error banner is escaped too", () => {
  const html = controlPage({
    state: createLoadRunner("http://127.0.0.1:1").state(),
    targetUrl: "http://storefront:3000",
    defaults: DEFAULTS,
    error: `<img src=x onerror=alert(1)>`,
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});
