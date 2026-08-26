import * as http from "node:http";
import type { Logger } from "./logger.js";

// Response helpers shared by every route handler. The server itself lives in
// http-server.ts (createApp) — the only server factory services boot.

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

/**
 * Merges caller headers over the defaults BY NAME, not by object key.
 *
 * `"Content-Type"` and `"content-type"` are two different keys in a JavaScript object and the
 * same header on the wire, so spreading one over the other emits both. A browser resolving a
 * duplicate Content-Type takes the first, which is how a stylesheet handed an explicit
 * `text/css` still arrives as `text/plain` and gets refused — the page loads and renders
 * completely unstyled, with a 200 in every log and every metric green.
 *
 * Node's own client reads the last of a duplicate pair, which is why a test asserting the
 * content type passed for as long as this was broken.
 */
function mergeHeaders(
  defaults: Record<string, string | number>,
  overrides: Record<string, string>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(defaults)) out[key.toLowerCase()] = value;
  for (const [key, value] of Object.entries(overrides)) out[key.toLowerCase()] = value;
  return out;
}

export function sendText(
  res: http.ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(
    status,
    mergeHeaders(
      { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) },
      headers,
    ),
  );
  res.end(text);
}

export function listen(
  server: http.Server,
  port: number,
  logger: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      logger.info("listening", { port });
      resolve();
    });
  });
}
