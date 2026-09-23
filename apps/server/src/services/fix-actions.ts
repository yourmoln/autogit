/**
 * Actions a fix agent hands back to AutoGit.
 *
 * The fix agent runs inside a sandbox: it can edit files, but it cannot change
 * a PR title or rewrite a branch, because both need credentials it does not
 * have. Reviews do ask for those things — a title that breaks the repository
 * convention, a branch whose history carries a committed package cache — and a
 * pipeline that can only fix files just spins: the review keeps asking while
 * every fix run correctly reports "nothing to change in the repository".
 *
 * So the agent asks for the change instead. It ends its summary with a single
 * `autogit` fenced block, and AutoGit carries it out with the credentials the
 * agent lacks. The model decides *what* to do and why; AutoGit only executes.
 */

export interface FixActions {
  /** Final PR title (`<英文类型>: <描述>`), or null to leave it alone. */
  prTitle: string | null;
  /** Full replacement PR body, or null to leave it alone. */
  prBody: string | null;
  /** Repo-relative paths to delete from this branch's own history. */
  purgePaths: string[];
  /** Why the actions are needed; echoed into the PR comment. */
  reason: string | null;
}

export const NO_FIX_ACTIONS: FixActions = {
  prTitle: null,
  prBody: null,
  purgePaths: [],
  reason: null,
};

const ACTION_FENCE_OPEN = /^```autogit\s*$/i;
const FENCE_CLOSE = /^```$/;

/** A repo-relative path that is safe to hand to `git rm --cached`. */
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

function readString(value: unknown, field: string, problems: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems.push(`${field} 必须是字符串，已忽略`);
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePath(value: unknown, problems: string[]): string | null {
  if (typeof value !== 'string') {
    problems.push('purgePaths 的元素必须是字符串，已忽略该条');
    return null;
  }
  const candidate = value
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (candidate.length === 0) {
    problems.push('purgePaths 里有空路径，已忽略');
    return null;
  }
  if (
    !SAFE_PATH.test(candidate) ||
    candidate.startsWith('/') ||
    candidate.includes('..') ||
    candidate === '.git' ||
    candidate.startsWith('.git/')
  ) {
    problems.push(`purgePaths 里的「${value}」不是安全的仓库内相对路径，已忽略`);
    return null;
  }
  return candidate;
}

/**
 * JSON body of the `autogit` block, located by lines rather than by a lazy
 * regex.
 *
 * A requested PR body normally carries fenced blocks of its own
 * (`\`\`\`mermaid` for the logic diagram), and inside JSON those fences are
 * part of a *string*: the lazy `/\`\`\`autogit([\s\S]*?)\`\`\`/` match stops at the
 * first one and silently truncates the request. Scanning for a line that is
 * nothing but a closing fence skips them, because a JSON string cannot contain
 * a real newline.
 */
function extractActionJson(summary: string): string | null {
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex((line) => ACTION_FENCE_OPEN.test(line.trim()));
  if (start === -1) return null;

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (FENCE_CLOSE.test(line.trim())) return body.join('\n');
    body.push(line);
  }
  // Unterminated fence: hand the remainder to the parser so a malformed block
  // is reported instead of silently ignored.
  return body.join('\n');
}

/**
 * Reads the agent's action block out of its final message.
 *
 * A missing block is normal (most fix runs only edit files); a malformed one is
 * reported through `problems` so the run log says what was dropped instead of
 * silently ignoring a request the model thought it had made.
 */
export function parseFixActions(summary: string): { actions: FixActions; problems: string[] } {
  const json = extractActionJson(summary);
  if (!json) return { actions: NO_FIX_ACTIONS, problems: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { actions: NO_FIX_ACTIONS, problems: ['`autogit` 代码块不是合法 JSON，已忽略'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { actions: NO_FIX_ACTIONS, problems: ['`autogit` 代码块必须是 JSON 对象，已忽略'] };
  }

  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const purgePaths: string[] = [];
  if (record.purgePaths !== undefined) {
    if (!Array.isArray(record.purgePaths)) {
      problems.push('purgePaths 必须是字符串数组，已忽略');
    } else {
      for (const entry of record.purgePaths) {
        const path = normalizePath(entry, problems);
        if (path && !purgePaths.includes(path)) purgePaths.push(path);
      }
    }
  }

  return {
    actions: {
      prTitle: readString(record.prTitle, 'prTitle', problems),
      prBody: readString(record.prBody, 'prBody', problems),
      purgePaths,
      reason: readString(record.reason, 'reason', problems),
    },
    problems,
  };
}

/** Short, log-friendly description of what the agent asked for. */
export function describeFixActions(actions: FixActions): string[] {
  const lines: string[] = [];
  if (actions.prTitle) lines.push(`修改 PR 标题为「${actions.prTitle}」`);
  if (actions.prBody) lines.push('替换 PR 正文');
  if (actions.purgePaths.length > 0) {
    lines.push(`从本分支历史中删除 ${actions.purgePaths.map((item) => `\`${item}\``).join('、')}`);
  }
  return lines;
}
