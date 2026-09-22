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

## 输出要求
最后用中文输出一段简短总结，包含：
- 修改了哪些文件，以及各自作用；
- 运行了哪些验证命令，结果如何；
- 仍然存在的风险或未完成事项（没有就写“无”）。
${tips}`;
}

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'issues'],
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
        required: ['severity', 'title', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          suggestion: { type: 'string' },
        },
      },
    },
    tests: { type: 'string', description: '为验证本次改动而运行的命令与结果。' },
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
5. 按给定的 JSON Schema 输出结论（verdict / summary / issues / tests），issues 中每条都要能直接指导修复。`;
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

${WORK_RULES}

## 输出要求
最后用中文输出：每条评审意见的处理结论（已修复 / 不适用 + 原因）、验证命令与结果、剩余风险。`;
}
