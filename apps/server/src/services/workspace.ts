import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { LogStream } from '@autogit/shared';

import type { RuntimeConfig } from '../config.js';
import type { RepositoryRecord } from '../db/store.js';
import type { GitProvider } from '../providers/index.js';
import { git } from './git.js';
import type { SettingsService } from './settings.js';

export type WorkspaceLog = (stream: LogStream, message: string) => void;

export interface CommitResult {
  committed: boolean;
  files: string[];
  sha: string | null;
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
      const result = await git(['clone', '--origin', 'origin', repository.cloneUrl, dir], {
        cwd: path.dirname(dir),
        authHeader,
        env,
        onLine: (line) => log('git', line.message),
      });
      if (result.code !== 0) {
        throw new Error(`克隆失败：${result.stderr.trim() || result.stdout.trim() || '未知错误'}`);
      }
    } else {
      log('git', `更新远端引用 ${repository.fullName}`);
      const fetch = await git(['fetch', '--all', '--prune', '--tags'], {
        cwd: dir,
        authHeader,
        env,
        onLine: (line) => log('git', line.message),
      });
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
    await git(['fetch', 'origin', base, '--prune'], {
      cwd: dir,
      authHeader,
      onLine: (l) => log('git', l.message),
    });
    const checkout = await git(['checkout', '-B', branch, `origin/${base}`], {
      cwd: dir,
      authHeader,
      onLine: (l) => log('git', l.message),
    });
    if (checkout.code !== 0) {
      throw new Error(`切换分支失败：${checkout.stderr.trim() || checkout.stdout.trim()}`);
    }
    await git(['reset', '--hard', `origin/${base}`], { cwd: dir, authHeader });
    await git(['clean', '-fd'], { cwd: dir, authHeader });
  }

  /** Checks out an existing remote branch (used for review / fix tasks). */
  async checkoutRemoteBranch(
    dir: string,
    branch: string,
    provider: GitProvider,
    log: WorkspaceLog,
  ): Promise<void> {
    const authHeader = this.authHeaderFor(provider);
    const fetch = await git(['fetch', 'origin', branch, '--prune'], {
      cwd: dir,
      authHeader,
      onLine: (l) => log('git', l.message),
    });
    if (fetch.code !== 0) {
      throw new Error(`拉取分支 ${branch} 失败：${fetch.stderr.trim() || '未知错误'}`);
    }
    const checkout = await git(['checkout', '-B', branch, `origin/${branch}`], {
      cwd: dir,
      authHeader,
      onLine: (l) => log('git', l.message),
    });
    if (checkout.code !== 0) {
      throw new Error(`切换分支失败：${checkout.stderr.trim() || checkout.stdout.trim()}`);
    }
    await git(['reset', '--hard', `origin/${branch}`], { cwd: dir, authHeader });
    await git(['clean', '-fd'], { cwd: dir, authHeader });
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
