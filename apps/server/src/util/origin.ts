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
 *
 * Two different comparisons live here, and they answer different questions:
 *
 * - `Origin` vs the request's own `Host`: only the host (and port) has to match.
 *   The scheme is left out on purpose — TLS normally terminates at a reverse
 *   proxy, where this process reports `request.protocol === 'http'` while the
 *   browser's `Origin` says `https://`, so comparing schemes would reject the
 *   realtime channel of every such deployment.
 * - `Origin` vs the configured lists (`AUTOGIT_ALLOWED_ORIGINS`,
 *   `AUTOGIT_DEV_ORIGINS`): an entry that names a scheme pins that scheme, so
 *   listing `https://autogit.example.com` no longer accepts
 *   `http://autogit.example.com`. A bare `host[:port]` entry keeps the old
 *   host-only meaning; writing the scheme is the stricter spelling and what the
 *   docs recommend.
 */

/** Request shape the helpers below need; Fastify's `request` satisfies it. */
export interface OriginAwareRequest {
  protocol: string;
  headers: Pick<IncomingHttpHeaders, 'host' | 'origin' | 'upgrade'>;
}

interface Origin {
  /** `http` / `https`, the only schemes a browser `Origin` can have here. */
  scheme: 'http' | 'https';
  /** `host[:port]`, lower-case, default ports dropped by `URL`. */
  host: string;
}

/** Parses an `Origin` header or a bare `Host` header into comparable parts. */
function parseOrigin(value: string, fallbackScheme: string): Origin | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `${fallbackScheme}://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      scheme: url.protocol === 'https:' ? 'https' : 'http',
      host: url.host.toLowerCase(),
    };
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

/**
 * `true` when `origin` is one of the listed origins.
 *
 * Entries are compared as complete origins (scheme + `host[:port]`, both
 * lower-cased) as soon as they name a scheme, so an operator who listed
 * `https://autogit.example.com` does not silently accept
 * `http://autogit.example.com` too. A bare `host[:port]` entry is parsed with
 * the request origin's own scheme and therefore keeps matching either scheme —
 * the behaviour every configuration written before this rule relied on.
 */
function matchesListedOrigin(candidates: readonly string[] | undefined, origin: Origin): boolean {
  for (const candidate of candidates ?? []) {
    const listed = parseOrigin(candidate, origin.scheme);
    if (listed && listed.scheme === origin.scheme && listed.host === origin.host) return true;
  }
  return false;
}

/**
 * `true` when the request's `Origin` names the host it actually arrived on, or
 * an origin the operator listed in `AUTOGIT_ALLOWED_ORIGINS` /
 * `AUTOGIT_DEV_ORIGINS` (an entry that names a scheme has to name the same one).
 *
 * A missing `Origin` is allowed: browsers always send it on WebSocket handshakes
 * and on every non-`GET` request, so its absence means a non-browser client
 * (`curl`, a probe, a script) — nothing a web page can forge, because `Origin` is
 * set by the browser itself and is not scriptable.
 */
export function isTrustedOrigin(request: OriginAwareRequest, policy: OriginPolicy = {}): boolean {
  const rawOrigin = request.headers.origin?.trim();
  if (!rawOrigin) return true;

  const scheme = request.protocol === 'https' ? 'https' : 'http';
  const source = parseOrigin(rawOrigin, scheme);
  if (!source) return false;

  const host = request.headers.host?.trim();
  const target = host ? parseOrigin(host, scheme) : null;
  if (target?.host === source.host) return true;

  if (matchesListedOrigin(policy.allowedOrigins, source)) return true;
  return matchesListedOrigin(policy.devOrigins, source);
}

/** `true` for a WebSocket upgrade (`Upgrade: websocket`). */
export function isWebSocketUpgrade(request: OriginAwareRequest): boolean {
  return request.headers.upgrade?.trim().toLowerCase() === 'websocket';
}
