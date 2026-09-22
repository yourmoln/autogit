import { existsSync } from 'node:fs';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ensureRuntimeDirectories, loadRuntimeConfig } from './config.js';
import { type AppContext, createContext } from './context.js';
import { ApiError } from './providers/index.js';
import { registerRoutes } from './routes/index.js';
import { HttpError } from './util/http.js';
import { initLogger, logger } from './util/logger.js';

async function buildServer(config: ReturnType<typeof loadRuntimeConfig>): Promise<{
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

  await app.register(cors, {
    origin: true,
    credentials: true,
  });
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
    if (request.url.startsWith('/api/')) {
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

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const { app, ctx } = await buildServer(config);
  const log = logger();

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    log.error({ err: error }, '服务启动失败');
    ctx.dispose();
    process.exitCode = 1;
    return;
  }

  const url = `http://${config.host}:${config.port}`;
  log.info(`AutoGit 服务已启动：${url}`);
  log.info(`数据目录：${config.home}`);
  log.info(
    config.webDist
      ? `已挂载前端构建产物：${config.webDist}`
      : '未检测到前端构建产物，开发模式请使用 pnpm dev:web（默认 http://localhost:5173）',
  );

  ctx.orchestrator.start();

  const shutdown = (signal: string): void => {
    log.info(`收到 ${signal}，正在关闭 AutoGit…`);
    void app
      .close()
      .catch((error: unknown) => log.warn({ err: error }, '关闭 HTTP 服务失败'))
      .finally(() => {
        ctx.dispose();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
