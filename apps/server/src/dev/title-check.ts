/**
 * Self check for pull request title normalization.
 *
 * `renderTitle()` renders the "设置 → PR 标题模板" setting through `conventionalTitle()`,
 * and the result becomes the pull request title — and, through GitHub's squash merge, the
 * commit subject written onto the base branch — so it has to satisfy the repository
 * convention `<英文类型>: <描述>` for every template and issue title a user can write.
 *
 * The regression this pins down: the English prefix branch accepted *any* letters before
 * the colon, so an issue title like `README: 更新说明` — prose that merely starts with an
 * English word — was rendered as `readme: 更新说明`, a type the convention does not list,
 * and the squash merge would have written it into the base branch history. Text whose
 * prefix is not a known type now stays the description and gets the inferred (or default)
 * type in front of it.
 *
 * The rules themselves live in `services/pr-metadata.ts` — the same module AutoGit uses to
 * repair PR metadata over the platform API — so this check exercises the shipped
 * implementation instead of a private copy that can drift away from it.
 *
 * Usage: pnpm --filter @autogit/server title:check
 */

import type { RemoteIssue } from '@autogit/shared';

import { renderTitle } from '../services/orchestrator.js';
import { conventionalTitle, titleProblem } from '../services/pr-metadata.js';

/**
 * Types the repository convention allows (README「PR 标题与正文规范」/ AGENTS.md).
 *
 * Mirrored here on purpose: this check fails as soon as the implementation starts emitting
 * a prefix this list does not contain.
 */
const ALLOWED_TYPES = [
  'feat',
  'fix',
  'chore',
  'refactor',
  'docs',
  'build',
  'perf',
  'test',
  'ci',
  'style',
  'revert',
];

/** Issue behind this branch (#4 新增登录密码), used for the template cases. */
const ISSUE: RemoteIssue = {
  number: 4,
  title: '新增登录密码',
  body: '为控制台加上登录门禁。',
  state: 'open',
  labels: ['ai/todo'],
  author: 'admin',
  htmlUrl: 'https://github.com/yourmoln/autogit/issues/4',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  comments: 0,
  isPullRequest: false,
};

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expect(name: string, run: () => string): void {
  try {
    record(name, true, run());
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

/** Type a normalized title starts with, `null` when the convention does not allow it. */
function leadingType(title: string): string | null {
  const match = title.match(/^([a-z]+): /);
  const type = match?.[1];
  return type !== undefined && ALLOWED_TYPES.includes(type) ? type : null;
}

/** `conventionalTitle()` case: the exact result *and* an allowed type prefix. */
function titleCase(input: string, expected: string): () => string {
  return () => {
    const actual = conventionalTitle(input);
    assert(
      actual === expected,
      `conventionalTitle(${JSON.stringify(input)}) 得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`,
    );
    assert(leadingType(actual) !== null, `结果不是白名单类型：${actual}`);
    const problem = titleProblem(actual);
    assert(problem === null, `生产线校验器不接受该标题：${problem}`);
    return actual;
  };
}

/** `renderTitle()` case: the exact result *and* an allowed type prefix. */
function templateCase(template: string, expected: string): () => string {
  return () => {
    const actual = renderTitle(template, ISSUE);
    assert(
      actual === expected,
      `renderTitle(${JSON.stringify(template)}) 得到 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`,
    );
    assert(leadingType(actual) !== null, `结果不是白名单类型：${actual}`);
    const problem = titleProblem(actual);
    assert(problem === null, `生产线校验器不接受该标题：${problem}`);
    return actual;
  };
}

function main(): void {
  // ① 白名单里的 11 个类型原样保留，只做归一化：大小写转小写、全角冒号换半角、空格压成一个。
  for (const type of ALLOWED_TYPES) {
    expect(`类型 ${type} 保留`, titleCase(`${type}: 描述`, `${type}: 描述`));
    expect(
      `类型 ${type} 归一化（大写 + 全角冒号 + 多余空格）`,
      titleCase(`${type.toUpperCase()}：  描述`, `${type}: 描述`),
    );
  }

  // ② 约定禁止的中文类型前缀改写成英文。
  expect('中文前缀 修复：', titleCase('修复：登录失败', 'fix: 登录失败'));
  expect('中文前缀 文档：', titleCase('文档：补充说明', 'docs: 补充说明'));
  expect('中文前缀 优化：', titleCase('优化：任务列表加载', 'perf: 任务列表加载'));

  // ③ 没有类型前缀时按标题开头的关键字补类型，推断不出来落 feat。
  expect('推断 新增… → feat', titleCase('新增登录密码 (#4)', 'feat: 新增登录密码 (#4)'));
  expect('推断 优化… → perf', titleCase('优化任务列表加载', 'perf: 优化任务列表加载'));
  expect('推断 修复… → fix', titleCase('修复登录失败', 'fix: 修复登录失败'));
  expect('推断不出来落 feat', titleCase('调整轮询间隔', 'feat: 调整轮询间隔'));

  // ④ 英文单词 + 冒号不等于类型：只有白名单里的类型才算前缀，其余整串当描述。
  //    这些标题都来自真实 Issue（`README: …`、`Release: …`），早期实现会原样透传成
  //    `readme:` / `release:` 这类约定外的类型，Squash 合并就会写进 main 的提交主题。
  expect('README: 更新说明', titleCase('README: 更新说明', 'feat: README: 更新说明'));
  expect('Release: v1.2', titleCase('Release: v1.2', 'feat: Release: v1.2'));
  expect('docker: 调整镜像', titleCase('docker: 调整镜像', 'feat: docker: 调整镜像'));
  expect('AutoGit: 一些说明', titleCase('AutoGit: 一些说明', 'feat: AutoGit: 一些说明'));
  expect(
    'readme: 更新说明（小写同样不算类型）',
    titleCase('readme: 更新说明', 'feat: readme: 更新说明'),
  );

  // ⑤ 模板渲染：默认模板补 feat、写死的类型只归一化、空模板回落到 Issue 标题 + 编号。
  expect(
    '默认模板补 feat',
    templateCase('{issueTitle} (#{issueNumber})', 'feat: 新增登录密码 (#4)'),
  );
  expect('模板写死 fix', templateCase('fix: {issueTitle}', 'fix: 新增登录密码'));
  expect('模板 FIX： 归一化', templateCase('FIX：  {issueTitle}', 'fix: 新增登录密码'));
  // 空模板在设置层就收敛成默认模板（`services/settings.ts`：
  // `prTitleTemplate.trim() || '{issueTitle} (#{issueNumber})'`），renderTitle 见不到空串。
  // 万一见到也不凭空的编一个 Issue 标题出来——回落只发生在设置层这一处。
  expect('空模板不编造标题（由设置层兜底）', () => {
    const actual = renderTitle('   ', ISSUE);
    assert(actual.trim() === '', `空模板不应当被编造成标题，实际 ${JSON.stringify(actual)}`);
    return '仅设置层回落';
  });
  expect('模板写了非类型前缀', templateCase('README: {issueTitle}', 'feat: README: 新增登录密码'));

  // ⑥ 超长标题截断到 250 字符，类型前缀必须还在。
  expect('超长标题截断保留前缀', () => {
    const long = renderTitle('{issueTitle} (#{issueNumber})', {
      ...ISSUE,
      title: '很长的标题'.repeat(60),
    });
    assert(long.length <= 250, `截断后仍有 ${long.length} 字符`);
    assert(long.startsWith('feat: '), `截断后丢了类型前缀：${long.slice(0, 20)}`);
    assert(leadingType(long) !== null, '截断后不是白名单类型');
    return `${long.length} 字符`;
  });

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(
    `\n结果：${checks.length - failed.length}/${checks.length} 项通过${
      failed.length > 0 ? '，存在失败项' : ' ✅'
    }\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`自检失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
