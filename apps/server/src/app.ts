import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { ensureRuntimeDirectories, type RuntimeConfig } from './config.js';
import { type AppContext, createContext } from './context.js';
import { ApiError } from './providers/index.js';
import { registerRoutes } from './routes/index.js';
import { decodeRequestPath, HttpError, isApiPath } from './util/http.js';
import { initLogger, logger } from './util/logger.js';

/**
 * Builds the HTTP stack without starting it.
 *
 * `index.ts` listens on it, `dev/auth-check.ts` drives it through
 * `app.inject()`, so both the dev self check and the real server exercise the
 * exact same routes, hooks and error handler.
 */
export async function buildServer(config: RuntimeConfig): Promise<{
  app: FastifyInstance;
  ctx: AppContext;
}> {
  ensureRuntimeDirectories(config);
  initLogger(config.logLevel, config.isDev);

  const ctx = createContext(config);
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
  });

  // No CORS plugin on purpose. The console is served from this very origin (dev
  // goes through the Vite proxy), so nothing needs cross-origin access — while
  // `origin: true` with credentials echoed any website's `Origin` back and let it
  // read this API through the visitor's browser.
  await app.register(websocket);

  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      wildcard: false,
    });
  }

  registerRoutes(app, ctx);

  // SPA fallback: everything that is not an API call renders the web app.
  app.setNotFoundHandler((request, reply) => {
    if (isApiPath(decodeRequestPath(request.url))) {
      return reply.code(404).send({ error: `接口不存在：${request.method} ${request.url}` });
    }
    if (config.webDist && existsSync(config.webDist)) {
      return reply.sendFile('index.html');
    }
    return reply
      .code(404)
      .send({ error: '前端尚未构建，请先执行 pnpm build 或使用 pnpm dev:web 启动开发服务器。' });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof ApiError) {
      return reply.code(502).send({ error: `${error.message}：${error.detail}` });
    }
    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    if (typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600) {
      return reply.code(rawStatus).send({ error: message });
    }
    logger().error({ err: error, url: request.url }, '请求处理失败');
    return reply.code(500).send({ error: message || '服务器内部错误' });
  });

  return {
    app,
    ctx,
  };
}
