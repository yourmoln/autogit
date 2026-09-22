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
import type { EngineRunInput, EngineRunResult } from '../services/runner.js';
import { EngineRunner } from '../services/runner.js';
import { SettingsService } from '../services/settings.js';
import { WorkspaceManager } from '../services/workspace.js';
import { initLogger, logger } from '../util/logger.js';

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

  override async run(input: EngineRunInput): Promise<EngineRunResult> {
    const started = Date.now();
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
  const providers = new ProviderFactory(store, Buffer.alloc(32, 7));
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
