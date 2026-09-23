/**
 * End-to-end simulation of the AutoGit pipeline.
 *
 * It runs the real orchestrator, the real git workspace manager and the real
 * label state machine, but replaces the Git host API with an in-memory stub and
 * the Codex CLI with a deterministic fake agent. That makes it possible to
 * verify the whole Issue → PR → review → fix loop locally, offline, in seconds.
 *
 * Usage: pnpm --filter @autogit/server simulate
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CodexModelProbe,
  CodexStatus,
  Comment,
  ProviderKind,
  RemoteIssue,
  RemoteLabel,
  RemotePullRequest,
  RemoteRepositorySummary,
  RemoteUser,
} from '@autogit/shared';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';

import { ensureRuntimeDirectories, loadRuntimeConfig } from '../config.js';
import { type AppContext, createContext } from '../context.js';
import { Db } from '../db/database.js';
import { migrate } from '../db/migrations.js';
import { Store } from '../db/store.js';
import { GiteaProvider } from '../providers/gitea.js';
import { GiteeProvider } from '../providers/gitee.js';
import type { GitProvider, ProviderAccount, RepoRef } from '../providers/index.js';
import { registerCodexRoutes } from '../routes/codex.js';
import { registerSystemRoutes } from '../routes/system.js';
import { registerTaskRoutes, withRetryState } from '../routes/tasks.js';
import { CodexService } from '../services/codex.js';
import { EventBus } from '../services/events.js';
import { LabelService } from '../services/labels.js';
import { buildPullRequestBody, Orchestrator } from '../services/orchestrator.js';
import { bodyProblems } from '../services/pr-metadata.js';
import { ProviderFactory } from '../services/providers.js';
import { ProxyService } from '../services/proxy.js';
import { mergeReviewDiscussion } from '../services/review-findings.js';
import type { EngineRunInput, EngineRunResult } from '../services/runner.js';
import { EngineRunner } from '../services/runner.js';
import { SettingsService } from '../services/settings.js';
import {
  isTransientGitFailure,
  type WorkspaceLog,
  WorkspaceManager,
} from '../services/workspace.js';
import { parseDiffAnchors } from '../util/diff-anchors.js';
import { initLogger, logger } from '../util/logger.js';
import { slugify } from '../util/time.js';

interface StubState {
  labels: Set<string>;
  issues: Map<number, RemoteIssue>;
  pullRequests: Map<number, RemotePullRequest>;
  comments: Map<number, Comment[]>;
  /** Inline (line anchored) review comments, kept apart from the comments above. */
  reviewComments: Map<number, Comment[]>;
  nextCommentId: number;
}

class StubProvider implements GitProvider {
  readonly kind: ProviderKind = 'github';
  readonly baseUrl = 'http://stub.local';
  readonly proxyUrl = null;
  /** Patch positions the orchestrator handed to `createReviewComment()`. */
  readonly inlinePositions: number[][] = [];
  readonly state: StubState = {
    labels: new Set<string>(),
    issues: new Map(),
    pullRequests: new Map(),
    comments: new Map(),
    reviewComments: new Map(),
    nextCommentId: 1,
  };
  private nextPullRequest = 1;
  /** Every title/body rewrite AutoGit asked for, in order. */
  readonly metadataUpdates: Array<{ number: number; title?: string; body?: string }> = [];

  constructor(private readonly cloneUrl: string) {}

  gitAuthorizationHeader(): string | null {
    return null;
  }

  async getCurrentUser(): Promise<RemoteUser> {
    return { login: 'autogit-bot', name: 'AutoGit Bot', avatarUrl: null, email: null };
  }

  async listRepositories(): Promise<{
    items: RemoteRepositorySummary[];
    page: number;
    hasMore: boolean;
  }> {
    return {
      items: [await this.getRepository({ owner: 'sim', name: 'demo' })],
      page: 1,
      hasMore: false,
    };
  }

  async getRepository(ref: RepoRef): Promise<RemoteRepositorySummary> {
    return {
      owner: ref.owner,
      name: ref.name,
      fullName: `${ref.owner}/${ref.name}`,
      defaultBranch: 'main',
      htmlUrl: `${this.baseUrl}/${ref.owner}/${ref.name}`,
      cloneUrl: this.cloneUrl,
      private: false,
      description: 'simulation repository',
      updatedAt: new Date().toISOString(),
      imported: true,
      repositoryId: null,
    };
  }

  async listLabels(): Promise<RemoteLabel[]> {
    return [...this.state.labels].map((name) => ({
      id: null,
      name,
      color: 'ffffff',
      description: null,
    }));
  }

  async createLabel(
    _ref: RepoRef,
    input: { name: string; color: string; description: string },
  ): Promise<RemoteLabel> {
    this.state.labels.add(input.name);
    return { id: null, name: input.name, color: input.color, description: input.description };
  }

  async updateLabel(
    _ref: RepoRef,
    _name: string,
    input: { name: string; color: string; description: string },
  ): Promise<RemoteLabel> {
    this.state.labels.add(input.name);
    return { id: null, name: input.name, color: input.color, description: input.description };
  }

  async listIssues(
    _ref: RepoRef,
    options: { state?: 'open' | 'closed' | 'all' } = {},
  ): Promise<RemoteIssue[]> {
    const state = options.state ?? 'open';
    return [...this.state.issues.values()].filter(
      (issue) => state === 'all' || issue.state === state,
    );
  }

  async getIssue(_ref: RepoRef, number: number): Promise<RemoteIssue> {
    const issue = this.state.issues.get(number);
    if (!issue) throw new Error(`stub issue #${number} not found`);
    return issue;
  }

  async listComments(_ref: RepoRef, number: number): Promise<Comment[]> {
    return this.state.comments.get(number) ?? [];
  }

  async createComment(_ref: RepoRef, number: number, body: string): Promise<Comment> {
    const comment: Comment = {
      id: String(this.state.nextCommentId++),
      author: 'autogit-bot',
      body,
      createdAt: new Date().toISOString(),
      url: null,
    };
    this.state.comments.set(number, [...(this.state.comments.get(number) ?? []), comment]);
    return comment;
  }

  async listReviewComments(_ref: RepoRef, number: number): Promise<Comment[]> {
    return this.state.reviewComments.get(number) ?? [];
  }

  async createReviewComment(
    _ref: RepoRef,
    number: number,
    input: { body: string; path: string; line: number; diffPositions: readonly number[] },
  ): Promise<Comment> {
    const comment: Comment = {
      id: String(this.state.nextCommentId++),
      author: 'autogit-bot',
      body: input.body,
      createdAt: new Date().toISOString(),
      url: null,
      path: input.path,
      line: input.line,
    };
    this.state.reviewComments.set(number, [
      ...(this.state.reviewComments.get(number) ?? []),
      comment,
    ]);
    this.inlinePositions.push([...input.diffPositions]);
    return comment;
  }

  async setLabels(
    _ref: RepoRef,
    target: { number: number; labels: string[]; isPullRequest: boolean },
  ): Promise<void> {
    if (target.isPullRequest) {
      const pr = this.state.pullRequests.get(target.number);
      if (!pr) throw new Error(`stub PR #${target.number} not found`);
      pr.labels = [...target.labels];
      return;
    }
    const issue = this.state.issues.get(target.number);
    if (!issue) throw new Error(`stub issue #${target.number} not found`);
    issue.labels = [...target.labels];
  }

  async listPullRequests(
    _ref: RepoRef,
    options: { state?: 'open' | 'closed' | 'all' } = {},
  ): Promise<RemotePullRequest[]> {
    const state = options.state ?? 'open';
    return [...this.state.pullRequests.values()].filter(
      (pr) => state === 'all' || pr.state === state,
    );
  }

  async getPullRequest(_ref: RepoRef, number: number): Promise<RemotePullRequest> {
    const pr = this.state.pullRequests.get(number);
    if (!pr) throw new Error(`stub PR #${number} not found`);
    return pr;
  }

  async findPullRequestByHead(_ref: RepoRef, headRef: string): Promise<RemotePullRequest | null> {
    return [...this.state.pullRequests.values()].find((pr) => pr.headRef === headRef) ?? null;
  }

  async createPullRequest(
    _ref: RepoRef,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<RemotePullRequest> {
    const number = this.nextPullRequest++;
    const pr: RemotePullRequest = {
      number,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      labels: [],
      author: 'autogit-bot',
      htmlUrl: `${this.baseUrl}/sim/demo/pulls/${number}`,
      headRef: input.head,
      baseRef: input.base,
      headSha: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      draft: false,
    };
    this.state.pullRequests.set(number, pr);
    return pr;
  }

  /**
   * Rewrites the title/body like a platform would. The returned PR is the same
   * object the orchestrator reads back, so the assertions can check the result
   * without another `getPullRequest` call.
   */
  async updatePullRequest(
    _ref: RepoRef,
    number: number,
    input: { title?: string; body?: string },
  ): Promise<RemotePullRequest> {
    const pr = this.state.pullRequests.get(number);
    if (!pr) throw new Error(`stub PR #${number} not found`);
    if (input.title !== undefined) pr.title = input.title;
    if (input.body !== undefined) pr.body = input.body;
    pr.updatedAt = new Date().toISOString();
    this.metadataUpdates.push({ number, ...input });
    return pr;
  }

  /** Test helper: makes a PR look like one AutoGit used to create. */
  setPullRequestMetadata(number: number, input: { title?: string; body?: string }): void {
    const pr = this.state.pullRequests.get(number);
    if (!pr) throw new Error(`stub PR #${number} not found`);
    if (input.title !== undefined) pr.title = input.title;
    if (input.body !== undefined) pr.body = input.body;
  }

  /** Test helper: merges a pull request so the reconcile path can be verified. */
  mergePullRequest(number: number): void {
    const pr = this.state.pullRequests.get(number);
    if (!pr) throw new Error(`stub PR #${number} not found`);
    pr.merged = true;
    pr.mergedAt = new Date().toISOString();
    pr.state = 'closed';
  }

  /** Test helper: closes an issue the way a maintainer does after verifying it. */
  closeIssue(number: number): void {
    const issue = this.state.issues.get(number);
    if (!issue) throw new Error(`stub issue #${number} not found`);
    issue.state = 'closed';
    issue.updatedAt = new Date().toISOString();
  }

  /** Test helper: seeds the issue that starts the pipeline. */
  seedIssue(input: { number: number; title: string; body: string; labels: string[] }): RemoteIssue {
    const issue: RemoteIssue = {
      number: input.number,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: input.labels,
      author: 'reporter',
      htmlUrl: `${this.baseUrl}/sim/demo/issues/${input.number}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      comments: 0,
      isPullRequest: false,
    };
    this.state.issues.set(input.number, issue);
    return issue;
  }
}

/** Deterministic stand-in for the Codex CLI. */
class SimulationRunner extends EngineRunner {
  reviewRounds = 0;
  /** How often a review had to be asked to re-output its verdict. */
  verdictRepairs = 0;
  /** How many following implement runs fail, to exercise the retry budget. */
  failImplementTimes = 0;
  /** How many following reviews answer `needs_fix` regardless of the diff. */
  forceNeedsFixRounds = 0;
  /**
   * How many following fix runs finish without touching a file, the way a real
   * one does when every finding is a merge-side or metadata action.
   */
  noChangeFixRounds = 0;
  /** Action block the next no-change fix run hands back to AutoGit. */
  fixActionBlock: Record<string, unknown> | null = null;
  /** Wall-clock deadline every following run waits for before doing its work. */
  private holdUntil = 0;
  /** Prompt of the most recent fix run that did work, so its content can be asserted. */
  lastFixPrompt: string | null = null;

  /**
   * Keeps the next runs inside the `running` state for `ms` milliseconds.
   *
   * The concurrency scenario needs tasks that are still running while the
   * orchestrator ticks again; without a hold the fake agent finishes instantly
   * and the queue would always be empty.
   */
  hold(ms: number): void {
    this.holdUntil = Date.now() + ms;
  }

  override async run(input: EngineRunInput): Promise<EngineRunResult> {
    const started = Date.now();
    const remaining = this.holdUntil - Date.now();
    if (remaining > 0) {
      input.log('agent', `模拟：保持任务运行 ${Math.ceil(remaining / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    if (input.signal?.aborted) {
      return {
        ok: false,
        exitCode: null,
        summary: '',
        output: '',
        durationMs: Date.now() - started,
        timedOut: false,
        aborted: true,
        error: '任务已取消',
        usage: null,
      };
    }
    mkdirSyncIfNeeded(input.cwd);

    // The first review answers in prose, so the parser cannot read a verdict and
    // the orchestrator has to ask the model again instead of failing the task.
    if (input.prompt.includes('重新输出结论')) {
      this.verdictRepairs += 1;
      const verdict = {
        verdict: 'needs_fix',
        summary: '实现方向正确，但 feature.txt 缺少标题行，需要补齐。',
        issues: [
          {
            severity: 'major',
            title: '缺少标题行',
            detail: 'feature.txt 需要包含一行标题，便于后续渲染。',
            file: 'src/feature.txt',
            // Resolvable against the diff, so the finding becomes an inline
            // comment instead of a bullet in the summary comment.
            line: 1,
            suggestion: '在第一行写入 "AutoGit Feature"。',
          },
        ],
        tests: 'node --test（模拟）',
      };
      input.log('agent', '模拟：按 JSON Schema 重新输出评审结论');
      return success(JSON.stringify(verdict, null, 2), started);
    }

    if (input.prompt.includes('代码评审代理')) {
      this.reviewRounds += 1;
      if (this.reviewRounds === 1) {
        const prose = '我看了这次改动：方向是对的，但 src/feature.txt 缺少标题行，补齐后再合并。';
        input.log('agent', prose);
        return success(prose, started);
      }
      if (this.forceNeedsFixRounds > 0) {
        this.forceNeedsFixRounds -= 1;
        const verdict = {
          verdict: 'needs_fix',
          summary: '改动本身可以合并，但分支历史里仍有必须由合并侧处理的内容。',
          issues: [
            {
              severity: 'blocker',
              title: '分支历史需要合并侧改写',
              detail: '历史里的缓存对象只能由有推送权限的一侧清理。',
              file: null,
              line: null,
              suggestion: '合并前先改写分支历史。',
            },
          ],
          tests: null,
        };
        input.log('agent', `模拟评审结论：${verdict.verdict}`);
        return success(JSON.stringify(verdict, null, 2), started);
      }
      const verdict = {
        verdict: 'approve',
        summary: '改动符合预期，测试通过，可以合并。',
        issues: [],
        tests: 'node --test（模拟）',
      };
      input.log('agent', `模拟评审结论：${verdict.verdict}`);
      return success(JSON.stringify(verdict, null, 2), started);
    }

    if (input.prompt.includes('修复代理')) {
      if (this.noChangeFixRounds > 0) {
        this.noChangeFixRounds -= 1;
        input.log('agent', '模拟：评审意见都不需要改动仓库文件，本轮不修改任何文件');
        const lines = [
          this.fixActionBlock
            ? '本轮意见都不需要改动仓库文件，已按下面的动作块交给 AutoGit 执行。'
            : '本轮意见都只能由人工/合并侧执行，仓库文件无需改动。',
          '',
          '## 实现假设清单',
          '',
          '- 假设分支历史只能由有推送权限的一侧改写。',
          '',
          '## 代码逻辑图',
          '',
          '```mermaid',
          'flowchart LR',
          '  A["评审意见"] --> B["人工/合并侧执行"]',
          '```',
        ];
        if (this.fixActionBlock) {
          lines.push('', '```autogit', JSON.stringify(this.fixActionBlock, null, 2), '```');
        }
        return success(lines.join('\n'), started);
      }
      input.log('command', '$ write src/feature.txt');
      writeFileSync(
        path.join(input.cwd, 'src', 'feature.txt'),
        'AutoGit Feature\n\n修复：按评审意见补上标题行。\n',
        'utf8',
      );
      this.lastFixPrompt = input.prompt;
      return success('已按评审意见补齐标题行。', started);
    }

    input.log('command', '$ write src/feature.txt');
    if (this.failImplementTimes > 0) {
      this.failImplementTimes -= 1;
      input.log('stderr', '模拟：实现代理执行失败');
      return {
        ok: false,
        exitCode: 1,
        summary: '模拟失败',
        output: '模拟失败',
        durationMs: Date.now() - started,
        timedOut: false,
        aborted: false,
        error: '模拟：实现代理执行失败',
        usage: null,
      };
    }
    writeFileSync(path.join(input.cwd, 'src', 'feature.txt'), 'feature work in progress\n', 'utf8');
    input.log('agent', '已实现 Issue 描述的功能');
    return success(
      `新增 src/feature.txt，实现 Issue 要求。

## 实现假设清单
- 假设 src/feature.txt 的首行作为标题使用。

## 代码逻辑图
\`\`\`mermaid
flowchart LR
    A[领取 Issue] --> B[写入 src/feature.txt]
    B --> C[提交并推送分支]
\`\`\``,
      started,
    );
  }
}

/**
 * Fake agent with the two hooks the regression checks need: a run can be held
 * open (so a task can be observed while it is `running`) or made to fail once.
 */
class GatedSimulationRunner extends SimulationRunner {
  private nextRunGate: Promise<void> | null = null;
  private pendingFailure: string | null = null;

  /**
   * Holds the next agent run until `gate` resolves, so a task can be observed
   * while it is genuinely running.
   */
  holdNextRun(gate: Promise<void>): void {
    this.nextRunGate = gate;
  }

  /** Makes the next agent run fail with `message`. */
  failNextRun(message: string): void {
    this.pendingFailure = message;
  }

  override async run(input: EngineRunInput): Promise<EngineRunResult> {
    const started = Date.now();
    const gate = this.nextRunGate;
    if (gate) {
      this.nextRunGate = null;
      await gate;
    }
    if (input.signal?.aborted) return cancelled(started);
    if (this.pendingFailure) {
      const message = this.pendingFailure;
      this.pendingFailure = null;
      input.log('stderr', `模拟：${message}`);
      return failed(message, started);
    }
    return super.run(input);
  }
}

function success(summary: string, started: number): EngineRunResult {
  return {
    ok: true,
    exitCode: 0,
    summary,
    output: summary,
    durationMs: Date.now() - started,
    timedOut: false,
    aborted: false,
    error: null,
    usage: null,
  };
}

function failed(message: string, started: number): EngineRunResult {
  return {
    ok: false,
    exitCode: 1,
    summary: '',
    output: '',
    durationMs: Date.now() - started,
    timedOut: false,
    aborted: false,
    error: message,
    usage: null,
  };
}

/** The runner reports an aborted run the same way the real engine does. */
function cancelled(started: number): EngineRunResult {
  return {
    ok: false,
    exitCode: null,
    summary: '',
    output: '',
    durationMs: Date.now() - started,
    timedOut: false,
    aborted: true,
    error: '任务已取消',
    usage: null,
  };
}

/** Promise the simulation resolves by hand to gate an async step. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function mkdirSyncIfNeeded(dir: string): void {
  const src = path.join(dir, 'src');
  if (!existsSync(src)) {
    mkdirSync(src, { recursive: true });
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function createRemoteRepository(root: string): string {
  const bare = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  writeFileSync(path.join(root, 'seed-ready'), '', 'utf8');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { stdio: 'ignore' });
  execFileSync('git', ['clone', bare, seed], { stdio: 'ignore' });
  git(['config', 'user.name', 'Seed'], seed);
  git(['config', 'user.email', 'seed@localhost'], seed);
  writeFileSync(
    path.join(seed, 'README.md'),
    '# Demo repository\n\n用于 AutoGit 管线模拟。\n',
    'utf8',
  );
  git(['add', '-A'], seed);
  git(['commit', '-m', 'chore: 初始化演示仓库'], seed);
  git(['push', 'origin', 'main'], seed);
  return bare;
}

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'autogit-sim-'));
  // `AUTOGIT_SIM_HOME` lets the simulation write into the real instance (used
  // to verify the UI with realistic data); otherwise everything stays in a
  // throwaway temp directory.
  const persistentHome = process.env.AUTOGIT_SIM_HOME;
  process.env.AUTOGIT_HOME = persistentHome ?? path.join(root, 'home');
  process.env.AUTOGIT_LOG_LEVEL = 'warn';
  process.env.AUTOGIT_POLL_SECONDS = '3600';

  const config = loadRuntimeConfig();
  ensureRuntimeDirectories(config);
  initLogger(config.logLevel, false);

  const bareRepo = createRemoteRepository(root);
  const cloneUrl = `file:///${bareRepo.replace(/\\/g, '/')}`;

  const db = new Db(config.dbFile);
  migrate(db);
  const store = new Store(db);
  const settings = new SettingsService(store, config);
  settings.update({
    pollSeconds: 3600,
    taskTimeoutMinutes: 5,
    commitAuthorName: 'AutoGit Sim',
    commitAuthorEmail: 'sim@localhost',
  });

  const events = new EventBus();
  const provider = new StubProvider(cloneUrl);
  const secretKey = Buffer.alloc(32, 7);
  const proxy = new ProxyService(store, secretKey);
  const providers = new ProviderFactory(store, secretKey, proxy);
  Object.assign(providers, { forAccount: () => provider });

  const codex = new CodexService(config, settings, events);
  const runner = new GatedSimulationRunner(config, settings, codex);
  const workspace = new WorkspaceManager(config, settings);
  const labels = new LabelService({ store, providers, events });
  const orchestrator = new Orchestrator({
    config,
    store,
    settings,
    events,
    codex,
    runner,
    workspace,
    providers,
    labels,
  });

  // 回归检查走真实 HTTP 路由，上下文按 index.ts 的方式由 createContext 建好，
  // 再把模拟自建的实例装进去：以后 AppContext 新增服务时这里不用跟着改，
  // 这些路由也不会用到它们之外的接口。
  const ctx: AppContext = createContext(config);
  ctx.db.close(); // 模拟用自己的 db / store
  Object.assign(ctx, {
    db,
    store,
    settings,
    events,
    providers,
    labels,
    codex,
    runner,
    workspace,
    orchestrator,
    dispose: () => orchestrator.stop(),
  });
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerSystemRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerCodexRoutes(app, ctx);
  await app.ready();

  const account = store.createAccount({
    id: 'acc_sim',
    name: 'simulation',
    provider: 'github',
    baseUrl: 'http://stub.local',
    tokenEnc: 'stub',
    username: 'autogit-bot',
    displayName: 'AutoGit Bot',
    avatarUrl: null,
    status: 'ok',
    statusMessage: 'simulated',
  });

  const repository = store.upsertRepository({
    id: 'repo_sim',
    accountId: account.id,
    provider: 'github',
    owner: 'sim',
    name: 'demo',
    fullName: 'sim/demo',
    defaultBranch: 'main',
    htmlUrl: 'http://stub.local/sim/demo',
    cloneUrl,
    private: false,
    description: 'simulation',
    enabled: true,
  });

  provider.seedIssue({
    number: 1,
    title: '新增功能说明文件',
    body: '请在仓库中新增 src/feature.txt，用于说明 AutoGit 的自动化能力。',
    labels: ['ai/todo', 'ai/priority-high'],
  });

  const log = logger();
  log.warn('=== AutoGit 管线模拟开始 ===');

  const labelResult = await labels.initialize(repository);
  log.warn(
    `标签初始化：新建 ${labelResult.created.length}，更新 ${labelResult.updated.length}，已存在 ${labelResult.unchanged.length}，失败 ${labelResult.failed.length}`,
  );
  if (labelResult.failed.length > 0)
    throw new Error(`标签初始化失败：${JSON.stringify(labelResult.failed)}`);
  if (provider.state.labels.size !== 15) {
    throw new Error(`期望创建 15 个标签，实际 ${provider.state.labels.size}`);
  }

  await runUntilQuiet(orchestrator, store, repository.id, 8);

  const issue = await provider.getIssue({ owner: 'sim', name: 'demo' }, 1);
  const pr = [...provider.state.pullRequests.values()][0];
  if (!pr) throw new Error('管线没有创建 PR');

  log.warn(`Issue #1 标签：${issue.labels.join(', ')}`);
  log.warn(`PR #${pr.number} 标签：${pr.labels.join(', ')}`);
  log.warn(`评审轮次：${runner.reviewRounds}；结论重试：${runner.verdictRepairs}`);

  assert(issue.labels.includes('ai/in-review'), 'Issue 应当处于 ai/in-review');
  assert(!issue.labels.includes('ai/todo'), 'Issue 不应当保留 ai/todo');
  assert(pr.labels.includes('ai/approved'), 'PR 应当评审通过为 ai/approved');
  assert(runner.reviewRounds >= 2, '应当经历「评审 → 修复 → 复审」至少两轮');
  assert(runner.verdictRepairs === 1, '首次评审输出不可解析时，应当要求模型重新输出一次结论');

  // PR 正文按仓库约定必须各出现一次「实现假设清单」与「代码逻辑图」，
  // 内容优先取实现代理给出的两节，缺失时由 AutoGit 补全。
  assert(
    occurrences(pr.body, '## 实现假设清单') === 1 && occurrences(pr.body, '## 代码逻辑图') === 1,
    'PR 正文应当各包含一次「实现假设清单」与「代码逻辑图」标题',
  );
  assert(
    pr.body.includes('假设 src/feature.txt 的首行作为标题使用'),
    'PR 正文应当带上实现代理给出的假设清单',
  );
  assert(pr.body.includes('flowchart LR'), 'PR 正文应当带上实现代理给出的代码逻辑图');
  const fallbackBody = buildPullRequestBody(
    issue,
    '只改了 README，没有额外说明。',
    ['README.md'],
    repository.defaultBranch,
  );
  assert(
    occurrences(fallbackBody, '## 实现假设清单') === 1 &&
      occurrences(fallbackBody, '## 代码逻辑图') === 1 &&
      fallbackBody.includes('```mermaid'),
    '实现代理没给出两节时，PR 正文也必须补全且非空',
  );
  log.warn('PR 正文：实现假设清单 / 代码逻辑图两节齐全（含回落路径）✅');

  const inlineComments = provider.state.reviewComments.get(pr.number) ?? [];
  assert(inlineComments.length === 1, `评审应当留下 1 条行内评论，实际 ${inlineComments.length}`);
  assert(
    inlineComments[0]?.path === 'src/feature.txt' && inlineComments[0]?.line === 1,
    `行内评论应当锚定在 src/feature.txt:1，实际 ${inlineComments[0]?.path}:${inlineComments[0]?.line}`,
  );
  assert(
    JSON.stringify(provider.inlinePositions) === '[[1]]',
    `行内评论应当带上 git patch 内的位置候选，实际 ${JSON.stringify(provider.inlinePositions)}`,
  );
  const reviewSummary = (provider.state.comments.get(pr.number) ?? []).find((comment) =>
    comment.body.includes('AI 评审'),
  );
  assert(
    reviewSummary?.body.includes('### 行内评论') === true &&
      reviewSummary?.body.includes('`src/feature.txt:1`') === true,
    '汇总评论应当列出已发布的行内评论与锚点',
  );
  // 汇总评论里本来就有 `src/feature.txt:1`，只断言这个锚点等于没断言行内接线：
  // 必须检查只有「行内评论」小节才会出现的文本。
  assert(
    runner.lastFixPrompt?.includes('### 行内评论 1 · `src/feature.txt:1`') === true,
    '修复任务的提示词应当带上行内评论小节及其锚点',
  );
  assert(
    runner.lastFixPrompt?.includes('feature.txt 需要包含一行标题，便于后续渲染。') === true,
    '修复任务的提示词应当带上行内评论正文',
  );
  log.warn('行内评论场景通过：评审问题贴在 src/feature.txt:1，修复任务读取到该评论 ✅');

  // 提示词预览必须和真实修复流程取同一份上下文：汇总评论进「评审意见」，
  // 行内评论走单独的小节。此前预览把行内评论追进评论摘要后再取最后一条，
  // 「评审意见」的位置会被行内评论顶掉。
  const latestSummary = [...(provider.state.comments.get(pr.number) ?? [])]
    .reverse()
    .find((comment) => comment.body.includes('AI 评审'));
  const previewResponse = await app.inject({
    method: 'GET',
    url: `/api/codex/prompt-preview?repositoryId=${repository.id}&kind=fix&prNumber=${pr.number}`,
  });
  assert(
    previewResponse.statusCode === 200,
    `提示词预览接口应当返回 200，实际 ${previewResponse.statusCode}`,
  );
  const previewPrompt = (previewResponse.json() as { prompt: string }).prompt;
  assert(
    latestSummary !== undefined && previewPrompt.includes(latestSummary.body),
    '提示词预览的「评审意见」应当取最新的汇总评论原文',
  );
  assert(
    previewPrompt.includes('### 行内评论 1 · `src/feature.txt:1`'),
    '提示词预览应当把行内评论放进独立小节',
  );
  log.warn('提示词预览场景通过：汇总评论与行内评论各就各位，与真实修复流程一致 ✅');

  const branch = pr.headRef;
  const files = git(['ls-tree', '--name-only', '-r', `refs/heads/${branch}`], bareRepo)
    .split(/\r?\n/)
    .filter(Boolean);
  assert(files.includes('src/feature.txt'), '远端分支应包含 src/feature.txt');
  log.warn(`远端分支 ${branch} 文件：${files.join(', ')}`);

  provider.mergePullRequest(pr.number);
  await orchestrator.tick('merge');
  const merged = await provider.getIssue({ owner: 'sim', name: 'demo' }, 1);
  log.warn(`合并后 Issue #1 标签：${merged.labels.join(', ')}`);
  assert(merged.labels.includes('ai/verify'), 'PR 合并后 Issue 应转为 ai/verify');
  assert(
    !store.listOpenPullRequests(repository.id).some((row) => row.number === pr.number),
    '合并后的 PR 应当从看板数据中移除',
  );
  assert(store.countTrackedItems().pullRequests === 0, '合并后的 PR 不应计入跟踪中的 PR');

  // 一个只有人工关闭才会离开流水线的条目（`ai/verify`）：远端关闭后，
  // 下一次轮询必须把本地快照也标记为 closed，否则它会继续留在看板上。
  const verified = provider.seedIssue({
    number: 2,
    title: '待人工验证并关闭的 Issue',
    body: '用于验证关闭后的条目会离开流水线看板。',
    labels: ['ai/verify'],
  });
  await orchestrator.tick('verify-open');
  assert(
    store.listOpenIssues(repository.id).some((row) => row.number === verified.number),
    'ai/verify 的 Issue 在远端仍 open 时应当留在看板上',
  );

  provider.closeIssue(verified.number);
  await orchestrator.tick('verify-closed');
  const closedRow = store.listIssues(repository.id).find((row) => row.number === verified.number);
  assert(closedRow?.state === 'closed', '远端关闭后本地快照应当标记为 closed');
  assert(
    !store.listOpenIssues(repository.id).some((row) => row.number === verified.number),
    '关闭的 Issue 不应当出现在看板数据里',
  );
  assert(store.countTrackedItems().issues === 1, '关闭的 Issue 不应计入跟踪中的 Issue');

  const tasks = store.listTasks({ repositoryId: repository.id, limit: 20 });
  log.warn(
    `任务记录：${tasks
      .map((task) => `${task.kind}:${task.status}`)
      .reverse()
      .join(' → ')}`,
  );
  const succeeded = tasks.filter((task) => task.status === 'succeeded').length;
  assert(succeeded >= 4, `期望至少 4 个成功任务（实现/评审/修复/复审），实际 ${succeeded}`);

  // ---- 场景 2：同一仓库并发 + 评审去重 ---------------------------------
  //
  // 两个 implement 任务在同一仓库同时运行，期间反复轮询，验证：
  //   1. `maxConcurrentPerRepo` 放开的并发任务各自拿到独立工作区；
  //   2. 同一个 PR 的评审任务不会因为「PR 号 ≠ 关联 Issue 号」被重复入队。
  settings.update({ maxConcurrentPerRepo: 2, maxConcurrentTasks: 4 });
  provider.seedIssue({
    number: 3,
    title: '并发任务 A',
    body: '用于验证同一仓库的并发执行。',
    labels: ['ai/todo'],
  });
  provider.seedIssue({
    number: 4,
    title: '并发任务 B',
    body: '用于验证同一仓库的并发执行。',
    labels: ['ai/todo'],
  });

  // 一个 PR 号与关联 Issue 号不同的评审：分支名指向 Issue #3，PR 号却是另一个。
  // 这正是重复入队的触发条件（旧代码按 Issue 号去重，永远匹配不上）。
  const decoyBranch = 'ai/issue-3-dedupe-regression';
  git(['branch', decoyBranch, 'main'], bareRepo);
  const decoy = await provider.createPullRequest(
    { owner: 'sim', name: 'demo' },
    {
      title: '评审去重回归',
      body: '关联 Issue #3，但 PR 号与 Issue 号不同。',
      head: decoyBranch,
      base: 'main',
    },
  );
  await provider.setLabels(
    { owner: 'sim', name: 'demo' },
    { number: decoy.number, labels: ['ai/needs-review'], isPullRequest: true },
  );

  runner.hold(10_000);
  await orchestrator.tick('concurrency');

  // 工作区是在调用模型之前准备的，两个任务都拿到自己的目录后才继续断言。
  await waitFor(
    () =>
      store.listActiveTasks().filter((task) => task.status === 'running' && task.workspace !== null)
        .length === 2,
    20_000,
    '两个并发任务应当各自准备好工作区',
  );

  const parallel = orchestrator.status();
  log.warn(
    `并发运行中的任务：${parallel.runningTaskIds.length}，排队中：${parallel.queuedTaskIds.length}`,
  );
  assert(
    parallel.runningTaskIds.length === 2,
    `期望同一仓库并行运行 2 个任务，实际 ${parallel.runningTaskIds.length}`,
  );
  assert(
    parallel.queuedTaskIds.length === 1,
    `期望 1 个评审任务在排队（仓库并发已满），实际 ${parallel.queuedTaskIds.length}`,
  );

  const runningWorkspaces = store
    .listActiveTasks()
    .filter((task) => task.status === 'running')
    .map((task) => task.workspace);
  assert(
    runningWorkspaces.every((dir) => dir !== null && existsSync(dir)),
    '并发任务的独立工作区应当真实存在',
  );
  assert(new Set(runningWorkspaces).size === 2, '同一仓库的并发任务不应共享工作区目录');

  // 评审还在排队（标签没变），重复轮询不得再入队一份。
  await orchestrator.tick('concurrency-dedupe-1');
  await orchestrator.tick('concurrency-dedupe-2');
  const queuedReviews = store
    .listTasks({ repositoryId: repository.id, limit: 200 })
    .filter((task) => task.kind === 'review' && task.prNumber === decoy.number);
  assert(queuedReviews.length === 1, `同一 PR 只应入队一条评审任务，实际 ${queuedReviews.length}`);

  await runUntilQuiet(orchestrator, store, repository.id, 8);
  const concurrentImpl = store
    .listTasks({ repositoryId: repository.id, limit: 200 })
    .filter(
      (task) => task.kind === 'implement' && (task.issueNumber === 3 || task.issueNumber === 4),
    );
  assert(
    concurrentImpl.length === 2,
    `并发场景应当只有 2 个实现任务，实际 ${concurrentImpl.length}`,
  );
  assert(
    concurrentImpl.every((task) => task.status === 'succeeded'),
    '同一仓库并发的实现任务应当全部成功',
  );
  const remoteBranches = git(['branch', '--list', '--format=%(refname:short)'], bareRepo).split(
    /\r?\n/,
  );
  for (const task of concurrentImpl) {
    assert(
      task.branch !== null && remoteBranches.includes(task.branch),
      `并发任务的远端分支应当存在：${task.branch}`,
    );
  }

  const reviewTasks = store
    .listTasks({ repositoryId: repository.id, limit: 200 })
    .filter((task) => task.kind === 'review' && task.prNumber === decoy.number);
  assert(reviewTasks.length === 1, `评审任务应当只执行一次，实际 ${reviewTasks.length}`);
  assert(reviewTasks[0]?.status === 'succeeded', '去重后的评审任务应当成功完成');
  const reviewedPr = await provider.getPullRequest({ owner: 'sim', name: 'demo' }, decoy.number);
  assert(reviewedPr.labels.includes('ai/approved'), '评审通过后 PR 应当转为 ai/approved');
  log.warn('并发与去重场景通过：同仓库并行 2 个任务，同一 PR 只评审一次 ✅');

  // ---- 场景 3：人工重试重置失败额度 -------------------------------------
  //
  // 旧行为：失败计数终身累计，人工移除 ai/stuck 后下一个 tick 会立刻再次判定
  // 「已连续失败 N 次」，流水线永远无法恢复。现在以最近一次 ai/stuck 为基线，
  // 人工重试即重新获得完整额度。
  settings.update({ maxConcurrentPerRepo: 1 });
  const retryIssue = provider.seedIssue({
    number: 5,
    title: '失败重试额度',
    body: '用于验证人工重试会重置失败计数。',
    labels: ['ai/todo'],
  });
  runner.failImplementTimes = 3;

  for (let round = 1; round <= 4; round += 1) {
    // 每一轮都模拟人工重试：移除 ai/stuck 并重新打上 ai/todo。
    await provider.setLabels(
      { owner: 'sim', name: 'demo' },
      { number: retryIssue.number, labels: ['ai/todo'], isPullRequest: false },
    );
    await orchestrator.tick(`manual-retry-${round}`);
    await waitForIdle(orchestrator, store, 60_000);
    const current = await provider.getIssue({ owner: 'sim', name: 'demo' }, retryIssue.number);
    if (!current.labels.includes('ai/stuck')) break;
  }

  const retried = await provider.getIssue({ owner: 'sim', name: 'demo' }, retryIssue.number);
  assert(!retried.labels.includes('ai/stuck'), '人工重试后不应再次被判为阻塞');
  const retryTasks = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .filter((task) => task.kind === 'implement' && task.issueNumber === retryIssue.number);
  assert(
    retryTasks.filter((task) => task.status === 'failed').length === 3,
    '前三次尝试应当失败并累计到额度上限',
  );
  assert(
    retryTasks.some((task) => task.status === 'succeeded'),
    '人工重试后应当真正执行任务，而不是立刻重新阻塞',
  );
  log.warn('重试额度场景通过：连续失败 3 次阻塞后，人工重试仍能重新执行 ✅');

  // ---- 场景 4：基础克隆残留的本地分支不得污染推送租约 -------------------
  //
  // 任务工作区是 `git clone --local <基础克隆>` 出来的，基础克隆里的本地分支会
  // 被复制成任务工作区的 `origin/*` 远端跟踪引用。该引用的名字一旦等于本次要推
  // 送的分支，`push --force-with-lease` 就会把它当作「远端当前值」：远端根本没有
  // 这个分支时，推送直接被拒（`! [rejected] (stale info)`，线上 Issue #4 的故障）。
  const phantomIssue = provider.seedIssue({
    number: 6,
    title: '残留本地分支不得阻塞推送',
    body: '用于验证基础克隆里的残留本地分支不会污染推送租约。',
    labels: ['ai/todo'],
  });
  const phantomBranch = `${settings.get().branchPrefix}${phantomIssue.number}-${slugify(
    phantomIssue.title,
  )}`.slice(0, 120);
  const baseClone = workspace.pathFor(repository.id);
  git(['branch', phantomBranch, 'main'], baseClone);

  const remoteBranchNames = (): string[] =>
    git(['branch', '--list', '--format=%(refname:short)'], bareRepo)
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
  assert(
    !remoteBranchNames().includes(phantomBranch),
    `回归场景要求远端一开始没有 ${phantomBranch}`,
  );

  await runUntilQuiet(orchestrator, store, repository.id, 8);

  const phantomTasks = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .filter((task) => task.kind === 'implement' && task.issueNumber === phantomIssue.number);
  assert(
    phantomTasks.some((task) => task.status === 'succeeded'),
    '基础克隆存在同名残留分支时，实现任务仍应推送成功',
  );
  assert(remoteBranchNames().includes(phantomBranch), `远端应当出现分支 ${phantomBranch}`);
  log.warn('残留分支场景通过：基础克隆的同名本地分支不再让推送以 stale info 失败 ✅');

  // 同一分支已存在于远端、而基础克隆里的残留分支指向另一个提交时，租约也必须以
  // 远端当前值为准（人工重试 / 重跑 Issue 的常见形态）。
  await provider.setLabels(
    { owner: 'sim', name: 'demo' },
    { number: phantomIssue.number, labels: ['ai/todo'], isPullRequest: false },
  );
  await orchestrator.tick('phantom-branch-rerun');
  await waitForIdle(orchestrator, store, 60_000);
  const rerunTasks = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .filter((task) => task.kind === 'implement' && task.issueNumber === phantomIssue.number);
  assert(
    rerunTasks.filter((task) => task.status === 'succeeded').length >= 2,
    '远端已有同名分支且基础克隆残留分支指向别处时，重跑实现任务仍应推送成功',
  );
  log.warn('残留分支场景通过：重跑 Issue 时租约同样以远端当前值为准 ✅');

  // ---- 场景 5：同仓库并发任务共享基座克隆，fetch 不得互抢 ref 锁 ----------
  //
  // 同一仓库的并发任务都会在基座克隆里跑 `git fetch --all --prune --tags`。
  // 两个 fetch 同时更新同一个 refs/remotes/origin/* 时，先到的把分支推到新值，
  // 后到的还拿着自己读到的旧值去加锁，于是整个任务报
  // `cannot lock ref … is at c241f09… but expected 1150e10…` 失败（线上 PR #5
  // 评审任务的故障）。这里先制造「基座克隆落后、远端已前进」的状态，再同时发起
  // 两次抓取：修复前两个 fetch 会争抢同一个 ref，修复后同一仓库的基座抓取串行
  // 执行，两次都成功。
  assert(
    isTransientGitFailure({
      command: 'git',
      args: ['fetch'],
      code: 128,
      stdout:
        ' ! 1150e10..c241f09  ai/issue-3-x -> origin/ai/issue-3-x  (unable to update local ref)',
      stderr:
        "error: cannot lock ref 'refs/remotes/origin/ai/issue-3-x': is at c241f09 but expected 1150e10",
      durationMs: 12,
      timedOut: false,
      aborted: false,
      spawnError: null,
    }),
    'ref 抢锁（cannot lock ref）应当算作可重试的瞬时错误',
  );

  const silentLog: WorkspaceLog = () => {};
  const raceBranch = `${settings.get().branchPrefix}9-并发抓取回归`;
  git(['branch', raceBranch, 'main'], bareRepo);
  // 基座克隆先跟上远端，随后远端再前进一步：本地引用就落在了旧值上。
  await workspace.ensureClone(repository, provider, silentLog);
  const baseCloneDir = workspace.pathFor(repository.id);
  const staleTip = git(['rev-parse', `refs/remotes/origin/${raceBranch}`], baseCloneDir).trim();

  const seedDir = path.join(root, 'seed');
  writeFileSync(path.join(seedDir, 'race.txt'), '远端已经前进，基座克隆仍停在旧值。\n', 'utf8');
  git(['add', '-A'], seedDir);
  git(['commit', '-m', 'chore: 推进并发抓取回归分支'], seedDir);
  git(['push', 'origin', `main:refs/heads/${raceBranch}`], seedDir);
  const remoteTip = git(['rev-parse', 'HEAD'], seedDir).trim();
  assert(staleTip !== remoteTip, '回归场景要求基座克隆的远端引用落后于远端');

  const raceTaskIds = ['sim-race-a', 'sim-race-b'];
  const raceLines: Array<{ task: string; message: string }> = [];
  const taggedLog =
    (task: string): WorkspaceLog =>
    (_stream, message) => {
      raceLines.push({ task, message });
    };
  const raceResults = await Promise.allSettled(
    raceTaskIds.map((taskId, index) =>
      workspace.ensureClone(repository, provider, taggedLog(index === 0 ? 'a' : 'b'), { taskId }),
    ),
  );
  // 串行化的观测点：第一个任务的抓取会打印 `From <远端>`，第二个任务必须等到它
  // 结束之后才轮到「更新远端引用」这一行。修复前两行会在同一批微任务里先后打出，
  // 第二个任务的抓取压根不会等第一个。
  const firstFetchOutput = raceLines.findIndex(
    (line) => line.task === 'a' && /^From /i.test(line.message),
  );
  const secondFetchStart = raceLines.findIndex(
    (line) => line.task === 'b' && line.message.startsWith('更新远端引用'),
  );
  assert(firstFetchOutput !== -1, '回归场景要求第一次抓取打印远端更新行');
  assert(
    secondFetchStart > firstFetchOutput,
    '同一仓库的第二次基座抓取应当排在第一次之后（基座克隆按仓库串行）',
  );

  const raceFailure = raceResults.find((result) => result.status === 'rejected');
  assert(
    raceFailure === undefined,
    `同一仓库并发抓取基座克隆不应互相抢锁：${
      raceFailure?.status === 'rejected' ? String(raceFailure.reason) : ''
    }`,
  );
  assert(
    git(['rev-parse', `refs/remotes/origin/${raceBranch}`], baseCloneDir).trim() === remoteTip,
    '基座克隆应当已经跟上远端最新提交',
  );
  for (const taskId of raceTaskIds) {
    assert(
      existsSync(path.join(workspace.pathForTask(repository.id, taskId), '.git')),
      `并发抓取的任务工作区应当就绪：${taskId}`,
    );
    workspace.releaseTaskWorkspace(repository.id, taskId);
  }
  log.warn('基座抓取场景通过：同仓库并发任务串行抓取基座克隆，不再互抢 ref 锁 ✅');

  // ---- 场景 6：无文件改动的修复不再判失败，标题/正文由 AutoGit 维护 --------
  //
  // 旧行为：修复任务只要没有产生文件改动就抛错判失败，于是「评审要求改 PR
  // 标题 / 要求合并侧改写历史」这类只能由 AutoGit 或人工执行的意见会把流水线
  // 卡死（线上 PR #8 连续 20 轮 review ↔ fix 空转后失败）。现在元数据由 AutoGit
  // 自己通过平台 API 修正，无改动的修复按「无需改动」记为成功并说明理由。
  settings.update({ maxConcurrentPerRepo: 1 });
  const metadataIssue = provider.seedIssue({
    number: 7,
    title: '标题与正文维护',
    body: '用于验证 AutoGit 自己维护 PR 标题与正文，以及无改动的修复不再判失败。',
    labels: ['ai/todo'],
  });
  await runUntilQuiet(orchestrator, store, repository.id, 8);

  const metadataTasks = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .filter((task) => task.kind === 'implement' && task.issueNumber === metadataIssue.number);
  assert(
    metadataTasks.some((task) => task.status === 'succeeded'),
    'Issue #7 应当实现成功',
  );
  const metadataBranch = metadataTasks.find((task) => task.branch !== null)?.branch ?? '';
  const metadataPr = await provider.findPullRequestByHead(
    { owner: 'sim', name: 'demo' },
    metadataBranch,
  );
  assert(metadataPr !== null, `Issue #7 应当创建 PR（分支 ${metadataBranch}）`);
  if (!metadataPr) throw new Error('Issue #7 应当创建 PR');

  // 默认模板渲染的是「标题与正文维护 (#7)」，AutoGit 建 PR 时就补齐类型前缀；
  // 正文由 buildPullRequestBody 生成，两节必须齐全。
  assert(
    metadataPr.title === `feat: ${metadataIssue.title} (#${metadataIssue.number})`,
    `新建 PR 的标题应当带类型前缀，实际「${metadataPr.title}」`,
  );
  assert(
    bodyProblems(metadataPr.body).length === 0,
    `新建 PR 的正文应当包含两节，问题：${bodyProblems(metadataPr.body).join('；')}`,
  );
  log.warn('元数据场景：新建 PR 的标题与正文已符合仓库约定 ✅');

  // 模拟历史遗留的 PR：标题没有类型前缀，正文也缺两节。
  const legacyPr = metadataPr;
  provider.setPullRequestMetadata(legacyPr.number, {
    title: '标题与正文维护 (#7)',
    body: '## 改动说明\n\n（人为去掉两节，模拟早期 AutoGit 建的 PR）',
  });
  const updatesBefore = provider.metadataUpdates.length;
  runner.forceNeedsFixRounds = 1;
  runner.noChangeFixRounds = 1;
  await provider.setLabels(
    { owner: 'sim', name: 'demo' },
    { number: legacyPr.number, labels: ['ai/needs-fix'], isPullRequest: true },
  );
  await orchestrator.tick('metadata-sync');
  await waitForIdle(orchestrator, store, 60_000);

  const syncedPr = await provider.getPullRequest({ owner: 'sim', name: 'demo' }, legacyPr.number);
  assert(
    syncedPr.title === `feat: ${metadataIssue.title} (#${metadataIssue.number})`,
    `AutoGit 应当把标题补成 \`feat: …\`，实际「${syncedPr.title}」`,
  );
  assert(
    bodyProblems(syncedPr.body).length === 0,
    `AutoGit 应当补齐正文两节，问题：${bodyProblems(syncedPr.body).join('；')}`,
  );
  assert(
    provider.metadataUpdates.length > updatesBefore &&
      provider.metadataUpdates.at(-1)?.number === legacyPr.number,
    'AutoGit 应当通过平台 API 修改过该 PR 的标题与正文',
  );
  const syncTask = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .find((task) => task.kind === 'fix' && task.prNumber === legacyPr.number);
  assert(
    syncTask?.status === 'succeeded',
    `没有文件改动的修复任务应当记为成功，实际 ${syncTask?.status}（${syncTask?.error ?? '无错误信息'}）`,
  );
  assert(syncTask?.error === null, '没有文件改动的修复任务不应带错误原因');
  assert(
    syncedPr.labels.includes('ai/needs-review'),
    'AutoGit 修正元数据后 PR 应当回到 ai/needs-review（有进展就继续流水线）',
  );
  log.warn('元数据场景通过：AutoGit 自己修正 PR 标题与正文，无改动的修复不判失败 ✅');

  // 元数据已经合规、文件也不用改：按「无需改动」记录理由并交回人工，
  // 既不再判失败，也不会让流水线继续空转。
  const updatesBeforePark = provider.metadataUpdates.length;
  runner.forceNeedsFixRounds = 1;
  runner.noChangeFixRounds = 1;
  await provider.setLabels(
    { owner: 'sim', name: 'demo' },
    { number: legacyPr.number, labels: ['ai/needs-fix'], isPullRequest: true },
  );
  await orchestrator.tick('no-change-fix');
  await waitForIdle(orchestrator, store, 60_000);

  const parkedPr = await provider.getPullRequest({ owner: 'sim', name: 'demo' }, legacyPr.number);
  const noChangeTasks = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .filter((task) => task.kind === 'fix' && task.prNumber === legacyPr.number);
  // `listTasks` returns newest first, so the parked run is the first entry.
  const noChangeTask = noChangeTasks[0];
  assert(
    noChangeTask?.status === 'succeeded',
    `没有任何改动的修复应当记为成功并说明理由，实际 ${noChangeTask?.status}`,
  );
  assert(noChangeTask?.error === null, '没有任何改动的修复不应带错误原因');
  assert(
    (noChangeTask?.summary ?? '').includes('没有产生文件改动'),
    '任务总结里应当说明「本轮没有产生文件改动」的理由',
  );
  assert(parkedPr.labels.includes('ai/stuck'), '没有任何改动时应当交回人工确认');
  assert(
    provider.metadataUpdates.length === updatesBeforePark,
    '元数据已经合规时不应再调用平台 API 改写标题/正文',
  );

  const tasksBeforeExtraTick = store.listTasks({ repositoryId: repository.id, limit: 300 }).length;
  await orchestrator.tick('no-change-fix-again');
  await waitForIdle(orchestrator, store, 60_000);
  assert(
    store.listTasks({ repositoryId: repository.id, limit: 300 }).length === tasksBeforeExtraTick,
    'ai/stuck 之后不应当再自动重排修复任务（否则又会回到 review ↔ fix 空转）',
  );
  log.warn('无改动场景通过：记录理由并转人工确认，不再判失败也不再空转 ✅');

  // 模型自己决定、AutoGit 代跑：修复代理在动作块里要求改标题与正文。
  const requestedBody = [
    '## 改动说明',
    '',
    '标题与正文由修复代理给出，AutoGit 负责执行。',
    '',
    '## 实现假设清单',
    '',
    '- 假设平台 API 由 AutoGit 调用，修复代理只负责判断。',
    '',
    '## 代码逻辑图',
    '',
    '```mermaid',
    'flowchart LR',
    '  A["修复代理提出动作"] --> B["AutoGit 执行"]',
    '```',
  ].join('\n');
  provider.setPullRequestMetadata(legacyPr.number, {
    title: '待代理修标题',
    body: '## 改动说明\n\n（缺两节，等代理请求）',
  });
  runner.forceNeedsFixRounds = 1;
  runner.noChangeFixRounds = 1;
  runner.fixActionBlock = {
    prTitle: 'fix: 待代理修标题',
    prBody: requestedBody,
    reason: '标题与正文属于平台元数据，沙箱里改不到',
  };
  await provider.setLabels(
    { owner: 'sim', name: 'demo' },
    { number: legacyPr.number, labels: ['ai/needs-fix'], isPullRequest: true },
  );
  await orchestrator.tick('agent-requested-metadata');
  await waitForIdle(orchestrator, store, 60_000);
  runner.fixActionBlock = null;

  const requestedPr = await provider.getPullRequest(
    { owner: 'sim', name: 'demo' },
    legacyPr.number,
  );
  assert(
    requestedPr.title === 'fix: 待代理修标题',
    `AutoGit 应当按请求改标题，实际「${requestedPr.title}」`,
  );
  assert(requestedPr.body === requestedBody, 'AutoGit 应当按请求替换 PR 正文');
  assert(
    requestedPr.labels.includes('ai/needs-review'),
    '执行完代理请求的动作后 PR 应当回到 ai/needs-review',
  );
  log.warn('动作场景通过：修复代理提出、AutoGit 代执行 PR 标题与正文修改 ✅');

  // ---- 场景 7：修复代理请求清理分支历史 --------------------------------
  //
  // 「分支历史里误提交了包缓存」只能靠改写历史解决，而改写需要写 `.git` 与推送
  // 权限——都在沙箱之外。模型把需求写进动作块，AutoGit 用有界改写（只动本分支
  // 自己的提交）+ 强推执行，tip 树与合并基准都不许变。
  const purgeIssue = provider.seedIssue({
    number: 8,
    title: '历史里的误提交缓存',
    body: '用于验证修复代理请求清理分支历史时，AutoGit 会代它改写并强推。',
    labels: ['ai/todo'],
  });
  await runUntilQuiet(orchestrator, store, repository.id, 8);

  const purgeTasks = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .filter((task) => task.kind === 'implement' && task.issueNumber === purgeIssue.number);
  const purgeBranch = purgeTasks.find((task) => task.branch !== null)?.branch ?? '';
  const purgePr = await provider.findPullRequestByHead({ owner: 'sim', name: 'demo' }, purgeBranch);
  assert(purgePr !== null, `Issue #8 应当创建 PR（分支 ${purgeBranch}）`);
  if (!purgePr) throw new Error('Issue #8 应当创建 PR');

  // 制造线上 PR #8 那种形态：先误提交缓存，再在后续提交里删掉工作树里的它。
  // 于是 tip 树干净，但对象仍然从分支可达——正是「删文件救不了」的情形。
  git(['fetch', 'origin', purgeBranch], seedDir);
  git(['checkout', '-B', purgeBranch, 'FETCH_HEAD'], seedDir);
  mkdirSync(path.join(seedDir, '.pnpm-store'), { recursive: true });
  writeFileSync(path.join(seedDir, '.pnpm-store', 'junk.bin'), 'cached tarball\n', 'utf8');
  git(['add', '-f', '--', '.pnpm-store'], seedDir);
  git(['commit', '-m', 'chore: 误提交包缓存'], seedDir);
  rmSync(path.join(seedDir, '.pnpm-store'), { recursive: true, force: true });
  git(['add', '-A'], seedDir);
  git(['commit', '-m', 'chore: 删除缓存目录（历史仍可达）'], seedDir);
  git(['push', '--force', 'origin', purgeBranch], seedDir);
  git(['checkout', 'main'], seedDir);

  const reachableJunk = (): string =>
    git(
      ['rev-list', '--objects', `refs/heads/${purgeBranch}`, '--', '.pnpm-store'],
      bareRepo,
    ).trim();
  assert(reachableJunk().length > 0, '回归场景要求分支历史里确实有缓存对象');
  const tipTreeBefore = git(['rev-parse', `refs/heads/${purgeBranch}^{tree}`], bareRepo).trim();
  const tipBefore = git(['rev-parse', `refs/heads/${purgeBranch}`], bareRepo).trim();

  runner.forceNeedsFixRounds = 1;
  runner.noChangeFixRounds = 1;
  runner.fixActionBlock = {
    purgePaths: ['.pnpm-store'],
    reason: '缓存目录只能从分支历史里删掉，沙箱没有写 .git 与推送的权限',
  };
  await provider.setLabels(
    { owner: 'sim', name: 'demo' },
    { number: purgePr.number, labels: ['ai/needs-fix'], isPullRequest: true },
  );
  await orchestrator.tick('purge-history');
  await waitForIdle(orchestrator, store, 60_000);
  runner.fixActionBlock = null;

  assert(
    reachableJunk() === '',
    `改写后分支历史里不应再有缓存对象，实际：${reachableJunk().slice(0, 200)}`,
  );
  assert(
    git(['rev-parse', `refs/heads/${purgeBranch}^{tree}`], bareRepo).trim() === tipTreeBefore,
    '改写分支历史后 tip 树必须逐字节不变',
  );
  assert(
    git(['rev-parse', `refs/heads/${purgeBranch}`], bareRepo).trim() !== tipBefore,
    '改写应当真的移动了分支 tip',
  );
  const purgeFixTask = store
    .listTasks({ repositoryId: repository.id, limit: 300 })
    .find((task) => task.kind === 'fix' && task.prNumber === purgePr.number);
  assert(
    purgeFixTask?.status === 'succeeded',
    `清理历史的修复任务应当成功，实际 ${purgeFixTask?.status}（${purgeFixTask?.error ?? '无错误信息'}）`,
  );
  assert(
    (purgeFixTask?.summary ?? '').includes('分支历史已改写'),
    '任务总结里应当说明 AutoGit 代执行的改写动作',
  );
  const purgedPr = await provider.getPullRequest({ owner: 'sim', name: 'demo' }, purgePr.number);
  assert(
    purgedPr.labels.includes('ai/needs-review'),
    '分支历史清理完成后 PR 应当回到 ai/needs-review',
  );
  log.warn('历史清理场景通过：模型提出、AutoGit 有界改写并强推，tip 树保持不变 ✅');

  orchestrator.stop();

  // ---- 场景 6：行内评论的锚点解析与平台回退语义 -------------------------
  //
  // ① 探针：git 默认 `core.quotePath=true` 会把非 ASCII 路径写成八进制转义
  //    （`+++ "b/docs/\350\257\264\346\230\216.md"`），解析器必须还原出真实
  //    路径，否则中文文件名永远锚不上；`workspace.diffPatch()` 另外用
  //    `-c core.quotePath=false` 让 git 直接给出原始 UTF-8 路径。
  const quotedUnicodePatch = [
    'diff --git "a/docs/\\350\\257\\264\\346\\230\\216.md" "b/docs/\\350\\257\\264\\346\\230\\216.md"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/docs/\\350\\257\\264\\346\\230\\216.md"',
    '@@ -0,0 +1,2 @@',
    '+第一行',
    '+第二行',
  ].join('\n');
  const quotedAnchor = parseDiffAnchors(quotedUnicodePatch).find('docs/说明.md', 2);
  assert(
    quotedAnchor?.line === 2 && JSON.stringify(quotedAnchor.diffPositions) === '[2]',
    `quotePath 转义的中文路径应当解析出锚点，实际 ${JSON.stringify(quotedAnchor)}`,
  );
  const rawAnchor = parseDiffAnchors(
    [
      'diff --git a/docs/说明.md b/docs/说明.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/说明.md',
      '@@ -0,0 +1,2 @@',
      '+第一行',
      '+第二行',
    ].join('\n'),
  ).find('docs/说明.md', 2);
  assert(
    rawAnchor?.line === 2 && JSON.stringify(rawAnchor.diffPositions) === '[2]',
    `原始 UTF-8 路径应当解析出锚点，实际 ${JSON.stringify(rawAnchor)}`,
  );

  // 顺带守住解析器已知的边界：删除文件、二进制文件、越界行号都不能锚定，
  // 新增行内容以 `+++ ` 开头时不得被当成文件头，路径后缀匹配仍然可用。
  const trickyPatch = [
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,3 @@',
    '+plain',
    '+++ 这不是文件头',
    '+tail',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-removed',
    'diff --git a/assets/logo.png b/assets/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/assets/logo.png differ',
    'diff --git a/src/deep/big.txt b/src/deep/big.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/deep/big.txt',
    '@@ -0,0 +1 @@',
    '+content',
  ].join('\n');
  const tricky = parseDiffAnchors(trickyPatch);
  assert(
    JSON.stringify(tricky.find('src/new.ts', 3)?.diffPositions) === '[3]',
    '以 `+++ ` 开头的新增行不应打乱后续行的 patch 位置',
  );
  assert(tricky.find('src/gone.ts', 1) === null, '删除的文件不应当解析出锚点');
  assert(tricky.find('assets/logo.png', 1) === null, '二进制文件不应当解析出锚点');
  assert(tricky.find('src/new.ts', 9) === null, 'diff 之外的行号不应当解析出锚点');
  assert(tricky.find('big.txt', 1)?.path === 'src/deep/big.txt', '唯一后缀匹配应当解析出锚点');

  // ①b 多 hunk 文件里的 position 口径：GitHub 文档写「从该文件第一个 @@ 起算、
  //     它下面那一行是 1」，并「一直数到下一个文件为止」；核对真实 PR 的行内
  //     评论可以确认后续 hunk 的 `@@` 头行同样占一个位置（第 N 个 hunk 差 N-1）。
  //     不数头行的读法只在第二个 hunk 起才不同，两种都随锚点带出。
  const multiHunkPatch = [
    'diff --git a/src/multi.txt b/src/multi.txt',
    '--- a/src/multi.txt',
    '+++ b/src/multi.txt',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    '@@ -10,3 +20,3 @@',
    ' x',
    '-y',
    '+Y',
    ' z',
    '@@ -30 +40 @@',
    '+Z',
  ].join('\n');
  const multi = parseDiffAnchors(multiHunkPatch);
  assert(
    JSON.stringify(multi.find('src/multi.txt', 2)?.diffPositions) === '[3]',
    `第一个 hunk 里两种口径一致，只应带一个候选（删除行也占一位），实际 ${JSON.stringify(multi.find('src/multi.txt', 2))}`,
  );
  assert(
    JSON.stringify(multi.find('src/multi.txt', 21)?.diffPositions) === '[8,7]',
    `第二个 hunk 应当带上两种口径，实际 ${JSON.stringify(multi.find('src/multi.txt', 21))}`,
  );
  assert(
    JSON.stringify(multi.find('src/multi.txt', 40)?.diffPositions) === '[11,9]',
    `第三个 hunk 的口径差应当是 2，实际 ${JSON.stringify(multi.find('src/multi.txt', 40))}`,
  );

  // ④ 路径启发式：模型漏写目录（`src/x.ts` 之于 `apps/web/src/x.ts`）可以按
  //    后缀补全，因为补出来的路径确实出现在 diff 里；反过来给相对路径**多加**
  //    目录不再猜（那些目录无法用 diff 核对，宁可退回汇总评论）。绝对路径是
  //    例外：仓库根之上那段目录本来就无从得知，只能按后缀匹配。
  const pathPatch = [
    'diff --git a/src/feature.txt b/src/feature.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/feature.txt',
    '@@ -0,0 +1 @@',
    '+content',
  ].join('\n');
  const paths = parseDiffAnchors(pathPatch);
  assert(paths.find('./src/feature.txt', 1)?.path === 'src/feature.txt', '`./` 前缀应当解析出锚点');
  assert(
    paths.find('b/src/feature.txt', 1)?.path === 'src/feature.txt',
    'diff 头路径应当解析出锚点',
  );
  assert(paths.find('feature.txt', 1)?.path === 'src/feature.txt', '漏写目录的后缀匹配应当保留');
  assert(
    paths.find('apps/server/src/feature.txt', 1) === null,
    '相对路径多写目录时不得锚到同后缀的其它文件',
  );
  assert(
    paths.find('/home/runner/work/demo/src/feature.txt', 1)?.path === 'src/feature.txt',
    '绝对路径应当按后缀匹配到仓库内路径',
  );
  log.warn(
    '锚点解析场景通过：中文路径、多 hunk position 口径、二进制/删除文件与路径启发式均符合预期 ✅',
  );

  // ② Gitee：`position` 的每个候选都必须试一次。第一次请求被实例拒绝（4xx）
  //    时也要继续试下一种语义，只有全部失败才退回汇总评论。
  const giteeApi = await startFakeApi((call) => {
    if (call.method === 'POST' && call.path === '/api/v5/repos/sim/demo/pulls/1/comments') {
      const body = call.body as { path: string; position: number };
      // 只认「新文件行号」的实例：两个 patch 位置都被拒，行号 20 通过。
      if (body.position !== 20) return { status: 400, json: { message: 'position 无效' } };
      return {
        status: 201,
        json: { id: 77, path: body.path, position: body.position, new_line: 20, body: 'body' },
      };
    }
    if (call.method === 'GET' && call.path === '/api/v5/repos/sim/demo/pulls/comments/77') {
      return {
        status: 200,
        json: {
          id: 77,
          path: 'src/feature.txt',
          position: 20,
          new_line: 20,
          body: 'body',
          created_at: new Date().toISOString(),
          user: { login: 'autogit-bot' },
        },
      };
    }
    return { status: 404, json: { message: 'not found' } };
  });
  const gitee = new GiteeProvider(fakeAccount('gitee', `${giteeApi.baseUrl}/api/v5`));
  const giteeComment = await gitee.createReviewComment({ owner: 'sim', name: 'demo' }, 1, {
    body: '行内评论正文',
    path: 'src/feature.txt',
    line: 20,
    diffPositions: [5, 4],
    commitId: null,
  });
  const giteePosts = giteeApi.calls
    .filter((call) => call.method === 'POST')
    .map((call) => (call.body as { position: number }).position);
  assert(
    giteePosts.join(',') === '5,4,20',
    `Gitee 前一次 position 被拒后应当继续尝试剩余候选，实际 POST position=${giteePosts.join(',')}`,
  );
  assert(giteeComment.line === 20, `Gitee 行内评论应当锚定在第 20 行，实际 ${giteeComment.line}`);
  await giteeApi.close();

  // ②b 只认「不数 hunk 头行」那种口径的实例：第二个候选（锚点里的备选口径）
  //     就能成功，不必再退到新文件行号；与行号相同的候选只发一次。
  const headerlessApi = await startFakeApi((call) => {
    if (call.method === 'POST' && call.path === '/api/v5/repos/sim/demo/pulls/1/comments') {
      const body = call.body as { path: string; position: number };
      if (body.position !== 4) return { status: 400, json: { message: 'position 无效' } };
      return {
        status: 201,
        json: { id: 78, path: body.path, position: 4, new_line: 20, body: 'body' },
      };
    }
    if (call.method === 'GET' && call.path === '/api/v5/repos/sim/demo/pulls/comments/78') {
      return {
        status: 200,
        // Gitee 的 OpenAPI 定义里 `position` / `new_line` 都是字符串。
        json: { id: 78, path: 'src/feature.txt', position: '4', new_line: '20', body: 'body' },
      };
    }
    return { status: 404, json: { message: 'not found' } };
  });
  const headerlessGitee = new GiteeProvider(
    fakeAccount('gitee', `${headerlessApi.baseUrl}/api/v5`),
  );
  const headerlessComment = await headerlessGitee.createReviewComment(
    { owner: 'sim', name: 'demo' },
    1,
    {
      body: '行内评论正文',
      path: 'src/feature.txt',
      line: 20,
      diffPositions: [20, 4],
      commitId: null,
    },
  );
  const headerlessPosts = headerlessApi.calls
    .filter((call) => call.method === 'POST')
    .map((call) => (call.body as { position: number }).position);
  assert(
    headerlessPosts.join(',') === '20,4' && headerlessComment.line === 20,
    `Gitee 应当按顺序试到备选 patch 口径为止，实际 POST position=${headerlessPosts.join(',')}，行号 ${headerlessComment.line}`,
  );
  await headerlessApi.close();

  // ③ Gitee 读回里只有被原样回写的 `position`（没有 `new_line`）时不算验证通过：
  //    必须删除这条评论并抛错，让调用方把它退回汇总评论。
  const echoStore = new Map<number, { path: string; position: number }>();
  const echoApi = await startFakeApi((call) => {
    const id = Number.parseInt(call.path.split('/').at(-1) ?? '', 10);
    if (call.method === 'POST' && call.path.endsWith('/comments')) {
      const body = call.body as { path: string; position: number };
      const created = 90 + echoStore.size;
      echoStore.set(created, { path: body.path, position: body.position });
      // 只回写 position，不回传 new_line：锚点无法验证。
      return { status: 201, json: { id: created, path: body.path, position: body.position } };
    }
    if (call.method === 'GET' && call.path.includes('/pulls/comments/')) {
      const stored = echoStore.get(id);
      return stored
        ? { status: 200, json: { id, ...stored, body: 'body' } }
        : { status: 404, json: { message: 'not found' } };
    }
    if (call.method === 'DELETE' && call.path.includes('/pulls/comments/')) {
      echoStore.delete(id);
      return { status: 204 };
    }
    return { status: 404, json: { message: 'not found' } };
  });
  const echoGitee = new GiteeProvider(fakeAccount('gitee', `${echoApi.baseUrl}/api/v5`));
  const echoFailure = await expectRejects(
    () =>
      echoGitee.createReviewComment({ owner: 'sim', name: 'demo' }, 1, {
        body: '行内评论正文',
        path: 'src/feature.txt',
        line: 20,
        diffPositions: [5],
        commitId: null,
      }),
    'Gitee 无法读回 new_line 时应当判定锚定失败',
  );
  assert(
    echoFailure.includes('退回汇总评论'),
    `Gitee 失败信息应当说明会退回汇总评论，实际：${echoFailure}`,
  );
  assert(
    echoStore.size === 0 &&
      echoApi.calls.filter((call) => call.method === 'DELETE').length === 2 &&
      echoApi.calls.filter((call) => call.method === 'POST').length === 2,
    'Gitee 未验证通过的评论应当被删除，且两种 position 语义都要试过',
  );
  await echoApi.close();

  // ④ Gitea：写接口只回 review id，必须读回 `reviews/{id}/comments` 核对行号；
  //    对不上就删除这条 review（Gitea 会连带删除它的代码评论）并退回汇总评论。
  const giteaApi = await startFakeApi((call) => {
    if (call.method === 'POST' && call.path === '/api/v1/repos/sim/demo/pulls/1/reviews') {
      return { status: 200, json: { id: 33, comments_count: 1 } };
    }
    if (
      call.method === 'GET' &&
      call.path === '/api/v1/repos/sim/demo/pulls/1/reviews/33/comments'
    ) {
      // 实例把 new_position 当成了 patch 位置：真实行号与目标行号不一致。
      return {
        status: 200,
        json: [{ id: 9, path: 'src/feature.txt', position: 5, original_position: 5, body: 'x' }],
      };
    }
    if (call.method === 'DELETE' && call.path === '/api/v1/repos/sim/demo/pulls/1/reviews/33') {
      return { status: 204 };
    }
    return { status: 404, json: { message: 'not found' } };
  });
  const gitea = new GiteaProvider(fakeAccount('gitea', `${giteaApi.baseUrl}/api/v1`));
  const giteaFailure = await expectRejects(
    () =>
      gitea.createReviewComment({ owner: 'sim', name: 'demo' }, 1, {
        body: '行内评论正文',
        path: 'src/feature.txt',
        line: 20,
        diffPositions: [5],
        commitId: null,
      }),
    'Gitea 读回的行号与目标不一致时应当判定锚定失败',
  );
  assert(
    giteaFailure.includes('退回汇总评论'),
    `Gitea 失败信息应当说明会退回汇总评论，实际：${giteaFailure}`,
  );
  assert(
    ['POST', 'GET', 'DELETE'].every((method) =>
      giteaApi.calls.some((call) => call.method === method),
    ),
    `Gitea 应当写入后读回核对并删除错位的 review，实际调用：${giteaApi.calls
      .map((call) => `${call.method} ${call.path}`)
      .join(' → ')}`,
  );
  await giteaApi.close();

  const giteaOkApi = await startFakeApi((call) => {
    if (call.method === 'POST' && call.path === '/api/v1/repos/sim/demo/pulls/1/reviews') {
      return { status: 200, json: { id: 34, comments_count: 1 } };
    }
    if (
      call.method === 'GET' &&
      call.path === '/api/v1/repos/sim/demo/pulls/1/reviews/34/comments'
    ) {
      return {
        status: 200,
        json: [{ id: 10, path: 'src/feature.txt', position: 20, original_position: 20 }],
      };
    }
    return { status: 404, json: { message: 'not found' } };
  });
  const giteaOk = new GiteaProvider(fakeAccount('gitea', `${giteaOkApi.baseUrl}/api/v1`));
  const giteaComment = await giteaOk.createReviewComment({ owner: 'sim', name: 'demo' }, 1, {
    body: '行内评论正文',
    path: 'src/feature.txt',
    line: 20,
    diffPositions: [5],
    commitId: null,
  });
  assert(giteaComment.line === 20, `Gitea 行内评论应当锚定在第 20 行，实际 ${giteaComment.line}`);
  await giteaOkApi.close();

  // ⑤ 行内小节只在真的有行内评论时出现：旧的断言只匹配 `src/feature.txt:1`，
  //    而汇总评论文本里本来就有它，所以必须落到「### 行内评论」这段独有文本上。
  const savedInlineComments = provider.state.reviewComments.get(pr.number) ?? [];
  provider.state.reviewComments.set(pr.number, []);
  const previewWithoutInline = await app.inject({
    method: 'GET',
    url: `/api/codex/prompt-preview?repositoryId=${repository.id}&kind=fix&prNumber=${pr.number}`,
  });
  provider.state.reviewComments.set(pr.number, savedInlineComments);
  assert(
    previewWithoutInline.statusCode === 200,
    `提示词预览应当返回 200，实际 ${previewWithoutInline.statusCode}`,
  );
  const promptWithoutInline = (previewWithoutInline.json() as { prompt: string }).prompt;
  assert(
    promptWithoutInline.includes('AI 评审'),
    '提示词预览应当带上评审意见原文',
  );
  assert(
    !promptWithoutInline.includes('### 行内评论'),
    '没有行内评论时提示词不应出现行内小节',
  );

  // ⑥ 合并讨论（复审提示词的「已有讨论」、提示词预览）必须与会话评论去重：
  //    Gitee 的代码行评论同时出现在两个读取端点里，同一条意见不能被喂两次。
  const duplicateComment = {
    id: '9',
    author: 'autogit-bot',
    body: '同一条意见',
    createdAt: '2026-01-01T00:00:00.000Z',
    url: null,
  };
  const deduped = mergeReviewDiscussion(
    [duplicateComment],
    [{ ...duplicateComment, path: 'src/feature.txt', line: 1 }],
  );
  assert(deduped.length === 1, `重复的行内评论应当被去掉，实际 ${deduped.length} 条`);
  const anchoredOnly = mergeReviewDiscussion(
    [],
    [{ ...duplicateComment, id: '10', path: 'src/feature.txt', line: 3, body: '行内正文' }],
  );
  assert(
    anchoredOnly[0]?.body === '`src/feature.txt:3`\n行内正文',
    `行内评论正文应当带上锚点，实际 ${JSON.stringify(anchoredOnly[0]?.body)}`,
  );
  log.warn('行内评论回退场景通过：中文路径可锚定，Gitee/Gitea 均会读回核对并退回汇总评论 ✅');

  // ---------------------------------------------------------- 回归：评审意见

  // ① 任务失败后，本地快照必须立刻带上 ai/stuck：重试按钮依赖它判断可用性，
  //    而下一轮轮询（默认 45s）之前没人会刷新它。
  const stuckIssue = provider.seedIssue({
    number: 7,
    title: '验证失败后的重试门禁',
    body: '该 Issue 的实现任务会被模拟为失败，用于验证本地快照与 ai/stuck 同步。',
    labels: ['ai/todo'],
  });
  runner.failNextRun('模拟：Codex 执行失败');
  await orchestrator.tick('retry-gate');
  await waitForIdle(orchestrator, store, 60_000);

  const failedTask = store
    .listTasks({ repositoryId: repository.id, limit: 50 })
    .find(
      (task) =>
        task.kind === 'implement' &&
        task.issueNumber === stuckIssue.number &&
        task.status === 'failed',
    );
  if (!failedTask) throw new Error('断言失败：期望一个失败任务，但最近的任务都不是 failed');
  const retrySnapshot = store
    .listIssues(repository.id)
    .find((row) => row.number === stuckIssue.number);
  assert(retrySnapshot?.labels.includes('ai/stuck') === true, '失败后本地快照应立即包含 ai/stuck');
  assert(
    withRetryState(store, [failedTask])[0]?.retryable === true,
    '失败后重试门禁应立即放行，无需等待下一轮轮询',
  );
  log.warn(`回归 ①：失败后 Issue #${stuckIssue.number} 的本地快照立即同步 ai/stuck ✅`);

  // ② “重新检测”不得内联等待模型探测（最长 3 分钟）：请求立即返回并报告
  //    探测进行中，结果由状态接口跟进，且并发请求复用同一次模型调用。
  const probeGate = deferred<CodexModelProbe>();
  let probeRuns = 0;
  // 真实探测会启动 Codex CLI，模拟环境里没有；这里只替换探测本身，
  // 缓存、并发合并与接口契约仍然走真实代码。
  const probeSeam = codex as unknown as {
    runModelProbe: () => Promise<CodexModelProbe>;
    cacheProbe: (probe: CodexModelProbe) => CodexModelProbe;
  };
  probeSeam.runModelProbe = async () => {
    probeRuns += 1;
    return probeSeam.cacheProbe(await probeGate.promise);
  };

  const invalidate = await withTimeout(
    app.inject({ method: 'POST', url: '/api/codex/invalidate' }),
    5_000,
    '“重新检测”不应内联等待模型探测',
  );
  assert(invalidate.statusCode === 200, `重新检测接口应返回 200，实际 ${invalidate.statusCode}`);
  const invalidated = invalidate.json<{ status: CodexStatus; probing: boolean }>();
  assert(probeRuns === 1, `重新检测应当触发一次模型探测，实际 ${probeRuns} 次`);
  assert(invalidated.probing === true, '重新检测应立即返回并标记“探测进行中”');

  const sharedProbe = codex.modelProbe(true);
  assert(probeRuns === 1, '探测进行中再次请求应复用同一次模型调用');
  const probingStatus = (await app.inject({ method: 'GET', url: '/api/codex/status' })).json<{
    status: CodexStatus;
  }>();
  assert(probingStatus.status.probing === true, '探测进行中时状态接口应报告 probing');
  assert(probingStatus.status.modelProbe === null, '探测未完成时不应伪造探测结果');

  probeGate.resolve({
    ready: true,
    message: 'pong',
    durationMs: 12,
    checkedAt: new Date().toISOString(),
  });
  await sharedProbe;
  const settledStatus = (await app.inject({ method: 'GET', url: '/api/codex/status' })).json<{
    status: CodexStatus;
  }>();
  assert(settledStatus.status.probing === false, '探测结束后不应继续报告“进行中”');
  assert(settledStatus.status.modelProbe?.ready === true, '探测结束后状态应带上探测结果');
  assert(
    store.listActivity(50).some((entry) => entry.message.includes('模型响应正常')),
    '后台探测结束后应写入活动记录',
  );
  log.warn('回归 ②：“重新检测”立即返回，模型探测在后台完成且只调用一次 ✅');

  // ③ 重启调度器不得把内存队列/运行中的任务当成“服务重启中断”：
  //    它们随后照常执行，之前会被先标成 cancelled 并留下误导性活动。
  // 关掉仓库轮询，让重启触发的 tick 不会另外调度新任务，这里只看任务状态。
  store.updateRepository(repository.id, { enabled: false });
  const runGate = deferred<void>();
  runner.holdNextRun(runGate.promise);

  const runningTask = await orchestrator.enqueueManual({
    repositoryId: repository.id,
    kind: 'implement',
    issueNumber: 1,
  });
  assert(store.getTask(runningTask.id)?.status === 'running', '手动任务应立即进入运行状态');
  const queuedTask = await orchestrator.enqueueManual({
    repositoryId: repository.id,
    kind: 'implement',
    issueNumber: 2,
  });
  assert(store.getTask(queuedTask.id)?.status === 'queued', '同一仓库的第二个任务应留在队列里');

  const restarted = await app.inject({ method: 'POST', url: '/api/orchestrator/restart' });
  assert(restarted.statusCode === 200, `重启接口应返回 200，实际 ${restarted.statusCode}`);
  assert(
    store.getTask(queuedTask.id)?.status === 'queued',
    '重启不应把仍在内存队列中的任务标成 cancelled',
  );
  assert(
    !store.listActivity(200).some((entry) => entry.message.includes('因服务重启被中断')),
    '重启不应为仍在处理中的任务写入“服务重启中断”活动',
  );

  runGate.resolve();
  await waitForIdle(orchestrator, store, 60_000);
  assert(
    store.getTask(runningTask.id)?.status === 'cancelled',
    '被重启中断的运行中任务应记录为 cancelled',
  );
  assert(
    store.getTask(queuedTask.id)?.summary?.includes('Issue 已关闭') === true,
    '重启后留在队列里的任务应照常执行',
  );
  log.warn('回归 ③：重启保留内存队列，不再误报“服务重启中断” ✅');

  await app.close();
  orchestrator.stop(); // 回归 ③ 用 restart() 拉起过调度器，这里停掉计时器
  db.close();
  rmSync(root, { recursive: true, force: true });
  log.warn('=== 模拟通过：Issue → PR → 评审 → 修复 → 复审 → 合并 ✅ ===');
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`);
}

/** Account stub for a provider that is pointed at a local fake API. */
function fakeAccount(provider: ProviderAccount['provider'], baseUrl: string): ProviderAccount {
  return { provider, baseUrl, username: null, token: 'sim-token', proxyUrl: null };
}

function expectRejects(action: () => Promise<unknown>, message: string): Promise<string> {
  return action().then(
    () => {
      throw new Error(`断言失败：${message}（实际没有抛错）`);
    },
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      if (!text) throw new Error(`断言失败：${message}（未带上错误信息）`);
      return text;
    },
  );
}

interface FakeApiCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * In-process stand-in for a platform REST API, so the provider fallbacks can be
 * verified offline: it records every call and answers from `handler`.
 */
async function startFakeApi(handler: (call: FakeApiCall) => { status: number; json?: unknown }) {
  const calls: FakeApiCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const call: FakeApiCall = {
        method: request.method ?? '',
        path: new URL(request.url ?? '/', 'http://fake.local').pathname,
        body,
      };
      calls.push(call);
      const answer = handler(call);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.json === undefined ? '' : JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('模拟 API 未能绑定本地端口');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // 原生 fetch 会保持 keep-alive 连接，不主动断开的话 close() 永不回调。
        server.closeAllConnections();
      }),
  };
}

/** How often `needle` appears in `text` (used to check PR section headings). */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Fails fast instead of hanging when an endpoint waits on a step that never ends. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`断言失败：${message}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForIdle(
  orchestrator: Orchestrator,
  store: Store,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = orchestrator.status();
    const active = store.listActiveTasks();
    if (
      status.runningTaskIds.length === 0 &&
      status.queuedTaskIds.length === 0 &&
      active.length === 0
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('等待任务完成超时');
}

/** Polls a synchronous condition, so assertions can wait for async git work. */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${message}`);
}

/**
 * Each tick can enqueue follow-up work (a new PR needs a review, a review with
 * findings needs a fix...), so the simulation keeps ticking until the pipeline
 * stops producing new tasks.
 */
async function runUntilQuiet(
  orchestrator: Orchestrator,
  store: Store,
  repositoryId: string,
  maxRounds: number,
): Promise<void> {
  for (let round = 1; round <= maxRounds; round += 1) {
    const before = store.listTasks({ repositoryId, limit: 500 }).length;
    await orchestrator.tick(`round-${round}`);
    await waitForIdle(orchestrator, store, 60_000);
    const after = store.listTasks({ repositoryId, limit: 500 }).length;
    logger().warn(`轮次 ${round}：任务数 ${before} → ${after}`);
    if (after === before) return;
  }
}

main().catch(async (error: unknown) => {
  logger().error({ err: error }, '模拟失败');
  // The orchestrator keeps a poll timer alive, so a failed run must not wait
  // for the event loop to drain: flush the log and exit with a failure code.
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(1);
});
