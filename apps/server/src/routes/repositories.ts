import {
  isAiLabel,
  isPaused,
  isStuck,
  priorityOf,
  type RemoteRepositorySummary,
  type RepositoryOverview,
  resolvePipelineStatus,
  type TrackedIssue,
} from '@autogit/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { describeProviderError } from '../services/providers.js';
import { randomId } from '../util/crypto.js';
import { HttpError, parseOrThrow } from '../util/http.js';

const createSchema = z.object({
  accountId: z.string().min(1),
  fullName: z.string().min(3, '请填写 owner/repo 形式的仓库名'),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  defaultBranch: z.string().min(1).optional(),
});

const manualTaskSchema = z.object({
  kind: z.enum(['implement', 'review', 'fix']),
  issueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive().optional(),
});

function toTrackedIssue(
  repositoryId: string,
  item: {
    number: number;
    title: string;
    state: 'open' | 'closed';
    labels: string[];
    author: string | null;
    htmlUrl: string | null;
    updatedAt: string;
    isPullRequest: boolean;
  },
): TrackedIssue {
  return {
    id: `${repositoryId}:${item.number}`,
    repositoryId,
    number: item.number,
    title: item.title,
    state: item.state,
    labels: item.labels,
    author: item.author ?? 'unknown',
    htmlUrl: item.htmlUrl ?? '',
    updatedAt: item.updatedAt,
    isPullRequest: item.isPullRequest,
    aiStatus: resolvePipelineStatus(item.labels),
    priority: priorityOf(item.labels),
    paused: isPaused(item.labels),
    stuck: isStuck(item.labels),
  };
}

export function registerRepositoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/repositories', async () => {
    const repositories = ctx.store.listRepositories();
    return {
      items: repositories.map((repository) => ({
        ...repository,
        tracked: ctx.store.listIssues(repository.id).length,
        pullRequests: ctx.store.listPullRequests(repository.id).length,
      })),
    };
  });

  app.post('/api/repositories', async (request, reply) => {
    const body = parseOrThrow(createSchema, request.body, '仓库信息');
    const account = ctx.store.getAccount(body.accountId);
    if (!account) throw new HttpError(404, '账号不存在');

    const [owner, name] = body.fullName.split('/').map((part) => part.trim());
    if (!owner || !name) throw new HttpError(400, '仓库名需要形如 owner/repo');

    const provider = ctx.providers.forAccount(account.id);
    let remote: RemoteRepositorySummary;
    try {
      remote = await provider.getRepository({ owner, name });
    } catch (error) {
      throw new HttpError(502, `读取仓库失败：${describeProviderError(error)}`);
    }

    const repository = ctx.store.upsertRepository({
      id: randomId('repo'),
      accountId: account.id,
      provider: account.provider,
      owner: remote.owner,
      name: remote.name,
      fullName: remote.fullName,
      defaultBranch: remote.defaultBranch,
      htmlUrl: remote.htmlUrl,
      cloneUrl: remote.cloneUrl,
      private: remote.private,
      description: remote.description,
      enabled: body.enabled ?? true,
    });

    ctx.events.emit({ type: 'repository.updated', repositoryId: repository.id });
    ctx.store.addActivity({
      level: 'success',
      scope: 'repository',
      repositoryId: repository.id,
      message: `导入仓库 ${repository.fullName}`,
    });
    return reply.code(201).send({ repository });
  });

  app.get('/api/repositories/:id', async (request) => {
    const { id } = request.params as { id: string };
    const repository = ctx.store.getRepository(id);
    if (!repository) throw new HttpError(404, '仓库不存在');
    return { repository };
  });

  app.patch('/api/repositories/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateSchema, request.body, '仓库设置');
    const repository = ctx.store.updateRepository(id, body);
    if (!repository) throw new HttpError(404, '仓库不存在');
    ctx.events.emit({ type: 'repository.updated', repositoryId: id });
    return { repository };
  });

  app.delete('/api/repositories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const purge = (request.query as { purge?: string }).purge === 'true';
    const repository = ctx.store.getRepository(id);
    if (!repository) throw new HttpError(404, '仓库不存在');

    ctx.store.deleteRepository(id);
    if (purge) ctx.workspace.removeWorkspace(id);
    ctx.store.addActivity({
      level: 'warning',
      scope: 'repository',
      repositoryId: null,
      message: `移除仓库 ${repository.fullName}${purge ? '（含本地工作区）' : ''}`,
    });
    return reply.code(204).send();
  });

  app.get('/api/repositories/:id/overview', async (request) => {
    const { id } = request.params as { id: string };
    const repository = ctx.store.getRepository(id);
    if (!repository) throw new HttpError(404, '仓库不存在');

    const issueRows = ctx.store.listIssues(id).filter((issue) => !issue.isPullRequest);
    const prRows = ctx.store.listPullRequests(id);
    const issues = issueRows.map((issue) => toTrackedIssue(id, issue));
    const pullRequests = prRows.map((pr) =>
      toTrackedIssue(id, {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        labels: pr.labels,
        author: pr.author,
        htmlUrl: pr.htmlUrl,
        updatedAt: pr.updatedAt,
        isPullRequest: true,
      }),
    );

    const overview: RepositoryOverview = {
      repository,
      counts: {
        todo: issues.filter((issue) => issue.labels.includes('ai/todo')).length,
        doing: issues.filter((issue) => issue.labels.includes('ai/doing')).length,
        inReview: issues.filter((issue) => issue.labels.includes('ai/in-review')).length,
        verify: issues.filter((issue) => issue.labels.includes('ai/verify')).length,
        needsReview: pullRequests.filter((pr) => pr.labels.includes('ai/needs-review')).length,
        needsFix: pullRequests.filter((pr) => pr.labels.includes('ai/needs-fix')).length,
        approved: pullRequests.filter((pr) => pr.labels.includes('ai/approved')).length,
        stuck:
          issues.filter((issue) => issue.stuck).length +
          pullRequests.filter((pr) => pr.stuck).length,
        paused:
          issues.filter((issue) => issue.paused).length +
          pullRequests.filter((pr) => pr.paused).length,
      },
      issues: issues.filter(
        (issue) => issue.labels.some((label) => isAiLabel(label)) || issue.stuck || issue.paused,
      ),
      pullRequests: pullRequests.filter(
        (pr) => pr.labels.some((label) => isAiLabel(label)) || pr.stuck || pr.paused,
      ),
      tasks: ctx.store.listTasks({ repositoryId: id, limit: 30 }),
      lastSyncedAt: repository.lastPolledAt,
    };
    return overview;
  });

  app.get('/api/repositories/:id/labels/preview', async (request) => {
    const { id } = request.params as { id: string };
    const repository = ctx.store.getRepository(id);
    if (!repository) throw new HttpError(404, '仓库不存在');
    return { labels: await ctx.labels.preview(repository) };
  });

  app.post('/api/repositories/:id/labels/initialize', async (request) => {
    const { id } = request.params as { id: string };
    const repository = ctx.store.getRepository(id);
    if (!repository) throw new HttpError(404, '仓库不存在');
    const result = await ctx.labels.initialize(repository);
    return { result, repository: ctx.store.getRepository(id) };
  });

  app.post('/api/repositories/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    const repository = ctx.store.getRepository(id);
    if (!repository) throw new HttpError(404, '仓库不存在');
    const report = await ctx.orchestrator.tick('manual');
    return { report, repository: ctx.store.getRepository(id) };
  });

  app.post('/api/repositories/:id/tasks', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(manualTaskSchema, request.body, '任务参数');
    const repository = ctx.store.getRepository(id);
    if (!repository) throw new HttpError(404, '仓库不存在');

    if (body.kind === 'implement' && !body.issueNumber) {
      throw new HttpError(400, '实现任务需要提供 issueNumber');
    }
    if (body.kind !== 'implement' && !body.prNumber) {
      throw new HttpError(400, '评审/修复任务需要提供 prNumber');
    }

    const task = await ctx.orchestrator.enqueueManual({
      repositoryId: id,
      kind: body.kind,
      issueNumber: body.issueNumber ?? null,
      prNumber: body.prNumber ?? null,
      priority: 'high',
    });
    return reply.code(202).send({ task });
  });
}
