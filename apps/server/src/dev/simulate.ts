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
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  Comment,
  ProviderKind,
  RemoteIssue,
  RemoteLabel,
  RemotePullRequest,
  RemoteRepositorySummary,
  RemoteUser,
} from '@autogit/shared';

import { ensureRuntimeDirectories, loadRuntimeConfig } from '../config.js';
import { Db } from '../db/database.js';
import { migrate } from '../db/migrations.js';
import { Store } from '../db/store.js';
import type { GitProvider, RepoRef } from '../providers/index.js';
import { CodexService } from '../services/codex.js';
import { EventBus } from '../services/events.js';
import { LabelService } from '../services/labels.js';
import { Orchestrator } from '../services/orchestrator.js';
import { ProviderFactory } from '../services/providers.js';
import { ProxyService } from '../services/proxy.js';
import type { EngineRunInput, EngineRunResult } from '../services/runner.js';
import { EngineRunner } from '../services/runner.js';
import { SettingsService } from '../services/settings.js';
import { WorkspaceManager } from '../services/workspace.js';
import { initLogger, logger } from '../util/logger.js';
import { slugify } from '../util/time.js';

interface StubState {
  labels: Set<string>;
  issues: Map<number, RemoteIssue>;
  pullRequests: Map<number, RemotePullRequest>;
  comments: Map<number, Comment[]>;
  nextCommentId: number;
}

class StubProvider implements GitProvider {
  readonly kind: ProviderKind = 'github';
  readonly baseUrl = 'http://stub.local';
  readonly proxyUrl = null;
  readonly state: StubState = {
    labels: new Set<string>(),
    issues: new Map(),
    pullRequests: new Map(),
    comments: new Map(),
    nextCommentId: 1,
  };
  private nextPullRequest = 1;

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
  /** Wall-clock deadline every following run waits for before doing its work. */
  private holdUntil = 0;

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
            line: null,
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
      input.log('command', '$ write src/feature.txt');
      writeFileSync(
        path.join(input.cwd, 'src', 'feature.txt'),
        'AutoGit Feature\n\n修复：按评审意见补上标题行。\n',
        'utf8',
      );
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
    return success('新增 src/feature.txt，实现 Issue 要求。', started);
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
  const runner = new SimulationRunner(config, settings, codex);
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

  orchestrator.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
  log.warn('=== 模拟通过：Issue → PR → 评审 → 修复 → 复审 → 合并 ✅ ===');
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`);
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

main().catch((error: unknown) => {
  logger().error({ err: error }, '模拟失败');
  process.exitCode = 1;
});
