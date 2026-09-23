#!/usr/bin/env node
/**
 * Repository hygiene check: the pnpm store must not be part of the repository.
 *
 * `.pnpm-store/` is a package cache, not source. A single accidental `git add`
 * puts every cached tarball into the history for good — the branch this check
 * was written for carried 11,678 objects (~267 MB, largest single object
 * ~72 MB) reachable from `HEAD` even after the files were deleted from the
 * working tree, because deleting them only fixes the tip: the blobs stay
 * reachable from every commit that added them. Anyone who merges such a branch
 * with a regular merge commit inherits the whole cache into `main`, and only a
 * history rewrite gets rid of it again.
 *
 * So: fail loudly while it is still cheap to fix (rewrite the branch, or merge
 * with "Squash and merge" which only takes the final tree).
 *
 * Usage: pnpm repo:check
 */
import { execFileSync } from 'node:child_process';

const FORBIDDEN = '.pnpm-store';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const MAX_BUFFER = 512 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync(GIT, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function isStorePath(value) {
  return value === FORBIDDEN || value.startsWith(`${FORBIDDEN}/`);
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `[{ sha, path }]` for every object under `.pnpm-store` reachable from HEAD. */
function historyEntries() {
  const output = git(['rev-list', '--objects', 'HEAD', '--', FORBIDDEN]);
  const entries = [];
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const separator = text.indexOf(' ');
    if (separator === -1) continue;
    const path = text.slice(separator + 1);
    if (!isStorePath(path)) continue;
    entries.push({ sha: text.slice(0, separator), path });
  }
  return entries;
}

/** Sum of the blob sizes behind the given object ids. */
function totalBlobBytes(entries) {
  if (entries.length === 0) return 0;
  const input = entries.map((entry) => entry.sha).join('\n');
  const output = execFileSync(GIT, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
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

const problems = [];

const tracked = git(['ls-files'])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && isStorePath(line));
if (tracked.length > 0) {
  problems.push(
    `${tracked.length} 个 .pnpm-store 文件仍在索引中：先执行 git rm -r --cached ${FORBIDDEN}`,
  );
}

try {
  git(['check-ignore', '-q', `${FORBIDDEN}/`]);
} catch {
  problems.push(`.gitignore 缺少 ${FORBIDDEN}/ 规则，下次安装依赖会把缓存重新带回仓库`);
}

const entries = historyEntries();
if (entries.length > 0) {
  problems.push(
    `HEAD 可达的历史里仍有 ${entries.length} 个 ${FORBIDDEN} 对象（blob 合计 ${formatMb(
      totalBlobBytes(entries),
    )}）：改写该分支（git filter-repo --path ${FORBIDDEN} --invert-paths 后 push --force-with-lease），` +
      '或改用 Squash and merge 合并（只取最终树），合并后删除该分支',
  );
}

if (problems.length === 0) {
  process.stdout.write('✅ 仓库历史与索引都干净：没有 .pnpm-store 对象\n');
} else {
  for (const problem of problems) process.stderr.write(`❌ ${problem}\n`);
  process.exitCode = 1;
}
