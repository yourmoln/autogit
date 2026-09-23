import type { RemoteIssue, RemotePullRequest } from '@autogit/shared';

export interface PromptRepository {
  fullName: string;
  defaultBranch: string;
  owner: string;
  name: string;
}

export interface CommentDigest {
  author: string;
  body: string;
  createdAt: string;
}

const WORK_RULES = `工作规范：
1. 只修改本仓库内的文件，不要改动 .git 目录、CI 密钥或任何凭证。
2. 改动范围聚焦在 issue / 评审意见描述的问题上，不要顺带重构无关模块。
3. 优先复用仓库现有依赖与代码风格，新增依赖前先确认确有必要。
4. 如果仓库提供了测试 / 类型检查脚本，运行与改动相关的部分并修复失败。
5. 不要执行 git commit、git push、git checkout，AutoGit 会统一处理版本控制。`;

/**
 * PR title and body belong to AutoGit, not to the agents.
 *
 * A fix agent has no platform credentials and cannot change them, so a review
 * that blocks on the title (or on missing body sections) deadlocks the loop:
 * the reviewer keeps asking, every fix run correctly reports nothing to change
 * in the repository. AutoGit therefore repairs both itself at the end of each
 * run, and both prompts say so.
 */
const PR_METADATA_NOTE = `PR 的标题与正文由 AutoGit 自动维护：标题会补成 \`<英文类型>: <描述>\`，正文保证包含 \`## 实现假设清单\` 与 \`## 代码逻辑图\` 两节（每轮任务结束时自动修正）。`;

/**
 * The agent's escape hatch for everything its sandbox cannot do.
 *
 * File edits are not the only kind of finding: a review can also demand a
 * compliant PR title or a branch history without the committed package cache.
 * Both need credentials the agent does not have, so it asks AutoGit to run them
 * instead of being blocked — the model still decides what should happen.
 */
const FIX_ACTION_CHANNEL = `## 你做不到的事：交给 AutoGit 执行
你在沙箱里只能改文件。如果某条意见需要修改 PR 标题/正文，或需要把误提交的路径（例如包缓存目录）从本分支历史里删掉，不要放弃，也不要用无意义的文件改动去凑：在总结最后附一个 \`\`\`autogit 代码块，AutoGit 会用凭据替你执行。

\`\`\`autogit
{
  "prTitle": "feat: 期望的最终标题（不需要就省略）",
  "prBody": "完整正文，必须包含 ## 实现假设清单 与 ## 代码逻辑图 各一次（不需要就省略）",
  "purgePaths": [".pnpm-store"],
  "reason": "为什么需要这些动作"
}
\`\`\`

- \`purgePaths\` 只会把该路径从**本分支自己新增的提交**（合并基准之后）里删除，且必须保证 tip 的树内容不变，随后由 AutoGit 强推；
- 整个代码块必须是**合法 JSON**：换行写成 JSON 的 \`\\n\` 转义（不要出现真正的多行字符串），正文里可以照常包含 \`\`\`mermaid 代码块；
- 只有确实需要、并且你已经核实过时才写进这个块；不需要就完全不要写这个块。`;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（内容已截断）`;
}

function commentsSection(comments: CommentDigest[]): string {
  if (comments.length === 0) return '（暂无评论）';
  return comments
    .slice(-12)
    .map((comment, index) => {
      const body = truncate(comment.body.trim(), 2000);
      return `### 评论 ${index + 1} · @${comment.author} · ${comment.createdAt}\n${body}`;
    })
    .join('\n\n');
}

export function buildImplementPrompt(input: {
  repository: PromptRepository;
  issue: RemoteIssue;
  comments: CommentDigest[];
  branch: string;
  verificationHints: string[];
}): string {
  const { repository, issue } = input;
  const tips =
    input.verificationHints.length > 0
      ? `\n额外提示：\n- ${input.verificationHints.join('\n- ')}`
      : '';

  return `你是 AutoGit 的自动实现代理，需要在仓库 ${repository.fullName}（默认分支 ${repository.defaultBranch}）上完成一个 Issue。

## Issue #${issue.number}：${issue.title}
提出人：@${issue.author}
链接：${issue.htmlUrl}

${truncate(issue.body.trim() || '（Issue 没有正文描述）', 8000)}

## Issue 讨论
${commentsSection(input.comments)}

## 你的任务
1. 先阅读仓库结构、README 以及与 issue 相关的既有代码，理解现有实现方式。
2. 制定最小可行方案并直接在代码中实现，产出可直接合并的改动。
3. 补齐必要的测试、类型定义、文档或配置，使改动自洽。
4. 运行能验证本次改动的命令（构建、单测、lint、类型检查），并以结果作为结论依据。
5. 当前工作分支是 ${input.branch}，不要切换分支。

${WORK_RULES}

${PR_METADATA_NOTE}

## 输出要求
最后用中文输出一段简短总结，要求覆盖本次分支上的全部改动（不要只描述其中一部分），包含：
- 修改了哪些文件（含服务端 / 前端 / 文档），以及各自作用；
- 运行了哪些验证命令，结果如何；
- 仍然存在的风险或未完成事项（没有就写“无”）。

总结里必须带上下面两节，AutoGit 会把它们原样放进 PR 正文（缺失或留空都不合仓库约定）：

## 实现假设清单
逐条列出本次实现依赖的假设；确实没有额外假设时写“无额外假设”。

## 代码逻辑图
用 Mermaid 描述本次改动的实际流程，例如：

\`\`\`mermaid
flowchart TD
    A[入口] --> B[新增/修改的处理]
\`\`\`
${tips}`;
}

/**
 * JSON Schema handed to `codex exec --output-schema`.
 *
 * The CLI submits this as a *strict* response schema, and strict mode rejects
 * any object whose `required` list does not name every key in `properties`
 * ("Required properties must match all properties in the object"). Fields that
 * are genuinely optional are therefore `required` + nullable instead of
 * omitted; `EngineRunner.parseVerdict` already maps `null` back to "absent".
 */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues', 'tests'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'needs_fix'],
      description: 'approve 表示可以合并；needs_fix 表示必须先修复问题。',
    },
    summary: { type: 'string', description: '中文评审总结，说明结论与理由。' },
    issues: {
      type: 'array',
      description: '需要修复的问题清单；verdict 为 approve 时应当是空数组。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'detail', 'file', 'line', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          file: { type: ['string', 'null'], description: '相关文件路径；不适用时填 null。' },
          line: { type: ['integer', 'null'], description: '相关行号；不适用时填 null。' },
          suggestion: { type: ['string', 'null'], description: '修复建议；不适用时填 null。' },
        },
      },
    },
    tests: {
      type: ['string', 'null'],
      description: '为验证本次改动而运行的命令与结果；没有运行测试时填 null。',
    },
  },
} as const;

export function buildReviewPrompt(input: {
  repository: PromptRepository;
  pullRequest: RemotePullRequest;
  issue: RemoteIssue | null;
  diff: string;
  comments: CommentDigest[];
}): string {
  const { repository, pullRequest } = input;
  return `你是 AutoGit 的代码评审代理，正在评审仓库 ${repository.fullName} 的 PR #${pullRequest.number}。

## PR 信息
标题：${pullRequest.title}
作者：@${pullRequest.author}
分支：${pullRequest.headRef} → ${pullRequest.baseRef}
链接：${pullRequest.htmlUrl}
${input.issue ? `关联 Issue：#${input.issue.number} ${input.issue.title}` : '（未找到关联 Issue）'}

## PR 描述
${truncate(pullRequest.body.trim() || '（PR 没有描述）', 4000)}

## 已有讨论
${commentsSection(input.comments)}

## 变更内容（diff）
\`\`\`diff
${input.diff}
\`\`\`

## 评审要求
1. 以“能否安全合并”为目标，重点检查正确性、边界条件、异常处理、安全性与向后兼容。
2. 你可以读取工作区中的完整代码验证 diff，也可以运行构建、测试、lint 来确认结论。
3. 只有存在真实缺陷时才给 needs_fix；风格偏好或可选优化记为 minor，不作为阻塞项。
4. 不要修改任何文件，只做评审。
5. 按给定的 JSON Schema 输出结论（verdict / summary / issues / tests），issues 中每条都要能直接指导修复。
6. ${PR_METADATA_NOTE}所以标题格式、正文小节这类问题记为 minor 并在总结里说明即可，不要作为 needs_fix 的阻塞理由。`;
}

/** Human-readable shape of `REVIEW_SCHEMA`, restated in the repair prompt. */
const REVIEW_VERDICT_SHAPE = `{
  "verdict": "approve 或 needs_fix",
  "summary": "中文评审总结：结论与理由",
  "issues": [
    {
      "severity": "blocker / major / minor",
      "title": "问题标题",
      "detail": "问题说明",
      "file": "相关文件路径，不适用时填 null",
      "line": 12,
      "suggestion": "修复建议，不适用时填 null"
    }
  ],
  "tests": "验证命令与结果，没有就填 null"
}`;

/**
 * Repair prompt for the case where a review run finished but its output could
 * not be parsed into a verdict.
 *
 * Re-asking is far cheaper than a failed review task: the model has already
 * reached a conclusion, only the serialisation went wrong. So it gets its own
 * output back together with the exact JSON shape, and is explicitly told not to
 * re-review or touch the workspace.
 */
export function buildVerdictRepairPrompt(input: {
  previousOutput: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const previous = truncate(input.previousOutput.trim() || '（上一次输出为空）', 8000);
  return `你是 AutoGit 的代码评审代理。你上一条消息无法被程序解析成评审结论，现在需要你重新输出结论（第 ${input.attempt}/${input.maxAttempts} 次尝试）。

## 你上一次的输出
\`\`\`
${previous}
\`\`\`

## 你的任务
1. 不要重新评审，不要读取或修改任何文件，不要运行任何命令。
2. 只把你已经得出的评审结论重新输出成一个 JSON 对象，必须满足下面的结构。
3. 只输出 JSON 本身：不要 Markdown 代码块包裹、不要任何解释文字，第一个字符必须是 \`{\`，最后一个字符必须是 \`}\`。
4. 所有字段都必须出现：顶层 verdict / summary / issues / tests；issues 中每条的 severity / title / detail / file / line / suggestion。没有内容时用 \`null\` 或空数组。
5. 上一次输出里已有的结论请原样保留，只补齐缺失或格式不对的部分。

## 必须满足的 JSON 结构
${REVIEW_VERDICT_SHAPE}`;
}

export function buildFixPrompt(input: {
  repository: PromptRepository;
  pullRequest: RemotePullRequest;
  issue: RemoteIssue | null;
  reviewComment: string;
  diffStat: string;
}): string {
  const { repository, pullRequest } = input;
  return `你是 AutoGit 的修复代理，需要按评审意见修订仓库 ${repository.fullName} 的 PR #${pullRequest.number}。

## PR 信息
标题：${pullRequest.title}
分支：${pullRequest.headRef} → ${pullRequest.baseRef}
链接：${pullRequest.htmlUrl}
${input.issue ? `关联 Issue：#${input.issue.number} ${input.issue.title}` : ''}

## 当前改动概览
\`\`\`
${input.diffStat}
\`\`\`

## 评审意见（必须逐条处理）
${truncate(input.reviewComment, 8000)}

## 你的任务
1. 逐条修复评审意见指出的问题；若某条意见经核实不成立，在总结中说明理由。
2. 补齐或更新对应测试，避免同类问题回归。
3. 当前分支已经是 ${pullRequest.headRef}，直接在该分支上修改，不要切换分支。
4. 完成后运行相关验证命令。
5. 如果某条意见属于平台元数据（PR 标题不合规、正文缺少小节），不需要改动仓库文件：${PR_METADATA_NOTE}需要改的话按下面的动作块交给 AutoGit。
6. 如果所有意见都不落在仓库文件上，优先用下面的动作块让 AutoGit 执行；确实无法执行（例如需要人工决定的事）才把理由写清楚，AutoGit 会按「无需改动」记录并交回人工确认。

${FIX_ACTION_CHANNEL}

${WORK_RULES}

## 输出要求
最后用中文输出：每条评审意见的处理结论（已修复 / 不适用 + 原因）、验证命令与结果、剩余风险；并用 \`## 实现假设清单\`（列出本轮修复依赖的假设，没有额外假设就明确写明）与 \`## 代码逻辑图\`（mermaid 代码块）两节收尾，AutoGit 会用它们维护 PR 正文。`;
}
