import { AI_LABELS } from './labels.js';
import type { TaskPriority } from './types.js';

export const ISSUE_STATUS_LABELS = ['ai/todo', 'ai/doing', 'ai/in-review', 'ai/verify'] as const;

export const PR_STATUS_LABELS = ['ai/needs-review', 'ai/needs-fix', 'ai/approved'] as const;

export const ENGINE_LABELS = ['ai/prefer-codex', 'ai/prefer-claude'] as const;
export const REVIEW_ENGINE_LABELS = ['ai/review-codex', 'ai/review-claude'] as const;
export const PRIORITY_LABELS = ['ai/priority-high', 'ai/priority-low'] as const;

export const PAUSED_LABEL = 'ai/paused';
export const STUCK_LABEL = 'ai/stuck';

export type IssueStatus = (typeof ISSUE_STATUS_LABELS)[number];
export type PullRequestStatus = (typeof PR_STATUS_LABELS)[number];

const ISSUE_STATUS_SET = new Set<string>(ISSUE_STATUS_LABELS);
const PR_STATUS_SET = new Set<string>(PR_STATUS_LABELS);

export function isIssueStatus(label: string): label is IssueStatus {
  return ISSUE_STATUS_SET.has(label);
}

export function isPullRequestStatus(label: string): label is PullRequestStatus {
  return PR_STATUS_SET.has(label);
}

/** Current pipeline status of an issue/PR, or `null` when it is not managed. */
export function resolvePipelineStatus(labels: readonly string[]): string | null {
  for (const label of ISSUE_STATUS_LABELS) {
    if (labels.includes(label)) return label;
  }
  for (const label of PR_STATUS_LABELS) {
    if (labels.includes(label)) return label;
  }
  return null;
}

export function isPaused(labels: readonly string[]): boolean {
  return labels.includes(PAUSED_LABEL);
}

export function isStuck(labels: readonly string[]): boolean {
  return labels.includes(STUCK_LABEL);
}

export function priorityOf(labels: readonly string[]): TaskPriority {
  if (labels.includes('ai/priority-high')) return 'high';
  if (labels.includes('ai/priority-low')) return 'low';
  return 'normal';
}

/** Lower number wins inside a queue. */
export function priorityRank(priority: TaskPriority): number {
  switch (priority) {
    case 'high':
      return 0;
    case 'normal':
      return 1;
    case 'low':
      return 2;
    default:
      return 1;
  }
}

export type EnginePreference = 'codex' | 'claude';

export function preferredEngine(labels: readonly string[]): EnginePreference {
  if (labels.includes('ai/prefer-claude')) return 'claude';
  return 'codex';
}

export function preferredReviewEngine(labels: readonly string[]): EnginePreference {
  if (labels.includes('ai/review-claude')) return 'claude';
  return 'codex';
}

/** Labels that must be removed when moving an issue into `status`. */
export function labelsToClearForIssueStatus(
  labels: readonly string[],
  status: IssueStatus,
): string[] {
  return labels.filter((label) => label !== status && ISSUE_STATUS_SET.has(label));
}

/** Labels that must be removed when moving a pull request into `status`. */
export function labelsToClearForPullStatus(
  labels: readonly string[],
  status: PullRequestStatus,
): string[] {
  return labels.filter((label) => label !== status && PR_STATUS_SET.has(label));
}

/**
 * Applies a status transition on a label set. Returns the new label array and
 * the diff that should be pushed to the remote.
 */
export function applyStatusTransition(
  labels: readonly string[],
  status: IssueStatus | PullRequestStatus,
  options: { clearStuck?: boolean } = {},
): { next: string[]; added: string[]; removed: string[] } {
  const next = new Set(labels);
  const removed: string[] = [];

  const statuses = isIssueStatus(status) ? ISSUE_STATUS_LABELS : PR_STATUS_LABELS;
  for (const candidate of statuses) {
    if (candidate !== status && next.has(candidate)) {
      next.delete(candidate);
      removed.push(candidate);
    }
  }
  if (options.clearStuck && next.has(STUCK_LABEL)) {
    next.delete(STUCK_LABEL);
    removed.push(STUCK_LABEL);
  }
  const added = next.has(status) ? [] : [status];
  next.add(status);

  return { next: [...next], added, removed };
}

export const PIPELINE_STAGES = [
  {
    id: 'todo',
    labels: ['ai/todo'],
    title: '待实现队列',
    description: '打上 ai/todo 后由轮询器领取并切换到 ai/doing。',
    tone: 'todo',
  },
  {
    id: 'doing',
    labels: ['ai/doing'],
    title: 'Codex 实现中',
    description: 'Codex CLI 正在阅读 Issue、修改代码并准备提交。',
    tone: 'doing',
  },
  {
    id: 'in-review',
    labels: ['ai/in-review'],
    title: '评审 / 修复',
    description: 'PR 已创建，处于 AI 评审与评审意见修复循环。',
    tone: 'review',
  },
  {
    id: 'verify',
    labels: ['ai/verify'],
    title: '待人工验证',
    description: 'PR 已合并，等待提出人或产品确认后关闭 Issue。',
    tone: 'verify',
  },
] as const;

export function describeLabelCoverage(existing: readonly string[]): {
  total: number;
  present: number;
  missing: string[];
} {
  const present = AI_LABELS.filter((label) => existing.includes(label.name));
  return {
    total: AI_LABELS.length,
    present: present.length,
    missing: AI_LABELS.filter((label) => !existing.includes(label.name)).map((label) => label.name),
  };
}
