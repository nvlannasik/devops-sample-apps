import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-token auth for service-to-service calls.
 *
 * Deliberately NOT the session-and-login design the load generator's control page uses. That
 * page has a human at the other end; these endpoints have the storefront, which cannot fill in
 * a form. The same distinction the rest of this workspace makes: `MCP_AUTH_TOKEN` between the
 * agent and the MCP server, `ALERT_WEBHOOK_TOKEN` on the alert webhook — one value configured
 * identically on both sides, presented as a bearer token.
 */

/**
 * Constant-time string equality. Hashing both sides to a fixed 32-byte digest first means the
 * comparison never leaks the secret's length and `timingSafeEqual` never throws on a length
 * mismatch. Mirrors `timingSafeEqualStr` in devops-ai-agent and devops-mcp-server.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Pulls the token out of `Authorization: Bearer <token>`, or null if absent or malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Whether a request carries the expected token.
 *
 * An unset expectation authorises everything, matching `ALERT_WEBHOOK_TOKEN` and
 * `MCP_AUTH_TOKEN`: a token nobody configured must not break a local stack. What keeps that
 * from being silent is the caller's boot warning, not this function.
 */
export function authorized(header: string | undefined, expected: string | null): boolean {
  if (!expected) return true;
  const provided = bearerToken(header);
  return provided !== null && timingSafeEqualStr(provided, expected);
}
