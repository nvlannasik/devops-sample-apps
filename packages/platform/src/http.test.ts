import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { sendHtml, sendJson, sendText } from "./http.js";

/** Returns the RAW header list, so a duplicate is visible instead of being joined away. */
async function rawHeaders(handler: (res: http.ServerResponse) => void): Promise<string[]> {
  const server = http.createServer((_req, res) => handler(res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string[]>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.rawHeaders));
        })
        .on("error", reject);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function contentTypeValues(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "content-type") out.push(raw[i + 1]!);
  }
  return out;
}

// The bug this pins: "Content-Type" and "content-type" are different object keys and the same
// header. Emitting both makes a browser take the FIRST — a stylesheet explicitly served as
// text/css arrives as text/plain and is refused, with a 200 in every log and no metric moving.
// Node's own client reads the LAST, which is why this survived a test that asked for the
// content type by name.
test("a caller's content-type replaces the default instead of joining it", async () => {
  const raw = await rawHeaders((res) =>
    sendText(res, 200, "body {}", { "content-type": "text/css; charset=utf-8" }),
  );
  assert.deepEqual(contentTypeValues(raw), ["text/css; charset=utf-8"]);
});

test("case is not what decides an override", async () => {
  for (const name of ["Content-Type", "CONTENT-TYPE", "content-type"]) {
    const raw = await rawHeaders((res) => sendText(res, 200, "x", { [name]: "text/css" }));
    assert.deepEqual(contentTypeValues(raw), ["text/css"], `${name} did not override`);
  }
});

test("extra headers still arrive, and the default stands when nothing overrides it", async () => {
  const raw = await rawHeaders((res) => sendText(res, 200, "x", { "cache-control": "public, max-age=60" }));
  assert.deepEqual(contentTypeValues(raw), ["text/plain; charset=utf-8"]);
  const names = raw.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
  assert.ok(names.includes("cache-control"));
  assert.equal(names.filter((n) => n === "content-length").length, 1);
});

test("sendJson and sendHtml each send exactly one content-type", async () => {
  assert.deepEqual(contentTypeValues(await rawHeaders((res) => sendJson(res, 200, { ok: true }))), ["application/json"]);
  assert.deepEqual(contentTypeValues(await rawHeaders((res) => sendHtml(res, 200, "<p>x</p>"))), ["text/html; charset=utf-8"]);
});
