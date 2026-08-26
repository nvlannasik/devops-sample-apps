import { test } from "node:test";
import assert from "node:assert/strict";
import { authorized, bearerToken, timingSafeEqualStr } from "./bearer.js";

const TOKEN = "s3rvice-t0ken";

test("timingSafeEqualStr compares without throwing on a length mismatch", () => {
  assert.equal(timingSafeEqualStr(TOKEN, TOKEN), true);
  assert.equal(timingSafeEqualStr(TOKEN, `${TOKEN} `), false);
  // Different lengths on purpose: timingSafeEqual throws on unequal buffers, so a comparison
  // that did not digest both sides first would crash here rather than return false.
  assert.equal(timingSafeEqualStr("x", TOKEN), false);
  assert.equal(timingSafeEqualStr("", ""), true);
});

test("bearerToken reads the scheme case-insensitively and rejects the rest", () => {
  assert.equal(bearerToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(bearerToken(`bearer ${TOKEN}`), TOKEN, "RFC 7235 makes the scheme case-insensitive");
  assert.equal(bearerToken(`  Bearer   ${TOKEN}  `), TOKEN);
  for (const header of [undefined, "", TOKEN, `Basic ${TOKEN}`, "Bearer", "Bearer "]) {
    assert.equal(bearerToken(header), null, `accepted ${JSON.stringify(header)}`);
  }
});

test("an unset expectation authorises everything — a local stack needs no credential", () => {
  assert.equal(authorized(undefined, null), true);
  assert.equal(authorized("Bearer anything", null), true);
});

test("a configured expectation admits only the exact token", () => {
  assert.equal(authorized(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(authorized(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(authorized(TOKEN, TOKEN), false, "a bare value is not a bearer credential");
  assert.equal(authorized(undefined, TOKEN), false);
});
