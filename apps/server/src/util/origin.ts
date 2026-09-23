import type { IncomingHttpHeaders } from 'node:http';

/**
 * Origin checks for requests a browser initiates.
 *
 * AutoGit serves the console from the same origin as the API (development goes
 * through the Vite proxy, production is served by this very server) and
 * registers no CORS layer, so a legitimate `Origin` always names the host the
 * request arrived on. The session cookie is `HttpOnly; SameSite=Lax`, which is
 * what keeps a browser from *attaching* it to cross-site subrequests — but that
 * is a browser-side decision the server never sees. The realtime upgrade is the
 * one request where nothing else stands behind the cookie (no CORS layer, no
 * readable response, and WebSocket `SameSite` handling has varied between
 * engines), so it compares `Origin` with `Host` itself instead of trusting the
 * browser to have withheld the credential.
 */

/** Request shape the helpers below need; Fastify's `request` satisfies it. */
export interface OriginAwareRequest {
  protocol: string;
  headers: Pick<IncomingHttpHeaders, 'host' | 'origin' | 'upgrade'>;
}

interface Authority {
  /** `host[:port]`, lower-case, default ports dropped by `URL`. */
  host: string;
}

/** Parses an `Origin` header or a bare `Host` header into comparable parts. */
function parseAuthority(value: string, fallbackScheme: string): Authority | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `${fallbackScheme}://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { host: url.host.toLowerCase() };
  } catch {
    // `Origin: null` (sandboxed documents, `file://`) and malformed values must
    // never end up equalling a host.
    return null;
  }
}

export interface OriginPolicy {
  /** Extra origins accepted although they do not name the request's own host. */
  allowedOrigins?: readonly string[];
  /**
   * Origins of the local dev console. The Vite dev server proxies with
   * `changeOrigin: true`, so the backend sees `Origin: http://localhost:5173`
   * alongside `Host: 127.0.0.1:4711` and a strict comparison would lock the dev
   * console out of its own realtime channel. Empty outside development (see
   * `RuntimeConfig.devOrigins`), and narrower than "any loopback origin" on
   * purpose: every other page on the machine is same-site for `127.0.0.1` and
   * would carry the session cookie into its handshake.
   */
  devOrigins?: readonly string[];
}

/** `true` when `host` matches one of the listed origin authorities. */
function matchesOrigin(
  candidates: readonly string[] | undefined,
  host: string,
  scheme: string,
): boolean {
  for (const candidate of candidates ?? []) {
    if (parseAuthority(candidate, scheme)?.host === host) return true;
  }
  return false;
}

/**
 * `true` when the request's `Origin` names the host it actually arrived on (or a
 * host the operator listed in `AUTOGIT_ALLOWED_ORIGINS`).
 *
 * A missing `Origin` is allowed: browsers always send it on WebSocket handshakes
 * and on every non-`GET` request, so its absence means a non-browser client
 * (`curl`, a probe, a script) — nothing a web page can forge, because `Origin` is
 * set by the browser itself and is not scriptable.
 */
export function isTrustedOrigin(request: OriginAwareRequest, policy: OriginPolicy = {}): boolean {
  const origin = request.headers.origin?.trim();
  if (!origin) return true;

  const scheme = request.protocol === 'https' ? 'https' : 'http';
  const source = parseAuthority(origin, scheme);
  if (!source) return false;

  const host = request.headers.host?.trim();
  const target = host ? parseAuthority(host, scheme) : null;
  if (target?.host === source.host) return true;

  if (matchesOrigin(policy.allowedOrigins, source.host, scheme)) return true;
  return matchesOrigin(policy.devOrigins, source.host, scheme);
}

/** `true` for a WebSocket upgrade (`Upgrade: websocket`). */
export function isWebSocketUpgrade(request: OriginAwareRequest): boolean {
  return request.headers.upgrade?.trim().toLowerCase() === 'websocket';
}
