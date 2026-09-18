import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ConfigError } from "./config.js";
import { activeFaults, armFault, clearFaults, disarmFault, faultBool, faultInt, faultStr } from "./faults.js";

afterEach(() => clearFaults());

test("an unarmed knob reads the value the environment gave it", () => {
  assert.equal(faultInt("SSR_CONCURRENCY", 32), 32);
  assert.equal(faultStr("ASSET_VERSION", "abc123"), "abc123");
  assert.equal(faultBool("LIVENESS_CHECKS_DB", false), false);
});

test("an armed knob overrides the boot value until it is disarmed", () => {
  armFault("SSR_CONCURRENCY", "1", 60);
  assert.equal(faultInt("SSR_CONCURRENCY", 32), 1);
  assert.equal(disarmFault("SSR_CONCURRENCY"), true);
  assert.equal(faultInt("SSR_CONCURRENCY", 32), 32);
  // Disarming something that was never armed is not an error, but it is not a disarm either:
  // the endpoint logs a WARN only for the true case.
  assert.equal(disarmFault("SSR_CONCURRENCY"), false);
});

test("a knob lapses on its own, with nobody calling disarm", () => {
  armFault("GATEWAY_TIMEOUT_MS", "50", -1);
  assert.equal(faultInt("GATEWAY_TIMEOUT_MS", 2000), 2000);
  assert.deepEqual(activeFaults(), []);
});

test("activeFaults reports what is armed, and drops what has lapsed", () => {
  armFault("ASSET_VERSION", "stale", 60);
  armFault("GATEWAY_TIMEOUT_MS", "50", -1);
  assert.deepEqual(activeFaults().map((f) => f.key), ["ASSET_VERSION"]);
});

test("the override goes through the same parser the environment variable does", () => {
  // Not defence against a hostile value — the endpoint only ever stores a knob's declared
  // `armed` string. It is defence against a typo in that declaration reaching production as a
  // silently wrong number instead of a loud boot-style error.
  armFault("SSR_CONCURRENCY", "not-a-number", 60);
  assert.throws(() => faultInt("SSR_CONCURRENCY", 32), ConfigError);
  clearFaults();
  armFault("SSR_CONCURRENCY", "0", 60);
  assert.throws(() => faultInt("SSR_CONCURRENCY", 32, { min: 1 }), ConfigError);
});
