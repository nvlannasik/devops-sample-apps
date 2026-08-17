import type { Metrics } from "./metrics.js";

export type DownstreamErrorKind = "timeout" | "network" | "status" | "parse";

export class DownstreamError extends Error {
  readonly peer: string;
  readonly kind: DownstreamErrorKind;
  readonly status?: number;

  constructor(message: string, opts: { peer: string; kind: DownstreamErrorKind; status?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "DownstreamError";
    this.peer = opts.peer;
    this.kind = opts.kind;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

/** A caller that gave up first is a gateway timeout; anything else is a bad gateway. */
export function statusForDownstream(err: DownstreamError): number {
  return err.kind === "timeout" ? 504 : 502;
}

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface HttpClient {
  getJson<T>(peer: string, url: string, opts?: RequestOptions): Promise<T>;
  postJson<T>(peer: string, url: string, body: unknown, opts?: RequestOptions): Promise<T>;
}

export interface HttpClientDeps {
  service: string;
  metrics: Metrics;
  /** DOWNSTREAM_TIMEOUT_MS / GATEWAY_TIMEOUT_MS — the fault knob. */
  timeoutMs: number;
}

/**
 * `peer` is the logical service name, never the URL: it is a metric label, and the URL
 * would make http_client_* unbounded.
 */
export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const request = async <T>(peer: string, url: string, init: RequestInit, opts: RequestOptions): Promise<T> => {
    const startedAt = process.hrtime.bigint();
    const observe = (status: string): void => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      deps.metrics.httpClientRequests.inc({ service: deps.service, peer, status });
      deps.metrics.httpClientDuration.observe({ service: deps.service, peer }, seconds);
    };

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? deps.timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      observe(timedOut ? "timeout" : "error");
      throw new DownstreamError(
        timedOut ? `${peer} timed out after ${opts.timeoutMs ?? deps.timeoutMs}ms` : `${peer} unreachable: ${String(err)}`,
        { peer, kind: timedOut ? "timeout" : "network", cause: err },
      );
    }

    observe(String(res.status));
    const text = await res.text();

    if (!res.ok) {
      throw new DownstreamError(`${peer} returned ${res.status}: ${text.slice(0, 200)}`, {
        peer,
        kind: "status",
        status: res.status,
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new DownstreamError(`${peer} returned unparseable JSON: ${text.slice(0, 200)}`, {
        peer,
        kind: "parse",
        status: res.status,
        cause: err,
      });
    }
  };

  return {
    getJson: (peer, url, opts = {}) =>
      request(peer, url, { method: "GET", headers: { accept: "application/json", ...opts.headers } }, opts),
    postJson: (peer, url, body, opts = {}) =>
      request(
        peer,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...opts.headers },
          body: JSON.stringify(body),
        },
        opts,
      ),
  };
}