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
  /** Host name without the port; IPv6 literals keep their brackets. */
  hostname: string;
}

/** Parses an `Origin` header or a bare `Host` header into comparable parts. */
function parseAuthority(value: string, fallbackScheme: string): Authority | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `${fallbackScheme}://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase() };
  } catch {
    // `Origin: null` (sandboxed documents, `file://`) and malformed values must
    // never end up equalling a host.
    return null;
  }
}

/** `true` for `localhost`, `127.0.0.0/8` and `::1` (including IPv4-mapped forms). */
export function isLoopbackHost(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    bare.startsWith('127.') ||
    bare.startsWith('::ffff:127.')
  );
}

export interface OriginPolicy {
  /** Extra origins accepted although they do not name the request's own host. */
  allowedOrigins?: readonly string[];
  /**
   * Accept any loopback origin. Only enabled in development: the Vite dev server
   * proxies with `changeOrigin: true`, so the backend sees
   * `Origin: http://localhost:5173` alongside `Host: 127.0.0.1:4711` and a strict
   * comparison would lock the dev console out of its own realtime channel.
   */
  allowLoopback?: boolean;
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

  for (const candidate of policy.allowedOrigins ?? []) {
    if (parseAuthority(candidate, scheme)?.host === source.host) return true;
  }

  return policy.allowLoopback === true && isLoopbackHost(source.hostname);
}

/** `true` for a WebSocket upgrade (`Upgrade: websocket`). */
export function isWebSocketUpgrade(request: OriginAwareRequest): boolean {
  return request.headers.upgrade?.trim().toLowerCase() === 'websocket';
}
