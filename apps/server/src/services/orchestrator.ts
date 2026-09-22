import path from 'node:path';

import {
  applyStatusTransition,
  type EngineId,
  type IssueStatus,
  isAiLabel,
  isPaused,
  isStuck,
  type OrchestratorStatus,
  type PullRequestStatus,
  preferredEngine,
  preferredReviewEngine,
  priorityOf,
  priorityRank,
  type RemoteIssue,
  type RemotePullRequest,
  type Task,
  type TaskKind,
  type TaskPriority,
} from '@autogit/shared';

import type { RuntimeConfig } from '../config.js';
import type { RepositoryRecord, Store } from '../db/store.js';
import type { GitProvider, RepoRef } from '../providers/index.js';
import { childLogger } from '../util/logger.js';
import { nowIso, slugify } from '../util/time.js';
import type { CodexService } from './codex.js';
import type { EventBus } from './events.js';
import { buildGitEnv } from './git.js';
import type { LabelService } from './labels.js';
import {
  buildFixPrompt,
  buildImplementPrompt,
  buildReviewPrompt,
  type CommentDigest,
  REVIEW_SCHEMA,
} from './prompts.js';
import type { ProviderFactory } from './providers.js';
import { EngineRunner, type ReviewVerdict, type TaskLogger } from './runner.js';
import type { SettingsService } from './settings.js';
import type { WorkspaceManager } from './workspace.js';

const AI_MARKER = '<!-- autogit -->';
const MAX_ATTEMPTS_PER_ITEM = 3;

export interface OrchestratorDeps {
  config: RuntimeConfig;
  store: Store;
  settings: SettingsService;
  events: EventBus;
  codex: CodexService;
  runner: EngineRunner;
  workspace: WorkspaceManager;
  providers: ProviderFactory;
  labels: LabelService;
}

interface QueueEntry {
  taskId: string;
  repositoryId: string;
  kind: TaskKind;
  priority: TaskPriority;
  issueNumber: number | null;
  prNumber: number | null;
  enqueuedAt: number;
}

interface RunningTask {
  entry: QueueEntry;
  controller: AbortController;
}

export interface TickReport {
  at: string;
  reason: string;
  scannedRepositories: number;
  queued: number;
  running: number;
  errors: string[];
}

export class Orchestrator {
  private readonly log = childLogger('orchestrator');
  private readonly queue: QueueEntry[] = [];
  private readonly running = new Map<string, RunningTask>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private tickInFlight = false;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private nextTickAt: string | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  // -------------------------------------------------------------- lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    this.log.info('orchestrator started');
    void this.tick('startup');
    this.scheduleNext(1000);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const runningTask of this.running.values()) runningTask.controller.abort();
    this.log.info('orchestrator stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    const seconds = this.deps.settings.get().pollSeconds;
    const wait = delayMs > 0 ? delayMs : seconds * 1000;
    this.nextTickAt = new Date(Date.now() + wait).toISOString();
    this.timer = setTimeout(() => {
      void this.tick('scheduled');
    }, wait);
  }

  status(): OrchestratorStatus {
    return buildStatus({
      running: this.started,
      pollSeconds: this.deps.settings.get().pollSeconds,
      maxConcurrent: this.deps.settings.get().maxConcurrentTasks,
      runningTaskIds: [...this.running.keys()],
      queuedTaskIds: this.queue.map((entry) => entry.taskId),
      lastTickAt: this.lastTickAt,
      nextTickAt: this.nextTickAt,
      lastTickError: this.lastTickError,
      repositories: this.deps.store.listRepositories().map((repository) => ({
        repositoryId: repository.id,
        fullName: repository.fullName,
        enabled: repository.enabled,
        lastPolledAt: repository.lastPolledAt,
        lastPollError: repository.lastPollError,
        trackedIssues: this.deps.store
          .listIssues(repository.id)
          .filter(
            (issue) =>
              issue.state === 'open' &&
              (issue.labels.some((label) => isAiLabel(label)) || issue.isPullRequest),
          ).length,
      })),
    });
  }

  isRunningTask(taskId: string): boolean {
    return this.running.has(taskId);
  }

  // -------------------------------------------------------------------- tick

  async tick(reason: string): Promise<TickReport> {
    const report: TickReport = {
      at: nowIso(),
      reason,
      scannedRepositories: 0,
      queued: 0,
      running: this.running.size,
      errors: [],
    };

    if (this.tickInFlight) return report;
    this.tickInFlight = true;

    try {
      const repositories = this.deps.store.listEnabledRepositories();
      for (const repository of repositories) {
        try {
          await this.syncRepository(repository);
          report.scannedRepositories += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report.errors.push(`${repository.fullName}: ${message}`);
          this.lastTickError = message;
          this.deps.store.updateRepository(repository.id, {
            lastPolledAt: nowIso(),
            lastPollError: message,
          });
          this.deps.store.addActivity({
            level: 'error',
            scope: 'poll',
            repositoryId: repository.id,
            message: `轮询失败：${message}`,
          });
        }
      }

      this.lastTickAt = nowIso();
      await this.processQueue();
      report.queued = this.queue.length;
      report.running = this.running.size;

      this.deps.events.emit({
        type: 'orchestrator.tick',
        at: this.lastTickAt,
        queued: this.queue.length,
        running: this.running.size,
        error: report.errors[0] ?? null,
      });
    } finally {
      this.tickInFlight = false;
      this.scheduleNext(0);
    }

    return report;
  }

  // ---------------------------------------------------------- repo scanning

  private async syncRepository(repository: RepositoryRecord): Promise<void> {
    const provider = this.deps.providers.forAccount(repository.accountId);
    const ref: RepoRef = { owner: repository.owner, name: repository.name };
    const settings = this.deps.settings.get();

    const issues = await provider.listIssues(ref, { state: 'open', limit: 200 });
    const trackedIssues = issues.filter((issue) => issue.labels.some((label) => isAiLabel(label)));

    for (const issue of trackedIssues) {
      this.deps.store.upsertIssue({
        repositoryId: repository.id,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels,
        author: issue.author,
        htmlUrl: issue.htmlUrl,
        updatedAt: issue.updatedAt,
        isPullRequest: false,
      });
    }

    const pullRequests = await provider.listPullRequests(ref, { state: 'open', limit: 100 });
    const trackedPulls = pullRequests.filter(
      (pr) => pr.labels.some((label) => isAiLabel(label)) || this.isAgentBranch(pr.headRef),
    );

    for (const pr of trackedPulls) {
      this.upsertPullRequest(repository, pr);
    }

    if (settings.autoInitializeLabels && !repository.labelsInitialized) {
      await this.deps.labels.initialize(repository);
    }

    await this.scheduleIssues(repository, provider, ref, trackedIssues);
    await this.schedulePullRequests(repository, provider, ref, trackedPulls);
    await this.reconcileMerged(repository, provider, ref, trackedIssues);
    await this.recoverStalled(repository, provider, ref, trackedIssues);

    this.deps.store.updateRepository(repository.id, {
      lastPolledAt: nowIso(),
      lastPollError: null,
    });
  }

  private upsertPullRequest(repository: RepositoryRecord, pr: RemotePullRequest): void {
    const issueNumber = this.issueNumberFromPull(repository, pr);
    this.deps.store.upsertPullRequest({
      repositoryId: repository.id,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged: pr.merged,
      labels: pr.labels,
      author: pr.author,
      htmlUrl: pr.htmlUrl,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      headSha: pr.headSha,
      issueNumber,
      mergedAt: pr.mergedAt,
      updatedAt: pr.updatedAt,
    });
  }

  private issueNumberFromPull(repository: RepositoryRecord, pr: RemotePullRequest): number | null {
    const fromBranch = issueNumberFromBranch(pr.headRef, this.deps.settings.get().branchPrefix);
    if (fromBranch !== null) return fromBranch;
    const fromBody = pr.body.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
    if (fromBody?.[1]) return Number.parseInt(fromBody[1], 10);
    const stored = this.deps.store.findPullRequestByHead(repository.id, pr.headRef);
    return stored?.issueNumber ?? null;
  }

  private isAgentBranch(branch: string): boolean {
    return branch.startsWith(this.deps.settings.get().branchPrefix);
  }

  private async scheduleIssues(
    repository: RepositoryRecord,
    provider: GitProvider,
    ref: RepoRef,
    issues: RemoteIssue[],
  ): Promise<void> {
    for (const issue of issues) {
      if (isPaused(issue.labels) || isStuck(issue.labels)) continue;

      const hasTodo = issue.labels.includes('ai/todo');
      const hasDoing = issue.labels.includes('ai/doing');
      if (!hasTodo && !hasDoing) continue;

      const kind: TaskKind = 'implement';
      if (this.hasOpenTask(repository.id, kind, issue.number)) continue;

      const attempts = this.deps.store.countFailedTasks(repository.id, 'implement', {
        issueNumber: issue.number,
      });
      if (attempts >= MAX_ATTEMPTS_PER_ITEM) {
        await this.markStuck(
          provider,
          ref,
          { number: issue.number, labels: issue.labels, isPullRequest: false },
          `已连续失败 ${attempts} 次，自动流水线暂停。请检查 Issue 描述或补充上下文后移除 ${'ai/stuck'} 标签重试。`,
        );
        continue;
      }

      const engine = this.resolveEngine(issue.labels, 'implement');
      const task = this.deps.store.createTask({
        id: `${repository.id}-${nowIso()}-${issue.number}-${Math.random().toString(36).slice(2, 8)}`,
        repositoryId: repository.id,
        kind,
        engine,
        priority: priorityOf(issue.labels),
        issueNumber: issue.number,
        issueTitle: issue.title,
      });

      this.enqueue({
        taskId: task.id,
        repositoryId: repository.id,
        kind,
        priority: task.priority,
        issueNumber: issue.number,
        prNumber: null,
        enqueuedAt: Date.now(),
      });
      this.emitTask(task.id);

      this.deps.store.addActivity({
        level: 'info',
        scope: 'queue',
        repositoryId: repository.id,
        message: `#${issue.number} ${issue.title} 进入实现队列（${engine === 'codex' ? 'Codex' : 'Claude'}）`,
      });
    }
  }

  private async schedulePullRequests(
    repository: RepositoryRecord,
    provider: GitProvider,
    ref: RepoRef,
    pullRequests: RemotePullRequest[],
  ): Promise<void> {
    const settings = this.deps.settings.get();

    for (const pr of pullRequests) {
      if (isPaused(pr.labels) || isStuck(pr.labels)) continue;

      if (settings.autoReview && pr.labels.includes('ai/needs-review')) {
        if (!this.hasOpenTask(repository.id, 'review', pr.number)) {
          const attempts = this.deps.store.countFailedTasks(repository.id, 'review', {
            prNumber: pr.number,
          });
          if (attempts >= MAX_ATTEMPTS_PER_ITEM) {
            await this.markStuck(
              provider,
              ref,
              { number: pr.number, labels: pr.labels, isPullRequest: true },
              `评审连续失败 ${attempts} 次，请人工介入。`,
            );
            continue;
          }
          const task = this.deps.store.createTask({
            id: `${repository.id}-${nowIso()}-pr${pr.number}-review-${Math.random().toString(36).slice(2, 8)}`,
            repositoryId: repository.id,
            kind: 'review',
            engine: this.resolveEngine(pr.labels, 'review'),
            priority: priorityOf(pr.labels),
            prNumber: pr.number,
            issueNumber: this.issueNumberFromPull(repository, pr),
          });
          this.enqueue({
            taskId: task.id,
            repositoryId: repository.id,
            kind: 'review',
            priority: task.priority,
            issueNumber: task.issueNumber,
            prNumber: pr.number,
            enqueuedAt: Date.now(),
          });
          this.emitTask(task.id);
          this.deps.store.addActivity({
            level: 'info',
            scope: 'queue',
            repositoryId: repository.id,
            message: `PR #${pr.number} ${pr.title} 进入评审队列`,
          });
        }
      }

      if (settings.autoFix && pr.labels.includes('ai/needs-fix')) {
        if (this.hasOpenTask(repository.id, 'fix', pr.number)) continue;
        const attempts = this.deps.store.countFailedTasks(repository.id, 'fix', {
          prNumber: pr.number,
        });
        if (attempts >= MAX_ATTEMPTS_PER_ITEM) {
          await this.markStuck(
            provider,
            ref,
            { number: pr.number, labels: pr.labels, isPullRequest: true },
            `修复连续失败 ${attempts} 次，请人工介入。`,
          );
          continue;
        }
        const task = this.deps.store.createTask({
          id: `${repository.id}-${nowIso()}-pr${pr.number}-fix-${Math.random().toString(36).slice(2, 8)}`,
          repositoryId: repository.id,
          kind: 'fix',
          engine: this.resolveEngine(pr.labels, 'fix'),
          priority: priorityOf(pr.labels),
          prNumber: pr.number,
          issueNumber: this.issueNumberFromPull(repository, pr),
        });
        this.enqueue({
          taskId: task.id,
          repositoryId: repository.id,
          kind: 'fix',
          priority: task.priority,
          issueNumber: task.issueNumber,
          prNumber: pr.number,
          enqueuedAt: Date.now(),
        });
        this.emitTask(task.id);
        this.deps.store.addActivity({
          level: 'info',
          scope: 'queue',
          repositoryId: repository.id,
          message: `PR #${pr.number} 进入修复队列`,
        });
      }
    }
  }

  /**
   * Issues sitting in `ai/in-review` are watched until their pull request gets
   * merged (→ `ai/verify`) or closed without merging (→ `ai/stuck`).
   */
  private async reconcileMerged(
    repository: RepositoryRecord,
    provider: GitProvider,
    ref: RepoRef,
    issues: RemoteIssue[],
  ): Promise<void> {
    for (const issue of issues) {
      if (!issue.labels.includes('ai/in-review')) continue;

      const branch = this.deps.store
        .listRecentTaskByIssue(repository.id, issue.number)
        .find((task) => task.kind === 'implement' && task.branch)?.branch;
      if (!branch) continue;

      const pr = await provider.findPullRequestByHead(ref, branch);
      if (!pr) continue;

      this.upsertPullRequest(repository, pr);

      if (pr.merged) {
        await this.transitionIssue(repository.id, provider, ref, issue, 'ai/verify', {
          comment: `PR #${pr.number} 已合并，进入人工验证阶段。验证通过后请人工关闭本 Issue。`,
        });
        this.deps.store.addActivity({
          level: 'success',
          scope: 'pipeline',
          repositoryId: repository.id,
          message: `#${issue.number} 的 PR #${pr.number} 已合并，Issue 转为 ai/verify`,
        });
      } else if (pr.state === 'closed') {
        await this.markStuck(
          provider,
          ref,
          { number: issue.number, labels: issue.labels, isPullRequest: false },
          `关联的 PR #${pr.number} 在未合并的情况下被关闭。请确认是放弃该改动，还是重新打上 ai/todo 让 AI 再来一次。`,
        );
      }
    }
  }

  /** Re-claims `ai/doing` issues that lost their worker (e.g. app restart). */
  private async recoverStalled(
    repository: RepositoryRecord,
    _provider: GitProvider,
    _ref: RepoRef,
    issues: RemoteIssue[],
  ): Promise<void> {
    for (const issue of issues) {
      if (!issue.labels.includes('ai/doing')) continue;
      if (isPaused(issue.labels) || isStuck(issue.labels)) continue;
      if (this.hasOpenTask(repository.id, 'implement', issue.number)) continue;
      if (this.deps.store.findOpenTask(repository.id, 'implement', issue.number)) continue;

      const last = this.deps.store
        .listRecentTaskByIssue(repository.id, issue.number)
        .find((task) => task.kind === 'implement');
      const unfinished = !last || last.status === 'failed' || last.status === 'cancelled';
      if (!unfinished) continue;

      const attempts = this.deps.store.countFailedTasks(repository.id, 'implement', {
        issueNumber: issue.number,
      });
      if (attempts >= MAX_ATTEMPTS_PER_ITEM) continue;

      const task = this.deps.store.createTask({
        id: `${repository.id}-${nowIso()}-${issue.number}-resume-${Math.random().toString(36).slice(2, 8)}`,
        repositoryId: repository.id,
        kind: 'implement',
        engine: this.resolveEngine(issue.labels, 'implement'),
        priority: priorityOf(issue.labels),
        issueNumber: issue.number,
        issueTitle: issue.title,
      });
      this.enqueue({
        taskId: task.id,
        repositoryId: repository.id,
        kind: 'implement',
        priority: task.priority,
        issueNumber: issue.number,
        prNumber: null,
        enqueuedAt: Date.now(),
      });
      this.emitTask(task.id);
      this.deps.store.addActivity({
        level: 'warning',
        scope: 'pipeline',
        repositoryId: repository.id,
        message: `#${issue.number} 处于 ai/doing 但没有运行中的任务，已重新入队`,
      });
    }
  }

  // ------------------------------------------------------------------ queue

  enqueue(entry: QueueEntry): void {
    const exists = this.queue.some((item) => item.taskId === entry.taskId);
    if (exists || this.running.has(entry.taskId)) return;
    this.queue.push(entry);
    this.queue.sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.enqueuedAt - b.enqueuedAt,
    );
  }

  async enqueueManual(input: {
    repositoryId: string;
    kind: TaskKind;
    issueNumber?: number | null;
    prNumber?: number | null;
    priority?: TaskPriority;
  }): Promise<Task> {
    const repository = this.deps.store.getRepository(input.repositoryId);
    if (!repository) throw new Error('仓库不存在');

    const engine = this.resolveEngine([], input.kind);
    const task = this.deps.store.createTask({
      id: `${repository.id}-${nowIso()}-manual-${Math.random().toString(36).slice(2, 8)}`,
      repositoryId: repository.id,
      kind: input.kind,
      engine,
      priority: input.priority ?? 'high',
      issueNumber: input.issueNumber ?? null,
      prNumber: input.prNumber ?? null,
    });
    this.enqueue({
      taskId: task.id,
      repositoryId: repository.id,
      kind: input.kind,
      priority: task.priority,
      issueNumber: task.issueNumber,
      prNumber: task.prNumber,
      enqueuedAt: Date.now(),
    });
    this.emitTask(task.id);
    void this.processQueue();
    return task;
  }

  cancelTask(taskId: string): boolean {
    const runningTask = this.running.get(taskId);
    if (runningTask) {
      runningTask.controller.abort();
      return true;
    }
    const index = this.queue.findIndex((entry) => entry.taskId === taskId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      const task = this.deps.store.updateTask(taskId, {
        status: 'cancelled',
        finishedAt: nowIso(),
        summary: '已取消',
      });
      if (task) {
        this.appendLog(taskId, 'system', '任务在队列中取消');
        this.emitTask(taskId);
      }
      return true;
    }
    return false;
  }

  private hasOpenTask(repositoryId: string, kind: TaskKind, number: number | null): boolean {
    const inQueue = this.queue.some(
      (entry) =>
        entry.repositoryId === repositoryId && entry.kind === kind && entry.issueNumber === number,
    );
    if (inQueue) return true;
    for (const runningTask of this.running.values()) {
      if (runningTask.entry.repositoryId === repositoryId && runningTask.entry.kind === kind) {
        if (kind === 'review' || kind === 'fix') {
          if (runningTask.entry.prNumber === number) return true;
        } else if (runningTask.entry.issueNumber === number) return true;
      }
    }
    return this.deps.store.findOpenTask(repositoryId, kind, number) !== null;
  }

  private async processQueue(): Promise<void> {
    const settings = this.deps.settings.get();
    if (this.queue.length === 0) return;
    if (this.running.size >= settings.maxConcurrentTasks) return;

    const busyRepositories = new Set(
      [...this.running.values()].map((task) => task.entry.repositoryId),
    );

    for (let index = 0; index < this.queue.length; index += 1) {
      if (this.running.size >= settings.maxConcurrentTasks) break;
      const entry = this.queue[index];
      if (!entry) continue;
      if (busyRepositories.has(entry.repositoryId)) continue;

      this.queue.splice(index, 1);
      index -= 1;

      const controller = new AbortController();
      this.running.set(entry.taskId, { entry, controller });
      busyRepositories.add(entry.repositoryId);

      void this.execute(entry, controller)
        .catch((error: unknown) => {
          this.log.error({ err: error, taskId: entry.taskId }, 'task crashed outside of handler');
        })
        .finally(() => {
          this.running.delete(entry.taskId);
          void this.processQueue();
        });
    }
  }

  // -------------------------------------------------------------- execution

  private async execute(entry: QueueEntry, controller: AbortController): Promise<void> {
    const task = this.deps.store.getTask(entry.taskId);
    if (!task) return;

    const startedAt = nowIso();
    this.deps.store.updateTask(entry.taskId, {
      status: 'running',
      startedAt,
      attempts: task.attempts + 1,
      error: null,
    });
    this.emitTask(entry.taskId);
    this.appendLog(entry.taskId, 'system', `任务开始（${entry.kind}）`);

    try {
      switch (entry.kind) {
        case 'implement':
          await this.runImplement(entry, controller.signal);
          break;
        case 'review':
          await this.runReview(entry, controller.signal);
          break;
        case 'fix':
          await this.runFix(entry, controller.signal);
          break;
        default:
          throw new Error(`未知任务类型：${String(entry.kind)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = nowIso();
      this.deps.store.updateTask(entry.taskId, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: message,
        finishedAt,
      });
      this.appendLog(entry.taskId, 'stderr', message);
      this.emitTask(entry.taskId);
      // A user-initiated cancel must not park the issue on `ai/stuck`.
      if (!controller.signal.aborted) {
        await this.handleFailure(entry, message).catch((nested: unknown) => {
          this.log.warn({ err: nested }, 'failed to record failure state');
        });
      }
    } finally {
      this.deps.store.pruneLogs(entry.taskId);
    }
  }

  private async runImplement(entry: QueueEntry, signal: AbortSignal): Promise<void> {
    const { workspace, runner, providers, config } = this.deps;
    const settings = this.deps.settings.get();
    const repository = this.requireRepository(entry.repositoryId);
    const provider = providers.forAccount(repository.accountId);
    const ref: RepoRef = { owner: repository.owner, name: repository.name };
    const issueNumber = entry.issueNumber;
    if (issueNumber === null) throw new Error('实现任务缺少 Issue 编号');

    const log = this.taskLogger(entry.taskId);
    const issue = await provider.getIssue(ref, issueNumber);
    this.deps.store.upsertIssue({
      repositoryId: repository.id,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      author: issue.author,
      htmlUrl: issue.htmlUrl,
      updatedAt: issue.updatedAt,
      isPullRequest: false,
    });

    if (isPaused(issue.labels)) {
      this.finishTask(entry.taskId, 'cancelled', 'Issue 处于 ai/paused，跳过执行');
      return;
    }

    const branch = `${settings.branchPrefix}${issue.number}-${slugify(issue.title)}`.slice(0, 120);
    this.deps.store.updateTask(entry.taskId, { branch, issueTitle: issue.title });

    await this.transitionIssue(repository.id, provider, ref, issue, 'ai/doing', {
      comment: `AutoGit 已领取该 Issue，正在实现中（分支 \`${branch}\`）。`,
    });

    const comments = await provider.listComments(ref, issue.number);
    const digests: CommentDigest[] = comments.map((comment) => ({
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt,
    }));

    const cwd = await workspace.ensureClone(repository, provider, log);
    await workspace.prepareBranchFromBase(cwd, repository, branch, provider, log);

    const prompt = buildImplementPrompt({
      repository: {
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        owner: repository.owner,
        name: repository.name,
      },
      issue,
      comments: digests,
      branch,
      verificationHints: buildVerificationHints(repository),
    });

    this.appendLog(entry.taskId, 'system', '开始调用 Codex 实现 Issue');
    const result = await runner.run({
      taskId: entry.taskId,
      engine: this.currentEngine(entry.taskId),
      cwd,
      prompt,
      log,
      signal,
      timeoutMs: settings.taskTimeoutMinutes * 60_000,
      env: buildGitEnv(provider.gitAuthorizationHeader()),
      taskDir: path.join(config.dataDir, 'tasks', entry.taskId),
    });

    if (!result.ok) throw new Error(result.error ?? 'Codex 执行失败');

    const commit = await workspace.commitAll(
      cwd,
      buildCommitMessage(issue, result.summary),
      provider,
      log,
    );
    if (!commit.committed) {
      throw new Error('Codex 没有产生任何文件改动，无法创建 PR。请补充 Issue 细节后重试。');
    }

    await workspace.pushBranch(cwd, branch, provider, log, { force: true });

    const existing = await provider.findPullRequestByHead(ref, branch);
    const pr =
      existing ??
      (await provider.createPullRequest(ref, {
        title: renderTitle(settings.prTitleTemplate, issue),
        body: buildPullRequestBody(issue, result.summary, commit.files, repository.defaultBranch),
        head: branch,
        base: repository.defaultBranch,
      }));

    this.upsertPullRequest(repository, pr);
    await this.transitionPull(repository.id, provider, ref, pr, 'ai/needs-review', {
      comment: existing
        ? `已推送新的实现提交（\`${commit.sha?.slice(0, 7) ?? 'unknown'}\`），重新进入 AI 评审队列。`
        : undefined,
    });

    const fresh = await provider.getIssue(ref, issue.number);
    await this.transitionIssue(repository.id, provider, ref, fresh, 'ai/in-review', {
      comment: `已创建 PR #${pr.number}：${pr.htmlUrl}\n\n后续评审与修复由 AI 自动推进，评审通过后会打上 \`ai/approved\` 等待人工合并。`,
    });

    this.finishTask(entry.taskId, 'succeeded', result.summary, {
      prNumber: pr.number,
      prUrl: pr.htmlUrl,
      branch,
      workspace: cwd,
    });
    this.deps.store.addActivity({
      level: 'success',
      scope: 'pipeline',
      repositoryId: repository.id,
      message: `#${issue.number} 实现完成，已创建 PR #${pr.number}`,
    });
  }

  private async runReview(entry: QueueEntry, signal: AbortSignal): Promise<void> {
    const { workspace, runner, providers, config } = this.deps;
    const settings = this.deps.settings.get();
    const repository = this.requireRepository(entry.repositoryId);
    const provider = providers.forAccount(repository.accountId);
    const ref: RepoRef = { owner: repository.owner, name: repository.name };
    const prNumber = entry.prNumber;
    if (prNumber === null) throw new Error('评审任务缺少 PR 编号');

    const log = this.taskLogger(entry.taskId);
    const pullRequest = await provider.getPullRequest(ref, prNumber);
    this.upsertPullRequest(repository, pullRequest);

    if (isPaused(pullRequest.labels)) {
      this.finishTask(entry.taskId, 'cancelled', 'PR 处于 ai/paused，跳过评审');
      return;
    }
    if (!pullRequest.labels.includes('ai/needs-review')) {
      this.finishTask(entry.taskId, 'cancelled', 'PR 已不在 ai/needs-review 状态，跳过');
      return;
    }

    const issue = await this.fetchLinkedIssue(repository, provider, ref, pullRequest);
    const cwd = await workspace.ensureClone(repository, provider, log);
    await workspace.checkoutRemoteBranch(cwd, pullRequest.headRef, provider, log);
    const diff = await workspace.diffAgainstBase(cwd, `origin/${pullRequest.baseRef}`, provider);
    const comments = await provider.listComments(ref, prNumber);

    const prompt = buildReviewPrompt({
      repository: {
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        owner: repository.owner,
        name: repository.name,
      },
      pullRequest,
      issue,
      diff,
      comments: comments.map((comment) => ({
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    });

    this.appendLog(entry.taskId, 'system', '开始调用 Codex 评审 PR');
    const result = await runner.run({
      taskId: entry.taskId,
      engine: this.currentEngine(entry.taskId),
      cwd,
      prompt,
      log,
      signal,
      timeoutMs: Math.min(settings.taskTimeoutMinutes, 30) * 60_000,
      outputSchema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
      env: buildGitEnv(provider.gitAuthorizationHeader()),
      taskDir: path.join(config.dataDir, 'tasks', entry.taskId),
    });

    if (!result.ok) throw new Error(result.error ?? 'Codex 评审执行失败');

    const verdict =
      EngineRunner.parseVerdict(result.summary) ?? EngineRunner.parseVerdict(result.output);
    if (!verdict) {
      await provider.createComment(
        ref,
        prNumber,
        `${AI_MARKER}\n## 🤖 AI 评审未能给出结论\n\n模型输出没有包含可解析的评审结论，请人工查看任务日志。\n\n<details><summary>原始输出</summary>\n\n\`\`\`\n${result.summary.slice(0, 4000)}\n\`\`\`\n\n</details>`,
      );
      throw new Error('无法从 Codex 输出中解析评审结论');
    }

    const body = renderReviewComment(verdict, result.durationMs);
    await provider.createComment(ref, prNumber, body);

    if (verdict.verdict === 'approve') {
      const fresh = await provider.getPullRequest(ref, prNumber);
      await this.transitionPull(repository.id, provider, ref, fresh, 'ai/approved', {
        clearStuck: true,
      });
      this.finishTask(entry.taskId, 'succeeded', verdict.summary, {
        prNumber,
        prUrl: pullRequest.htmlUrl,
      });
      this.deps.store.addActivity({
        level: 'success',
        scope: 'review',
        repositoryId: repository.id,
        message: `PR #${prNumber} 评审通过（ai/approved），等待人工合并`,
      });
      return;
    }

    const fresh = await provider.getPullRequest(ref, prNumber);
    await this.transitionPull(repository.id, provider, ref, fresh, 'ai/needs-fix', {
      clearStuck: true,
    });
    this.finishTask(entry.taskId, 'succeeded', verdict.summary, {
      prNumber,
      prUrl: pullRequest.htmlUrl,
    });
    this.deps.store.addActivity({
      level: 'warning',
      scope: 'review',
      repositoryId: repository.id,
      message: `PR #${prNumber} 评审发现问题（${verdict.issues.length} 条），已转 ai/needs-fix`,
    });
  }

  private async runFix(entry: QueueEntry, signal: AbortSignal): Promise<void> {
    const { workspace, runner, providers, config } = this.deps;
    const settings = this.deps.settings.get();
    const repository = this.requireRepository(entry.repositoryId);
    const provider = providers.forAccount(repository.accountId);
    const ref: RepoRef = { owner: repository.owner, name: repository.name };
    const prNumber = entry.prNumber;
    if (prNumber === null) throw new Error('修复任务缺少 PR 编号');

    const log = this.taskLogger(entry.taskId);
    const pullRequest = await provider.getPullRequest(ref, prNumber);
    this.upsertPullRequest(repository, pullRequest);

    if (isPaused(pullRequest.labels)) {
      this.finishTask(entry.taskId, 'cancelled', 'PR 处于 ai/paused，跳过修复');
      return;
    }
    if (!pullRequest.labels.includes('ai/needs-fix')) {
      this.finishTask(entry.taskId, 'cancelled', 'PR 已不在 ai/needs-fix 状态，跳过');
      return;
    }

    const issue = await this.fetchLinkedIssue(repository, provider, ref, pullRequest);
    const comments = await provider.listComments(ref, prNumber);
    const reviewComment = findLatestReviewComment(comments);

    const cwd = await workspace.ensureClone(repository, provider, log);
    await workspace.checkoutRemoteBranch(cwd, pullRequest.headRef, provider, log);
    const diffStat = await workspace.diffStat(cwd, `origin/${pullRequest.baseRef}`, provider);

    const prompt = buildFixPrompt({
      repository: {
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        owner: repository.owner,
        name: repository.name,
      },
      pullRequest,
      issue,
      reviewComment: reviewComment?.body ?? '（未找到评审意见，请根据 PR 描述自查并修复明显问题）',
      diffStat,
    });

    this.appendLog(entry.taskId, 'system', '开始调用 Codex 修复评审意见');
    const result = await runner.run({
      taskId: entry.taskId,
      engine: this.currentEngine(entry.taskId),
      cwd,
      prompt,
      log,
      signal,
      timeoutMs: settings.taskTimeoutMinutes * 60_000,
      env: buildGitEnv(provider.gitAuthorizationHeader()),
      taskDir: path.join(config.dataDir, 'tasks', entry.taskId),
    });

    if (!result.ok) throw new Error(result.error ?? 'Codex 修复执行失败');

    const commit = await workspace.commitAll(
      cwd,
      `fix: 按评审意见修复 PR #${prNumber}`,
      provider,
      log,
    );
    if (!commit.committed) {
      throw new Error('修复任务没有产生文件改动，可能评审意见已被处理或需要人工确认。');
    }

    await workspace.pushBranch(cwd, pullRequest.headRef, provider, log, { force: true });
    const fresh = await provider.getPullRequest(ref, prNumber);
    await this.transitionPull(repository.id, provider, ref, fresh, 'ai/needs-review', {
      clearStuck: true,
    });
    await provider.createComment(
      ref,
      prNumber,
      `${AI_MARKER}\n## 🛠️ AI 已提交修复\n\n提交：\`${commit.sha?.slice(0, 7) ?? 'unknown'}\`\n文件：${commit.files.length} 个\n\n任务已完成，重新进入 AI 评审队列。\n\n<details><summary>修复总结</summary>\n\n${result.summary.slice(0, 4000)}\n\n</details>`,
    );

    this.finishTask(entry.taskId, 'succeeded', result.summary, {
      prNumber,
      prUrl: pullRequest.htmlUrl,
    });
    this.deps.store.addActivity({
      level: 'success',
      scope: 'fix',
      repositoryId: repository.id,
      message: `PR #${prNumber} 修复完成，已转回 ai/needs-review`,
    });
  }

  // ------------------------------------------------------------- transitions

  private async transitionIssue(
    repositoryId: string,
    provider: GitProvider,
    ref: RepoRef,
    issue: RemoteIssue,
    status: IssueStatus,
    options: { comment?: string; clearStuck?: boolean } = {},
  ): Promise<void> {
    const { next } = applyStatusTransition(issue.labels, status, {
      clearStuck: options.clearStuck ?? true,
    });
    await provider.setLabels(ref, { number: issue.number, labels: next, isPullRequest: false });

    this.deps.store.upsertIssue({
      repositoryId,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: next,
      author: issue.author,
      htmlUrl: issue.htmlUrl,
      updatedAt: nowIso(),
      isPullRequest: false,
    });
    if (options.comment) {
      await provider.createComment(ref, issue.number, `${AI_MARKER}\n${options.comment}`);
    }
  }

  private async transitionPull(
    repositoryId: string,
    provider: GitProvider,
    ref: RepoRef,
    pullRequest: RemotePullRequest,
    status: PullRequestStatus,
    options: { comment?: string; clearStuck?: boolean } = {},
  ): Promise<void> {
    const { next } = applyStatusTransition(pullRequest.labels, status, {
      clearStuck: options.clearStuck ?? true,
    });
    await provider.setLabels(ref, {
      number: pullRequest.number,
      labels: next,
      isPullRequest: true,
    });

    this.deps.store.upsertPullRequest({
      repositoryId,
      number: pullRequest.number,
      title: pullRequest.title,
      state: pullRequest.state,
      merged: pullRequest.merged,
      labels: next,
      author: pullRequest.author,
      htmlUrl: pullRequest.htmlUrl,
      headRef: pullRequest.headRef,
      baseRef: pullRequest.baseRef,
      headSha: pullRequest.headSha,
      issueNumber: null,
      mergedAt: pullRequest.mergedAt,
      updatedAt: nowIso(),
    });
    if (options.comment) {
      await provider.createComment(ref, pullRequest.number, `${AI_MARKER}\n${options.comment}`);
    }
  }

  private async markStuck(
    provider: GitProvider,
    ref: RepoRef,
    target: { number: number; labels: string[]; isPullRequest: boolean },
    reason: string,
  ): Promise<void> {
    if (target.labels.includes('ai/stuck')) return;
    // `ai/stuck` replaces the pipeline slot without dropping the previous
    // status label, so a human can see where the run stopped and hand it back.
    const finalLabels = [...new Set([...target.labels, 'ai/stuck'])];

    await provider.setLabels(ref, {
      number: target.number,
      labels: finalLabels,
      isPullRequest: target.isPullRequest,
    });
    await provider.createComment(
      ref,
      target.number,
      `${AI_MARKER}\n## ⛔ AI 流水线已阻塞\n\n${reason}`,
    );
  }

  private async handleFailure(entry: QueueEntry, message: string): Promise<void> {
    const repository = this.deps.store.getRepository(entry.repositoryId);
    if (!repository) return;
    const provider = this.deps.providers.forAccount(repository.accountId);
    const ref: RepoRef = { owner: repository.owner, name: repository.name };

    let target: { number: number; labels: string[]; isPullRequest: boolean } | null = null;
    try {
      if (entry.kind === 'implement') {
        const issue = await provider.getIssue(ref, entry.issueNumber ?? 0);
        target = { number: issue.number, labels: issue.labels, isPullRequest: false };
      } else {
        const pr = await provider.getPullRequest(ref, entry.prNumber ?? 0);
        target = { number: pr.number, labels: pr.labels, isPullRequest: true };
      }
    } catch {
      target = null;
    }

    if (!target) return;
    await this.markStuck(
      provider,
      ref,
      target,
      `任务失败：${message}\n\n修复后请移除 \`ai/stuck\`，并重新打上合适的流转标签（例如 \`ai/todo\` 或 \`ai/needs-review\`）。`,
    );
    this.deps.store.addActivity({
      level: 'error',
      scope: entry.kind,
      repositoryId: repository.id,
      message: `#${target.number} ${entry.kind} 任务失败：${message.slice(0, 300)}`,
    });
  }

  // ----------------------------------------------------------------- helpers

  private currentEngine(taskId: string): EngineId {
    return this.deps.store.getTask(taskId)?.engine ?? 'codex';
  }

  private resolveEngine(labels: readonly string[], kind: TaskKind): EngineId {
    const settings = this.deps.settings.get();
    const preference = kind === 'review' ? preferredReviewEngine(labels) : preferredEngine(labels);
    if (preference === 'claude' && settings.allowClaudeFallback) return 'claude';
    return 'codex';
  }

  private requireRepository(repositoryId: string): RepositoryRecord {
    const repository = this.deps.store.getRepository(repositoryId);
    if (!repository) throw new Error(`仓库不存在：${repositoryId}`);
    return repository;
  }

  private async fetchLinkedIssue(
    repository: RepositoryRecord,
    provider: GitProvider,
    ref: RepoRef,
    pullRequest: RemotePullRequest,
  ): Promise<RemoteIssue | null> {
    const number = this.issueNumberFromPull(repository, pullRequest);
    if (number === null) return null;
    try {
      return await provider.getIssue(ref, number);
    } catch {
      return null;
    }
  }

  private taskLogger(taskId: string): TaskLogger {
    return (stream, message) => this.appendLog(taskId, stream, message);
  }

  private appendLog(
    taskId: string,
    stream: Parameters<Store['appendLog']>[1],
    message: string,
  ): void {
    const line = this.deps.store.appendLog(taskId, stream, message);
    this.deps.events.emit({ type: 'task.log', line });
  }

  private emitTask(taskId: string): void {
    const task = this.deps.store.getTask(taskId);
    if (task) this.deps.events.emit({ type: 'task.updated', task });
  }

  private finishTask(
    taskId: string,
    status: Task['status'],
    summary: string,
    extra: Partial<Pick<Task, 'prNumber' | 'prUrl' | 'branch' | 'workspace'>> = {},
  ): void {
    this.deps.store.updateTask(taskId, {
      status,
      summary: summary.slice(0, 4000),
      finishedAt: nowIso(),
      error: null,
      ...extra,
    });
    this.emitTask(taskId);
  }
}

// ------------------------------------------------------------------ helpers

function buildStatus(input: {
  running: boolean;
  pollSeconds: number;
  maxConcurrent: number;
  runningTaskIds: string[];
  queuedTaskIds: string[];
  lastTickAt: string | null;
  nextTickAt: string | null;
  lastTickError: string | null;
  repositories: Array<{
    repositoryId: string;
    fullName: string;
    enabled: boolean;
    lastPolledAt: string | null;
    lastPollError: string | null;
    trackedIssues: number;
  }>;
}) {
  return { ...input };
}

export function issueNumberFromBranch(branch: string, prefix: string): number | null {
  if (!branch.startsWith(prefix)) return null;
  const rest = branch.slice(prefix.length);
  const match = rest.match(/^(\d+)/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildVerificationHints(repository: RepositoryRecord): string[] {
  const hints: string[] = [];
  if (repository.provider === 'gitea' || repository.provider === 'gitee') {
    hints.push('仓库托管在自建/国内平台，克隆与推送由 AutoGit 负责，你只需要改代码。');
  }
  hints.push(`默认分支为 ${repository.defaultBranch}，请确保改动能直接合并进该分支。`);
  return hints;
}

function buildCommitMessage(issue: RemoteIssue, summary: string): string {
  const title = issue.title.length > 60 ? `${issue.title.slice(0, 57)}…` : issue.title;
  const body = summary.trim().slice(0, 3000) || 'AutoGit 自动实现';
  return `feat: 实现 #${issue.number} ${title}\n\n${body}`;
}

export function renderTitle(template: string, issue: RemoteIssue): string {
  return template
    .replaceAll('{issueTitle}', issue.title)
    .replaceAll('{issueNumber}', String(issue.number))
    .slice(0, 250);
}

export function buildPullRequestBody(
  issue: RemoteIssue,
  summary: string,
  files: string[],
  baseBranch: string,
): string {
  const list = files.slice(0, 40).join('\n');
  return `## 关联 Issue

Closes #${issue.number}

## 改动说明

${summary.trim() || '由 AutoGit 自动生成。'}

## 改动文件

\`\`\`
${list}
\`\`\`

## 流水线信息

- 目标分支：\`${baseBranch}\`
- 执行引擎：Codex CLI（AutoGit Agent）
- 本 PR 由 AI 自动创建，评审通过后会打上 \`ai/approved\`，需要人工确认后再合并。

${AI_MARKER}`;
}

export function renderReviewComment(verdict: ReviewVerdict, durationMs: number): string {
  const header =
    verdict.verdict === 'approve'
      ? '## ✅ AI 评审通过'
      : `## ⚠️ AI 评审发现问题（${verdict.issues.length}）`;

  const issueList =
    verdict.issues.length === 0
      ? ''
      : `\n### 需要修复的问题\n\n${verdict.issues
          .map((item, index) => {
            const location = item.file
              ? ` · \`${item.file}${item.line ? `:${item.line}` : ''}\``
              : '';
            const suggestion = item.suggestion ? `\n  - 建议：${item.suggestion}` : '';
            return `${index + 1}. **[${severityLabel(item.severity)}]** ${item.title}${location}\n  - ${item.detail}${suggestion}`;
          })
          .join('\n')}`;

  const tests = verdict.tests ? `\n### 验证记录\n\n${verdict.tests}` : '';
  const cost = `\n\n---\n\n> 🤖 由 AutoGit 调用 Codex CLI 生成 · 耗时 ${Math.round(durationMs / 1000)}s`;

  return `${AI_MARKER}\n${header}\n\n${verdict.summary}${issueList}${tests}${cost}`;
}

function severityLabel(severity: ReviewVerdict['issues'][number]['severity']): string {
  switch (severity) {
    case 'blocker':
      return '阻塞';
    case 'major':
      return '重要';
    default:
      return '次要';
  }
}

function findLatestReviewComment(
  comments: Array<{ author: string; body: string; createdAt: string }>,
): { author: string; body: string; createdAt: string } | null {
  const reviews = comments.filter((comment) => comment.body.includes('AI 评审'));
  if (reviews.length > 0) return reviews.at(-1) ?? null;
  return comments.at(-1) ?? null;
}
