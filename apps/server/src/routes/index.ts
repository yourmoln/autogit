import type { AuthSession } from '@autogit/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from '../context.js';
import { AUTH_SESSION_COOKIE, sessionCookieMaxAge } from '../services/auth.js';
import { readCookie, serializeCookie } from '../util/cookies.js';
import { API_PREFIX, decodeRequestPath, isApiPath } from '../util/http.js';
import { logger } from '../util/logger.js';
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

/**
 * Methods that carry no state change of their own.
 *
 * `GET`/`HEAD` are read-only, and `OPTIONS` is skipped on purpose: AutoGit
 * answers no preflight (same-origin console, no CORS layer), so such a request
 * cannot do anything. The origin comparison is only there to keep other pages
 * from *triggering* things, not from reading them.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Answers a write that came from neither this host nor a listed origin.
 *
 * Writes used to stand on the session cookie alone, and `SameSite=Lax` only
 * keeps *cross-site* pages from attaching it: a page on the same site but another
 * port (127.0.0.1:5173, a stray local server) sends the cookie along, and a
 * request without a body is a simple request the browser performs without a
 * preflight — the server would never see anything but a valid session. So the
 * origin is compared here, with the same policy as the realtime upgrade and the
 * same escape hatch (`AUTOGIT_ALLOWED_ORIGINS`) for reverse proxies that rewrite
 * `Host`. Callers that send no `Origin` at all (curl, probes, scripts) keep
 * working: a browser always sends one and cannot script it away; see
 * `util/origin.ts`.
 */
function rejectUntrustedWrite(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  logger().warn(
    { origin: request.headers.origin, host: request.headers.host, method: request.method },
    '来源不在信任列表的写请求，已拒绝（反向代理改写 Host 时用 AUTOGIT_ALLOWED_ORIGINS 声明）',
  );
  return reply.code(403).send({ error: '跨站来源的写请求已被拒绝' });
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('authSession', null);
  app.decorateRequest('authSessionHash', null);
  app.decorateRequest('authSessionRenewed', false);

  // One policy object for both places that compare `Origin` with the host a
  // request arrived on — the realtime upgrade and the write gate below. They ask
  // the same question, so they must answer it the same way.
  const originPolicy = {
    allowedOrigins: ctx.config.allowedOrigins,
    // Development only: the local Vite dev server, which reaches this process
    // through a proxy that rewrites `Host`. Empty in production and limited to
    // the dev server's own origins, so a page on another local port — same-site
    // for 127.0.0.1, hence able to carry the Lax cookie — can neither subscribe
    // to task logs nor drive the API. See `config.devOrigins`.
    devOrigins: ctx.config.devOrigins,
  };

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

    // `Origin` decides which pages may *act*: reads keep running on the session
    // alone (they change nothing, and with no CORS layer another site cannot read
    // the answer), `OPTIONS` is exempt so the guard keeps answering "no preflight"
    // rather than a `403`, and every other method has to name this host or an
    // origin the operator listed. Non-browser callers send no `Origin` at all and
    // keep working; see `util/origin.ts`.
    const trustedOrigin = isTrustedOrigin(request, originPolicy);
    const trustedWrite = SAFE_METHODS.has(request.method) || trustedOrigin;

    // Public routes may still carry a session — resolving it here is what keeps
    // "保持登录" sliding and lets `GET /api/auth/session` answer without a second
    // lookup — they just do not require one. The write gate is not a session
    // rule, though, so public writes stay behind it: `POST /api/auth/login` runs
    // without a session and a cross-site page reaching it could point this
    // browser at an account the attacker controls.
    if (PUBLIC_API_ROUTES.has(path)) {
      if (!trustedWrite) return rejectUntrustedWrite(request, reply);
      return;
    }
    if (!resolved) {
      return reply.code(401).send({ error: '登录状态已失效，请重新登录' });
    }
    // Session first, so an anonymous caller cannot use the status code to learn
    // whether an origin is trusted; then the write gate. It used to cover the
    // realtime upgrade only, which left a page on any other local port able to
    // start a poll, restart the scheduler or invalidate the model probe just by
    // loading a URL.
    if (!trustedWrite) return rejectUntrustedWrite(request, reply);
    // A valid cookie is not by itself proof of a same-origin console. The
    // realtime upgrade is replied to with a `101`, so it cannot be protected the
    // way the JSON API is (no readable response, no CORS layer to fall back on)
    // and `SameSite=Lax` is enforced by the browser, not by this process. Compare
    // `Origin` with the host the handshake arrived on and refuse the upgrade
    // otherwise — authenticated cross-site pages then get a `403` instead of a
    // socket that streams every task log to them. Non-browser clients send no
    // `Origin` at all and keep working; see `util/origin.ts` for the details.
    if (isWebSocketUpgrade(request) && !trustedOrigin) {
      // The one legitimate victim of this rule is a dev console whose Vite port
      // is not in `devOrigins` (5173 was taken, so Vite moved on). Name the
      // origin instead of leaving a socket that silently never opens. The
      // session is already verified at this point, so an anonymous stranger
      // cannot use this line to fill the log.
      logger().warn(
        { origin: request.headers.origin, host: request.headers.host },
        '实时连接来源不在信任列表，已拒绝（开发服务器换了端口时用 AUTOGIT_DEV_ORIGINS 声明）',
      );
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
