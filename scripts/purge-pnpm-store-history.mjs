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
 * The rewrite is limited to the commits this branch adds on top of its base
 * (`<merge base>..<branch>`), because `git filter-branch` rebuilds every commit
 * it walks and a rebuilt commit loses its `gpgsig`. GitHub signs the merge
 * commits it creates, so an unrestricted rewrite rebuilds the base branch's own
 * commits inside this branch and moves the merge base backwards — on
 * `ai/issue-4-新增登录密码` from `403990a` to `9daccf9`, which turns a
 * conflict-free PR into one with 8 conflicted files while the tip tree stays
 * identical, so the tree check alone cannot see it.
 *
 * It is an operator tool on purpose: rewriting a branch needs write access to
 * `.git` and to the remote, which the AutoGit fix sandbox does not have. The
 * script never pushes — it prints the `git push --force-with-lease` command at
 * the end — and a dry run touches nothing at all.
 *
 * Usage:
 *   pnpm repo:purge                    # 预演：会被改写的对象数量与备份位置
 *   pnpm repo:purge --apply            # 真正改写（工作树与索引必须干净）
 *   pnpm repo:purge --ref <branch>     # 改写指定的本地分支（默认当前分支）
 *   pnpm repo:purge --base <ref>       # 指定合并基准分支（默认自动探测）
 *   pnpm repo:purge --skip-self-test   # 跳过改写逻辑自检（默认先跑一遍自检）
 *
 * Run `git fetch origin` first: which commits count as "this branch's own"
 * depends entirely on the base ref.
 *
 * Safety rails:
 *   - a self test rewrites throwaway repositories first and proves that the
 *     rewrite drops the cache, keeps the tip tree, leaves the base branch's
 *     commits (signed merges included) and the merge base alone, and refuses a
 *     cache the branch only inherited from its base;
 *   - the rewrite happens on a throwaway branch first, so the real branch is
 *     only moved once the result is verified;
 *   - the tip *tree* has to be identical afterwards (`<branch>^{tree}`), because
 *     the rewrite may only change what the branch carries in its ancestry, never
 *     what it contains;
 *   - the merge base with the base ref has to be identical too: that is what
 *     keeps the PR mergeable into the base branch without conflicts;
 *   - the object scan runs again on the result and the script refuses to move the
 *     branch while any `.pnpm-store` object is still reachable from it;
 *   - the old tip is kept in `refs/autogit-backup/<branch>/<timestamp>`, so
 *     `git update-ref refs/heads/<branch> <backup>` undoes the whole thing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = '.pnpm-store';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const MAX_BUFFER = 256 * 1024 * 1024;
const EMPTY = '0'.repeat(40);
const SELF_TEST_SCRIPT = fileURLToPath(import.meta.url);
/** 合并基准的默认探测顺序：常见默认分支在前，`origin/HEAD` 兜底。 */
const BASE_CANDIDATES = ['origin/main', 'main', 'origin/master', 'master', 'origin/HEAD'];

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
function storeObjects(ref, directory = root) {
  const output = git(['rev-list', '--objects', ref, '--', FORBIDDEN], { cwd: directory });
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

/** `ids` 去掉 `minus` 里出现过的对象（同 SHA 即同对象）。 */
function subtractObjects(ids, minus) {
  const seen = new Set(minus);
  return ids.filter((id) => !seen.has(id));
}

/**
 * 合并基准：`--base` 显式指定优先，否则按 `BASE_CANDIDATES` 找一个能解析、不是这条
 * 分支自己、且与它有共同祖先的引用。返回 `{ ref, sha }`。
 */
function resolveBase(explicit, branchTip) {
  const tried = [];
  for (const candidate of explicit ? [explicit] : BASE_CANDIDATES) {
    const sha = gitProbe(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (!sha) {
      tried.push(`${candidate}（不存在）`);
      continue;
    }
    if (sha === branchTip) {
      tried.push(`${candidate}（就是这条分支自己）`);
      continue;
    }
    if (!gitProbe(['merge-base', sha, branchTip])) {
      tried.push(`${candidate}（与本分支没有共同祖先）`);
      continue;
    }
    return { ref: candidate, sha };
  }
  throw new Error(
    `无法确定合并基准分支（已尝试 ${tried.join('、')}）：用 --base <ref> 指定要合并进的分支，` +
      '例如 --base origin/main。脚本只改写在基准之上的提交，少了基准就无法划出范围',
  );
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/** 在自检 fixture 里跑 git（与操作者的仓库无关）。 */
function gitIn(directory, args, options = {}) {
  return execFileSync(GIT, args, {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

const FIXTURE_IDENTITY = [
  '-c',
  'user.name=repo-purge',
  '-c',
  'user.email=repo-purge@example.com',
  '-c',
  'commit.gpgsign=false',
];

function fixtureCommit(directory, message) {
  gitIn(directory, [...FIXTURE_IDENTITY, 'add', '-A']);
  gitIn(directory, [...FIXTURE_IDENTITY, 'commit', '-q', '-m', message]);
}

/**
 * 把提交换成带 `gpgsig` 头的版本：GitHub 建的合并提交就是这样，重建（filter-branch）
 * 时会丢掉签名、SHA 随之改变。签名内容不必有效，自检只需要那个形状。
 */
function signLikeGithub(directory, commit) {
  const raw = gitIn(directory, ['cat-file', 'commit', commit]);
  const separator = raw.indexOf('\n\n');
  const signature = [
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' iQEcBAABCAAGBQJfakeSignatureForTheSelfTest=',
    ' -----END PGP SIGNATURE-----',
  ].join('\n');
  const signed = `${raw.slice(0, separator)}\n${signature}${raw.slice(separator)}`;
  return gitIn(directory, ['hash-object', '-w', '-t', 'commit', '--stdin'], { input: signed }).trim();
}

/** 在 fixture 里把本脚本当命令行跑一遍（子进程，走真实参数解析）。 */
function runSelfTestScript(directory, args) {
  const result = spawnSync(process.execPath, [SELF_TEST_SCRIPT, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    status: result.status ?? 1,
    output: result.error ? `${output}${result.error.message}` : output,
  };
}

/**
 * Proves the rewrite still does what it was written for.
 *
 * The interesting shape is the one this repository hit: the branch adds the cache
 * in one commit and deletes it in a later one, and the base branch moves past a
 * signed merge commit — which is exactly what an unrestricted `filter-branch`
 * run rebuilds, and rebuilding it drops the signature and the SHA. The tip tree
 * then stays identical while the merge base with the base branch slides
 * backwards and the PR turns into a conflicted one.
 */
function selfTest() {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'autogit-repo-purge-'));
  const leaked = path.join(sandbox, 'leaked');
  const inherited = path.join(sandbox, 'inherited');

  try {
    // ① 分支自己的提交里带着 .pnpm-store。
    mkdirSync(leaked, { recursive: true });
    gitIn(leaked, ['init', '-q']);
    gitIn(leaked, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    writeFileSync(path.join(leaked, 'a.txt'), 'a\n');
    fixtureCommit(leaked, 'a');
    writeFileSync(path.join(leaked, 'b.txt'), 'b\n');
    fixtureCommit(leaked, 'b');
    gitIn(leaked, ['switch', '-q', '-c', 'topic']);
    writeFileSync(path.join(leaked, 'topic.txt'), 'topic\n');
    fixtureCommit(leaked, 'topic');
    gitIn(leaked, ['switch', '-q', 'main']);
    gitIn(leaked, [
      ...FIXTURE_IDENTITY,
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'Merge pull request #1',
      'topic',
    ]);
    const merged = gitIn(leaked, ['rev-parse', 'HEAD']).trim();
    gitIn(leaked, ['update-ref', 'refs/heads/main', signLikeGithub(leaked, merged)]);

    gitIn(leaked, ['switch', '-q', '-c', 'feature']);
    writeFileSync(path.join(leaked, 'c.txt'), 'c\n');
    fixtureCommit(leaked, 'feature: c');
    mkdirSync(path.join(leaked, FORBIDDEN, 'v10', 'files', 'aa'), { recursive: true });
    writeFileSync(
      path.join(leaked, FORBIDDEN, 'v10', 'files', 'aa', 'cache.bin'),
      Buffer.alloc(64 * 1024, 7),
    );
    fixtureCommit(leaked, 'feature: add store');
    rmSync(path.join(leaked, FORBIDDEN), { recursive: true, force: true });
    writeFileSync(path.join(leaked, '.gitignore'), `${FORBIDDEN}/\n`);
    fixtureCommit(leaked, 'feature: remove store');
    writeFileSync(path.join(leaked, 'c.txt'), 'c2\n');
    fixtureCommit(leaked, 'feature: c again');

    // 基准分支在分叉之后继续前进（本仓库的 main 就是这样），
    // 所以合并基准不等于基准 tip，下面的断言才有意义。
    gitIn(leaked, ['switch', '-q', 'main']);
    writeFileSync(path.join(leaked, 'd.txt'), 'd\n');
    fixtureCommit(leaked, 'main 前进');
    gitIn(leaked, ['switch', '-q', 'feature']);
    const advanced = gitIn(leaked, ['rev-parse', 'refs/heads/main']).trim();

    const featureTip = gitIn(leaked, ['rev-parse', 'refs/heads/feature']).trim();
    const featureTree = gitIn(leaked, ['rev-parse', 'refs/heads/feature^{tree}']).trim();
    const mergeBase = gitIn(leaked, ['merge-base', 'refs/heads/main', 'refs/heads/feature']).trim();
    if (storeObjects('refs/heads/feature', leaked).length === 0) {
      throw new Error('自检仓库没有造出可检出的 .pnpm-store 对象，用例无效');
    }

    const applied = runSelfTestScript(leaked, [
      '--apply',
      '--ref',
      'feature',
      '--base',
      'main',
      '--skip-self-test',
    ]);
    if (applied.status !== 0) {
      throw new Error(`改写失败（退出码 ${applied.status}）：${applied.output.trim()}`);
    }

    const tip = gitIn(leaked, ['rev-parse', 'refs/heads/feature']).trim();
    const after = {
      tree: gitIn(leaked, ['rev-parse', 'refs/heads/feature^{tree}']).trim(),
      mergeBase: gitIn(leaked, ['merge-base', 'refs/heads/main', 'refs/heads/feature']).trim(),
      main: gitIn(leaked, ['rev-parse', 'refs/heads/main']).trim(),
      store: storeObjects('refs/heads/feature', leaked).length,
      content: gitIn(leaked, ['diff', '--name-only', featureTip, tip]).trim(),
    };
    if (tip === featureTip) throw new Error('tip 没变，这次改写什么都没做');
    if (after.tree !== featureTree) throw new Error(`改写后 tip 树变了：${featureTree} → ${after.tree}`);
    if (after.store !== 0) throw new Error(`改写后仍有 ${after.store} 个 ${FORBIDDEN} 对象可达`);
    if (after.mergeBase !== mergeBase) {
      throw new Error(`改写重建了基准分支的提交：与 main 的合并基准从 ${mergeBase} 挪到 ${after.mergeBase}`);
    }
    if (after.main !== advanced) throw new Error('改写动到了基准分支的引用');
    if (after.content !== '') throw new Error('改写改变了分支的内容');

    // ② 已经干净的分支：再跑一次是纯 no-op。
    const again = runSelfTestScript(leaked, ['--ref', 'feature', '--base', 'main', '--skip-self-test']);
    if (again.status !== 0 || !again.output.includes('无需改写')) {
      throw new Error(`干净分支没有走 no-op 分支：${again.output.trim()}`);
    }

    // ③ 缓存是基准分支带进来的：只继承时要拒绝，自己又加一份时也要拒绝。
    mkdirSync(inherited, { recursive: true });
    gitIn(inherited, ['init', '-q']);
    gitIn(inherited, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    writeFileSync(path.join(inherited, 'a.txt'), 'a\n');
    mkdirSync(path.join(inherited, FORBIDDEN, 'v10', 'files', 'bb'), { recursive: true });
    writeFileSync(
      path.join(inherited, FORBIDDEN, 'v10', 'files', 'bb', 'cache.bin'),
      Buffer.alloc(4096, 3),
    );
    fixtureCommit(inherited, 'main: add store');
    gitIn(inherited, ['switch', '-q', '-c', 'feature']);
    writeFileSync(path.join(inherited, 'c.txt'), 'c\n');
    fixtureCommit(inherited, 'feature: c');

    const onlyInherited = runSelfTestScript(inherited, [
      '--apply',
      '--ref',
      'feature',
      '--base',
      'main',
      '--skip-self-test',
    ]);
    if (onlyInherited.status === 0 || !onlyInherited.output.includes('都不在它自己的提交里')) {
      throw new Error(`基准自带的缓存没有被拒绝：${onlyInherited.output.trim()}`);
    }

    mkdirSync(path.join(inherited, FORBIDDEN, 'v10', 'files', 'cc'), { recursive: true });
    writeFileSync(
      path.join(inherited, FORBIDDEN, 'v10', 'files', 'cc', 'cache.bin'),
      Buffer.alloc(4096, 5),
    );
    fixtureCommit(inherited, 'feature: add store');
    const both = runSelfTestScript(inherited, [
      '--apply',
      '--ref',
      'feature',
      '--base',
      'main',
      '--skip-self-test',
    ]);
    if (both.status === 0 || !both.output.includes('消不掉它们')) {
      throw new Error(`基准与本分支都带缓存时没有被拒绝：${both.output.trim()}`);
    }

    return `分支自带的 ${FORBIDDEN} 对象改写后归零、tip 树与和 main 的合并基准都没变、基准分支没被重建，干净分支走 no-op，基准自带的缓存被拒绝`;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = { apply: false, ref: null, base: null, selfTest: true, help: false };
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
    if (argument === '--base') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--base 需要一个分支名或提交号');
      options.base = value;
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
    throw new Error(
      `未知参数：${argument}（可用：--apply、--ref <branch>、--base <ref>、--skip-self-test）`,
    );
  }
  return options;
}

/**
 * Rewrites `branch` on a throwaway branch and only then moves the real ref.
 *
 * `git filter-branch --index-filter` is used because it ships with git itself:
 * it rebuilds every commit from an index that had `.pnpm-store` removed. The
 * scratch branch keeps the checkout untouched — filter-branch only rewrites the
 * working tree when the ref it is rewriting is the one that is checked out.
 *
 * The rev-list range is `<merge base>..<scratch branch>` — the commits this branch
 * adds — and never the whole ancestry: every rebuilt commit loses its `gpgsig`,
 * and GitHub signs the merge commits it creates, so walking further rebuilds
 * commits this branch does not own and slides the merge base backwards.
 */
function purge(branch, base, objects, bytes) {
  const ref = `refs/heads/${branch}`;
  const tip = gitText(['rev-parse', ref]);
  const tree = gitText(['rev-parse', `${ref}^{tree}`]);
  const mergeBase = gitText(['merge-base', base.sha, tip]);
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
        `${mergeBase}..${scratchRef}`,
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
    const mergeBaseAfter = gitText(['merge-base', base.sha, rewritten]);
    if (mergeBaseAfter !== mergeBase) {
      throw new Error(
        `改写后与 ${base.ref} 的合并基准从 ${mergeBase.slice(0, 7)} 挪到了 ${mergeBaseAfter.slice(0, 7)}：` +
          '这次改写重建了基准分支自己的提交（重建带签名的合并提交会丢签名，SHA 也随之改变），' +
          `合并进 ${base.ref} 会因此产生冲突。已放弃，${branch} 未被改动`,
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
      `✅ ${branch} 已改写：它自己带进来的 ${FORBIDDEN} 对象 ${objects.length} 个（${formatMb(bytes)}）→ 0 个，` +
        `tip 树未变（${tree.slice(0, 7)}），与 ${base.ref} 的合并基准仍是 ${mergeBase.slice(0, 7)}\n` +
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
      '用法：node scripts/purge-pnpm-store-history.mjs [--apply] [--ref <branch>] [--base <ref>] [--skip-self-test]\n' +
        '  默认只预演；--apply 才改写分支（要求工作树与索引干净）。\n' +
        '  只改写在合并基准之上的提交，基准分支的历史不动；改写前先跑一遍自检。\n',
    );
    return;
  }

  if (options.selfTest) {
    try {
      process.stdout.write(`✅ 改写逻辑自检：${selfTest()}\n`);
    } catch (error) {
      // 自检没过就不碰任何引用：写历史前先证明改写逻辑没坏。
      process.stderr.write(`❌ 自检失败，改写结果不可信：${errorMessage(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    root = gitText(['rev-parse', '--show-toplevel']);
    const branch = options.ref ?? gitProbe(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) throw new Error('当前是 detached HEAD，请用 --ref <branch> 指定要改写的分支');
    const ref = `refs/heads/${branch}`;
    const tip = gitProbe(['rev-parse', '--verify', '--quiet', ref]);
    if (!tip) throw new Error(`${branch} 不是本地分支（脚本只改写本地分支，改完再推送）`);
    const base = resolveBase(options.base, tip);

    const branchObjects = storeObjects(ref);
    const owned = subtractObjects(branchObjects, storeObjects(base.sha));
    const inherited = branchObjects.length - owned.length;
    if (owned.length === 0) {
      if (inherited === 0) {
        process.stdout.write(`✅ ${branch} 的可达历史里没有 ${FORBIDDEN} 对象，无需改写\n`);
        return;
      }
      throw new Error(
        `${branch} 可达的 ${inherited} 个 ${FORBIDDEN} 对象都不在它自己的提交里，而是随基准 ${base.ref} 继承来的：` +
          '改写本分支只会白改一遍，合并时照样把它们带进目标分支。请在真正添加了这些提交的分支上跑同样的流程；' +
          '若基准选错了（例如 origin/HEAD 指向这条分支的旧副本），用 --base 指定正确的基准',
      );
    }
    if (inherited > 0) {
      throw new Error(
        `除本分支自己带入的 ${owned.length} 个对象外，还有 ${inherited} 个 ${FORBIDDEN} 对象是随基准 ${base.ref} ` +
          '继承来的，改写本分支消不掉它们：先在把缓存写进历史的那个分支上处理，再回来改写这条',
      );
    }

    const mergeBase = gitText(['merge-base', base.sha, tip]);
    const rewrites = gitText(['rev-list', '--count', `${mergeBase}..${ref}`]);
    const bytes = blobBytes(owned);

    process.stdout.write(
      `⚠️  ${branch} 自己的提交里带入 ${owned.length} 个 ${FORBIDDEN} 对象（blob 合计 ${formatMb(bytes)}）\n` +
        `    基准：${base.ref}（${base.sha.slice(0, 7)}），合并基准 ${mergeBase.slice(0, 7)}，` +
        `将被改写的是基准之上的 ${rewrites} 个提交（${base.ref} 的历史不动）\n`,
    );
    if (!options.apply) {
      process.stdout.write(
        '    预演结束：没有改动任何引用。真正执行（先 git fetch origin，保证基准是最新的）：\n' +
          `      pnpm repo:purge --apply${options.ref ? ` --ref ${branch}` : ''}${options.base ? ` --base ${base.ref}` : ''}\n` +
          `    改写会先把旧 tip 备份到 refs/autogit-backup/${branch}/<时间戳>，再改写基准之上的提交；` +
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
    purge(branch, base, owned, bytes);
  } catch (error) {
    problems.push(errorMessage(error));
  }

  for (const problem of problems) process.stderr.write(`❌ ${problem}\n`);
  if (problems.length > 0) process.exitCode = 1;
}

main();
