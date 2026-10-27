import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The regression this guards (2026-10-27): every service is ESM, and `import * as http from
// "node:http"` is hoisted above the initTracing() call that used to sit in index.ts — so
// HttpInstrumentation patched a module the app had already bound, and Jaeger received nothing
// from any service for as long as it had run, while each one logged "tracing enabled". A unit
// test of initTracing cannot see that; only a real ESM process can. So this runs one: the
// built preload, an app that imports node:http the way platform does and calls a peer with
// fetch the way http-client.ts does, and a fake OTLP receiver that records what arrives.
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

test("with the preload, an ESM app's server and fetch calls arrive as one trace", async () => {
  const bodies: Array<{ resourceSpans: any[] }> = [];
  const receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/v1/traces") bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const port = (receiver.address() as { port: number }).port;

  const dir = mkdtempSync(join(tmpdir(), "otel-esm-"));
  const app = join(dir, "app.mjs");
  writeFileSync(
    app,
    `import * as http from "node:http";
     import { activeTracing } from ${JSON.stringify(pathToFileURL(join(DIST, "tracing.js")).href)};
     const srv = http.createServer((req, res) => res.end("ok"));
     await new Promise((r) => srv.listen(0, "127.0.0.1", r));
     await (await fetch("http://127.0.0.1:" + srv.address().port + "/orders")).text();
     srv.close();
     await activeTracing()?.shutdown();`
  );
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, ["--import", join(DIST, "tracing-preload.js"), app], {
      env: { ...process.env, OTEL_SERVICE_NAME: "probe-svc", OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, LOG_LEVEL: "error" },
      stdio: "inherit",
    });
    child.on("exit", resolve);
  });
  receiver.close();
  assert.equal(code, 0);

  const spans = bodies.flatMap((b) =>
    b.resourceSpans.flatMap((rs) => {
      const svc = rs.resource.attributes.find((a: any) => a.key === "service.name")?.value.stringValue;
      return rs.scopeSpans.flatMap((ss: any) => ss.spans.map((s: any) => ({ ...s, svc, scope: ss.scope.name })));
    })
  );
  const server = spans.find((s) => s.kind === 2); // SPAN_KIND_SERVER
  const client = spans.find((s) => s.kind === 3); // SPAN_KIND_CLIENT
  assert.ok(server, "the server span — node:http imported as an ESM namespace was instrumented");
  assert.ok(client, "the client span — fetch (undici) was instrumented");
  assert.equal(server.svc, "probe-svc", "OTEL_SERVICE_NAME names the resource");
  assert.match(client.scope, /undici/);
  assert.equal(server.traceId, client.traceId, "fetch carried traceparent, so both hops are one trace");
});
