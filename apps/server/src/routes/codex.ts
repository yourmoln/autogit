import type { CodexModelProbe } from '@autogit/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { findLatestReviewComment } from '../services/orchestrator.js';
import { buildFixPrompt, buildImplementPrompt, buildReviewPrompt } from '../services/prompts.js';
import { mergeReviewDiscussion } from '../services/review-findings.js';
import { HttpError, parseOrThrow } from '../util/http.js';
import { logger } from '../util/logger.js';

const configSchema = z.object({
  content: z.string().min(1, '配置内容不能为空'),
});

/** Records a probe outcome in the activity feed, for both probe entry points. */
function recordProbe(ctx: AppContext, probe: CodexModelProbe): void {
  ctx.store.addActivity({
    level: probe.ready ? 'success' : 'warning',
    scope: 'codex',
    repositoryId: null,
    message: probe.ready
      ? `Codex 模型响应正常（${probe.durationMs ?? 0}ms）`
      : `Codex 模型无响应：${probe.message ?? '未知原因'}`,
  });
}

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
    // "重新检测" also refreshes the model probe, so the UI never shows a stale
    // answer right after the user asked for a re-check. The probe is a real
    // model call that can take minutes, so it stays in the background: the
    // request answers at once with `probing: true`, and the UI follows the
    // result through /api/codex/status.
    void ctx.codex
      .modelProbe(true)
      .then((probe) => recordProbe(ctx, probe))
      .catch((error: unknown) => {
        logger().warn({ err: error }, '后台模型探测失败');
      });
    return { status: await ctx.codex.status({ force: true }), probing: ctx.codex.isProbing() };
  });

  app.post('/api/codex/probe', async () => {
    const probe = await ctx.codex.modelProbe(true);
    recordProbe(ctx, probe);
    return { probe };
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
      // Inline comments are a separate resource, and the prompt preview must
      // show the same discussion the real run gets.
      const inline = await provider.listReviewComments(ref, prNumber).catch(() => []);
      // `runReview()` merges the two lists (no duplicates, anchored bodies),
      // `runFix()` keeps them apart: the summary comment is the review it has
      // to work through, the inline findings are the lines it has to look at.
      const discussion = mergeReviewDiscussion(comments, inline);
      const reviewComment = findLatestReviewComment(comments);

      const prompt =
        kind === 'review'
          ? buildReviewPrompt({
              repository: promptRepository,
              pullRequest,
              issue: null,
              diff: '（预览模式下不包含真实 diff，运行时会注入完整变更）',
              comments: discussion.map((comment) => ({
                author: comment.author,
                body: comment.body,
                createdAt: comment.createdAt,
              })),
            })
          : buildFixPrompt({
              repository: promptRepository,
              pullRequest,
              issue: null,
              reviewComment:
                reviewComment?.body ?? '（未找到评审意见，请根据 PR 描述自查并修复明显问题）',
              inlineComments: inline.map((comment) => ({
                path: comment.path ?? null,
                line: comment.line ?? null,
                body: comment.body,
              })),
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
