/**
 * Rules for the PR title and body AutoGit maintains.
 *
 * AutoGit writes both when it opens a PR, but they can fall out of shape later:
 * the default title template (`{issueTitle} (#{issueNumber})`) produces titles
 * like `新增登录密码 (#4)` that break the repository's mandatory
 * `<英文类型>: <描述>` convention, and a body can end up without the two
 * sections the repository requires.
 *
 * Neither problem is a repository edit — a fix agent cannot change a PR title
 * with the tools it has — so AutoGit repairs them itself over the platform API
 * (see `Orchestrator.syncPullRequestMetadata`). Everything here is pure string
 * logic so the rules stay testable without a network or a database.
 */

/** Types accepted as a title prefix, mirroring Conventional Commits. */
export const TITLE_TYPES = [
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
] as const;

export type TitleType = (typeof TITLE_TYPES)[number];

/** Platform limits are lower, but AutoGit only ever needs a readable prefix. */
const TITLE_MAX_LENGTH = 250;

/** `<type>: <description>` with a half-width colon and exactly one space. */
const CONVENTIONAL_TITLE = /^([A-Za-z][A-Za-z0-9-]*): (.+)$/;

/** Any `<word><colon>` prefix, including ones that are not a valid type. */
const ANY_PREFIX = /^([A-Za-z][A-Za-z0-9-]*)\s*[:：]\s*(.*)$/;

/** `修复：登录失败` — a Chinese type word used as a prefix. */
const CHINESE_PREFIX =
  /^(功能|特性|新增|实现|添加|支持|引入|修复|修正|优化|性能|文档|构建|依赖|升级|测试|重构|样式|回滚|撤销)\s*[:：]\s*(.+)$/;

/**
 * Keyword to type inference, most specific first. Only used when no usable
 * type prefix is present, so `新增...` becomes `feat:` and `修复...` `fix:`.
 */
const INFERENCE: Array<{ pattern: RegExp; type: TitleType }> = [
  { pattern: /^(回滚|撤销|revert)/i, type: 'revert' },
  { pattern: /^(重构|refactor)/i, type: 'refactor' },
  { pattern: /^(文档|说明|docs)/i, type: 'docs' },
  { pattern: /^(构建|依赖|升级|build|deps)/i, type: 'build' },
  { pattern: /^(测试|test)/i, type: 'test' },
  { pattern: /^(样式|格式|style|format)/i, type: 'style' },
  { pattern: /^(持续集成|自动化|ci)/i, type: 'ci' },
  { pattern: /^(优化|性能|加速|perf)/i, type: 'perf' },
  { pattern: /^(修复|修正|解决|缺陷|报错|bug|fix)/i, type: 'fix' },
  { pattern: /^(新增|实现|添加|支持|引入|功能|特性|feat)/i, type: 'feat' },
];

/** Sections every PR body must contain exactly once, with content. */
export const ASSUMPTIONS_SECTION = '实现假设清单';
export const DIAGRAM_SECTION = '代码逻辑图';
export const REQUIRED_BODY_SECTIONS = [ASSUMPTIONS_SECTION, DIAGRAM_SECTION] as const;

function clampTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > TITLE_MAX_LENGTH
    ? collapsed.slice(0, TITLE_MAX_LENGTH).trim()
    : collapsed;
}

function inferType(description: string): TitleType {
  for (const entry of INFERENCE) {
    if (entry.pattern.test(description)) return entry.type;
  }
  return 'feat';
}

function typeOfChineseWord(word: string): TitleType {
  return inferType(word);
}

/**
 * Rewrites any title into `<英文类型>: <描述>`.
 *
 * - a valid type prefix is only normalised (lower case, half-width colon,
 *   single space), so `FIX：  登录门禁` becomes `fix: 登录门禁`;
 * - an unknown ASCII prefix stays part of the description, because `README:`
 *   and `Release:` are not Conventional Commits types: `README: 更新说明`
 *   becomes `feat: README: 更新说明`;
 * - otherwise the type is inferred from the leading keyword and defaults to
 *   `feat:`;
 * - a title that carries no description at all is returned unchanged: there is
 *   nothing to prefix, and `titleProblem` reports nothing for it either.
 */
export function conventionalTitle(raw: string): string {
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return trimmed;

  const typed = trimmed.match(ANY_PREFIX);
  if (typed) {
    const type = (typed[1] ?? '').toLowerCase();
    const description = (typed[2] ?? '').trim();
    if (description && (TITLE_TYPES as readonly string[]).includes(type)) {
      return clampTitle(`${type}: ${description}`);
    }
  }

  const chinese = trimmed.match(CHINESE_PREFIX);
  if (chinese) {
    return clampTitle(`${typeOfChineseWord(chinese[1] ?? '')}: ${(chinese[2] ?? '').trim()}`);
  }

  // `feat:` with nothing behind it: leave it alone instead of inventing a
  // description, so an automatic repair can never turn a title into noise.
  if (typed && !(typed[2] ?? '').trim()) return trimmed;

  return clampTitle(`${inferType(trimmed)}: ${trimmed}`);
}

/**
 * Why the title breaks the convention, or `null` when it is fine.
 *
 * The rule is the one the repository enforces: an allowed English type, a
 * half-width colon and exactly one space before a non-empty description.
 */
export function titleProblem(title: string): string | null {
  const trimmed = title.trim();
  const match = trimmed.match(CONVENTIONAL_TITLE);
  if (!match) {
    const prefix = trimmed.match(ANY_PREFIX);
    if (prefix && !(prefix[2] ?? '').trim()) {
      return `标题「${trimmed}」只有类型没有描述`;
    }
    return `标题「${trimmed}」不符合 \`<英文类型>: <描述>\` 约定（需要半角冒号且冒号后只有一个空格）`;
  }

  const type = (match[1] ?? '').toLowerCase();
  if (!(TITLE_TYPES as readonly string[]).includes(type)) {
    return `类型前缀 \`${match[1]}\` 不在允许列表（${TITLE_TYPES.join(' / ')}）内`;
  }
  return null;
}

/**
 * Title of a Markdown heading line, `null` when the line is not a heading.
 *
 * Agents write these headings by hand, so a trailing `:` / `：` is tolerated
 * and any level counts (`#` … `######`).
 */
export function headingTitle(line: string): string | null {
  const match = line.match(/^\s*#{1,6}\s*(.+?)\s*$/);
  return match?.[1] ? match[1].replace(/[:：]\s*$/, '') : null;
}

/** Number of heading lines naming this section. */
export function countSection(body: string, heading: string): number {
  return body.split(/\r?\n/).filter((line) => headingTitle(line) === heading).length;
}

/**
 * Content of one section, up to the next heading of any level. Returns `null`
 * when the section is absent or empty.
 *
 * The summary is free-form prose written by a model, so both required PR
 * sections are located by their heading and the rest stays in 改动说明.
 */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => headingTitle(line) === heading);
  if (start === -1) return null;

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (headingTitle(line) !== null) break;
    body.push(line);
  }

  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

/** Every way the body breaks the repository's section rules, as messages. */
export function bodyProblems(body: string): string[] {
  const problems: string[] = [];
  for (const heading of REQUIRED_BODY_SECTIONS) {
    const count = countSection(body, heading);
    if (count === 0) {
      problems.push(`缺少 \`## ${heading}\` 小节`);
      continue;
    }
    if (count > 1) {
      problems.push(`\`## ${heading}\` 出现了 ${count} 次`);
      continue;
    }
    if (extractSection(body, heading) === null) {
      problems.push(`\`## ${heading}\` 是空的`);
    }
  }
  return problems;
}

/**
 * Drops the given sections, keeping everything else.
 *
 * Used when a section is pulled out of an agent summary into its own part of
 * the body: leaving a copy behind would add a second heading and make the body
 * fail the very check it is built from.
 */
export function dropSections(markdown: string, headings: readonly string[]): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of markdown.split(/\r?\n/)) {
    const title = headingTitle(line);
    if (title !== null) {
      skipping = headings.includes(title);
      if (skipping) continue;
    } else if (skipping) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}
