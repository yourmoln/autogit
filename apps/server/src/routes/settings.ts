import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { parseOrThrow } from '../util/http.js';

const settingsSchema = z.object({
  pollSeconds: z.number().int().min(10).max(3600).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(8).optional(),
  maxConcurrentPerRepo: z.number().int().min(1).max(8).optional(),
  autoInitializeLabels: z.boolean().optional(),
  autoReview: z.boolean().optional(),
  autoFix: z.boolean().optional(),
  allowClaudeFallback: z.boolean().optional(),
  codexPath: z.string().nullable().optional(),
  codexModel: z.string().nullable().optional(),
  codexSandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  codexApprovalPolicy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']).optional(),
  codexExtraArgs: z.array(z.string()).optional(),
  commitAuthorName: z.string().min(1).optional(),
  commitAuthorEmail: z.string().min(3).optional(),
  taskTimeoutMinutes: z.number().int().min(5).max(240).optional(),
  branchPrefix: z.string().min(1).max(40).optional(),
  prTitleTemplate: z.string().min(1).max(200).optional(),
});

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/settings', async () => {
    return {
      settings: ctx.settings.get(),
      runtime: {
        home: ctx.config.home,
        dataDir: ctx.config.dataDir,
        workspacesDir: ctx.config.workspacesDir,
        dbFile: ctx.config.dbFile,
        codexHome: ctx.config.codexHome,
        webDist: ctx.config.webDist,
        port: ctx.config.port,
        host: ctx.config.host,
        nodeVersion: process.version,
      },
    };
  });

  app.put('/api/settings', async (request) => {
    const body = parseOrThrow(settingsSchema, request.body, '设置');
    const settings = ctx.settings.update(body);
    ctx.codex.invalidate();
    ctx.store.addActivity({
      level: 'info',
      scope: 'settings',
      repositoryId: null,
      message: `更新全局设置（轮询 ${settings.pollSeconds}s / 并发 ${settings.maxConcurrentTasks} / 单仓库并发 ${settings.maxConcurrentPerRepo}）`,
    });
    return { settings };
  });
}
