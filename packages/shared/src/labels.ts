/**
 * The single source of truth for every `ai/*` label AutoGit manages.
 *
 * The colour palette is intentionally spread across hues so a repository board
 * stays readable when several labels are attached to one issue or pull request.
 */

export const AI_LABEL_PREFIX = 'ai/';

export type AiLabelScope = 'issue' | 'pr' | 'both';

export type AiLabelGroup =
  | 'issue-status'
  | 'pr-status'
  | 'exception'
  | 'engine'
  | 'review-engine'
  | 'priority'
  | 'scheduler';

export interface AiLabelDefinition {
  /** Full label name, e.g. `ai/todo`. */
  name: string;
  /** Six digit hex colour without the leading `#` (GitHub/Gitea convention). */
  color: string;
  /** Human readable description written into the repository. */
  description: string;
  scope: AiLabelScope;
  group: AiLabelGroup;
  /** Labels inside the same group are mutually exclusive ("单选"). */
  exclusiveGroup?: string;
  /** Short Chinese title used by the dashboard. */
  title: string;
}

export const AI_LABELS: readonly AiLabelDefinition[] = [
  {
    name: 'ai/todo',
    color: '0e8a16',
    description: '[Issue状态·单选] 待AI实现；轮询领取后转 ai/doing。',
    scope: 'issue',
    group: 'issue-status',
    exclusiveGroup: 'issue-status',
    title: '待实现',
  },
  {
    name: 'ai/doing',
    color: '1f6feb',
    description: '[Issue状态·单选] AI正在实现；开PR后转 ai/in-review，异常转 ai/stuck。',
    scope: 'issue',
    group: 'issue-status',
    exclusiveGroup: 'issue-status',
    title: '实现中',
  },
  {
    name: 'ai/in-review',
    color: '8957e5',
    description: '[Issue状态·单选] 已关联PR并处于评审/修复；合并后转 ai/verify。',
    scope: 'issue',
    group: 'issue-status',
    exclusiveGroup: 'issue-status',
    title: '评审中',
  },
  {
    name: 'ai/verify',
    color: '0e7490',
    description: '[Issue状态·单选] PR已合并，待提出人/产品验证；通过后人工关闭Issue。',
    scope: 'issue',
    group: 'issue-status',
    exclusiveGroup: 'issue-status',
    title: '待验证',
  },
  {
    name: 'ai/needs-review',
    color: 'f2cc0c',
    description: '[PR状态·单选] 待AI评审；通过转 ai/approved，有问题转 ai/needs-fix。',
    scope: 'pr',
    group: 'pr-status',
    exclusiveGroup: 'pr-status',
    title: '待评审',
  },
  {
    name: 'ai/needs-fix',
    color: 'e16f24',
    description: '[PR状态·单选] 待按评审意见修复；完成后转 ai/needs-review。',
    scope: 'pr',
    group: 'pr-status',
    exclusiveGroup: 'pr-status',
    title: '待修复',
  },
  {
    name: 'ai/approved',
    color: '2ea043',
    description: '[PR状态·单选] AI评审通过，待人工审核并决定是否合并。',
    scope: 'pr',
    group: 'pr-status',
    exclusiveGroup: 'pr-status',
    title: '已通过',
  },
  {
    name: 'ai/stuck',
    color: '8b1a1a',
    description: '[Issue/PR异常状态·替代] 流水线暂停；处理后移除并打回一个适用状态标签。',
    scope: 'both',
    group: 'exception',
    title: '已阻塞',
  },
  {
    name: 'ai/paused',
    color: '6e7781',
    description: '[调度开关·Issue/PR] 人工暂停；保留当前状态但轮询器不执行。',
    scope: 'both',
    group: 'scheduler',
    title: '已暂停',
  },
  {
    name: 'ai/prefer-codex',
    color: '10a37f',
    description: '[执行引擎·可选单选·Issue/PR] Codex优先；限额时切Claude；默认即此顺序。',
    scope: 'both',
    group: 'engine',
    exclusiveGroup: 'engine',
    title: '优先 Codex',
  },
  {
    name: 'ai/prefer-claude',
    color: 'd97757',
    description: '[执行引擎·可选单选·Issue/PR] Claude优先；限额时切Codex。',
    scope: 'both',
    group: 'engine',
    exclusiveGroup: 'engine',
    title: '优先 Claude',
  },
  {
    name: 'ai/review-codex',
    color: '0b7a5f',
    description: '[评审引擎·可选单选·PR] Codex评审优先；未设置时默认即此顺序。',
    scope: 'pr',
    group: 'review-engine',
    exclusiveGroup: 'review-engine',
    title: 'Codex 评审',
  },
  {
    name: 'ai/review-claude',
    color: 'a24b2b',
    description: '[评审引擎·可选单选·PR] Claude评审优先；未设置时Codex优先。',
    scope: 'pr',
    group: 'review-engine',
    exclusiveGroup: 'review-engine',
    title: 'Claude 评审',
  },
  {
    name: 'ai/priority-high',
    color: 'c4322b',
    description: '[调度优先级·可选单选·Issue/PR] 高；构建队列全局优先，评审队列内优先。',
    scope: 'both',
    group: 'priority',
    exclusiveGroup: 'priority',
    title: '高优先级',
  },
  {
    name: 'ai/priority-low',
    color: '8ca0b3',
    description: '[调度优先级·可选单选·Issue/PR] 低；无标签为普通，构建/评审队列均后置。',
    scope: 'both',
    group: 'priority',
    exclusiveGroup: 'priority',
    title: '低优先级',
  },
] as const;

export const AI_LABEL_NAMES: readonly string[] = AI_LABELS.map((label) => label.name);

export const AI_LABEL_BY_NAME: Readonly<Record<string, AiLabelDefinition>> = Object.fromEntries(
  AI_LABELS.map((label) => [label.name, label]),
);

export function isAiLabel(name: string): boolean {
  return name.startsWith(AI_LABEL_PREFIX);
}

export function aiLabelsOnly(labels: readonly string[]): string[] {
  return labels.filter(isAiLabel);
}

export function labelDefinition(name: string): AiLabelDefinition | undefined {
  return AI_LABEL_BY_NAME[name];
}

export function labelTitle(name: string): string {
  return AI_LABEL_BY_NAME[name]?.title ?? name;
}

/** Groups that are rendered as a pipeline column in the UI, in display order. */
export const ISSUE_PIPELINE_ORDER: readonly string[] = [
  'ai/todo',
  'ai/doing',
  'ai/in-review',
  'ai/verify',
];

export const PR_PIPELINE_ORDER: readonly string[] = [
  'ai/needs-review',
  'ai/needs-fix',
  'ai/approved',
];
