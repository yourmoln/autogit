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
 * The same run also reports where `pnpm install` would put the store, because a
 * repo-local cache is the root cause of the accident above: an install inside the
 * repository leaves ~265 MB of cache in the working tree, and only `.gitignore`
 * keeps it out of the index. That report is a warning instead of a failure — the
 * location comes from the machine's pnpm configuration, not from the repository,
 * and a gate that fails on it would also fail in environments that install into
 * the workspace on purpose. A committed `.npmrc` is not the fix either: the Codex
 * sandbox AutoGit runs its tasks in only allows writes inside the task workspace
 * and the temp directory, so pinning `store-dir` to the user home makes
 * `pnpm install` fail inside the pipeline. Configure it outside the repository
 * instead (`pnpm install --store-dir <仓库外路径>`, or `~/.npmrc` for a machine
 * wide setting).
 *
 * Usage:
 *   pnpm repo:check                     # scan HEAD (the current branch)
 *   pnpm repo:check --ref origin/main   # scan another ref as well
 *   pnpm repo:check --skip-self-test    # skip the scanner self test
 *
 * Every run starts with a self test (`--skip-self-test` opts out): a throwaway
 * repository in the temp directory proves that a clean history passes, that
 * `.pnpm-store` objects a later commit deleted are still caught and that the store
 * location check separates a store inside the repository from a sibling directory
 * that merely shares the prefix. If the detection logic ever breaks, this gate
 * fails instead of silently passing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/** pnpm reads `store-dir` from this environment variable before any npmrc file. */
const STORE_DIR_ENV = 'npm_config_store_dir';
/** On Windows the pnpm CLI is a `.cmd` shim, which needs a shell to be spawned. */
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const PNPM_TIMEOUT_MS = 30_000;

/** `~`, `${VAR}` and `$VAR` expansion, then resolution against the config file. */
function expandStoreDir(value, baseDir) {
  const expanded = value
    .trim()
    .replace(/^~(?=$|[\\/])/, homedir())
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_match, name) => process.env[name] ?? '');
  return path.resolve(baseDir, expanded);
}

/** `store-dir` from one npmrc file, `null` when the file does not set it. */
function npmrcStoreDir(file) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let value = null;
  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*store-dir\s*=\s*(.+?)\s*$/);
    if (match?.[1]) value = match[1]; // the last assignment wins, like ini parsing
  }
  if (value === null) return null;
  // pnpm resolves a relative store-dir against the npmrc file, not the cwd.
  return { dir: expandStoreDir(value, path.dirname(file)), source: file };
}

/** Configured store directory: environment first, then project and user npmrc. */
function configuredStoreDir(cwd) {
  const fromEnvironment = process.env[STORE_DIR_ENV]?.trim();
  if (fromEnvironment) {
    return { dir: expandStoreDir(fromEnvironment, cwd), source: STORE_DIR_ENV };
  }
  return npmrcStoreDir(path.join(cwd, '.npmrc')) ?? npmrcStoreDir(path.join(homedir(), '.npmrc'));
}

/** `pnpm store path` — the authoritative answer, `null` when pnpm cannot answer. */
function pnpmStoreDir(cwd) {
  // 常量命令 + shell：Windows 上 pnpm 是 .cmd 垫片，必须经过 shell；命令里没有外部输入。
  const result = spawnSync(`${PNPM} store path`, {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: PNPM_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const lines = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // A path line, not a stray notice: pnpm prints nothing else today, but this
  // keeps a future warning line from being mistaken for the store location.
  const line = lines.find((entry) => path.isAbsolute(entry)) ?? lines[0];
  return line ? { dir: path.resolve(cwd, line), source: 'pnpm store path' } : null;
}

/** `true` when `child` is `parent` itself or lives below it. */
function isInsideRepository(parent, child) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(parent), normalize(child));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Warning for a store that `pnpm install` would write inside the repository, `null`
 * when it is outside (or unknown). Never a failure: see the file header.
 */
function storeLocationWarning(cwd, store) {
  if (!store || !isInsideRepository(cwd, store.dir)) return null;
  return (
    `pnpm 的 store 目录落在仓库内（${path.resolve(store.dir)}，来源：${store.source}）：` +
    '一次 pnpm install 就会在这里写入 265 MB 量级的包缓存，一旦误提交只能改写历史才能清掉。\n' +
    '   处理：安装依赖时把 store 指向仓库外 —— Windows：pnpm install --store-dir "$env:TEMP\\pnpm-store"；' +
    'Linux/macOS：pnpm install --store-dir /tmp/pnpm-store；也可以写进机器级 ~/.npmrc。' +
    '不要提交仓库内 .npmrc 固定 store-dir：AutoGit 流水线的 Codex 沙箱只允许写任务工作区与临时目录，' +
    '固定到用户目录会让沙箱内的 pnpm install 直接失败。'
  );
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

  // `pnpm store path` knows about every config source; the npmrc/env scan is the
  // fallback for machines without pnpm.
  const store = pnpmStoreDir(cwd) ?? configuredStoreDir(cwd);

  return { problems, entries: entries.length, bytes, tracked: tracked.length, store };
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

    // A store inside the repository has to be reported, while a sibling directory
    // whose name merely shares the prefix has to stay silent.
    const insideStore = storeLocationWarning(clean, {
      dir: path.join(clean, FORBIDDEN, 'v10'),
      source: '自检',
    });
    if (insideStore === null) throw new Error('仓库内的 pnpm store 没有被警告');
    const siblingStore = storeLocationWarning(clean, {
      dir: path.join(root, 'sibling-store', 'v10'),
      source: '自检',
    });
    if (siblingStore !== null) throw new Error(`仓库外的 pnpm store 被误报：${siblingStore}`);

    // `.npmrc` 的相对路径按 pnpm 的规则相对该文件解析，`~` 展开到用户目录。
    const configured = path.join(root, 'configured');
    mkdirSync(configured, { recursive: true });
    writeFileSync(path.join(configured, '.npmrc'), 'store-dir=../.pnpm-store\n');
    const relativeStore = npmrcStoreDir(path.join(configured, '.npmrc'));
    if (relativeStore?.dir !== path.resolve(configured, '..', '.pnpm-store')) {
      throw new Error(`.npmrc 的相对 store-dir 解析错误：${relativeStore?.dir}`);
    }
    const tildeStore = expandStoreDir('~/.pnpm-store', configured);
    if (tildeStore !== path.join(homedir(), '.pnpm-store')) {
      throw new Error(`store-dir 的 ~ 没有展开到用户目录：${tildeStore}`);
    }

    return (
      `干净仓库 0 命中、提交后删除仍检出 ${found.entries} 个对象、缺少 .gitignore 规则被拦下、` +
      '仓库内的 store 目录被警告而仓库外的不误报'
    );
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
  const warnings = [];

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
    const result = scan(process.cwd(), options.ref);
    problems.push(...result.problems);
    const warning = storeLocationWarning(process.cwd(), result.store);
    if (warning) {
      warnings.push(warning);
    } else if (result.store) {
      notes.push(`✅ pnpm store 在仓库外：${result.store.dir}（来源：${result.store.source}）`);
    } else {
      notes.push('ℹ️ 无法确定 pnpm store 目录（没有 pnpm 也没有 store-dir 配置），跳过该检查');
    }
  } catch (error) {
    problems.push(`无法扫描 ${options.ref}：${errorMessage(error)}`);
  }

  for (const note of notes) process.stdout.write(`${note}\n`);
  for (const warning of warnings) process.stdout.write(`⚠️ ${warning}\n`);
  if (problems.length === 0) {
    process.stdout.write(`✅ ${options.ref} 的索引与可达历史都干净：没有 ${FORBIDDEN} 对象\n`);
    return;
  }
  for (const problem of problems) process.stderr.write(`❌ ${problem}\n`);
  process.exitCode = 1;
}

main();
