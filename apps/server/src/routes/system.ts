import { AI_LABELS, PROVIDER_META } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    version: '0.1.0',
    node: process.version,
  }));

  app.get('/api/system/overview', async () => {
    const accounts = ctx.store.listAccounts();
    const repositories = ctx.store.listRepositories();
    const tracked = ctx.store.countTrackedItems();
    return {
      stats: {
        accounts: accounts.length,
        repositories: repositories.length,
        enabledRepositories: repositories.filter((repository) => repository.enabled).length,
        labelsInitialized: repositories.filter((repository) => repository.labelsInitialized).length,
        trackedIssues: tracked.issues,
        trackedPullRequests: tracked.pullRequests,
        tasks: ctx.store.countTasksByStatus(),
      },
      orchestrator: ctx.orchestrator.status(),
      repositories: repositories.map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
        provider: repository.provider,
        enabled: repository.enabled,
        labelsInitialized: repository.labelsInitialized,
        lastPolledAt: repository.lastPolledAt,
        lastPollError: repository.lastPollError,
      })),
      activity: ctx.store.listActivity(30),
      labels: AI_LABELS,
      providers: PROVIDER_META,
      realtimeClients: ctx.events.subscriberCount,
    };
  });

  app.get('/api/system/activity', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number.parseInt(query.limit ?? '80', 10) || 80;
    return { items: ctx.store.listActivity(limit) };
  });

  app.get('/api/system/labels', async () => ({ labels: AI_LABELS }));

  app.get('/api/orchestrator', async () => ctx.orchestrator.status());

  app.post('/api/orchestrator/tick', async () => {
    const report = await ctx.orchestrator.tick('api');
    return { report, status: ctx.orchestrator.status() };
  });

  app.post('/api/orchestrator/restart', async () => {
    ctx.orchestrator.stop();
    ctx.settings.invalidate();
    ctx.orchestrator.start();
    return { status: ctx.orchestrator.status() };
  });

  app.get('/api/realtime', { websocket: true }, (socket, request) => {
    socket.send(
      JSON.stringify({
        type: 'notice',
        level: 'info',
        message: `已连接到 AutoGit 实时通道（${new Date().toLocaleTimeString('zh-CN')}）`,
      }),
    );
    socket.send(
      JSON.stringify({ type: 'orchestrator.snapshot', status: ctx.orchestrator.status() }),
    );

    const unsubscribe = ctx.events.subscribe((event) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(event));
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    request.log.debug('realtime client connected');
  });
}
