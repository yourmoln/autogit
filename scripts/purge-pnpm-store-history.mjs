#!/usr/bin/env node
/**
 * Purges `.pnpm-store` from the history of one branch.
 *
 * `scripts/check-repo-hygiene.mjs` can only report the problem: the cache lives
 * in the branch *history*, so deleting it from the tree (or in a later commit)
 * leaves every object reachable from `HEAD`. `Create a merge commit` then writes
 * that whole chain into the base branch for good and `Rebase and merge` replays
 * the commit that added it, so the only two safe ways to land such a branch are
 * `Squash and merge` (final tree only) or a rewrite of the branch. This script
 * performs the rewrite, which makes *every* merge method safe again.
 *
 * It is an operator tool on purpose: rewriting a branch needs write access to
 * `.git` and to the remote, which the AutoGit fix sandbox does not have. The
 * script never pushes — it prints the `git push --force-with-lease` command at
 * the end — and a dry run touches nothing at all.
 *
 * Usage:
 *   pnpm repo:purge                  # 预演：会被改写的对象数量与备份位置
 *   pnpm repo:purge --apply          # 真正改写（工作树与索引必须干净）
 *   pnpm repo:purge --ref <branch>   # 改写指定的本地分支（默认当前分支）
 *
 * Safety rails:
 *   - the rewrite happens on a throwaway branch first, so the real branch is
 *     only moved once the result is verified;
 *   - the tip *tree* has to be identical afterwards (`<branch>^{tree}`), because
 *     the rewrite may only change what the branch carries in its ancestry, never
 *     what it contains;
 *   - the object scan runs again on the result and the script refuses to move the
 *     branch while any `.pnpm-store` object is still reachable from it;
 *   - the old tip is kept in `refs/autogit-backup/<branch>/<timestamp>`, so
 *     `git update-ref refs/heads/<branch> <backup>` undoes the whole thing.
 */
import { execFileSync } from 'node:child_process';

const FORBIDDEN = '.pnpm-store';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const MAX_BUFFER = 256 * 1024 * 1024;
const EMPTY = '0'.repeat(40);

let root = process.cwd();

function git(args, options = {}) {
  return execFileSync(GIT, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function gitText(args) {
  return git(args).trim();
}

/** Same as `gitText()`, but `null` instead of throwing (for optional refs). */
function gitProbe(args) {
  try {
    return gitText(args);
  } catch {
    return null;
  }
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '').trim() : '';
  return stderr && !message.includes(stderr) ? `${message}\n${stderr}` : message;
}

/** Object ids of every `.pnpm-store` object (blob, tree) reachable from `ref`. */
function storeObjects(ref) {
  const output = git(['rev-list', '--objects', ref, '--', FORBIDDEN]);
  const ids = [];
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const separator = text.indexOf(' ');
    if (separator === -1) continue;
    const objectPath = text.slice(separator + 1);
    if (objectPath !== FORBIDDEN && !objectPath.startsWith(`${FORBIDDEN}/`)) continue;
    ids.push(text.slice(0, separator));
  }
  return ids;
}

/** Total size of the blobs behind the given object ids. */
function blobBytes(ids) {
  if (ids.length === 0) return 0;
  const output = execFileSync(GIT, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
    cwd: root,
    input: ids.join('\n'),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });

  let bytes = 0;
  for (const line of output.split('\n')) {
    const [type, size] = line.trim().split(' ');
    if (type !== 'blob') continue;
    const parsed = Number.parseInt(size ?? '', 10);
    if (Number.isFinite(parsed)) bytes += parsed;
  }
  return bytes;
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function parseArguments(argv) {
  const options = { apply: false, ref: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (argument === '--ref') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--ref 需要一个本地分支名');
      options.ref = value;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`未知参数：${argument}（可用：--apply、--ref <branch>）`);
  }
  return options;
}

/**
 * Rewrites `branch` on a throwaway branch and only then moves the real ref.
 *
 * `git filter-branch --index-filter` is used because it ships with git itself:
 * it rebuilds every commit from an index that had `.pnpm-store` removed, which
 * is exactly what `git filter-repo --path .pnpm-store --invert-paths` does. The
 * scratch branch keeps the checkout untouched — filter-branch only rewrites the
 * working tree when the ref it is rewriting is the one that is checked out.
 */
function purge(branch, objects, bytes) {
  const ref = `refs/heads/${branch}`;
  const tip = gitText(['rev-parse', ref]);
  const tree = gitText(['rev-parse', `${ref}^{tree}`]);
  const stamp = timestamp();
  const scratchBranch = `autogit-purge-${stamp}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
  const scratchRef = `refs/heads/${scratchBranch}`;
  const backupRef = `refs/autogit-backup/${branch}/${stamp}`;

  git(['update-ref', scratchRef, tip, EMPTY]);
  try {
    git(
      [
        'filter-branch',
        '-f',
        '--index-filter',
        `git rm -r --cached --ignore-unmatch ${FORBIDDEN}`,
        '--prune-empty',
        '--',
        scratchBranch,
      ],
      { env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' } },
    );

    const rewritten = gitText(['rev-parse', scratchRef]);
    const rewrittenTree = gitText(['rev-parse', `${scratchRef}^{tree}`]);
    if (rewrittenTree !== tree) {
      throw new Error(
        `改写后的 tip 树变了（${tree.slice(0, 7)} → ${rewrittenTree.slice(0, 7)}），已放弃，${branch} 未被改动`,
      );
    }
    const remaining = storeObjects(scratchRef);
    if (remaining.length > 0) {
      throw new Error(
        `改写后仍有 ${remaining.length} 个 ${FORBIDDEN} 对象可达，已放弃，${branch} 未被改动`,
      );
    }

    git(['update-ref', '-m', `repo:purge 备份（改写前 tip ${tip.slice(0, 7)}）`, backupRef, tip, EMPTY]);
    git([
      'update-ref',
      '-m',
      `repo:purge 从历史里移除 ${FORBIDDEN}`,
      ref,
      rewritten,
      tip,
    ]);
    process.stdout.write(
      `✅ ${branch} 已改写：可达的 ${FORBIDDEN} 对象 ${objects.length} 个（${formatMb(bytes)}）→ 0 个，` +
        `tip 树未变（${tree.slice(0, 7)}）\n` +
        `   改写前历史：${backupRef}\n` +
        `   下一步：\n` +
        `     git fetch origin\n` +
        `     git push --force-with-lease origin ${branch}\n` +
        `     pnpm repo:check                    # 确认本地可达历史归零\n` +
        `     pnpm repo:check --ref origin/main  # 合并完成后复核目标分支\n` +
        `   合并后清理备份：git update-ref -d ${backupRef}\n` +
        `   远端 refs/pull/<n> 下的旧对象要等平台 GC，属正常现象。\n`,
    );
  } finally {
    // Both are bookkeeping of this run: the scratch branch never needs to
    // survive it, and `refs/autogit-backup/...` above keeps the old history.
    gitProbe(['update-ref', '-d', scratchRef]);
    gitProbe(['update-ref', '-d', `refs/original/refs/heads/${scratchBranch}`]);
  }
}

function main() {
  const problems = [];
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`❌ ${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(
      '用法：node scripts/purge-pnpm-store-history.mjs [--apply] [--ref <branch>]\n' +
        '  默认只预演；--apply 才改写分支（要求工作树与索引干净）。\n',
    );
    return;
  }

  try {
    root = gitText(['rev-parse', '--show-toplevel']);
    const branch = options.ref ?? gitProbe(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) throw new Error('当前是 detached HEAD，请用 --ref <branch> 指定要改写的分支');
    if (!gitProbe(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
      throw new Error(`${branch} 不是本地分支（脚本只改写本地分支，改完再推送）`);
    }

    const objects = storeObjects(branch);
    const bytes = blobBytes(objects);
    if (objects.length === 0) {
      process.stdout.write(`✅ ${branch} 的可达历史里没有 ${FORBIDDEN} 对象，无需改写\n`);
      return;
    }

    process.stdout.write(
      `⚠️  ${branch} 可达的历史里有 ${objects.length} 个 ${FORBIDDEN} 对象（blob 合计 ${formatMb(bytes)}）\n`,
    );
    if (!options.apply) {
      process.stdout.write(
        '    预演结束：没有改动任何引用。真正执行：\n' +
          `      pnpm repo:purge --apply${options.ref ? ` --ref ${branch}` : ''}\n` +
          `    改写会先把旧 tip 备份到 refs/autogit-backup/${branch}/<时间戳>，再重写整条历史；` +
          '脚本不会推送，最后一步由你执行：\n' +
          `      git fetch origin && git push --force-with-lease origin ${branch}\n` +
          `    若不想改写历史，就在合并这个 PR 时用 Squash and merge（不要用 ` +
          'Create a merge commit / Rebase and merge）。\n',
      );
      return;
    }

    const dirty = gitProbe(['status', '--porcelain']);
    if (dirty) {
      throw new Error('工作树或索引不干净，先提交（或 stash）再改写：filter-branch 会同步工作树');
    }
    purge(branch, objects, bytes);
  } catch (error) {
    problems.push(errorMessage(error));
  }

  for (const problem of problems) process.stderr.write(`❌ ${problem}\n`);
  if (problems.length > 0) process.exitCode = 1;
}

main();
