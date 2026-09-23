import type { AuthSessionPayload } from '@autogit/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { AUTH_SESSION_COOKIE, type AuthLoginResult } from '../services/auth.js';
import { clearCookie, readCookie, serializeCookie } from '../util/cookies.js';
import { parseOrThrow } from '../util/http.js';

const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名').max(64),
  password: z.string().min(1, '请输入密码').max(256),
  /** 勾选后 cookie 落盘，重启浏览器仍然保持登录。 */
  remember: z.boolean().optional(),
});

const credentialsSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(256),
  username: z.string().max(64).nullable().optional(),
  /** `null`/空字符串表示不改密码。 */
  password: z.string().max(256).nullable().optional(),
});

function sendSessionCookie(reply: FastifyReply, result: AuthLoginResult, secure: boolean): void {
  const maxAgeSeconds = result.session.persistent
    ? Math.max(0, Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000))
    : null;
  reply.header(
    'set-cookie',
    serializeCookie(AUTH_SESSION_COOKIE, result.token, { maxAgeSeconds, secure }),
  );
}

function sessionPayload(ctx: AppContext, token: string | null): AuthSessionPayload {
  const session = ctx.auth.resolveSession(token);
  return {
    authenticated: session !== null,
    session,
    // Credential details are only reachable for a signed in browser.
    credentials: session ? ctx.auth.credentialsSummary() : null,
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/auth/login', async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body, '登录信息');
    const remember = body.remember ?? false;

    let result: AuthLoginResult;
    try {
      result = ctx.auth.login({
        username: body.username,
        password: body.password,
        remember,
      });
    } catch (error) {
      ctx.store.addActivity({
        level: 'warning',
        scope: 'auth',
        repositoryId: null,
        message: `登录失败：用户名或密码不正确（${body.username.trim() || '未填写用户名'}）`,
      });
      throw error;
    }

    sendSessionCookie(reply, result, request.protocol === 'https');
    ctx.store.addActivity({
      level: 'success',
      scope: 'auth',
      repositoryId: null,
      message: `登录成功：${result.session.username}${remember ? '（保持登录）' : ''}`,
    });

    return {
      session: result.session,
      credentials: ctx.auth.credentialsSummary(),
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const session = ctx.auth.resolveSession(
      readCookie(request.headers.cookie, AUTH_SESSION_COOKIE),
    );
    ctx.auth.logout(readCookie(request.headers.cookie, AUTH_SESSION_COOKIE));
    reply.header(
      'set-cookie',
      clearCookie(AUTH_SESSION_COOKIE, { secure: request.protocol === 'https' }),
    );

    if (session) {
      ctx.store.addActivity({
        level: 'info',
        scope: 'auth',
        repositoryId: null,
        message: `已退出登录：${session.username}`,
      });
    }
    return { ok: true };
  });

  /** Public endpoint: the SPA asks who it is before rendering any page. */
  app.get('/api/auth/session', async (request) =>
    sessionPayload(ctx, readCookie(request.headers.cookie, AUTH_SESSION_COOKIE)),
  );

  app.put('/api/auth/credentials', async (request, reply) => {
    const body = parseOrThrow(credentialsSchema, request.body, '账号信息');
    const result = ctx.auth.updateCredentials({
      currentPassword: body.currentPassword,
      username: body.username ?? null,
      password: body.password ?? null,
      persistent: request.authSession?.persistent ?? false,
    });
    sendSessionCookie(reply, result, request.protocol === 'https');
    ctx.store.addActivity({
      level: 'success',
      scope: 'auth',
      repositoryId: null,
      message: `登录账号已更新：${result.session.username}，其他设备的登录状态已失效`,
    });

    return {
      session: result.session,
      credentials: ctx.auth.credentialsSummary(),
    };
  });
}
