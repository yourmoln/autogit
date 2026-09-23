#!/usr/bin/env node
/**
 * Repository hygiene check: the pnpm store must not be part of the repository.
 *
 * `.pnpm-store/` is a package cache, not source. A single accidental `git add`
 * puts every cached tarball into the history for good — the branch this check
 * was written for carried 11,678 objects (~265 MB, largest single object
 * ~72 MB) reachable from `HEAD` even after the files were deleted from the
 * working tree, because deleting them only fixes the tip: the blobs stay
 * reachable from every commit that added them.
 *
 * Reachable is what matters for the merge button: `Create a merge commit` puts
 * that whole chain into the base branch's ancestry and `Rebase and merge` does
 * the same by replaying the commit that added the files, so both make the cache
 * permanent (`git clone` size, every future checkout) until the base branch
 * history itself is rewritten. `Squash and merge` takes the final tree alone and
 * leaves the objects behind — that, or rewriting the branch first, is the only
 * safe way to land a branch like this one.
 *
 * Usage:
 *   pnpm repo:check                     # scan HEAD (the current branch)
 *   pnpm repo:check --ref origin/main   # scan another ref as well
 *   pnpm repo:check --skip-self-test    # skip the scanner self test
 *
 * Every run starts with a self test (`--skip-self-test` opts out): a throwaway
 * repository in the temp directory proves that a clean history passes and that
 * `.pnpm-store` objects a later commit deleted are still caught. If the
 * detection logic ever breaks, this gate fails instead of silently passing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FORBIDDEN = '.pnpm-store';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const MAX_BUFFER = 512 * 1024 * 1024;

function git(cwd, args, options = {}) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isStorePath(value) {
  return value === FORBIDDEN || value.startsWith(`${FORBIDDEN}/`);
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `[{ sha, path }]` for every object under `.pnpm-store` reachable from `ref`. */
function historyEntries(cwd, ref) {
  const output = git(cwd, ['rev-list', '--objects', ref, '--', FORBIDDEN]);
  const entries = [];
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const separator = text.indexOf(' ');
    if (separator === -1) continue;
    const objectPath = text.slice(separator + 1);
    if (!isStorePath(objectPath)) continue;
    entries.push({ sha: text.slice(0, separator), path: objectPath });
  }
  return entries;
}

/** Sum of the blob sizes behind the given object ids. */
function totalBlobBytes(cwd, entries) {
  if (entries.length === 0) return 0;
  const input = entries.map((entry) => entry.sha).join('\n');
  const output = execFileSync(GIT, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
    cwd,
    input,
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

/**
 * Scans one repository: the index, the ignore rule and every object reachable
 * from `ref`. Returns the problems plus the numbers the caller reports.
 */
function scan(cwd, ref) {
  const problems = [];

  const tracked = git(cwd, ['ls-files'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isStorePath(line));
  if (tracked.length > 0) {
    problems.push(
      `${tracked.length} 个 .pnpm-store 文件仍在索引中：先执行 git rm -r --cached ${FORBIDDEN}`,
    );
  }

  try {
    git(cwd, ['check-ignore', '-q', `${FORBIDDEN}/`]);
  } catch {
    problems.push(`.gitignore 缺少 ${FORBIDDEN}/ 规则，下次安装依赖会把缓存重新带回仓库`);
  }

  const entries = historyEntries(cwd, ref);
  const bytes = totalBlobBytes(cwd, entries);
  if (entries.length > 0) {
    problems.push(
      `${ref} 可达的历史里有 ${entries.length} 个 ${FORBIDDEN} 对象（blob 合计 ${formatMb(bytes)}）。` +
        '删除文件只让工作树与索引变干净：这些对象仍从当初添加它们的提交起可达，' +
        'Create a merge commit 会把整条链并进目标分支，Rebase and merge 会重放那次添加。\n' +
        '   处理（二选一）：① 在有远端写权限的环境改写该分支：先 git fetch origin，再 pnpm repo:purge 预演、' +
        'pnpm repo:purge --apply，最后 git push --force-with-lease，再跑 pnpm repo:check 确认归零；' +
        '该脚本只改写分支自己的提交（基准分支的历史与合并基准都不动，不会把 PR 变成有冲突的）；' +
        '② 直接用 Squash and merge 合并（只取最终树）并在合并后删除该分支。',
    );
  }

  return { problems, entries: entries.length, bytes, tracked: tracked.length };
}

function commitAll(cwd, message) {
  const identity = [
    '-c',
    'user.name=repo-check',
    '-c',
    'user.email=repo-check@example.com',
    '-c',
    'commit.gpgsign=false',
  ];
  git(cwd, [...identity, 'add', '-A']);
  git(cwd, [...identity, 'commit', '-q', '-m', message]);
}

/**
 * Proves the scanner still detects what it was written for.
 *
 * The interesting shape is the one this repository actually hit: `.pnpm-store`
 * was committed once, then removed in a later commit, so the working tree and
 * the index look clean while the objects are still reachable from `HEAD`.
 */
function selfTest() {
  const root = mkdtempSync(path.join(tmpdir(), 'autogit-repo-check-'));
  const clean = path.join(root, 'clean');
  const leaked = path.join(root, 'leaked');
  const unignored = path.join(root, 'unignored');

  try {
    for (const directory of [clean, leaked, unignored]) {
      mkdirSync(directory, { recursive: true });
      git(directory, ['init', '-q']);
      writeFileSync(path.join(directory, 'README.md'), '# repo-check self test\n');
    }

    // A repository that never saw the cache: the gate must stay quiet.
    writeFileSync(path.join(clean, '.gitignore'), `${FORBIDDEN}/\n`);
    commitAll(clean, 'init');
    const healthy = scan(clean, 'HEAD');
    if (healthy.problems.length > 0 || healthy.entries !== 0) {
      throw new Error(`干净仓库被误报：${healthy.problems.join(' / ') || healthy.entries}`);
    }

    // The real accident: commit the cache, then delete it and ignore it.
    mkdirSync(path.join(leaked, FORBIDDEN, 'v3', 'files', 'aa'), { recursive: true });
    writeFileSync(
      path.join(leaked, FORBIDDEN, 'v3', 'files', 'aa', 'cache.bin'),
      Buffer.alloc(64 * 1024, 7),
    );
    commitAll(leaked, 'add store');
    rmSync(path.join(leaked, FORBIDDEN), { recursive: true, force: true });
    writeFileSync(path.join(leaked, '.gitignore'), `${FORBIDDEN}/\n`);
    commitAll(leaked, 'remove store');
    const found = scan(leaked, 'HEAD');
    if (found.tracked !== 0) throw new Error('自检仓库的索引并不干净，用例无效');
    if (found.entries < 1) throw new Error('提交后又删除的 .pnpm-store 没有被检出');
    if (found.bytes <= 0) throw new Error('检出了对象但没有统计体积');
    if (!found.problems.some((problem) => problem.includes('可达的历史'))) {
      throw new Error('检出对象但没有给出历史相关的诊断');
    }

    // A missing ignore rule is its own problem: the next install adds it back.
    commitAll(unignored, 'init');
    const noRule = scan(unignored, 'HEAD');
    if (!noRule.problems.some((problem) => problem.includes('.gitignore'))) {
      throw new Error('缺少 .pnpm-store 忽略规则没有被拦下');
    }

    return `干净仓库 0 命中、提交后删除仍检出 ${found.entries} 个对象、缺少 .gitignore 规则被拦下`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = { ref: 'HEAD', selfTest: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ref') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--ref 需要一个分支名或提交号');
      options.ref = value;
      index += 1;
      continue;
    }
    if (argument === '--skip-self-test') {
      options.selfTest = false;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`未知参数：${argument}（可用：--ref <rev>、--skip-self-test）`);
  }
  return options;
}

function main() {
  const problems = [];
  const notes = [];

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
      '用法：node scripts/check-repo-hygiene.mjs [--ref <rev>] [--skip-self-test]\n',
    );
    return;
  }

  if (options.selfTest) {
    try {
      notes.push(`✅ 扫描逻辑自检：${selfTest()}`);
    } catch (error) {
      problems.push(`自检失败，仓库检查结果不可信：${errorMessage(error)}`);
    }
  }

  try {
    problems.push(...scan(process.cwd(), options.ref).problems);
  } catch (error) {
    problems.push(`无法扫描 ${options.ref}：${errorMessage(error)}`);
  }

  for (const note of notes) process.stdout.write(`${note}\n`);
  if (problems.length === 0) {
    process.stdout.write(`✅ ${options.ref} 的索引与可达历史都干净：没有 ${FORBIDDEN} 对象\n`);
    return;
  }
  for (const problem of problems) process.stderr.write(`❌ ${problem}\n`);
  process.exitCode = 1;
}

main();
