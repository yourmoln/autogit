import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { LogStream } from '@autogit/shared';

import type { RuntimeConfig } from '../config.js';
import type { RepositoryRecord } from '../db/store.js';
import type { GitProvider } from '../providers/index.js';
import type { RunResult } from '../util/subprocess.js';
import { git } from './git.js';
import type { SettingsService } from './settings.js';

export type WorkspaceLog = (stream: LogStream, message: string) => void;

export interface CommitResult {
  committed: boolean;
  files: string[];
  sha: string | null;
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

/** Clone / fetch are the only git calls that fail on a flaky link, so they get retries. */
const NETWORK_ATTEMPTS = 3;
const NETWORK_RETRY_DELAYS_MS = [2_000, 5_000];
const TRANSIENT_GIT_ERROR =
  /(could not resolve host|connection (was )?(reset|refused|closed)|connection timed out|recv failure|send failure|unable to access|remote end hung up|early eof|rpc failed|gnutls|ssl|tls|operation timed out|proxy|error: 5\d\d)/i;
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
function isTransientGitFailure(result: RunResult): boolean {
  if (result.code === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  if (PERMANENT_GIT_ERROR.test(text)) return false;
  return TRANSIENT_GIT_ERROR.test(text) || result.timedOut;
}

/**
 * Owns the on-disk clones AutoGit works in. Every repository gets exactly one
 * workspace directory; branches are switched with a hard reset so the agent
 * always starts from a clean, predictable tree.
 */
export class WorkspaceManager {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly settings: SettingsService,
  ) {}

  pathFor(repositoryId: string): string {
    return path.join(this.config.workspacesDir, repositoryId);
  }

  private authHeaderFor(provider: GitProvider): string | null {
    try {
      return provider.gitAuthorizationHeader();
    } catch {
      return null;
    }
  }

  async ensureClone(
    repository: RepositoryRecord,
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<string> {
    const dir = this.pathFor(repository.id);
    const authHeader = this.authHeaderFor(provider);
    const env = { GIT_LFS_SKIP_SMUDGE: '1' };

    if (!existsSync(path.join(dir, '.git'))) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.dirname(dir), { recursive: true });
      log('git', `克隆仓库 ${repository.fullName} → ${dir}`);
      const result = await this.runNetworkGit(
        ['clone', '--origin', 'origin', repository.cloneUrl, dir],
        {
          cwd: path.dirname(dir),
          authHeader,
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
        { cwd: dir, authHeader, env },
        log,
      );
      if (fetch.code !== 0) {
        throw new Error(`git fetch 失败：${fetch.stderr.trim() || '未知错误'}`);
      }
    }

    await this.configureIdentity(dir, authHeader);
    return dir;
  }

  private async configureIdentity(dir: string, authHeader: string | null): Promise<void> {
    const settings = this.settings.get();
    await git(['config', 'user.name', settings.commitAuthorName], { cwd: dir, authHeader });
    await git(['config', 'user.email', settings.commitAuthorEmail], { cwd: dir, authHeader });
    await git(['config', 'commit.gpgsign', 'false'], { cwd: dir, authHeader });
    await git(['config', 'core.longpaths', 'true'], { cwd: dir, authHeader });
  }

  /**
   * Runs a clone / fetch and retries transient network failures.
   *
   * The pipeline used to park an Issue on `ai/stuck` after a single
   * `Recv failure: Connection was reset`; a couple of retries turn that kind
   * of hiccup back into a normal run, while auth and permission errors still
   * fail on the first attempt.
   */
  private async runNetworkGit(
    args: string[],
    options: {
      cwd: string;
      authHeader: string | null;
      env?: NodeJS.ProcessEnv;
      beforeRetry?: () => void;
    },
    log: WorkspaceLog,
  ): Promise<RunResult> {
    const run = (): Promise<RunResult> =>
      git(args, {
        cwd: options.cwd,
        authHeader: options.authHeader,
        env: options.env,
        onLine: (line) => log('git', line.message),
      });

    let result = await run();
    for (
      let attempt = 1;
      attempt < NETWORK_ATTEMPTS && isTransientGitFailure(result);
      attempt += 1
    ) {
      const wait = NETWORK_RETRY_DELAYS_MS[attempt - 1] ?? NETWORK_RETRY_DELAYS_MS.at(-1) ?? 5_000;
      log(
        'system',
        `git ${args[0] ?? ''} 网络失败（第 ${attempt}/${NETWORK_ATTEMPTS} 次）：${firstLine(
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
    authHeader: string | null,
    log: WorkspaceLog,
  ): Promise<void> {
    let failure = '';
    if (await this.cleanWorkingTree(dir, authHeader, log, { aggressive: false })) {
      const checkout = await this.checkoutBranch(dir, branch, startPoint, authHeader, log);
      if (checkout.ok) return;
      failure = checkout.message;
      log('system', `切换分支失败，改用强制清理工作区后重试：${failure}`);
    } else {
      log('system', '常规清理工作区失败，改用强制清理工作区后重试');
    }

    if (!(await this.cleanWorkingTree(dir, authHeader, log, { aggressive: true }))) {
      throw new Error(`切换分支失败：工作区无法清理（${failure || 'git reset/clean 执行失败'}）`);
    }
    const retry = await this.checkoutBranch(dir, branch, startPoint, authHeader, log);
    if (!retry.ok) throw new Error(`切换分支失败：${retry.message}`);
  }

  private async checkoutBranch(
    dir: string,
    branch: string,
    startPoint: string,
    authHeader: string | null,
    log: WorkspaceLog,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const result = await git(['checkout', '--force', '-B', branch, startPoint], {
      cwd: dir,
      authHeader,
      onLine: (line) => log('git', line.message),
    });
    if (result.code === 0) return { ok: true };
    return { ok: false, message: result.stderr.trim() || result.stdout.trim() || '未知错误' };
  }

  /** Returns `false` when the tree could not be cleaned, so callers can escalate. */
  private async cleanWorkingTree(
    dir: string,
    authHeader: string | null,
    log: WorkspaceLog,
    options: { aggressive: boolean },
  ): Promise<boolean> {
    if (options.aggressive) {
      await this.abortInterruptedOperations(dir, authHeader, log);
      this.removeStaleLockFiles(dir, log);
    }

    // `clean` comes first: an untracked file sitting where a tracked directory
    // belongs makes `reset --hard` fail as well.
    const clean = await git(options.aggressive ? ['clean', '-fdx'] : ['clean', '-fd'], {
      cwd: dir,
      authHeader,
      onLine: (line) => log('git', line.message),
    });
    if (clean.code !== 0) {
      log('system', `清理工作区失败：${firstLine(clean.stderr || clean.stdout)}`);
      return false;
    }

    const reset = await git(['reset', '--hard'], {
      cwd: dir,
      authHeader,
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
    authHeader: string | null,
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
      await git(args, { cwd: dir, authHeader });
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
    const authHeader = this.authHeaderFor(provider);
    const base = repository.defaultBranch;
    const fetch = await this.runNetworkGit(
      ['fetch', 'origin', base, '--prune'],
      { cwd: dir, authHeader },
      log,
    );
    if (fetch.code !== 0) {
      throw new Error(`拉取分支 ${base} 失败：${fetch.stderr.trim() || '未知错误'}`);
    }
    await this.switchBranch(dir, branch, `origin/${base}`, authHeader, log);
  }

  /** Checks out an existing remote branch (used for review / fix tasks). */
  async checkoutRemoteBranch(
    dir: string,
    branch: string,
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<void> {
    const authHeader = this.authHeaderFor(provider);
    const fetch = await this.runNetworkGit(
      ['fetch', 'origin', branch, '--prune'],
      { cwd: dir, authHeader },
      log,
    );
    if (fetch.code !== 0) {
      throw new Error(`拉取分支 ${branch} 失败：${fetch.stderr.trim() || '未知错误'}`);
    }
    await this.switchBranch(dir, branch, `origin/${branch}`, authHeader, log);
  }

  async changedFiles(dir: string, provider: GitProvider): Promise<string[]> {
    const result = await git(['status', '--porcelain'], {
      cwd: dir,
      authHeader: this.authHeaderFor(provider),
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
    const authHeader = this.authHeaderFor(provider);
    const status = await git(['status', '--porcelain'], { cwd: dir, authHeader });
    const files = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (files.length === 0) {
      return { committed: false, files: [], sha: null };
    }

    await git(['add', '-A'], { cwd: dir, authHeader });
    const commit = await git(['commit', '-m', message], {
      cwd: dir,
      authHeader,
      onLine: (line) => log('git', line.message),
    });
    if (commit.code !== 0) {
      throw new Error(`git commit 失败：${commit.stderr.trim() || commit.stdout.trim()}`);
    }
    const sha = await git(['rev-parse', 'HEAD'], { cwd: dir, authHeader });
    return { committed: true, files, sha: sha.stdout.trim() || null };
  }

  async pushBranch(
    dir: string,
    branch: string,
    provider: GitProvider,
    log: WorkspaceLog,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const authHeader = this.authHeaderFor(provider);
    const args = ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`];
    if (options.force) args.splice(1, 0, '--force-with-lease');

    const result = await git(args, {
      cwd: dir,
      authHeader,
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
    const authHeader = this.authHeaderFor(provider);
    const stat = await git(['diff', '--stat', `${baseRef}...HEAD`], { cwd: dir, authHeader });
    const diff = await git(['diff', `${baseRef}...HEAD`], { cwd: dir, authHeader });
    const text = `${stat.stdout.trim()}\n\n${diff.stdout.trim()}`.trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（diff 已截断）` : text;
  }

  async diffStat(dir: string, baseRef: string, provider: GitProvider): Promise<string> {
    const authHeader = this.authHeaderFor(provider);
    const result = await git(['diff', '--stat', `${baseRef}...HEAD`], { cwd: dir, authHeader });
    return result.stdout.trim();
  }

  async currentBranch(dir: string, provider: GitProvider): Promise<string> {
    const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      authHeader: this.authHeaderFor(provider),
    });
    return result.stdout.trim();
  }

  async headSha(dir: string, provider: GitProvider): Promise<string | null> {
    const result = await git(['rev-parse', 'HEAD'], {
      cwd: dir,
      authHeader: this.authHeaderFor(provider),
    });
    return result.stdout.trim() || null;
  }

  removeWorkspace(repositoryId: string): void {
    const dir = this.pathFor(repositoryId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
