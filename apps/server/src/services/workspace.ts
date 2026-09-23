import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { type LogStream, maskProxyUrl } from '@autogit/shared';

import type { RuntimeConfig } from '../config.js';
import type { RepositoryRecord } from '../db/store.js';
import type { GitProvider } from '../providers/index.js';
import { KeyedLock } from '../util/keyed-lock.js';
import { safePathSegment } from '../util/paths.js';
import type { RunResult } from '../util/subprocess.js';
import { type GitProxyOption, git } from './git.js';
import type { SettingsService } from './settings.js';

export type WorkspaceLog = (stream: LogStream, message: string) => void;

/**
 * Everything `git` needs to reach the remote of one account: the token based
 * authorization header and the proxy AutoGit resolved for that account.
 */
interface GitNet {
  authHeader: string | null;
  proxy: GitProxyOption;
}

export interface CommitResult {
  committed: boolean;
  files: string[];
  sha: string | null;
}

export interface PurgeResult {
  /** Whether the branch tip actually moved. */
  rewritten: boolean;
  /** Branch tip before the rewrite. */
  from: string;
  /** Branch tip after the rewrite (`from` when nothing was rewritten). */
  to: string;
}

/** Lock files a killed git process can leave behind; git refuses to run while they exist. */
const STALE_LOCK_FILES = [
  'index.lock',
  'HEAD.lock',
  'config.lock',
  'shallow.lock',
  'packed-refs.lock',
];

/** Operations that stay half-applied when a run is killed mid-flight. */
const INTERRUPTED_OPERATIONS = [
  ['merge', '--abort'],
  ['rebase', '--abort'],
  ['cherry-pick', '--abort'],
  ['revert', '--abort'],
  ['am', '--abort'],
];

/**
 * Diffs are read with `core.quotePath=false`: with the default setting git
 * escapes every non ASCII byte of a path (`"b/docs/\350\257\264\346\230\216.md"`),
 * which hides the real file name from `util/diff-anchors.ts` and from the
 * prompts, so findings on such files could never be anchored.
 */
const RAW_PATH_DIFF = ['-c', 'core.quotePath=false'];

/**
 * Clone / fetch are the only git calls that fail on a flaky link or on a ref
 * another writer moved first, so they are the ones that get retries.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 5_000];
const TRANSIENT_GIT_ERROR =
  /(could not resolve host|connection (was )?(reset|refused|closed)|connection timed out|recv failure|send failure|unable to access|remote end hung up|early eof|rpc failed|gnutls|ssl|tls|operation timed out|proxy|error: 5\d\d)/i;
/**
 * Another git process (a second AutoGit task, a manual fetch, an IDE) already
 * moved the ref this fetch planned to update: it read the old value, the other
 * writer committed the new one, and the lock now finds
 * `is at <new> but expected <old>`. Reading the ref again — which is exactly
 * what a retry does — resolves it, so it counts as transient.
 */
const REF_LOCK_ERROR = /(cannot lock ref|unable to update local ref)/i;
/** Auth or permission problems never heal by retrying. */
const PERMANENT_GIT_ERROR =
  /(returned error: 4\d\d|authentication failed|permission denied|repository not found|could not read username)/i;

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when running the same git command again has a realistic chance to succeed. */
export function isTransientGitFailure(result: RunResult): boolean {
  if (result.code === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  if (PERMANENT_GIT_ERROR.test(text)) return false;
  if (REF_LOCK_ERROR.test(text)) return true;
  return TRANSIENT_GIT_ERROR.test(text) || result.timedOut;
}

/**
 * Owns the on-disk clones AutoGit works in.
 *
 * Every repository keeps one *base* clone, which is only fetched and never
 * edited, plus one disposable clone per task. Task clones are created from the
 * base clone with `git clone --local` (the object database is hardlinked, so
 * this is a directory walk instead of a second download) and deleted when the
 * task ends. That per-task isolation is what makes more than one concurrent
 * task per repository safe: two runs never share a checked-out branch.
 *
 * Inside a task clone branches are switched with a hard reset so the agent
 * always starts from a clean, predictable tree.
 *
 * The base clone itself is shared state, so everything that writes it (clone,
 * fetch, prune) is queued per repository: with `maxConcurrentPerRepo` above 1
 * two tasks of the same repository fetched it at the same moment and raced for
 * the same `refs/remotes/origin/*`.
 */
export class WorkspaceManager {
  private readonly baseFetches = new KeyedLock();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly settings: SettingsService,
  ) {}

  pathFor(repositoryId: string): string {
    return path.join(this.config.workspacesDir, repositoryId);
  }

  /** Directory that holds one repository's task clones. */
  private pathForTasks(repositoryId: string): string {
    return path.join(this.config.workspacesDir, 'tasks', repositoryId);
  }

  /** Clone a single task works in; removed again by `releaseTaskWorkspace`. */
  pathForTask(repositoryId: string, taskId: string): string {
    return path.join(this.pathForTasks(repositoryId), safePathSegment(taskId, 'task'));
  }

  private authHeaderFor(provider: GitProvider): string | null {
    try {
      return provider.gitAuthorizationHeader();
    } catch {
      return null;
    }
  }

  private netFor(provider: GitProvider): GitNet {
    return {
      authHeader: this.authHeaderFor(provider),
      proxy: { url: provider.proxyUrl },
    };
  }

  async ensureClone(
    repository: RepositoryRecord,
    provider: GitProvider,
    log: WorkspaceLog,
    options: { taskId?: string } = {},
  ): Promise<string> {
    const base = await this.baseFetches.run(repository.id, () =>
      this.ensureBaseClone(repository, provider, log),
    );
    if (!options.taskId) return base;
    return this.ensureTaskClone(base, repository, provider, log, options.taskId);
  }

  /** Clone (first time) or fetch (afterwards) the shared base clone of a repository. */
  private async ensureBaseClone(
    repository: RepositoryRecord,
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<string> {
    const dir = this.pathFor(repository.id);
    const net = this.netFor(provider);
    const env = { GIT_LFS_SKIP_SMUDGE: '1' };

    if (!existsSync(path.join(dir, '.git'))) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      log('git', `克隆仓库 ${repository.fullName} → ${dir}`);
      log('git', `代理：${describeGitProxy(net.proxy.url)}`);
      const result = await this.runNetworkGit(
        ['clone', '--origin', 'origin', repository.cloneUrl, dir],
        {
          cwd: path.dirname(dir),
          net,
          env,
          // A clone that died halfway leaves a directory the retry cannot use.
          beforeRetry: () => rmSync(dir, { recursive: true, force: true }),
        },
        log,
      );
      if (result.code !== 0) {
        throw new Error(`克隆失败：${result.stderr.trim() || result.stdout.trim() || '未知错误'}`);
      }
    } else {
      log('git', `更新远端引用 ${repository.fullName}`);
      const fetch = await this.runNetworkGit(
        ['fetch', '--all', '--prune', '--tags'],
        { cwd: dir, net, env },
        log,
      );
      if (fetch.code !== 0) {
        throw new Error(`git fetch 失败：${fetch.stderr.trim() || '未知错误'}`);
      }
    }

    await this.configureIdentity(dir, net);
    return dir;
  }

  /**
   * Creates a task-scoped working copy out of the base clone.
   *
   * The local clone inherits the base clone as `origin`; pointing the remote
   * back at the provider afterwards keeps every later `fetch` / `push` on the
   * real repository instead of the local cache.
   *
   * That repointing is not enough on its own: `git clone --local` copies the
   * base clone's *local* branches into the task clone's `origin/*` refs, so
   * those refs describe the cache instead of the provider. A leftover branch
   * whose name matches the one a task pushes is read by `push --force-with-lease`
   * as the expected remote value, and the push is rejected with `stale info`
   * even though nothing is wrong at the provider. Every task therefore starts
   * with a pruned refresh so `origin/*` mirrors the real repository.
   */
  private async ensureTaskClone(
    base: string,
    repository: RepositoryRecord,
    provider: GitProvider,
    log: WorkspaceLog,
    taskId: string,
  ): Promise<string> {
    const dir = this.pathForTask(repository.id, taskId);
    const net = this.netFor(provider);
    const env = { GIT_LFS_SKIP_SMUDGE: '1' };

    if (!existsSync(path.join(dir, '.git'))) {
      // A clone that died halfway leaves a directory the retry cannot use.
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      log('git', `准备任务工作区（本地克隆 ${repository.fullName}）→ ${dir}`);
      const clone = await git(['clone', '--local', base, dir], {
        cwd: path.dirname(dir),
        ...net,
        env,
        onLine: (line) => log('git', line.message),
      });
      if (clone.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error(
          `准备任务工作区失败：${clone.stderr.trim() || clone.stdout.trim() || '未知错误'}`,
        );
      }
      const remote = await git(['remote', 'set-url', 'origin', repository.cloneUrl], {
        cwd: dir,
        ...net,
      });
      if (remote.code !== 0) {
        throw new Error(`设置任务工作区远端失败：${remote.stderr.trim() || '未知错误'}`);
      }
    }

    await this.refreshRemoteRefs(dir, repository, net, env, log);
    await this.configureIdentity(dir, net);
    return dir;
  }

  /**
   * Makes `origin/*` of a task clone describe the provider, not the base clone.
   *
   * `--prune` drops the inherited branches that never existed at the provider
   * (the ones that break `--force-with-lease`), the fetch updates the ones that
   * do, and `origin/HEAD` is repointed at the default branch so no dangling
   * symref is left behind.
   */
  private async refreshRemoteRefs(
    dir: string,
    repository: RepositoryRecord,
    net: GitNet,
    env: NodeJS.ProcessEnv,
    log: WorkspaceLog,
  ): Promise<void> {
    const fetch = await this.runNetworkGit(
      ['fetch', '--prune', '--no-tags', 'origin'],
      { cwd: dir, net, env },
      log,
    );
    if (fetch.code !== 0) {
      throw new Error(
        `刷新任务工作区远端引用失败：${fetch.stderr.trim() || fetch.stdout.trim() || '未知错误'}`,
      );
    }

    const head = await git(
      [
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        `refs/remotes/origin/${repository.defaultBranch}`,
      ],
      { cwd: dir, ...net },
    );
    if (head.code !== 0) {
      log(
        'system',
        `未能把 origin/HEAD 指向 ${repository.defaultBranch}：${
          head.stderr.trim() || head.stdout.trim() || '未知错误'
        }`,
      );
    }
  }

  /**
   * Deletes the clone a finished task worked in.
   *
   * Best effort: on Windows a directory stays busy while a killed git process
   * still holds a handle. Leftovers are swept on the next service start, where
   * `reconcileInterruptedTasks()` releases the workspaces of dead tasks.
   */
  releaseTaskWorkspace(repositoryId: string, taskId: string, log?: WorkspaceLog): void {
    const dir = this.pathForTask(repositoryId, taskId);
    if (!existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
      log?.('system', `已清理任务工作区 ${dir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.('system', `任务工作区未能删除（${message}），将在下次启动时清理`);
    }
  }

  private async configureIdentity(dir: string, net: GitNet): Promise<void> {
    const settings = this.settings.get();
    await git(['config', 'user.name', settings.commitAuthorName], { cwd: dir, ...net });
    await git(['config', 'user.email', settings.commitAuthorEmail], { cwd: dir, ...net });
    await git(['config', 'commit.gpgsign', 'false'], { cwd: dir, ...net });
    await git(['config', 'core.longpaths', 'true'], { cwd: dir, ...net });
  }

  /**
   * Runs a clone / fetch and retries failures that a second attempt can fix.
   *
   * The pipeline used to park an Issue on `ai/stuck` after a single
   * `Recv failure: Connection was reset`; a couple of retries turn that kind
   * of hiccup back into a normal run. The same goes for a ref lock another
   * process held for a moment, while auth and permission errors still fail on
   * the first attempt.
   */
  private async runNetworkGit(
    args: string[],
    options: {
      cwd: string;
      net: GitNet;
      env?: NodeJS.ProcessEnv;
      beforeRetry?: () => void;
    },
    log: WorkspaceLog,
  ): Promise<RunResult> {
    const run = (): Promise<RunResult> =>
      git(args, {
        cwd: options.cwd,
        ...options.net,
        env: options.env,
        onLine: (line) => log('git', line.message),
      });

    let result = await run();
    for (let attempt = 1; attempt < RETRY_ATTEMPTS && isTransientGitFailure(result); attempt += 1) {
      const wait = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 5_000;
      log(
        'system',
        `git ${args[0] ?? ''} 失败（第 ${attempt}/${RETRY_ATTEMPTS} 次）：${firstLine(
          result.stderr || result.stdout,
        )}；${Math.round(wait / 1000)}s 后重试`,
      );
      await delay(wait);
      options.beforeRetry?.();
      result = await run();
    }
    return result;
  }

  /**
   * Hard-switches the clone to `branch` starting at `startPoint`.
   *
   * The tree is discarded *before* the checkout: a run killed mid-flight
   * leaves modified files behind, and `checkout -B` then aborts with
   * "Your local changes … would be overwritten", which parked the Issue on
   * `ai/stuck` again on every following attempt. The first pass cleans gently
   * (ignored caches survive), the second one also aborts half-applied
   * merge / rebase state, drops stale git locks and removes ignored files.
   */
  private async switchBranch(
    dir: string,
    branch: string,
    startPoint: string,
    net: GitNet,
    log: WorkspaceLog,
  ): Promise<void> {
    let failure = '';
    if (await this.cleanWorkingTree(dir, net, log, { aggressive: false })) {
      const checkout = await this.checkoutBranch(dir, branch, startPoint, net, log);
      if (checkout.ok) return;
      failure = checkout.message;
      log('system', `切换分支失败，改用强制清理工作区后重试：${failure}`);
    } else {
      log('system', '常规清理工作区失败，改用强制清理工作区后重试');
    }

    if (!(await this.cleanWorkingTree(dir, net, log, { aggressive: true }))) {
      throw new Error(`切换分支失败：工作区无法清理（${failure || 'git reset/clean 执行失败'}）`);
    }
    const retry = await this.checkoutBranch(dir, branch, startPoint, net, log);
    if (!retry.ok) throw new Error(`切换分支失败：${retry.message}`);
  }

  private async checkoutBranch(
    dir: string,
    branch: string,
    startPoint: string,
    net: GitNet,
    log: WorkspaceLog,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const result = await git(['checkout', '--force', '-B', branch, startPoint], {
      cwd: dir,
      ...net,
      onLine: (line) => log('git', line.message),
    });
    if (result.code === 0) return { ok: true };
    return { ok: false, message: result.stderr.trim() || result.stdout.trim() || '未知错误' };
  }

  /** Returns `false` when the tree could not be cleaned, so callers can escalate. */
  private async cleanWorkingTree(
    dir: string,
    net: GitNet,
    log: WorkspaceLog,
    options: { aggressive: boolean },
  ): Promise<boolean> {
    if (options.aggressive) {
      await this.abortInterruptedOperations(dir, net, log);
      this.removeStaleLockFiles(dir, log);
    }

    // `clean` comes first: an untracked file sitting where a tracked directory
    // belongs makes `reset --hard` fail as well.
    const clean = await git(options.aggressive ? ['clean', '-fdx'] : ['clean', '-fd'], {
      cwd: dir,
      ...net,
      onLine: (line) => log('git', line.message),
    });
    if (clean.code !== 0) {
      log('system', `清理工作区失败：${firstLine(clean.stderr || clean.stdout)}`);
      return false;
    }

    const reset = await git(['reset', '--hard'], {
      cwd: dir,
      ...net,
      onLine: (line) => log('git', line.message),
    });
    if (reset.code !== 0) {
      log('system', `重置工作区失败：${firstLine(reset.stderr || reset.stdout)}`);
      return false;
    }
    return true;
  }

  /** Rolls back a merge / rebase / cherry-pick that a killed run left behind. */
  private async abortInterruptedOperations(
    dir: string,
    net: GitNet,
    log: WorkspaceLog,
  ): Promise<void> {
    const gitDir = this.gitDir(dir);
    const markers = [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ];
    if (!markers.some((name) => existsSync(path.join(gitDir, name)))) return;

    for (const args of INTERRUPTED_OPERATIONS) {
      // Best effort: git exits non-zero when there is nothing left to abort.
      await git(args, { cwd: dir, ...net });
    }
    log('system', '已回滚工作区中未完成的 git 操作（merge / rebase / cherry-pick）');
  }

  /** Only AutoGit runs git inside a workspace, so an idle lock file is always stale. */
  private removeStaleLockFiles(dir: string, log: WorkspaceLog): void {
    const gitDir = this.gitDir(dir);
    for (const name of STALE_LOCK_FILES) {
      const file = path.join(gitDir, name);
      if (!existsSync(file)) continue;
      rmSync(file, { force: true });
      log('system', `已清理残留锁文件 ${name}`);
    }
  }

  private gitDir(dir: string): string {
    const dotGit = path.join(dir, '.git');
    try {
      const pointer = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1];
      if (pointer) return path.resolve(path.dirname(dotGit), pointer.trim());
    } catch {
      // `.git` is a directory (plain clone) — nothing to resolve.
    }
    return dotGit;
  }

  /** Creates (or resets) a branch from the repository default branch. */
  async prepareBranchFromBase(
    dir: string,
    repository: RepositoryRecord,
    branch: string,
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<void> {
    const net = this.netFor(provider);
    const base = repository.defaultBranch;
    const fetch = await this.runNetworkGit(
      ['fetch', 'origin', base, '--prune'],
      { cwd: dir, net },
      log,
    );
    if (fetch.code !== 0) {
      throw new Error(`拉取分支 ${base} 失败：${fetch.stderr.trim() || '未知错误'}`);
    }
    await this.switchBranch(dir, branch, `origin/${base}`, net, log);
  }

  /** Checks out an existing remote branch (used for review / fix tasks). */
  async checkoutRemoteBranch(
    dir: string,
    branch: string,
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<void> {
    const net = this.netFor(provider);
    const fetch = await this.runNetworkGit(
      ['fetch', 'origin', branch, '--prune'],
      { cwd: dir, net },
      log,
    );
    if (fetch.code !== 0) {
      throw new Error(`拉取分支 ${branch} 失败：${fetch.stderr.trim() || '未知错误'}`);
    }
    await this.switchBranch(dir, branch, `origin/${branch}`, net, log);
  }

  async changedFiles(dir: string, provider: GitProvider): Promise<string[]> {
    const result = await git(['status', '--porcelain'], {
      cwd: dir,
      ...this.netFor(provider),
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async commitAll(
    dir: string,
    message: string,
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<CommitResult> {
    const net = this.netFor(provider);
    const status = await git(['status', '--porcelain'], { cwd: dir, ...net });
    const files = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (files.length === 0) {
      return { committed: false, files: [], sha: null };
    }

    await git(['add', '-A'], { cwd: dir, ...net });
    const commit = await git(['commit', '-m', message], {
      cwd: dir,
      ...net,
      onLine: (line) => log('git', line.message),
    });
    if (commit.code !== 0) {
      throw new Error(`git commit 失败：${commit.stderr.trim() || commit.stdout.trim()}`);
    }
    const sha = await git(['rev-parse', 'HEAD'], { cwd: dir, ...net });
    return { committed: true, files, sha: sha.stdout.trim() || null };
  }

  async pushBranch(
    dir: string,
    branch: string,
    provider: GitProvider,
    log: WorkspaceLog,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const net = this.netFor(provider);
    const args = ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`];
    if (options.force) args.splice(1, 0, '--force-with-lease');

    const result = await git(args, {
      cwd: dir,
      ...net,
      onLine: (line) => log('git', line.message),
      timeoutMs: 15 * 60_000,
    });
    if (result.code !== 0) {
      throw new Error(`git push 失败：${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async diffAgainstBase(
    dir: string,
    baseRef: string,
    provider: GitProvider,
    maxChars = 60_000,
  ): Promise<string> {
    const net = this.netFor(provider);
    const stat = await git([...RAW_PATH_DIFF, 'diff', '--stat', `${baseRef}...HEAD`], {
      cwd: dir,
      ...net,
    });
    const diff = await git([...RAW_PATH_DIFF, 'diff', `${baseRef}...HEAD`], { cwd: dir, ...net });
    const text = `${stat.stdout.trim()}\n\n${diff.stdout.trim()}`.trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（diff 已截断）` : text;
  }

  /**
   * Deletes `paths` from the commits this branch added, leaving the rest alone.
   *
   * A path committed by mistake (`.pnpm-store/`, build output) cannot be fixed
   * by deleting it in a later commit: every object stays reachable from `HEAD`,
   * so `Create a merge commit` still drags the whole cache into the base
   * branch's ancestry for good. The only repair is rewriting the commits that
   * added it.
   *
   * The rewrite is bounded to `<merge base>..HEAD` — the commits this branch
   * contributes — because `git filter-branch` rebuilds every commit it walks
   * and a rebuilt commit loses its `gpgsig`; walking the base branch's own
   * commits would move the merge base backwards and turn a mergeable PR into a
   * conflicted one while the tip tree stayed identical.
   *
   * The branch is only moved when both invariants hold afterwards: the tip
   * *tree* is byte-identical (a rewrite may change what the branch carries in
   * its history, never what it contains) and the merge base with `baseRef` is
   * unchanged (which is what keeps the PR mergeable without conflicts).
   */
  async purgePathsFromHistory(
    dir: string,
    baseRef: string,
    paths: string[],
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<PurgeResult> {
    const net = this.netFor(provider);
    const run = (args: string[], env?: NodeJS.ProcessEnv) =>
      git(args, { cwd: dir, ...net, env, onLine: (line) => log('git', line.message) });
    const head = async (): Promise<string> => (await run(['rev-parse', 'HEAD'])).stdout.trim();

    const from = await head();
    const treeBefore = (await run(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const mergeBase = (await run(['merge-base', baseRef, 'HEAD'])).stdout.trim();
    if (!from || !treeBefore || !mergeBase) {
      throw new Error(`无法读取分支状态（HEAD=${from}，合并基准=${mergeBase || '未知'}）`);
    }

    const filter = paths
      .map((item) => `git rm -r --cached --ignore-unmatch -- "${item}"`)
      .join(' && ');
    const rewrite = await git(
      [
        'filter-branch',
        '-f',
        '--index-filter',
        filter,
        '--prune-empty',
        '--',
        `${mergeBase}..HEAD`,
      ],
      {
        cwd: dir,
        ...net,
        // The helpers git uses to run `--index-filter` print a deprecation
        // notice on every run; the rewrite itself is deliberate here.
        env: { FILTER_BRANCH_SQUELCH_WARNING: '1' },
        timeoutMs: 30 * 60_000,
        onLine: (line) => log('git', line.message),
      },
    );
    if (rewrite.code !== 0) {
      await run(['reset', '--hard', from]);
      throw new Error(
        `改写分支历史失败：${firstLine(rewrite.stderr) || firstLine(rewrite.stdout)}`,
      );
    }

    const to = await head();
    if (to === from) return { rewritten: false, from, to };

    const treeAfter = (await run(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const mergeBaseAfter = (await run(['merge-base', baseRef, 'HEAD'])).stdout.trim();
    if (treeAfter !== treeBefore || mergeBaseAfter !== mergeBase) {
      // Undo our own rewrite: the branch must not move when either invariant
      // broke, and the old tip is still reachable through the backup ref git
      // leaves in `refs/original/`.
      await run(['reset', '--hard', from]);
      throw new Error('改写后的分支与预期不一致（tip 树或合并基准发生变化），已放弃改写');
    }

    return { rewritten: true, from, to };
  }

  async diffStat(dir: string, baseRef: string, provider: GitProvider): Promise<string> {
    const result = await git([...RAW_PATH_DIFF, 'diff', '--stat', `${baseRef}...HEAD`], {
      cwd: dir,
      ...this.netFor(provider),
    });
    return result.stdout.trim();
  }

  /**
   * Raw patch of the branch against its base, used to resolve the lines an
   * inline review comment may be anchored to. `diffAgainstBase()` prepends a
   * stat block and truncates, which would silently shift or drop hunks, so the
   * anchors are computed from this untouched patch instead.
   */
  async diffPatch(
    dir: string,
    baseRef: string,
    provider: GitProvider,
    maxChars = 2_000_000,
  ): Promise<string> {
    const result = await git([...RAW_PATH_DIFF, 'diff', '--no-color', `${baseRef}...HEAD`], {
      cwd: dir,
      ...this.netFor(provider),
    });
    if (result.code !== 0) return '';
    return result.stdout.length > maxChars ? result.stdout.slice(0, maxChars) : result.stdout;
  }

  async currentBranch(dir: string, provider: GitProvider): Promise<string> {
    const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      ...this.netFor(provider),
    });
    return result.stdout.trim();
  }

  async headSha(dir: string, provider: GitProvider): Promise<string | null> {
    const result = await git(['rev-parse', 'HEAD'], {
      cwd: dir,
      ...this.netFor(provider),
    });
    return result.stdout.trim() || null;
  }

  removeWorkspace(repositoryId: string): void {
    const dir = this.pathFor(repositoryId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const tasks = this.pathForTasks(repositoryId);
    if (existsSync(tasks)) rmSync(tasks, { recursive: true, force: true });
  }
}

function describeGitProxy(url: string | null): string {
  return url ? (maskProxyUrl(url) ?? url) : '直连（不使用代理）';
}
