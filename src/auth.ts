/**
 * Bearer-token authentication and the bind guard (architecture §16, decision 0014).
 * One owner, one token: the CLI and agents send `Authorization: Bearer <token>`; the dashboard
 * trades the token for an HttpOnly cookie via POST /api/login so EventSource works too.
 */
import type http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "orch_token";

/** Hosts that only accept connections from this machine. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison of two strings of any length (SHA-256 digests have equal length). */
export function tokenMatches(given: string, token: string): boolean {
  return timingSafeEqual(digest(given), digest(token));
}

/** The token from `Authorization: Bearer …` or the `orch_token` cookie, if either is present. */
function presentedTokens(req: Pick<http.IncomingMessage, "headers">): string[] {
  const out: string[] = [];
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) out.push(m[1].trim());
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const i = part.indexOf("=");
      if (i < 0 || part.slice(0, i).trim() !== COOKIE_NAME) continue;
      try { out.push(decodeURIComponent(part.slice(i + 1).trim())); } catch { /* malformed: ignore */ }
    }
  }
  return out;
}

/** True when no token is configured (auth off), or the request carries the right one. */
export function isAuthorized(req: Pick<http.IncomingMessage, "headers">, token: string): boolean {
  if (!token) return true;
  return presentedTokens(req).some((t) => tokenMatches(t, token));
}

/** `Set-Cookie` value for a dashboard login. Lasts a year, so the browser asks once. */
export function loginCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

/**
 * Startup check: listening on a non-loopback address needs a token unless the owner opted out.
 * Returns the error message to print, or null when it is safe to listen.
 */
export function bindGuard({ host, token, allowInsecure }: { host: string; token: string; allowInsecure: boolean }): string | null {
  if (token || allowInsecure || LOOPBACK.has(host.trim().toLowerCase())) return null;
  return (
    `refusing to listen on ${host} without an access token: anyone who can reach this port could control agents.\n` +
    `Set auth.token (or the ORCH_TOKEN environment variable), or set auth.allowInsecure: true to accept the risk, ` +
    `or bind to 127.0.0.1.`
  );
}

/** The configured token: ORCH_TOKEN wins over the settings file (§16). */
export function resolveToken(fromConfig: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return (env.ORCH_TOKEN ?? "").trim() || (fromConfig ?? "").trim();
}
