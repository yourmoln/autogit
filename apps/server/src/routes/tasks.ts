import { STUCK_LABEL, type Task, type TaskStatus } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import type { TaskRecord } from '../db/store.js';
import { HttpError } from '../util/http.js';

/**
 * Annotates tasks with `retryable`.
 *
 * Retrying re-runs a failed/cancelled task, and it consumes the `ai/stuck`
 * label the failure parked on the Issue/PR — so the button is only offered
 * while that label is still present, which also makes it a one-shot action.
 * Labels come from the local snapshots the poller refreshes.
 */
function withRetryState(ctx: AppContext, tasks: TaskRecord[]): Task[] {
  const labelCache = new Map<string, string[] | null>();
  const labelsOf = (repositoryId: string, number: number, isPullRequest: boolean): string[] => {
    const key = `${repositoryId}:${isPullRequest ? 'pr' : 'issue'}:${number}`;
    if (!labelCache.has(key)) {
      const snapshot = isPullRequest
        ? ctx.store.listPullRequests(repositoryId).find((item) => item.number === number)
        : ctx.store.listIssues(repositoryId).find((item) => item.number === number);
      labelCache.set(key, snapshot?.labels ?? null);
    }
    return labelCache.get(key) ?? [];
  };

  return tasks.map((task) => {
    const isPullRequest = task.kind !== 'implement';
    const number = isPullRequest ? task.prNumber : task.issueNumber;
    const retryable =
      (task.status === 'failed' || task.status === 'cancelled') &&
      number !== null &&
      labelsOf(task.repositoryId, number, isPullRequest).includes(STUCK_LABEL);
    return { ...task, retryable };
  });
}

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/tasks', async (request) => {
    const query = request.query as { repositoryId?: string; status?: string; limit?: string };
    const status = query.status as TaskStatus | undefined;
    const limit = Number.parseInt(query.limit ?? '100', 10) || 100;
    return {
      items: withRetryState(
        ctx,
        ctx.store.listTasks({
          repositoryId: query.repositoryId,
          status,
          limit,
        }),
      ),
      counts: ctx.store.countTasksByStatus(),
    };
  });

  app.get('/api/tasks/:id', async (request) => {
    const { id } = request.params as { id: string };
    const task = ctx.store.getTask(id);
    if (!task) throw new HttpError(404, '任务不存在');
    return { task: withRetryState(ctx, [task])[0], logs: ctx.store.listLogs(id, 2000) };
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
    const result = await ctx.orchestrator.retryTask(id);
    if (!result.ok) throw new HttpError(result.status, result.reason);
    return reply.code(202).send({ task: result.task });
  });
}
