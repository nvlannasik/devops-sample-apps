import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteParams = Record<string, string>;

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: RouteParams;
  url: URL;
  readBody: () => Promise<string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface Route {
  method: string;
  /** The metric label. `/orders/:id`, never a raw path. */
  pattern: string;
  handler: RouteHandler;
}

/** Every unrouted request shares one label, so a 404 scan cannot explode cardinality. */
export const UNMATCHED_ROUTE = "__unmatched__";

const segments = (p: string): string[] => p.split("/").filter((s) => s.length > 0);

export function matchPath(pattern: string, pathname: string): RouteParams | null {
  const want = segments(pattern);
  const got = segments(pathname);
  if (want.length !== got.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) {
      params[w.slice(1)] = decodeURIComponent(g);
      continue;
    }
    if (w !== g) return null;
  }
  return params;
}

export function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: RouteParams } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}

const MAX_BODY_BYTES = 1_000_000;

export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}