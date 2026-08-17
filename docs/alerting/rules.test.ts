import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMetrics } from "@sample-app/platform";

const rules = readFileSync(fileURLToPath(new URL("./sample-app-rules.yaml", import.meta.url)), "utf8");

test("every alert the spec names is defined", () => {
  for (const name of [
    "SampleAppHighErrorRate",
    "SampleAppHighLatency",
    "SampleAppSettlementBacklog",
    "SampleAppTargetDown",
    "SampleAppNotReady",
    "SampleAppNoEndpoints",
  ]) {
    assert.match(rules, new RegExp(`alert: ${name}\\b`), `missing rule ${name}`);
  }
});

test("every app metric a rule queries is actually exported", async () => {
  const metrics = await createMetrics({ service: "orders-api", version: "test", commit: "test" }).registry.metrics();
  for (const metric of [
    "http_server_requests_total",
    "http_server_request_duration_seconds",
    "queue_oldest_job_age_seconds",
  ]) {
    assert.ok(rules.includes(metric), `no rule references ${metric}`);
    assert.ok(metrics.includes(metric), `${metric} is referenced by a rule but not exported`);
  }
});

test("no rule names a cause — a cause-level alert hands the agent the answer", () => {
  for (const forbidden of ["PoolExhausted", "CacheDisabled", "BadConfig", "WrongVersion", "Timeout"]) {
    assert.doesNotMatch(rules, new RegExp(`alert: \\w*${forbidden}`), `${forbidden} states a cause`);
  }
});

test("every rule carries a severity and both annotations", () => {
  const blocks = rules.split(/^\s*- alert: /m).slice(1);
  assert.equal(blocks.length, 6);
  for (const block of blocks) {
    assert.match(block, /severity: (critical|warning)/);
    assert.match(block, /summary:/);
    assert.match(block, /description:/);
  }
});

test("the scrape job and namespace selectors match the deployment contract", () => {
  assert.ok(rules.includes(`job="sample-app"`));
  assert.ok(rules.includes(`namespace=~"sample-app.*"`));
});