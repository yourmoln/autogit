import type { AuthSession } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { AUTH_SESSION_COOKIE } from '../services/auth.js';
import { readCookie } from '../util/cookies.js';
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
  }
}

/**
 * Endpoints the login page needs before a session exists.
 *
 * Everything else under `/api` (including the realtime WebSocket) requires a
 * valid session cookie — AutoGit refuses to run a single operation without it.
 * `logout` is public on purpose: it can only revoke the session named by the
 * request's own cookie, and it must still work when that session already
 * expired (clicking "退出登录" should never fail).
 */
const PUBLIC_API_ROUTES = new Set(['/api/auth/login', '/api/auth/session', '/api/auth/logout']);

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('authSession', null);

  app.addHook('onRequest', async (request, reply) => {
    const path = (request.url.split('?')[0] ?? '').replace(/\/+$/, '');
    if (path !== '/api' && !path.startsWith('/api/')) return;
    // CORS preflight carries no credentials by design.
    if (request.method === 'OPTIONS') return;
    if (PUBLIC_API_ROUTES.has(path)) return;

    const session = ctx.auth.resolveSession(
      readCookie(request.headers.cookie, AUTH_SESSION_COOKIE),
    );
    if (!session) {
      return reply.code(401).send({ error: '登录状态已失效，请重新登录' });
    }
    request.authSession = session;
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
