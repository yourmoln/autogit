import type { AuthSession } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { AUTH_SESSION_COOKIE, sessionCookieMaxAge } from '../services/auth.js';
import { readCookie, serializeCookie } from '../util/cookies.js';
import { API_PREFIX, decodeRequestPath, isApiPath } from '../util/http.js';
import { isTrustedOrigin, isWebSocketUpgrade } from '../util/origin.js';
import { registerAccountRoutes } from './accounts.js';
import { registerAuthRoutes } from './auth.js';
import { registerCodexRoutes } from './codex.js';
import { registerProxyRoutes } from './proxy.js';
import { registerRepositoryRoutes } from './repositories.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSystemRoutes } from './system.js';
import { registerTaskRoutes } from './tasks.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Session resolved by the auth guard; `null` on public endpoints. */
    authSession: AuthSession | null;
    /** SHA-256 of the cookie that produced `authSession`; `null` without one. */
    authSessionHash: string | null;
    /** `true` when this request slid the session forward. */
    authSessionRenewed: boolean;
  }
}

/**
 * Endpoints the login page needs before a session exists.
 *
 * Everything else under `/api` (including the realtime WebSocket) requires a
 * valid session cookie — AutoGit refuses to run a single operation without it.
 * `health` is on the list because it is a probe endpoint: systemd, container
 * healthchecks and uptime monitors run without a session, and returning `401`
 * there turns "the process is up" into a permanently failing check. It answers
 * with nothing but uptime, version and the Node version.
 * `logout` is public on purpose: it can only revoke the session named by the
 * request's own cookie, and it must still work when that session already
 * expired (clicking "退出登录" should never fail).
 *
 * These are routing templates as the router reports them (`routeOptions.url`),
 * never raw request paths: see the guard in `registerRoutes()`.
 */
const PUBLIC_API_ROUTES = new Set([
  `${API_PREFIX}/auth/login`,
  `${API_PREFIX}/auth/session`,
  `${API_PREFIX}/auth/logout`,
  `${API_PREFIX}/health`,
]);

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('authSession', null);
  app.decorateRequest('authSessionHash', null);
  app.decorateRequest('authSessionRenewed', false);

  app.addHook('onRequest', async (request, reply) => {
    // Decide on the route the router actually matched, never on `request.url`:
    // find-my-way matches percent-decoded paths, so `/%61pi/system/overview` runs
    // the `/api/system/overview` handler while the raw URL still reads `/%61pi/…`.
    // Comparing raw strings let that spelling through with a 200 (and with it
    // every read and write endpoint, including the realtime upgrade). Requests
    // that matched no route only reach the 404 / SPA handler, but they are checked
    // against the decoded path too, so an encoded `/api` prefix can neither run a
    // handler nor pick the public allowlist.
    const matchedRoute = request.routeOptions?.url;
    const path =
      typeof matchedRoute === 'string' && matchedRoute.length > 0
        ? matchedRoute
        : decodeRequestPath(request.url);
    if (!isApiPath(path)) return;
    // No method gets a free pass — OPTIONS included. The guard used to return
    // early for `OPTIONS` "because it has no body", which is a standing exemption
    // on a security-critical path: the day an OPTIONS route (preflight help, API
    // docs, a health probe) is registered under `/api`, it would run unauthenticated.
    // AutoGit serves the console same-origin and registers no CORS layer, so no
    // preflight needs an answer here; an unauthenticated OPTIONS now gets 401.

    const resolved = ctx.auth.resolveSession(
      readCookie(request.headers.cookie, AUTH_SESSION_COOKIE),
    );
    if (resolved) {
      request.authSession = resolved.session;
      request.authSessionHash = resolved.tokenHash;
      request.authSessionRenewed = resolved.renewed;
    }

    // Public routes may still carry a session — resolving it here is what keeps
    // "保持登录" sliding and lets `GET /api/auth/session` answer without a second
    // lookup — they just do not require one.
    if (PUBLIC_API_ROUTES.has(path)) return;
    if (!resolved) {
      return reply.code(401).send({ error: '登录状态已失效，请重新登录' });
    }
    // A valid cookie is not by itself proof of a same-origin console. The
    // realtime upgrade is replied to with a `101`, so it cannot be protected the
    // way the JSON API is (no readable response, no CORS layer to fall back on)
    // and `SameSite=Lax` is enforced by the browser, not by this process. Compare
    // `Origin` with the host the handshake arrived on and refuse the upgrade
    // otherwise — authenticated cross-site pages then get a `403` instead of a
    // socket that streams every task log to them. Non-browser clients send no
    // `Origin` at all and keep working; see `util/origin.ts` for the details.
    if (
      isWebSocketUpgrade(request) &&
      !isTrustedOrigin(request, {
        allowedOrigins: ctx.config.allowedOrigins,
        allowLoopback: ctx.config.isDev,
      })
    ) {
      return reply.code(403).send({ error: '跨站来源的实时连接已被拒绝' });
    }
  });

  // `resolveSession()` moved the stored expiry forward, so the cookie has to
  // move with it: a `Max-Age` fixed on login day would throw an every-day user
  // out on day 30 even though the session in the database never expired.
  app.addHook('onSend', async (request, reply) => {
    const session = request.authSession;
    if (!request.authSessionRenewed || !session) return;
    // login / logout / credential rotation write their own cookie; this hook runs
    // after the route handler, so it must never clobber those.
    if (reply.getHeader('set-cookie') !== undefined) return;

    const token = readCookie(request.headers.cookie, AUTH_SESSION_COOKIE);
    if (!token) return;
    reply.header(
      'set-cookie',
      serializeCookie(AUTH_SESSION_COOKIE, token, {
        maxAgeSeconds: sessionCookieMaxAge(session),
        secure: request.protocol === 'https',
      }),
    );
  });

  registerAuthRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerRepositoryRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerCodexRoutes(app, ctx);
  registerProxyRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
}
