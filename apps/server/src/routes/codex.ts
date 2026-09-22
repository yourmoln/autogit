import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { buildFixPrompt, buildImplementPrompt, buildReviewPrompt } from '../services/prompts.js';
import { HttpError, parseOrThrow } from '../util/http.js';

const configSchema = z.object({
  content: z.string().min(1, '配置内容不能为空'),
});

export function registerCodexRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/codex/status', async (request) => {
    const query = request.query as { force?: string };
    return { status: await ctx.codex.status({ force: query.force === '1' }) };
  });

  app.get('/api/codex/install', async () => {
    return { state: ctx.codex.getInstallState() };
  });

  app.post('/api/codex/install', async (_request, reply) => {
    if (ctx.codex.isInstalling()) {
      return reply.code(202).send({ state: ctx.codex.getInstallState(), alreadyRunning: true });
    }
    ctx.store.addActivity({
      level: 'info',
      scope: 'codex',
      repositoryId: null,
      message: '开始安装/更新 Codex CLI',
    });
    const state = await ctx.codex.installOrUpdate();
    return reply.code(state.exitCode === 0 ? 200 : 502).send({ state });
  });

  app.post('/api/codex/invalidate', async () => {
    ctx.codex.invalidate();
    return { status: await ctx.codex.status({ force: true }) };
  });

  app.get('/api/codex/config', async () => {
    return {
      config: ctx.codex.readConfig(),
      backups: ctx.codex.listConfigBackups(),
    };
  });

  app.put('/api/codex/config', async (request) => {
    const body = parseOrThrow(configSchema, request.body, 'Codex 配置');
    try {
      const config = ctx.codex.writeConfig(body.content);
      ctx.store.addActivity({
        level: 'info',
        scope: 'codex',
        repositoryId: null,
        message: `更新 ${config.path}`,
      });
      return { config, backups: ctx.codex.listConfigBackups() };
    } catch (error) {
      throw new HttpError(
        400,
        `配置校验失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  app.get('/api/codex/prompt-preview', async (request) => {
    const query = request.query as {
      repositoryId?: string;
      kind?: string;
      issueNumber?: string;
      prNumber?: string;
    };
    if (!query.repositoryId) throw new HttpError(400, '缺少 repositoryId');

    const repository = ctx.store.getRepository(query.repositoryId);
    if (!repository) throw new HttpError(404, '仓库不存在');

    const provider = ctx.providers.forAccount(repository.accountId);
    const ref = { owner: repository.owner, name: repository.name };
    const kind = query.kind ?? 'implement';
    const promptRepository = {
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      owner: repository.owner,
      name: repository.name,
    };

    if (kind === 'review' || kind === 'fix') {
      const prNumber = Number.parseInt(query.prNumber ?? '0', 10);
      if (!prNumber) throw new HttpError(400, '缺少 prNumber');
      const pullRequest = await provider.getPullRequest(ref, prNumber);
      const comments = await provider.listComments(ref, prNumber);
      const digests = comments.map((comment) => ({
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
      }));

      const prompt =
        kind === 'review'
          ? buildReviewPrompt({
              repository: promptRepository,
              pullRequest,
              issue: null,
              diff: '（预览模式下不包含真实 diff，运行时会注入完整变更）',
              comments: digests,
            })
          : buildFixPrompt({
              repository: promptRepository,
              pullRequest,
              issue: null,
              reviewComment: digests.at(-1)?.body ?? '（没有找到评审评论）',
              diffStat: '（预览模式下不包含真实 diffstat）',
            });

      return { prompt, kind, prNumber };
    }

    const issueNumber = Number.parseInt(query.issueNumber ?? '0', 10);
    if (!issueNumber) throw new HttpError(400, '缺少 issueNumber');
    const issue = await provider.getIssue(ref, issueNumber);
    const comments = await provider.listComments(ref, issueNumber);
    return {
      prompt: buildImplementPrompt({
        repository: promptRepository,
        issue,
        comments: comments.map((comment) => ({
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
        })),
        branch: `${ctx.settings.get().branchPrefix}${issue.number}`,
        verificationHints: [],
      }),
      kind,
      issueNumber,
    };
  });
}
