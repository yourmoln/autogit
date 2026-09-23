import { buildServer } from './app.js';
import { loadRuntimeConfig } from './config.js';
import { logger } from './util/logger.js';

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
