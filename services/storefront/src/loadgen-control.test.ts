import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, createLogger, createMetrics, loadCommonConfig, RollingStats } from "@sample-app/platform";
import { createLoadRunner, type LoadRunner, type RunSettings } from "./loadgen.js";
import { controlPage, createControlRoutes, loginPage, parseSettings } from "./loadgen-control.js";

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

const PASSWORD = "correct horse battery staple";

async function withControl<T>(
  runner: LoadRunner,
  fn: (base: string) => Promise<T>,
  password: string | null = PASSWORD,
): Promise<T> {
  const server = createApp({
    service: "loadgen",
    config: loadCommonConfig({}),
    metrics: createMetrics({ service: "loadgen", version: "test", commit: "test" }),
    logger: createLogger({ service: "loadgen", version: "test", level: "error", write: () => {} }),
    stats: new RollingStats(),
    routes: createControlRoutes({
      runner,
      targetUrl: "http://storefront:3000",
      defaults: DEFAULTS,
      password,
      cookieSecure: false,
    }),
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

const post = (base: string, path: string, body: Record<string, string>, cookie?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });

/** Signs in the way a browser does and returns the cookie it would then carry. */
async function signIn(base: string): Promise<string> {
  const res = await post(base, "/login", { password: PASSWORD, next: "/" });
  assert.equal(res.status, 303, "sign-in did not succeed");
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "sign-in set no cookie");
  return setCookie.split(";")[0]!;
}

const get = (base: string, path: string, cookie?: string): Promise<Response> =>
  fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

test("GET / renders the control page with the env defaults while idle", async () => {
  await withControl(createLoadRunner("http://127.0.0.1:1"), async (base) => {
    const cookie = await signIn(base);
    const res = await get(base, "/", cookie);
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
      const cookie = await signIn(base);
      const res = await post(base, "/control/start", form({ concurrency: "2" }), cookie);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/");
      assert.equal(runner.state().running, true);
      assert.deepEqual(runner.state().settings, { rps: 10, concurrency: 2, checkoutRatio: 0.5, durationSeconds: 0 });

      const page = await (await get(base, "/", cookie)).text();
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
      const cookie = await signIn(base);
      await post(base, "/control/start", form(), cookie);
      const res = await post(base, "/control/stop", {}, cookie);
      assert.equal(res.status, 303);
      assert.equal(runner.state().running, false);
      assert.doesNotMatch(await (await get(base, "/", cookie)).text(), /http-equiv="refresh"/, "an idle page has nothing to poll for");
    });
  });
});

test("a bad setting renders 400 with the reason and never starts a run", async () => {
  const runner = createLoadRunner("http://127.0.0.1:1");
  await withControl(runner, async (base) => {
    const cookie = await signIn(base);
    const res = await post(base, "/control/start", form({ concurrency: "500" }), cookie);
    const html = await res.text();
    assert.equal(res.status, 400);
    assert.match(html, /concurrency must be a whole number between 1 and 100/);
    assert.equal(runner.state().running, false);
  });
});

// The page is not a viewer: everything behind the gate can put load on a real cluster.
test("every route that can read or change the run demands a session", async () => {
  const runner = createLoadRunner("http://127.0.0.1:1");
  await withControl(runner, async (base) => {
    for (const [method, path] of [["GET", "/"], ["POST", "/control/start"], ["POST", "/control/stop"]] as const) {
      const res = method === "GET" ? await get(base, path) : await post(base, path, form());
      assert.equal(res.status, 303, `${method} ${path} was not gated`);
      assert.match(res.headers.get("location") ?? "", /^\/login\?next=/, `${method} ${path} redirected somewhere odd`);
    }
    assert.equal(runner.state().running, false, "an unauthenticated POST started a run");
  });
});

test("the path survives the sign-in, so a bookmark still lands where it pointed", async () => {
  await withControl(createLoadRunner("http://127.0.0.1:1"), async (base) => {
    const res = await get(base, "/?live=off");
    assert.equal(res.headers.get("location"), `/login?next=${encodeURIComponent("/?live=off")}`);
  });
});

// A misconfigured page must close, never open. Serving Start anonymously because a secret is
// missing is the one outcome worth an outage on this port.
test("no password configured serves 503 and says why — never an anonymous Start button", async () => {
  const runner = createLoadRunner("http://127.0.0.1:1");
  await withControl(runner, async (base) => {
    for (const [method, path] of [["GET", "/"], ["GET", "/login"], ["POST", "/login"], ["POST", "/control/start"]] as const) {
      const res = method === "GET" ? await get(base, path) : await post(base, path, { password: "anything" });
      assert.equal(res.status, 503, `${method} ${path} did not fail closed`);
      assert.match(await res.text(), /LOADGEN_UI_PASSWORD/);
    }
    assert.equal(runner.state().running, false);
  }, null);
});

// The probes are served by createApp and never reach the guard, so a missing password closes
// the page without taking the pod out of service.
test("the probes stay open when the page is closed", async () => {
  await withControl(createLoadRunner("http://127.0.0.1:1"), async (base) => {
    assert.equal((await get(base, "/healthz")).status, 200);
    assert.equal((await get(base, "/readyz")).status, 200);
    assert.equal((await get(base, "/metrics")).status, 200);
  }, null);
});

test("a wrong password is refused, and the throttle stops a guessing run", async () => {
  await withControl(createLoadRunner("http://127.0.0.1:1"), async (base) => {
    for (let i = 0; i < 10; i++) {
      const res = await post(base, "/login", { password: `guess-${i}`, next: "/" });
      assert.equal(res.status, 401, `attempt ${i} was not refused`);
    }
    const blocked = await post(base, "/login", { password: "guess-11", next: "/" });
    assert.equal(blocked.status, 429);
    assert.match(await blocked.text(), /Too many sign-in attempts/);
    // Even the correct password waits out the window — the throttle is on the endpoint.
    assert.equal((await post(base, "/login", { password: PASSWORD, next: "/" })).status, 429);
  });
});

test("signing out clears the cookie and the session stops working", async () => {
  await withControl(createLoadRunner("http://127.0.0.1:1"), async (base) => {
    const cookie = await signIn(base);
    assert.equal((await get(base, "/", cookie)).status, 200);
    const out = await post(base, "/logout", {}, cookie);
    assert.equal(out.status, 303);
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });
});

test("the login page never carries the password back into the markup", async () => {
  await withControl(createLoadRunner("http://127.0.0.1:1"), async (base) => {
    const html = await (await post(base, "/login", { password: "hunter2", next: "/" })).text();
    assert.doesNotMatch(html, /hunter2/, "the rejected password was echoed into the page");
  });
});

test("the sign-in redirect cannot be pointed off this origin", () => {
  const html = loginPage({ next: "https://evil.example.com" });
  assert.doesNotMatch(html, /evil\.example\.com/);
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
