import type { TaskStatus } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { HttpError } from '../util/http.js';

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/tasks', async (request) => {
    const query = request.query as { repositoryId?: string; status?: string; limit?: string };
    const status = query.status as TaskStatus | undefined;
    const limit = Number.parseInt(query.limit ?? '100', 10) || 100;
    return {
      items: ctx.store.listTasks({
        repositoryId: query.repositoryId,
        status,
        limit,
      }),
      counts: ctx.store.countTasksByStatus(),
    };
  });

  app.get('/api/tasks/:id', async (request) => {
    const { id } = request.params as { id: string };
    const task = ctx.store.getTask(id);
    if (!task) throw new HttpError(404, '任务不存在');
    return { task, logs: ctx.store.listLogs(id, 2000) };
  });

  app.post('/api/tasks/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const task = ctx.store.getTask(id);
    if (!task) throw new HttpError(404, '任务不存在');
    if (task.status !== 'running' && task.status !== 'queued') {
      throw new HttpError(409, `任务处于 ${task.status} 状态，无法取消`);
    }
    const cancelled = ctx.orchestrator.cancelTask(id);
    ctx.store.addActivity({
      level: 'warning',
      scope: 'task',
      repositoryId: task.repositoryId,
      message: `取消任务 ${task.id}`,
    });
    return { cancelled, task: ctx.store.getTask(id) };
  });

  app.post('/api/tasks/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = ctx.store.getTask(id);
    if (!task) throw new HttpError(404, '任务不存在');
    if (task.status === 'running' || task.status === 'queued') {
      throw new HttpError(409, '任务仍在进行中，无法重试');
    }

    const retried = await ctx.orchestrator.enqueueManual({
      repositoryId: task.repositoryId,
      kind: task.kind,
      issueNumber: task.issueNumber,
      prNumber: task.prNumber,
      priority: 'high',
    });
    return reply.code(202).send({ task: retried });
  });
}
